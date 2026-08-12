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
        register: { base_url: 'https://openrouter.ai/api/v1', env_key: 'OPENROUTER_API_KEY' },
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
        register: { base_url: 'http://localhost:11434/v1', api_key: 'ollama' },
        models: [
          { id: 'ollama-qwen3-coder', name: 'Qwen3 Coder', upstream: 'qwen3-coder' },
          { id: 'ollama-qwen2-5-coder', name: 'Qwen2.5 Coder', upstream: 'qwen2.5-coder' },
          { id: 'ollama-devstral', name: 'Devstral', upstream: 'devstral' },
          { id: 'ollama-gpt-oss', name: 'GPT-OSS', upstream: 'gpt-oss' },
          { id: 'ollama-deepseek-coder-v2', name: 'DeepSeek Coder V2', upstream: 'deepseek-coder-v2' },
          { id: 'ollama-muse-glimmer', name: 'Muse Glimmer', upstream: 'muse-glimmer' },
        ],
      },
    ],
    prepare: ensureGrokAlias,
    args: (model, promptPath) => [
      '--prompt-file', promptPath,
      '--output-format', 'streaming-json',
      '--permission-mode', 'bypassPermissions',
      '--model', model,
    ],
    env() {},
    /**
     * Grok streams a token at a time, so a directive arrives split across events. Buffering to
     * whole lines is what makes `NOTE:` and friends matchable at all.
     */
    reader() {
      let pending = '';
      let all = '';
      return (evt) => {
        if (evt.type === 'end') {
          return { done: true, text: all.trim(), failed: Boolean(evt.error) || evt.stopReason === 'Error' };
        }
        if (evt.type !== 'text' || typeof evt.data !== 'string') return null;
        all += evt.data;
        pending += evt.data;
        if (!pending.includes('\n')) return null;
        const lines = pending.split('\n');
        pending = lines.pop();
        return { text: lines.join('\n') };
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
const catalogue = () => HARNESSES.map((h) => ({
  id: h.id,
  name: h.name,
  providers: h.providers.map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models.map((m) => ({ id: m.id, name: m.name })),
  })),
}));

module.exports = { HARNESSES, DEFAULT_HARNESS, GROK_CONFIG, byId, resolve, catalogue };
