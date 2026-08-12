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
function say(text) { emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } }); }
function note(text) { say(`NOTE: ${text}`); }

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

  // A follow-up on a finished task: plain prose back, no directives, and nothing written anywhere.
  const asked = /## The message to answer\n([\s\S]*)$/.exec(prompt);
  if (asked) {
    const question = asked[1].trim();
    say('Let me look at what the run left behind.');
    emit({ type: 'result', result: `You asked: ${question}\nNothing has changed since the run finished.` });
    return;
  }

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

  // An agent that answers with its plan and ends the turn: nothing done, nothing said. Handing the
  // plan back is what gets FAKE_PLAN_ONLY moving; FAKE_PLAN_ALWAYS never starts however it is asked.
  const resumed = prompt.includes('You have already broken this task down');
  if (prompt.includes('FAKE_PLAN_ALWAYS') || (prompt.includes('FAKE_PLAN_ONLY') && !resumed)) {
    say('PLAN: Read the code\nPLAN: Make the change');
    emit({ type: 'result', result: 'PLAN: Read the code' });
    return;
  }

  // A harness whose terminal event carries the whole run back, not just the closing message.
  if (prompt.includes('FAKE_TRANSCRIPT')) {
    fs.writeFileSync(path.join(process.cwd(), 'transcript.txt'), 'done\n');
    say('PLAN: Only step');
    note('Did the thing.');
    say('DONE: Only step');
    emit({
      type: 'result',
      result: 'I will start by reading things.\nNOTE: Did the thing.\nDONE: Only step\n\n'
        + '### Summary\nAll good.',
    });
    return;
  }

  say('PLAN: Read the code\nPLAN: Make the change\nPLAN: Check it works');
  say('DONE: read the CODE');
  // Real agents run one directive onto the end of another often enough to matter.
  say('NOTE: Read it top to bottom.DONE: make the CHANGE');

  const slow = /^FAKE_SLEEP\s+(\d+)$/m.exec(prompt);
  if (slow) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(slow[1]));

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

  if (prompt.includes('FAKE_LINGER')) {
    // A background process left holding the stdout pipe, so the runner never sees 'close'.
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'],
      { stdio: ['ignore', 'inherit', 'inherit'] });
    setTimeout(() => {}, 60000);
  }
}
