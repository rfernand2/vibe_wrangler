'use strict';

/**
 * A harness is a CLI that takes a prompt on stdin and streams JSON events back. Everything that
 * differs between them lives here — how it is launched, what it needs stripped from the environment,
 * and how one of its events maps onto the only two things the runner cares about: assistant text,
 * and the end of the run. agent.js never has to know which harness it is driving.
 */

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';

const HARNESSES = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: CLAUDE_BIN,
    // First in the list is what the harness falls back to when no model has been chosen.
    models: [
      { id: 'claude-opus-5', name: 'Opus 5' },
      { id: 'claude-fable-5', name: 'Fable 5' },
      { id: 'claude-sonnet-5', name: 'Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
    ],
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
    read(evt) {
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
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: CODEX_BIN,
    models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
    ],
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
    read(evt) {
      // Unlike Claude, the terminal event carries no text — the last message is the summary.
      if (evt.type === 'turn.completed') return { done: true, failed: false };
      if (evt.type === 'turn.failed') return { done: true, failed: true };
      if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
        return evt.item.text ? { text: evt.item.text } : null;
      }
      return null;
    },
  },
];

const DEFAULT_HARNESS = 'claude';

const byId = (id) => HARNESSES.find((h) => h.id === id) || null;

/**
 * Falls back rather than throwing. A setting or a task can name a harness or model that a later
 * version no longer offers, and that should cost the run its choice — not its ability to start.
 */
function resolve(harnessId, modelId) {
  const harness = byId(harnessId) || byId(DEFAULT_HARNESS);
  const model = harness.models.some((m) => m.id === modelId) ? modelId : harness.models[0].id;
  return { harness, model };
}

/** The shape the browser needs to build its two dependent dropdowns. */
const catalogue = () => HARNESSES.map((h) => ({ id: h.id, name: h.name, models: h.models }));

module.exports = { HARNESSES, DEFAULT_HARNESS, byId, resolve, catalogue };
