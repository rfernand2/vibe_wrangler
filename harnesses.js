'use strict';

/**
 * A harness is a CLI that takes a prompt and streams JSON events back. Everything that differs
 * between them lives here — how it is launched, how the prompt reaches it, what it needs stripped
 * from the environment, and how one of its events maps onto the only two things the runner cares
 * about: assistant text, and the end of the run. agent.js never has to know which one it is driving.
 *
 * Each harness offers its models through one or more providers. `native` is the harness's own
 * hosted models; the others route the same CLI at somebody else's endpoint.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const GROK_BIN = process.env.GROK_BIN || 'grok';

const GROK_CONFIG = process.env.GROK_CONFIG || path.join(os.homedir(), '.grok', 'config.toml');

/**
 * `--prompt-file` is single-turn: without a cap the model answers once and the run ends before it
 * has reached for a single tool, which reads as an agent that wrote a plan and did nothing. This is
 * a ceiling and not a target — a run that hits it ends `Cancelled` and is treated as failed.
 */
const GROK_MAX_TURNS = process.env.GROK_MAX_TURNS || '200';

/** Read per call, not once: a test points it at a stand-in server. */
const ollamaUrl = () => process.env.OLLAMA_HOST || 'http://localhost:11434';

/** How long Ollama has to answer before we take it as not running. */
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 1500;

/** Every model Ollama had pulled when the catalogue was last built. Empty until one has been. */
let ollamaInstalled = [];

/** A tag like `qwen3.6:latest` is not a TOML bare key, and the alias name has to be one. */
const ollamaAlias = (tag) => `ollama-${tag.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;

/**
 * Ollama's models are whichever ones the human has pulled, so any list written here is a guess that
 * is wrong on every machine that didn't make the same choices. Asking it is the only honest answer.
 * A failure leaves the last known list alone: Ollama not running is not the same as nothing installed,
 * and emptying the dropdown for a stopped server would be its own kind of lie.
 */
async function discoverOllama(provider) {
  const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
  const tags = (await res.json()).models?.map((m) => m.name).filter(Boolean) || [];
  if (!tags.length) return;
  ollamaInstalled = tags;
  provider.models = tags.map((tag) => ({ id: ollamaAlias(tag), name: tag, upstream: tag }));
}

/**
 * Grok only reaches a non-xAI endpoint through an alias in its own config file, so choosing an
 * OpenRouter or Ollama model in the app means that alias has to exist before the CLI starts.
 * Appends and never rewrites: an alias already there may have been tuned by hand, and clobbering
 * someone's credentials or context window to reassert our defaults would be worse than doing
 * nothing. The key itself still has to come from the environment.
 */
function ensureGrokAlias(provider, model) {
  if (!provider.register) return;
  const header = `[model.${model.id}]`;
  let current = '';
  try { current = fs.readFileSync(GROK_CONFIG, 'utf8'); } catch { /* first run, no file yet */ }
  if (current.includes(header)) return;

  const { base_url: baseUrl, env_key: envKey, api_key: apiKey } = provider.register;
  const block = [
    '', '# added by Vibe Wrangler', header,
    `model = "${model.upstream}"`,
    `name = "${model.name} (${provider.name})"`,
    `base_url = "${baseUrl}"`,
    envKey ? `env_key = "${envKey}"` : `api_key = "${apiKey}"`,
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(GROK_CONFIG), { recursive: true });
  fs.appendFileSync(GROK_CONFIG, current && !current.endsWith('\n') ? `\n${block}` : block);
}

/**
 * Where the runner's `NOTE:`/`PLAN:`/`DONE:` lines may be cut. A newline is the obvious one, but
 * models also run one directive straight onto the end of the last — `…in the project.NOTE: Found
 * the…` — and a reader that waits for a newline holds everything after it back. One five-minute run
 * narrated six times and the human saw all six in the last second, because no newline arrived in
 * between.
 */
const DIRECTIVE_BOUNDARY = /\r?\n|(?<=\S)(?=(?:NOTE|PLAN|DONE):)/g;

/** The last place `buf` can be split without cutting a directive in half, or null if there is none. */
function lastBoundary(buf) {
  let found = null;
  DIRECTIVE_BOUNDARY.lastIndex = 0;
  for (let m = DIRECTIVE_BOUNDARY.exec(buf); m; m = DIRECTIVE_BOUNDARY.exec(buf)) {
    found = { end: m.index, rest: m.index + m[0].length };
    // A lookahead matches nothing, so it would sit on the same index for ever.
    if (!m[0]) DIRECTIVE_BOUNDARY.lastIndex++;
  }
  return found;
}

/** A reader that sees whole messages needs no state, but the contract is a factory either way. */
const stateless = (read) => () => read;

const native = (models) => [{ id: 'native', name: 'Native', models }];

const HARNESSES = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: CLAUDE_BIN,
    input: 'stdin',
    // First in the list is what the harness falls back to when no model has been chosen.
    providers: native([
      { id: 'claude-opus-5', name: 'Opus 5' },
      { id: 'claude-fable-5', name: 'Fable 5' },
      { id: 'claude-sonnet-5', name: 'Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
    ]),
    args: (model) => [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model', model,
    ],
    env(env) {
      // Force subscription auth: an inherited API key would bill per token instead.
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.CLAUDE_CODE_USE_BEDROCK;
      delete env.CLAUDE_CODE_USE_VERTEX;
    },
    reader: stateless((evt) => {
      if (evt.type === 'result') {
        return {
          done: true,
          text: typeof evt.result === 'string' ? evt.result : '',
          failed: evt.is_error === true || Boolean(evt.subtype && evt.subtype !== 'success'),
        };
      }
      if (evt.type === 'assistant') {
        const text = (evt.message?.content || [])
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('\n');
        return text ? { text } : null;
      }
      return null;
    }),
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    bin: CODEX_BIN,
    input: 'stdin',
    providers: native([
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
    ]),
    // The trailing `-` is what makes it read the prompt from stdin rather than the command line.
    args: (model) => [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model', model,
      '-',
    ],
    env() {},
    reader: stateless((evt) => {
      // Unlike Claude, the terminal event carries no text — the last message is the summary.
      if (evt.type === 'turn.completed') return { done: true, failed: false };
      if (evt.type === 'turn.failed') return { done: true, failed: true };
      if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
        return evt.item.text ? { text: evt.item.text } : null;
      }
      return null;
    }),
  },
  {
    id: 'grok',
    name: 'Grok Build',
    bin: GROK_BIN,
    // It has no stdin mode: `-p` demands the prompt as an argument, which a long prompt would
    // overflow on Windows. A file sidesteps both problems.
    input: 'file',
    providers: [
      { id: 'native', name: 'Native', models: [{ id: 'grok-4.5', name: 'Grok 4.5' }] },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        // Grok reaches anything other than xAI through an alias in its own config file, so each
        // model here carries what that alias needs to be written. `id` is the alias itself.
        register: {
          base_url: 'https://openrouter.ai/api/v1',
          env_key: 'OPENROUTER_API_KEY',
          // The name OpenRouter documents is the one the alias asks for, but people keep their key
          // under whichever of these they met first. Any of them will do.
          env_alts: ['OPEN_ROUTER_KEY', 'OPENROUTER_KEY', 'OPENROUTER_API_TOKEN'],
        },
        models: [
          { id: 'openrouter-deepseek-v4-flash', name: 'DeepSeek V4 Flash 0731', upstream: 'deepseek/deepseek-v4-flash-20260731' },
          { id: 'openrouter-mimo-v2-5', name: 'MiMo-V2.5', upstream: 'xiaomi/mimo-v2.5-20260422' },
          { id: 'openrouter-glm-5-2', name: 'GLM 5.2', upstream: 'z-ai/glm-5.2-20260616' },
          { id: 'openrouter-gpt-5-6-luna', name: 'GPT-5.6 Luna', upstream: 'openai/gpt-5.6-luna-20260709' },
          { id: 'openrouter-hy3', name: 'Hy3', upstream: 'tencent/hy3-20260706' },
        ],
      },
      {
        id: 'ollama',
        name: 'Ollama',
        // A local server needs no credential, but the OpenAI-compatible route still wants a key
        // header, so Ollama accepts any non-empty string.
        register: { base_url: `${ollamaUrl()}/v1`, api_key: 'ollama' },
        discover: discoverOllama,
        // Replaced by whatever `discover` finds. These are only what the dropdown shows before it has
        // managed to ask, and the common pulls are a better guess than an empty list.
        models: [
          { id: 'ollama-qwen3-coder', name: 'qwen3-coder', upstream: 'qwen3-coder' },
          { id: 'ollama-devstral', name: 'devstral', upstream: 'devstral' },
          { id: 'ollama-gpt-oss', name: 'gpt-oss', upstream: 'gpt-oss' },
        ],
      },
    ],
    prepare: ensureGrokAlias,
    args: (model, promptPath) => [
      '--prompt-file', promptPath,
      '--output-format', 'streaming-json',
      '--permission-mode', 'bypassPermissions',
      '--max-turns', GROK_MAX_TURNS,
      '--model', model,
    ],
    env(env, provider) {
      // The alias names one variable, so a key kept under any of the other spellings is copied to it
      // rather than left for the endpoint to reject as a bare 401 five seconds into the run.
      const key = provider?.register?.env_key;
      if (!key || env[key]) return;
      const alt = (provider.register.env_alts || []).find((name) => env[name]?.trim());
      if (alt) env[key] = env[alt].trim();
    },
    /**
     * Why this run cannot work, before a worktree and a branch have been made for it. Both of these
     * reach the human as a status code from somewhere else — a bare 401, or a 404 naming a model they
     * just picked from a dropdown — with nothing said about what to do next.
     */
    preflight(provider, model, env) {
      const key = provider.register?.env_key;
      if (key && !env[key]) {
        const names = [key, ...(provider.register.env_alts || [])].join(', ');
        return `No ${provider.name} API key in the environment, so the request would be rejected as`
          + ` unauthorized. Set one of ${names} and restart Vibe Wrangler.`;
      }
      if (provider.discover && ollamaInstalled.length && !ollamaInstalled.includes(model.upstream)) {
        return `Ollama does not have \`${model.upstream}\` yet, and it has to be downloaded before`
          + ` this task can run — Ollama will not fetch it on demand. Run \`ollama pull`
          + ` ${model.upstream}\` and start the task again, or pick one that is already installed:`
          + ` ${ollamaInstalled.join(', ')}.`;
      }
      return null;
    },
    /**
     * Grok streams a token at a time, so a directive arrives split across events. Holding them
     * until a boundary is what makes `NOTE:` and friends matchable at all, and releasing them at
     * the earliest one is what lets the human watch the run rather than read it afterwards.
     */
    reader() {
      let pending = '';
      let all = '';
      return (evt) => {
        if (evt.type === 'end') {
          // `EndTurn` is the only way a run finishes having said everything it meant to. Anything
          // else — an error, or `Cancelled` from running out of turns — stopped it partway.
          return { done: true, text: all.trim(), failed: Boolean(evt.error) || evt.stopReason !== 'EndTurn' };
        }
        if (evt.type !== 'text' || typeof evt.data !== 'string') return null;
        all += evt.data;
        pending += evt.data;
        const cut = lastBoundary(pending);
        if (!cut) return null;
        const text = pending.slice(0, cut.end);
        pending = pending.slice(cut.rest);
        return text.trim() ? { text } : null;
      };
    },
  },
];

const DEFAULT_HARNESS = 'claude';

const byId = (id) => HARNESSES.find((h) => h.id === id) || null;

/**
 * Falls back rather than throwing, at every level. A setting or a task can name a harness, provider
 * or model that a later version no longer offers, and that should cost the run its choice — not its
 * ability to start.
 */
function resolve(harnessId, providerId, modelId) {
  const harness = byId(harnessId) || byId(DEFAULT_HARNESS);
  const provider = harness.providers.find((p) => p.id === providerId) || harness.providers[0];
  const model = provider.models.find((m) => m.id === modelId) || provider.models[0];
  return { harness, provider, model };
}

/** The shape the browser needs to build its three dependent dropdowns. */
async function catalogue() {
  for (const harness of HARNESSES) {
    for (const provider of harness.providers) {
      if (provider.discover) await provider.discover(provider).catch(() => { /* not running */ });
    }
  }
  return snapshot();
}

const snapshot = () => HARNESSES.map((h) => ({
  id: h.id,
  name: h.name,
  providers: h.providers.map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models.map((m) => ({ id: m.id, name: m.name })),
  })),
}));

module.exports = {
  HARNESSES, DEFAULT_HARNESS, GROK_CONFIG, DIRECTIVE_BOUNDARY, byId, resolve, catalogue, snapshot,
};
