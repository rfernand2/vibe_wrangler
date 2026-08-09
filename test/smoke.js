'use strict';

/* End-to-end API smoke test. Runs against a throwaway database on a spare port. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm_tasks-test-'));
process.env.LLM_TASKS_DB = path.join(tmp, 'test.db');
process.env.LLM_TASKS_LOGS = path.join(tmp, 'logs');
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
  assert.match(index.body, /llm_tasks/);
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
    title: 'First task', description: 'do the thing',
  })).body;
  assert.equal(t1.status, 'ready', 'defaults to ready');
  ok('creates a task defaulting to ready');

  const t2 = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'Parked task', status: 'blocked',
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
