'use strict';

/**
 * The agent is the model — "Grok 4.6" — not the harness that launched it, so the row needs all
 * three ids to name one. The board names the agent that produced a finished run, but a ready task
 * names the agent that would run next; keeping that choice independent of the DOM makes the subtle
 * retry case testable. A task's own choice is taken whole, never mixed with the default: a task set
 * to Grok must not borrow Claude's model just because it never picked one of its own.
 */
function taskAgent(task, defaults) {
  if (task.last_harness && ['active', 'completed', 'failed'].includes(task.status)) {
    return { harness: task.last_harness, provider: task.last_provider, model: task.last_model };
  }
  if (task.harness) return { harness: task.harness, provider: task.provider, model: task.model };
  return { harness: defaults.harness, provider: defaults.provider, model: defaults.model };
}

/**
 * What to call the agent behind a choice that may be half made. A task can name a harness without
 * naming a provider or a model, and what it would run then is the first of each — the same fallback
 * the runner makes — so the row names that rather than leaving a blank where the agent should be.
 * A model the catalogue no longer offers keeps its stored id: a name we cannot look up still says
 * more about the run than the harness that launched it.
 */
function agentName(harnesses, { harness, provider, model }) {
  const h = harnesses.find((x) => x.id === harness);
  const p = h?.providers.find((x) => x.id === provider) || h?.providers[0];
  const m = model ? p?.models.find((x) => x.id === model) : p?.models[0];
  return m?.name || model || h?.name || harness || '';
}

if (typeof module !== 'undefined') module.exports = { taskAgent, agentName };
