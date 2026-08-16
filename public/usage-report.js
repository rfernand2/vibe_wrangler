'use strict';

function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 1 : 2).replace(/\.00$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

function formatUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  const v = Number(n);
  if (v === 0) return '$0';
  if (Math.abs(v) < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}

function harnessLabel(harness) {
  if (harness === 'claude') return 'Claude Code';
  if (harness === 'codex') return 'OpenAI Codex';
  if (harness === 'grok') return 'Grok Build';
  return harness || 'Unknown';
}

function modelLabel(row) {
  return row.model || 'unknown';
}

function usageTable(pack) {
  const table = document.createElement('table');
  table.className = 'usage-table';
  table.innerHTML = `<thead><tr>
    <th>Model</th><th>Harness</th><th>Tasks</th><th>In</th><th>Cached</th><th>Out</th><th>Cost</th>
  </tr></thead><tbody></tbody><tfoot></tfoot>`;
  const body = table.querySelector('tbody');
  for (const row of pack.models) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(modelLabel(row))}</td>
      <td>${escapeHtml(harnessLabel(row.harness))}</td>
      <td>${row.tasks}</td>
      <td>${formatTokens(row.input_tokens)}</td>
      <td>${formatTokens(row.cached_tokens)}</td>
      <td>${formatTokens(row.output_tokens)}</td>
      <td>${formatUsd(row.cost_usd)}</td>`;
    body.appendChild(tr);
  }
  const t = pack.totals;
  table.querySelector('tfoot').innerHTML = `<tr>
    <td>Total</td>
    <td></td>
    <td>${t.tasks}</td>
    <td>${formatTokens(t.input_tokens)}</td>
    <td>${formatTokens(t.cached_tokens)}</td>
    <td>${formatTokens(t.output_tokens)}</td>
    <td>${formatUsd(t.cost_usd)}</td>
  </tr>`;
  return table;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderUsageReport(report, root, tab) {
  const pack = report[tab] || { models: [], totals: { tasks: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_usd: 0 } };
  root.replaceChildren();
  if (!pack.models.length) {
    const empty = document.createElement('div');
    empty.className = 'empty chart-empty';
    empty.textContent = tab === 'api'
      ? 'No metered API usage yet. Grok native, OpenRouter, and Ollama runs show up here.'
      : 'No subscription usage yet. New runs, and any old logs that recorded tokens, appear here.';
    root.appendChild(empty);
    return;
  }
  root.appendChild(usageTable(pack));
}

if (typeof module !== 'undefined') {
  module.exports = { formatTokens, formatUsd, modelLabel, harnessLabel, renderUsageReport };
}
