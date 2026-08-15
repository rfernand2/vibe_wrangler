const fs = require('fs');

function patch(file, fn) {
  let s = fs.readFileSync(file, 'utf8');
  const crlf = s.includes('\r\n');
  s = s.replace(/\r\n/g, '\n');
  const next = fn(s);
  if (next === s) console.log('NO CHANGE', file);
  else {
    fs.writeFileSync(file, crlf ? next.replace(/\n/g, '\r\n') : next);
    console.log('patched', file);
  }
}

patch('C:/github/vibe_wrangler/harnesses.js', (s) => {
  const old = `      if (!provider?.register) {
        // Native xAI: force the Grok subscription login. An inherited API key would bill per token.
        delete env.XAI_API_KEY;
        delete env.GROK_API_KEY;
        delete env.XAI_API_TOKEN;
        return;
      }`;
  const neu = `      if (!provider?.register) {
        // Native Grok on this machine is the xAI API key. The CLI only knows config
        // aliases without it, so grok-4.6 becomes "unknown model id".
        return;
      }`;
  if (!s.includes(old)) throw new Error('harnesses env block missing');
  return s.replace(old, neu);
});

patch('C:/github/vibe_wrangler/usage.js', (s) => {
  const oldCh = `function channelFor(provider) {
  if (provider === 'openrouter' || provider === 'ollama') return 'api';
  return 'subscription';
}`;
  const newCh = `function channelFor(provider, harness) {
  if (provider === 'openrouter' || provider === 'ollama') return 'api';
  // Grok Build's native path is the xAI API key, not a flat login.
  if (harness === 'grok') return 'api';
  return 'subscription';
}`;
  if (!s.includes(oldCh)) throw new Error('channelFor missing');
  s = s.replace(oldCh, newCh);
  const oldCall = 'channel: channelFor(provider || \'native\'),';
  const newCall = 'channel: channelFor(provider || \'native\', harness),';
  if (!s.includes(oldCall)) throw new Error('channelFor call missing');
  return s.replace(oldCall, newCall);
});

patch('C:/github/vibe_wrangler/public/usage-report.js', (s) => {
  const oldLabel = `function modelLabel(row) {
  const name = row.model || 'unknown';
  if (!row.harness && !row.provider) return name;
  const bits = [row.harness, row.provider && row.provider !== 'native' ? row.provider : null]
    .filter(Boolean);
  return bits.length ? name + ' · ' + bits.join(' / ') : name;
}`;
  // file may have mojibake for the middle dot
  const start = s.indexOf('function modelLabel');
  const end = s.indexOf('function usageTable');
  if (start < 0 || end < 0) throw new Error('modelLabel/usageTable not found');
  const neu = `function providerLabel(provider) {
  if (!provider || provider === 'native') return 'Native';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'ollama') return 'Ollama';
  return provider;
}

function modelLabel(row) {
  return row.model || 'unknown';
}

`;
  s = s.slice(0, start) + neu + s.slice(end);
  s = s.replace(
    '<th>Model</th><th>Tasks</th><th>In</th><th>Cached</th><th>Out</th><th>Cost</th>',
    '<th>Model</th><th>Provider</th><th>Tasks</th><th>In</th><th>Cached</th><th>Out</th><th>Cost</th>'
  );
  s = s.replace(
    '    tr.innerHTML = `<td>${escapeHtml(modelLabel(row))}</td>\n      <td>${row.tasks}</td>',
    '    tr.innerHTML = `<td>${escapeHtml(modelLabel(row))}</td>\n      <td>${escapeHtml(providerLabel(row.provider))}</td>\n      <td>${row.tasks}</td>'
  );
  s = s.replace(
    '    <td>Total</td>\n    <td>${t.tasks}</td>',
    '    <td>Total</td>\n    <td></td>\n    <td>${t.tasks}</td>'
  );
  s = s.replace(
    "      ? 'No metered API usage yet. OpenRouter runs will show up here.'",
    "      ? 'No metered API usage yet. Grok native, OpenRouter, and Ollama runs show up here.'"
  );
  s = s.replace(
    '  module.exports = { formatTokens, formatUsd, modelLabel, renderUsageReport };',
    '  module.exports = { formatTokens, formatUsd, modelLabel, providerLabel, renderUsageReport };'
  );
  return s;
});

patch('C:/github/vibe_wrangler/test/smoke.js', (s) => {
  s = s.replace(
    `  assert.equal(orRow.channel, 'api');\n  assert.ok(orRow.costUsd > 0);`,
    `  assert.equal(orRow.channel, 'api');\n  assert.ok(orRow.costUsd > 0);\n  const grokNative = usageMod.finishRow({ model: 'grok-4.6', input: 10, cached: 0, output: 2, costUsd: 0.01, costSource: 'cli' }, { harness: 'grok', provider: 'native' });\n  assert.equal(grokNative.channel, 'api');`
  );
  const oldT = `  const grokSub = harnesses.resolve('grok', 'native', 'grok-4.6');
  const grokEnv = { XAI_API_KEY: 'xai', GROK_API_KEY: 'g', PATH: '/bin' };
  grokSub.harness.env(grokEnv, grokSub.provider);
  assert.equal(grokEnv.XAI_API_KEY, undefined);
  assert.equal(grokEnv.GROK_API_KEY, undefined);
  const orKeep = { OPENROUTER_API_KEY: 'or', XAI_API_KEY: 'xai' };
  or.harness.env(orKeep, or.provider);
  assert.equal(orKeep.OPENROUTER_API_KEY, 'or', 'OpenRouter still uses its own key');
  ok('native Claude, Codex and Grok strip API keys so the subscription login is used');`;
  const newT = `  const grokSub = harnesses.resolve('grok', 'native', 'grok-4.6');
  const grokEnv = { XAI_API_KEY: 'xai', GROK_API_KEY: 'g', PATH: '/bin' };
  grokSub.harness.env(grokEnv, grokSub.provider);
  assert.equal(grokEnv.XAI_API_KEY, 'xai', 'native Grok still needs the xAI API key');
  const orKeep = { OPENROUTER_API_KEY: 'or', XAI_API_KEY: 'xai' };
  or.harness.env(orKeep, or.provider);
  assert.equal(orKeep.OPENROUTER_API_KEY, 'or', 'OpenRouter still uses its own key');
  ok('native Claude and Codex strip API keys so the subscription login is used');`;
  if (!s.includes(oldT)) throw new Error('smoke grok strip block missing');
  return s.replace(oldT, newT);
});

patch('C:/github/vibe_wrangler/README.md', (s) => {
  return s.replace(
    'there is no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `XAI_API_KEY` to manage and no',
    'there is no `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to manage and no'
  );
});
