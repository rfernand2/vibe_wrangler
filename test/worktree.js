'use strict';

/* Concurrency test: two agents on one repo at once, driven by a scripted stand-in CLI. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe_wrangler-wt-'));
process.env.VIBE_WRANGLER_DB = path.join(tmp, 'test.db');
process.env.VIBE_WRANGLER_LOGS = path.join(tmp, 'logs');
process.env.VIBE_WRANGLER_WORKTREES = path.join(tmp, 'worktrees');
process.env.CLAUDE_BIN = makeFakeCli();
// Long enough that a normal run always closes first, short enough to keep the suite quick.
process.env.AGENT_EXIT_GRACE_MS = '1500';

const { projects, tasks, comments } = require('../db');
const agent = require('../agent');
const git = require('../git');

let passed = 0;
const ok = (label) => { passed++; console.log(`  ok  ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The runner only ever passes fixed flags, so the stand-in needs a wrapper script. */
function makeFakeCli() {
  const target = path.join(__dirname, 'fake-claude.js');
  if (process.platform === 'win32') {
    const cmd = path.join(tmp, 'fake-claude.cmd');
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(tmp, 'fake-claude.sh');
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

function run(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.error?.message}`);
  return r.stdout.trim();
}

function makeRepo(name, files) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  run(dir, 'init', '--quiet', '--initial-branch=main');
  run(dir, 'config', 'user.name', 'test');
  run(dir, 'config', 'user.email', 'test@localhost');
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  run(dir, 'add', '-A');
  run(dir, 'commit', '--quiet', '-m', 'initial');
  return dir;
}

async function settle(ids, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (ids.every((id) => ['completed', 'failed', 'ready'].includes(tasks.get(id).status))) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for tasks ${ids.join(', ')}`);
}

const bodies = (id) => comments.listForTask(id).map((c) => c.body).join('\n');
/** core.autocrlf rewrites line endings on checkout, which is noise for these assertions. */
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');

async function main() {
  // --- two tasks, separate files: both should land on main ---
  const repo = makeRepo('repo', { 'a.txt': 'base\n', 'b.txt': 'base\n' });
  const p1 = projects.create({ name: 'Repo', directory: repo });
  const t1 = tasks.create({ project_id: p1.id, title: 'Task A', description: 'FAKE_APPEND a.txt|from A' });
  const t2 = tasks.create({ project_id: p1.id, title: 'Task B', description: 'FAKE_APPEND b.txt|from B' });

  agent.runTask(t1.id);
  agent.runTask(t2.id);
  assert.equal(tasks.get(t1.id).status, 'active');
  assert.equal(tasks.get(t2.id).status, 'active');
  ok('two tasks in one repo both go active at once');

  assert.ok(fs.existsSync(path.join(process.env.VIBE_WRANGLER_WORKTREES, `p${p1.id}-task-${t1.id}`)));
  assert.ok(fs.existsSync(path.join(process.env.VIBE_WRANGLER_WORKTREES, `p${p1.id}-task-${t2.id}`)));
  ok('each task gets its own worktree');

  assert.ok(tasks.get(t1.id).started_at);
  assert.equal(tasks.get(t1.id).finished_at, null);
  ok('the clock starts when a task goes active');

  assert.equal(read(repo, 'a.txt'), 'base\n');
  ok('the main checkout is untouched while agents work');

  await settle([t1.id, t2.id]);
  assert.equal(tasks.get(t1.id).status, 'completed');
  assert.equal(tasks.get(t2.id).status, 'completed');
  ok('both tasks complete');

  assert.equal(read(repo, 'a.txt'), 'base\nfrom A\n');
  assert.equal(read(repo, 'b.txt'), 'base\nfrom B\n');
  ok('both sets of changes are merged into the main checkout');

  assert.equal(run(repo, 'status', '--porcelain'), '');
  ok('the main checkout is left clean');

  assert.ok(!git.branchExists(repo, `llm-task/${t1.id}`));
  assert.ok(!fs.existsSync(path.join(process.env.VIBE_WRANGLER_WORKTREES, `p${p1.id}-task-${t1.id}`)));
  ok('worktrees and task branches are cleaned up');

  assert.match(bodies(t1.id), /merged into main/);
  ok('the thread says where the work landed');

  const list1 = tasks.get(t1.id).checklist;
  assert.deepEqual(list1.map((i) => i.text), ['Read the code', 'Make the change', 'Check it works']);
  assert.deepEqual(list1.map((i) => i.done), [true, true, false]);
  ok('PLAN lines build a checklist and DONE ticks the matching item off');

  assert.equal(/PLAN:|DONE:/.test(bodies(t1.id)), false);
  assert.match(bodies(t1.id), /Read it top to bottom\./);
  ok('a directive glued onto a sentence still counts, and leaves the sentence behind');

  const timed = tasks.get(t1.id);
  assert.ok(timed.started_at && timed.finished_at);
  assert.ok(new Date(timed.finished_at + 'Z') >= new Date(timed.started_at + 'Z'));
  ok('a completed run records when it started and finished');

  // --- two tasks editing the same file: the loser must resolve, not clobber ---
  const repo2 = makeRepo('repo2', { 'shared.txt': 'base\n' });
  const p2 = projects.create({ name: 'Repo2', directory: repo2 });
  const t3 = tasks.create({ project_id: p2.id, title: 'Task C', description: 'FAKE_APPEND shared.txt|from C' });
  const t4 = tasks.create({ project_id: p2.id, title: 'Task D', description: 'FAKE_APPEND shared.txt|from D' });

  agent.runTask(t3.id);
  agent.runTask(t4.id);
  await settle([t3.id, t4.id]);

  assert.equal(tasks.get(t3.id).status, 'completed');
  assert.equal(tasks.get(t4.id).status, 'completed');
  ok('both tasks complete despite touching the same file');

  const shared = read(repo2, 'shared.txt');
  assert.match(shared, /from C/);
  assert.match(shared, /from D/);
  ok('neither change is lost in the conflict');

  assert.equal(run(repo2, 'status', '--porcelain'), '');
  assert.ok(!shared.includes('<<<<<<<'));
  ok('no conflict markers reach the main checkout');

  const loser = /overlap/.test(bodies(t3.id)) ? t3.id : t4.id;
  assert.match(bodies(loser), /Asking the agent to reconcile/);
  ok('the conflict is reported in plain language');

  // --- a plain directory has nowhere to isolate, so tasks queue ---
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'c.txt'), 'base\n');
  const p3 = projects.create({ name: 'Plain', directory: plain });
  const t5 = tasks.create({ project_id: p3.id, title: 'Task E', description: 'FAKE_APPEND c.txt|from E' });
  const t6 = tasks.create({ project_id: p3.id, title: 'Task F', description: 'FAKE_APPEND c.txt|from F' });

  agent.runTask(t5.id);
  agent.runTask(t6.id);
  assert.equal(tasks.get(t5.id).status, 'active');
  assert.equal(tasks.get(t6.id).status, 'ready');
  assert.match(bodies(t6.id), /Queued/);
  ok('a non-git project runs one task at a time');

  await settle([t5.id]);
  await sleep(200);
  await settle([t6.id]);
  assert.equal(tasks.get(t6.id).status, 'completed');
  ok('the queued task starts once the first finishes');

  assert.equal(read(plain, 'c.txt'), 'base\nfrom E\nfrom F\n');
  ok('serialized tasks both applied their changes');

  // --- a failing run must not leave a worktree or a half-merge behind ---
  process.env.FAKE_CLAUDE_FAIL = '1';
  const t7 = tasks.create({ project_id: p1.id, title: 'Task G', description: 'FAKE_APPEND a.txt|from G' });
  agent.runTask(t7.id);
  await settle([t7.id]);
  delete process.env.FAKE_CLAUDE_FAIL;

  assert.equal(tasks.get(t7.id).status, 'failed');
  assert.equal(run(repo, 'status', '--porcelain'), '');
  assert.equal(read(repo, 'a.txt'), 'base\nfrom A\n');
  ok('a failed run leaves the main checkout untouched');

  // --- an agent that plans and stops is handed its own plan back rather than failing ---
  const t7b = tasks.create({
    project_id: p1.id, title: 'Task G2', description: 'FAKE_PLAN_ONLY\nFAKE_APPEND g2.txt|from G2',
  });
  agent.runTask(t7b.id);
  await settle([t7b.id]);
  assert.equal(tasks.get(t7b.id).status, 'completed', 'the second attempt did the work');
  assert.match(bodies(t7b.id), /Handing its plan back/);
  assert.match(read(repo, 'g2.txt'), /from G2/);
  ok('an agent that answers with a plan is asked again with that plan in hand');

  // --- a CLI that dies without explaining itself leaves only what it was saying at the time ---
  const t7e = tasks.create({ project_id: p1.id, title: 'Task G5', description: 'FAKE_SILENT_DIE' });
  agent.runTask(t7e.id);
  await settle([t7e.id]);
  assert.equal(tasks.get(t7e.id).status, 'failed');
  assert.match(bodies(t7e.id), /exit code 1[\s\S]*last thing it said was: "Let me check the CSS/);
  ok('a silent crash is reported with what the agent was in the middle of');

  // --- but a second silent stop is a real failure, not a loop ---
  const t7c = tasks.create({ project_id: p1.id, title: 'Task G3', description: 'FAKE_PLAN_ALWAYS' });
  agent.runTask(t7c.id);
  await settle([t7c.id]);
  assert.equal(tasks.get(t7c.id).status, 'failed', 'a run that never started is not a completed task');
  assert.match(bodies(t7c.id), /answered with a plan twice/);
  assert.ok(tasks.get(t7c.id).checklist.length, 'the plan it did emit is kept');
  ok('an agent that plans twice and works neither time fails');

  // --- a whole transcript handed back should not bury the summary under narration ---
  const t7d = tasks.create({ project_id: p1.id, title: 'Task G4', description: 'FAKE_TRANSCRIPT' });
  agent.runTask(t7d.id);
  await settle([t7d.id]);
  assert.equal(tasks.get(t7d.id).status, 'completed');
  const summary = comments.listForTask(t7d.id).filter((c) => c.author === 'agent').pop().body;
  assert.equal(summary, '### Summary\nAll good.');
  ok('the summary is what follows the last directive, not the whole run');

  // --- retrying a failed task must not destroy work its branch is still holding ---
  const t8 = tasks.create({ project_id: p1.id, title: 'Task H', description: 'FAKE_APPEND a.txt|from H' });
  const held = `llm-task/${t8.id}`;
  run(repo, 'branch', held);
  const wt = path.join(tmp, 'held-wt');
  run(repo, 'worktree', 'add', '--quiet', wt, held);
  fs.writeFileSync(path.join(wt, 'rescue.txt'), 'work the failed attempt saved\n');
  run(wt, 'add', '-A');
  run(wt, 'commit', '--quiet', '-m', 'rescued');
  run(repo, 'worktree', 'remove', '--force', wt);
  const rescued = run(repo, 'rev-parse', held);

  agent.runTask(t8.id);
  await settle([t8.id]);

  assert.equal(tasks.get(t8.id).status, 'completed');
  assert.equal(run(repo, 'rev-parse', held), rescued, 'the branch holding saved work is untouched');
  ok('a retry steps aside rather than deleting a branch with unmerged work');

  assert.equal(read(repo, 'a.txt'), 'base\nfrom A\nfrom H\n');
  ok('the retry still merges its own change back');

  // --- an agent that reports its result but leaves a process holding the pipe must not hang ---
  const t9 = tasks.create({
    project_id: p1.id,
    title: 'Task I',
    description: 'FAKE_APPEND a.txt|from I\nFAKE_LINGER',
  });
  agent.runTask(t9.id);
  await settle([t9.id]);

  assert.equal(tasks.get(t9.id).status, 'completed');
  ok('a finished run is not held open by a lingering background process');

  assert.equal(read(repo, 'a.txt'), 'base\nfrom A\nfrom H\nfrom I\n');
  assert.equal(run(repo, 'status', '--porcelain'), '');
  ok('the lingering run still merges its work back');

  console.log(`\n${passed} checks passed`);
}

main().then(
  () => process.exit(0),
  (err) => { console.error('\nFAILED:', err); process.exit(1); },
);
