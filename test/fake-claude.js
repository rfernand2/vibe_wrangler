'use strict';

/* Stands in for the Claude CLI in tests: same stream-json contract, scripted edits. */

const fs = require('node:fs');
const path = require('node:path');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  try { run(); } catch (e) { process.stderr.write(String(e.message)); process.exit(1); }
});

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function note(text) { emit({ type: 'assistant', message: { content: [{ type: 'text', text: `NOTE: ${text}` }] } }); }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

/** Keeps both sides of every conflict hunk — the behaviour we ask the real agent for. */
function resolve(text) {
  const out = [];
  let side = null;
  const ours = [];
  const theirs = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) { side = 'ours'; ours.length = 0; theirs.length = 0; continue; }
    if (line.startsWith('=======') && side === 'ours') { side = 'theirs'; continue; }
    if (line.startsWith('>>>>>>>')) { out.push(...ours, ...theirs); side = null; continue; }
    if (side === 'ours') ours.push(line);
    else if (side === 'theirs') theirs.push(line);
    else out.push(line);
  }
  return out.join('\n');
}

function run() {
  if (process.env.FAKE_CLAUDE_FAIL === '1') {
    process.stderr.write('fake claude was told to fail\n');
    process.exit(2);
  }

  emit({ type: 'system', subtype: 'init' });

  if (/resolving a git merge conflict/.test(prompt)) {
    let fixed = 0;
    for (const file of walk(process.cwd())) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (!text.includes('<<<<<<<')) continue;
      fs.writeFileSync(file, resolve(text));
      fixed++;
    }
    note(`Reconciled ${fixed} overlapping file(s), keeping both sets of edits.`);
    emit({ type: 'result', result: 'Resolved the conflict.' });
    return;
  }

  let edits = 0;
  for (const line of prompt.split(/\r?\n/)) {
    const m = /^FAKE_APPEND\s+([^|]+)\|(.*)$/.exec(line.trim());
    if (!m) continue;
    const file = path.join(process.cwd(), m[1].trim());
    fs.appendFileSync(file, m[2] + '\n');
    edits++;
  }
  note(`Applied ${edits} change(s).`);
  emit({ type: 'result', result: `Done, ${edits} change(s).` });
}
