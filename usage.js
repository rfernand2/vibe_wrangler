'use strict';

/**
 * Token usage for the Usage report. The three CLIs already emit counts (and, for Claude and Grok,
 * a dollar figure). This module reads those events, stores one row per model per run, and prices
 * Codex from the published API list when the CLI does not name a dollar amount.
 *
 * Subscription rows use the same numbers the API would have charged — a simulated cost, because
 * the native CLIs ride a flat login. API rows are the metered providers (OpenRouter today).
 */

const fs = require('node:fs');
const path = require('node:path');

/** USD per 1M tokens. Short-context list prices, August 2026. Used only when the CLI omits a cost. */
const PRICES = {
  'gpt-5.6-sol': { in: 5, cached: 0.5, out: 30 },
  'gpt-5.6-terra': { in: 2, cached: 0.2, out: 12 },
  'gpt-5.6-luna': { in: 0.2, cached: 0.02, out: 1.2 },
};

function channelFor(provider, harness) {
  if (provider === 'openrouter' || provider === 'ollama') return 'api';
  // Grok Build's native path is the xAI API key, not a flat login.
  if (harness === 'grok') return 'api';
  return 'subscription';
}

function priceKey(model) {
  const id = String(model || '');
  if (PRICES[id]) return id;
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return PRICES[bare] ? bare : id;
}

function inferProvider(provider, model) {
  if (provider && provider !== 'native') return provider;
  const id = String(model || '');
  if (id.includes(':')) return 'ollama';
  if (id.includes('/')) return 'openrouter';
  return provider || 'native';
}

function isTerminal(evt) {
  const t = evt && evt.type;
  return t === 'result' || t === 'end' || t === 'turn.completed' || t === 'turn.failed';
}

function estimateCost(model, input, cached, output) {
  const p = PRICES[priceKey(model)];
  if (!p) return null;
  return (input / 1e6) * p.in + (cached / 1e6) * p.cached + (output / 1e6) * p.out;
}

function num(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function fromUsageBlob(u) {
  if (!u || typeof u !== 'object') return null;
  const cached = num(
    u.cache_read_input_tokens, u.cacheReadInputTokens, u.cached_input_tokens, u.cachedInputTokens,
  ) + num(u.cache_creation_input_tokens, u.cacheCreationInputTokens);
  let input = num(u.input_tokens, u.inputTokens);
  // OpenAI reports input inclusive of the cached slice. Claude and Grok report it exclusive.
  if (u.cached_input_tokens != null || u.cachedInputTokens != null) {
    input = Math.max(0, input - cached);
  }
  const output = num(u.output_tokens, u.outputTokens)
    + num(u.reasoning_tokens, u.reasoning_output_tokens, u.reasoningOutputTokens);
  if (!input && !cached && !output) return null;
  return { input, cached, output };
}

function fromModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return [];
  const rows = [];
  for (const [id, u] of Object.entries(modelUsage)) {
    const blob = fromUsageBlob(u);
    if (!blob) continue;
    const cost = Number(u.costUSD ?? u.cost_usd);
    rows.push({
      model: u.canonicalModel || id,
      ...blob,
      costUsd: Number.isFinite(cost) ? cost : null,
      costSource: Number.isFinite(cost) ? 'cli' : 'estimate',
    });
  }
  return rows;
}

/**
 * Pull usage out of one CLI event. Terminal events (Claude `result`, Grok `end`, Codex
 * `turn.completed`) are the ones that carry a run total. Returns null when the event has none.
 */
function parseEvent(evt) {
  if (!evt || typeof evt !== 'object' || !isTerminal(evt)) return null;
  const fromModels = fromModelUsage(evt.modelUsage);
  if (fromModels.length) {
    return { harness: detectHarness(evt), models: fromModels };
  }
  const blob = fromUsageBlob(evt.usage || evt.message?.usage);
  if (!blob) return null;
  const cost = Number(evt.total_cost_usd ?? evt.usage?.total_cost_usd);
  return {
    harness: detectHarness(evt),
    models: [{
      model: null,
      ...blob,
      costUsd: Number.isFinite(cost) ? cost : null,
      costSource: Number.isFinite(cost) ? 'cli' : 'estimate',
    }],
  };
}

function detectHarness(evt) {
  if (!evt) return null;
  if (evt.type === 'result' || evt.modelUsage && evt.usage && evt.subtype) return 'claude';
  if (evt.type === 'end' || evt.stopReason) return 'grok';
  if (evt.type === 'turn.completed' || evt.type === 'turn.failed') return 'codex';
  return null;
}

/** Walk a transcript and keep the last terminal usage (the run total). */
function parseLog(text) {
  let found = null;
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let evt;
    try { evt = JSON.parse(s); } catch { continue; }
    const parsed = parseEvent(evt);
    if (parsed) found = parsed;
  }
  return found;
}

function finishRow(row, { model, harness, provider }) {
  const id = row.model || model || 'unknown';
  provider = inferProvider(provider, id);
  let costUsd = row.costUsd;
  let costSource = row.costSource;
  if (costUsd == null) {
    costUsd = estimateCost(id, row.input, row.cached, row.output);
    costSource = costUsd == null ? null : 'estimate';
  }
  if (provider === 'ollama') {
    costUsd = 0;
    costSource = 'cli';
  }
  return {
    model: id,
    harness: harness || null,
    provider: provider || 'native',
    channel: channelFor(provider || 'native', harness),
    input: row.input,
    cached: row.cached,
    output: row.output,
    costUsd,
    costSource,
  };
}

function taskIdFromLogName(name) {
  const m = String(name).match(/^task-(\d+)-/);
  return m ? Number(m[1]) : null;
}

/**
 * Import any log that is not already in the table. Safe to call on every boot: existing
 * (log_file, model) pairs are left alone.
 */
function backfill({ logDir, tasks, record, has }) {
  if (!logDir || !fs.existsSync(logDir)) return { scanned: 0, imported: 0 };
  let scanned = 0;
  let imported = 0;
  for (const name of fs.readdirSync(logDir)) {
    if (!name.endsWith('.log') || name.endsWith('.prompt.txt')) continue;
    scanned++;
    const taskId = taskIdFromLogName(name);
    const task = taskId ? tasks.get(taskId) : null;
    let parsed;
    try { parsed = parseLog(fs.readFileSync(path.join(logDir, name), 'utf8')); } catch { continue; }
    if (!parsed) continue;
    const harness = parsed.harness || task?.last_harness || task?.harness || null;
    const provider = task?.last_provider || task?.provider || 'native';
    const fallbackModel = task?.last_model || task?.model || null;
    for (const raw of parsed.models) {
      const row = finishRow(raw, { model: fallbackModel, harness, provider });
      if (has && has(name, row.model)) continue;
      record({
        run_id: null,
        task_id: taskId,
        log_file: name,
        harness: row.harness,
        provider: row.provider,
        model: row.model,
        channel: row.channel,
        input_tokens: row.input,
        cached_tokens: row.cached,
        output_tokens: row.output,
        cost_usd: row.costUsd,
        cost_source: row.costSource,
      });
      imported++;
    }
  }
  return { scanned, imported };
}

module.exports = {
  PRICES, channelFor, estimateCost, parseEvent, parseLog, detectHarness,
  finishRow, taskIdFromLogName, backfill, fromUsageBlob, inferProvider, priceKey, isTerminal,
};
