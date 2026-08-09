'use strict';

/* End-to-end API smoke test. Runs against a throwaway database on a spare port. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe_wrangler-test-'));
process.env.VIBE_WRANGLER_DB = path.join(tmp, 'test.db');
process.env.VIBE_WRANGLER_LOGS = path.join(tmp, 'logs');
process.env.PORT = '38111';
process.env.CLAUDE_BIN = 'definitely-not-a-real-binary';

const server = require('../server');
const base = `http://localhost:${process.env.PORT}`;

let passed = 0;
function ok(label) { passed++; console.log(`  ok  ${label}`); }

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => server.listening ? r() : server.once('listening', r));

  // --- static ---
  const index = await call('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.body, /Vibe Wrangler/);
  ok('serves the front end');

  assert.equal((await call('GET', '/../db.js')).status, 404);
  ok('rejects path traversal on static files');

  // --- projects ---
  assert.deepEqual((await call('GET', '/api/projects')).body, []);
  ok('starts with no projects');

  const bad = await call('POST', '/api/projects', { name: '  ' });
  assert.equal(bad.status, 400);
  ok('rejects a project with no name');

  const workdir = path.join(tmp, 'work');
  fs.mkdirSync(workdir);
  const proj = (await call('POST', '/api/projects', {
    name: 'Demo', description: 'demo project', directory: workdir,
  })).body;
  assert.ok(proj.id > 0);
  ok('creates a project');

  const renamed = (await call('PUT', `/api/projects/${proj.id}`, { name: 'Demo 2' })).body;
  assert.equal(renamed.name, 'Demo 2');
  assert.equal(renamed.directory, workdir, 'unspecified fields are preserved');
  ok('updates a project');

  // --- tasks ---
  assert.equal((await call('POST', `/api/projects/${proj.id}/tasks`, { title: '' })).status, 400);
  ok('rejects a task with no title');

  const t1 = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'First task', description: 'do the thing', tags: ' Backend , bug ,backend,',
  })).body;
  assert.equal(t1.status, 'ready', 'defaults to ready');
  assert.deepEqual(t1.tags, ['backend', 'bug'], 'tags are normalized and de-duplicated');
  ok('creates a task defaulting to ready, with normalized tags');

  const t2 = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'Parked task', status: 'blocked', tags: ['bug'],
  })).body;
  ok('creates a task with a user-defined status');

  const counts = (await call('GET', '/api/projects')).body[0];
  assert.equal(counts.task_count, 2);
  assert.equal(counts.ready_count, 1);
  ok('project rollup counts are right');

  const readyOnly = (await call('GET', `/api/projects/${proj.id}/tasks?status=ready`)).body;
  assert.equal(readyOnly.length, 1);
  assert.equal(readyOnly[0].id, t1.id);
  ok('filters tasks by status');

  const statuses = (await call('GET', '/api/statuses')).body;
  assert.deepEqual(statuses.builtin, ['ready', 'active', 'completed']);
  assert.deepEqual(statuses.custom, ['blocked']);
  ok('reports user-defined statuses');

  // --- tags across projects ---
  const other = (await call('POST', '/api/projects', { name: 'Other', directory: workdir })).body;
  const t3 = (await call('POST', `/api/projects/${other.id}/tasks`, {
    title: 'Task in another project', tags: 'bug, ui',
  })).body;
  ok('creates a tagged task in a second project');

  const tags = (await call('GET', '/api/tags')).body;
  assert.deepEqual(tags, [
    { tag: 'backend', count: 1 },
    { tag: 'bug', count: 3 },
    { tag: 'ui', count: 1 },
  ]);
  ok('lists every tag with its usage count');

  const allTasks = (await call('GET', '/api/tasks')).body;
  assert.equal(allTasks.length, 3);
  assert.ok(allTasks.every((t) => t.project_name), 'each task names its project');
  ok('lists tasks across all projects');

  const bugTasks = (await call('GET', '/api/tasks?tag=bug')).body;
  assert.deepEqual(bugTasks.map((t) => t.id).sort(), [t1.id, t2.id, t3.id].sort());
  ok('filters tasks by tag across all projects');

  const uiTasks = (await call('GET', '/api/tasks?tag=UI')).body;
  assert.deepEqual(uiTasks.map((t) => t.id), [t3.id], 'tag lookup is case-insensitive');
  ok('tag filtering ignores case');

  const readyBugs = (await call('GET', '/api/tasks?tag=bug&status=ready')).body;
  assert.deepEqual(readyBugs.map((t) => t.id).sort(), [t1.id, t3.id].sort());
  ok('combines tag and status filters');

  const scoped = (await call('GET', `/api/projects/${proj.id}/tasks?tag=bug`)).body;
  assert.equal(scoped.length, 2, 'tag filter also works inside a project');
  ok('filters by tag within a single project');

  const retagged = (await call('PUT', `/api/tasks/${t1.id}`, { tags: 'backend' })).body;
  assert.deepEqual(retagged.tags, ['backend']);
  assert.equal((await call('GET', '/api/tags')).body.find((x) => x.tag === 'bug').count, 2);
  ok('replaces tags on update');

  assert.deepEqual((await call('PUT', `/api/tasks/${t1.id}`, { title: 'First task' })).body.tags,
    ['backend'], 'omitting tags leaves them alone');
  ok('an update without tags preserves them');

  await call('DELETE', `/api/tasks/${t3.id}`);
  assert.ok(!(await call('GET', '/api/tags')).body.some((x) => x.tag === 'ui'),
    'tags disappear with their task');
  ok('deleting a task clears its tags');

  await call('DELETE', `/api/projects/${other.id}`);

  // --- comments ---
  await call('POST', `/api/tasks/${t1.id}/comments`, { body: 'looks good to me' });
  await call('POST', `/api/tasks/${t1.id}/comments`, { author: 'agent', body: 'started looking' });
  assert.equal((await call('POST', `/api/tasks/${t1.id}/comments`, { body: '   ' })).status, 400);
  const detail = (await call('GET', `/api/tasks/${t1.id}`)).body;
  assert.equal(detail.comments.length, 2);
  assert.equal(detail.comments[0].author, 'user');
  assert.equal(detail.comments[1].author, 'agent');
  ok('adds multiple comments from user and agent');

  await call('DELETE', `/api/comments/${detail.comments[0].id}`);
  assert.equal((await call('GET', `/api/tasks/${t1.id}`)).body.comments.length, 1);
  ok('deletes a comment');

  // --- agent: missing directory is reported, not crashed on ---
  const noDir = (await call('POST', '/api/projects', { name: 'Nowhere', directory: '' })).body;
  const orphan = (await call('POST', `/api/projects/${noDir.id}/tasks`, { title: 'nope' })).body;
  await call('POST', `/api/tasks/${orphan.id}/run`);
  const orphanDetail = (await call('GET', `/api/tasks/${orphan.id}`)).body;
  assert.equal(orphanDetail.status, 'failed');
  assert.match(orphanDetail.comments.at(-1).body, /directory/i);
  ok('refuses to run a task whose project directory is missing');

  // --- agent: a broken CLI fails the task instead of hanging ---
  await call('POST', `/api/tasks/${t1.id}/run`);
  for (let i = 0; i < 40 && (await call('GET', `/api/tasks/${t1.id}`)).body.status === 'active'; i++) {
    await sleep(100);
  }
  const afterRun = (await call('GET', `/api/tasks/${t1.id}`)).body;
  assert.equal(afterRun.status, 'failed');
  assert.ok(afterRun.comments.some((c) => /Claude CLI/i.test(c.body)), 'explains the spawn failure');
  assert.ok(afterRun.log_file, 'records a log file');
  ok('a missing Claude CLI fails the task with a readable message');

  const log = await call('GET', `/api/tasks/${t1.id}/log`);
  assert.equal(log.status, 200);
  assert.match(log.body, /Reporting protocol/, 'log contains the prompt that was sent');
  ok('exposes the raw transcript');

  // --- run-ready only picks up ready tasks ---
  await call('PUT', `/api/tasks/${t1.id}`, { status: 'ready' });
  const startedResp = (await call('POST', `/api/projects/${proj.id}/run-ready`)).body;
  assert.deepEqual(startedResp.started, [t1.id], 'skips the blocked task');
  ok('run-ready ignores user-defined statuses');

  // --- a task left active by a killed server is recovered on the next start ---
  const stale = (await call('POST', `/api/projects/${proj.id}/tasks`, { title: 'Interrupted' })).body;
  await call('PUT', `/api/tasks/${stale.id}`, { status: 'active' });
  require('../agent').adoptOrphans();
  const recovered = (await call('GET', `/api/tasks/${stale.id}`)).body;
  assert.equal(recovered.status, 'ready');
  assert.match(recovered.comments.at(-1).body, /restarted/i);
  ok('resets tasks left active by a previous run');

  // --- failed tasks can be retried in bulk ---
  const retryProj = (await call('POST', '/api/projects', { name: 'Retries', directory: tmp })).body;
  const bust = (await call('POST', `/api/projects/${retryProj.id}/tasks`, { title: 'Broke' })).body;
  const spare = (await call('POST', `/api/projects/${retryProj.id}/tasks`, { title: 'Fine' })).body;
  await call('PUT', `/api/tasks/${bust.id}`, { status: 'failed' });
  await call('PUT', `/api/tasks/${spare.id}`, { status: 'blocked' });
  const retried = (await call('POST', `/api/projects/${retryProj.id}/run-failed`)).body;
  assert.deepEqual(retried.started, [bust.id], 'only the failed task is retried');
  ok('run-failed retries failed tasks');

  // --- the agent registry is queryable and rejects unknown runs ---
  assert.ok(Array.isArray((await call('GET', '/api/agents')).body));
  assert.equal((await call('POST', '/api/agents/99999/stop')).status, 409);
  ok('lists agents and refuses to stop a run it does not know');

  // --- an agent left running by a previous instance of the app is picked back up ---
  const { runs, db } = require('../db');
  const agentMod = require('../agent');
  const proc = require('../proc');

  const orphanTask = (await call('POST', `/api/projects/${retryProj.id}/tasks`, { title: 'Inherited' })).body;
  const sleeper = require('node:child_process').spawn(
    process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const record = runs.start({ task_id: orphanTask.id, pid: sleeper.pid, image: proc.imageName(sleeper.pid) });
  // A previous instance recorded it, so it must not look like one of ours.
  db.prepare('UPDATE agent_runs SET server_pid = 1 WHERE id = ?').run(record.id);

  assert.equal(agentMod.adoptOrphans().adopted, 1);
  const listed = (await call('GET', '/api/agents')).body.find((x) => x.id === record.id);
  assert.ok(listed && listed.pid === sleeper.pid && listed.mine === false);
  assert.equal((await call('GET', `/api/tasks/${orphanTask.id}`)).body.status, 'active');
  ok('reattaches to an agent inherited from a previous session');

  assert.equal((await call('POST', `/api/agents/${record.id}/stop`)).status, 200);
  for (let i = 0; i < 60 && proc.isAlive(sleeper.pid); i++) await sleep(100);
  assert.ok(!proc.isAlive(sleeper.pid), 'the inherited agent was killed');
  ok('terminates an inherited agent');

  // --- the change stream is what keeps the browser current now that Refresh is gone ---
  const stream = await fetch(`${base}/api/events`);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const frame = async () => {
    const started = Date.now();
    let buf = '';
    while (Date.now() - started < 5000) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      const m = /^data: (.+)$/m.exec(buf);
      if (m) return JSON.parse(m[1]);
    }
    return null;
  };

  const greeting = await frame();
  assert.ok(greeting && typeof greeting.rev === 'number', 'a new connection is greeted immediately');
  ok('the event stream greets every connection so a reconnect resyncs itself');

  const nudge = call('POST', `/api/projects/${retryProj.id}/tasks`, { title: 'Pushed live' });
  const pushed = await frame();
  await nudge;
  assert.ok(pushed && pushed.rev > greeting.rev, 'the write bumped the revision');
  ok('a write is pushed to connected clients');

  await reader.cancel();

  // --- deletes cascade ---
  assert.equal((await call('DELETE', `/api/tasks/${t2.id}`)).status, 200);
  assert.equal((await call('GET', `/api/tasks/${t2.id}`)).status, 404);
  ok('deletes a task');

  await call('DELETE', `/api/projects/${proj.id}`);
  assert.equal((await call('GET', `/api/tasks/${t1.id}`)).status, 404, 'tasks are cascade-deleted');
  ok('deleting a project removes its tasks');

  assert.equal((await call('GET', '/api/nope')).status, 404);
  ok('unknown endpoints 404');

  console.log(`\n${passed} checks passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('\nFAILED:', err); process.exit(1); });
