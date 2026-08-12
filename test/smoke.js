'use strict';

/* End-to-end API smoke test. Runs against a throwaway database on a spare port. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe_wrangler-test-'));
process.env.VIBE_WRANGLER_DB = path.join(tmp, 'test.db');
process.env.VIBE_WRANGLER_LOGS = path.join(tmp, 'logs');
process.env.VIBE_WRANGLER_ATTACHMENTS = path.join(tmp, 'attachments');
process.env.PORT = '38111';
process.env.CLAUDE_BIN = 'definitely-not-a-real-binary';
process.env.GROK_BIN = 'definitely-not-a-real-binary';
// So writing a Grok model alias in a test never touches the real ~/.grok/config.toml.
process.env.GROK_CONFIG = path.join(tmp, 'grok.toml');

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

  assert.equal(t1.number, 1);
  assert.equal(t2.number, 2);
  ok('numbers tasks within their project');

  // Touching the older task must not float it to the top — the number is what orders the board.
  await call('PUT', `/api/tasks/${t1.id}`, { title: 'First task' });
  assert.deepEqual(
    (await call('GET', `/api/projects/${proj.id}/tasks`)).body.map((t) => t.number),
    [2, 1]
  );
  ok('lists tasks newest number first');

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
  assert.equal(t3.number, 1, 'each project counts from one');
  ok('creates a tagged task in a second project');

  const gap = (await call('POST', `/api/projects/${other.id}/tasks`, { title: 'Doomed' })).body;
  assert.equal(gap.number, 2);
  await call('DELETE', `/api/tasks/${gap.id}`);
  const afterGap = (await call('POST', `/api/projects/${other.id}/tasks`, { title: 'Next' })).body;
  assert.equal(afterGap.number, 3, 'a deleted number is retired, not handed out again');
  await call('DELETE', `/api/tasks/${afterGap.id}`);
  ok('numbers are never reused');

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

  // --- quick tags: the set offered on a task's right-click menu ---
  const quick = (await call('GET', '/api/quick-tags')).body;
  assert.deepEqual(quick, { builtin: ['needs review', 'reviewed', 'verified'], custom: [] });
  ok('offers the three review tags out of the box');

  const added = (await call('POST', '/api/quick-tags', { tag: '  Needs  Rework ' })).body;
  assert.equal(added.tag, 'needs rework', 'the tag comes back normalized');
  assert.deepEqual(added.custom, ['needs rework']);
  ok('a custom tag joins the set, normalized like any other tag');

  await call('POST', '/api/quick-tags', { tag: 'needs rework' });
  await call('POST', '/api/quick-tags', { tag: 'VERIFIED' });
  const again = (await call('GET', '/api/quick-tags')).body;
  assert.deepEqual(again.custom, ['needs rework'], 'no duplicates, and builtins are not re-added');
  ok('adding a tag twice is harmless');

  assert.equal((await call('POST', '/api/quick-tags', { tag: '   ' })).status, 400);
  ok('rejects an empty custom tag');

  await call('PUT', `/api/tasks/${t1.id}`, { tags: ['needs rework'] });
  await call('PUT', `/api/tasks/${t1.id}`, { tags: [] });
  assert.deepEqual((await call('GET', '/api/quick-tags')).body.custom, ['needs rework'],
    'the menu keeps a tag no task carries any more');
  ok('a custom tag outlives the tasks that used it');

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
  assert.ok(afterRun.comments.some((c) => /Claude Code CLI/i.test(c.body)), 'explains the spawn failure');
  assert.ok(afterRun.log_file, 'records a log file');
  ok('a missing harness CLI fails the task with a readable message');

  const log = await call('GET', `/api/tasks/${t1.id}/log`);
  assert.equal(log.status, 200);
  assert.match(log.body, /Reporting protocol/, 'log contains the prompt that was sent');
  ok('exposes the raw transcript');

  // A harness that is set up before it starts, and reads its prompt from a file, takes a different
  // path through the spawn than Claude Code does — one no other test walks.
  const viaFile = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'File prompt', harness: 'grok', model: 'grok-4.5',
  })).body;
  await call('POST', `/api/tasks/${viaFile.id}/run`);
  for (let i = 0; i < 40 && (await call('GET', `/api/tasks/${viaFile.id}`)).body.status === 'active'; i++) {
    await sleep(100);
  }
  const fileRun = (await call('GET', `/api/tasks/${viaFile.id}`)).body;
  assert.equal(fileRun.status, 'failed', 'a harness that cannot start fails rather than sitting active');
  assert.ok(fileRun.comments.some((c) => /Grok Build CLI/i.test(c.body)), 'explains the spawn failure');
  assert.match(
    fs.readFileSync(path.join(process.env.VIBE_WRANGLER_LOGS, `${fileRun.log_file}.prompt.txt`), 'utf8'),
    /Reporting protocol/, 'the prompt is written beside the log');
  ok('a file-prompt harness is prepared, given its prompt, and fails cleanly');

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

  // --- harnesses and settings ---
  const harnesses = require('../harnesses');
  const config = (await call('GET', '/api/config')).body;
  assert.ok(config.version, 'reports its version');
  assert.deepEqual(config.harnesses.map((h) => h.id), ['claude', 'codex', 'grok']);
  assert.ok(config.harnesses[0].providers[0].models.length, 'each provider offers models');
  const grokCat = config.harnesses.find((h) => h.id === 'grok');
  assert.deepEqual(grokCat.providers.map((p) => p.id), ['native', 'openrouter', 'ollama']);
  ok('publishes the harness catalogue, models grouped under their provider');

  // These are the event shapes each CLI actually emits; the directives are read out of them.
  const claude = harnesses.byId('claude').reader();
  assert.deepEqual(
    claude({ type: 'assistant', message: { content: [{ type: 'text', text: 'NOTE: hi' }] } }),
    { text: 'NOTE: hi' });
  assert.deepEqual(
    claude({ type: 'result', subtype: 'success', result: 'all done' }),
    { done: true, text: 'all done', failed: false });
  assert.equal(claude({ type: 'system' }), null);

  const codex = harnesses.byId('codex').reader();
  assert.deepEqual(
    codex({ type: 'item.completed', item: { type: 'agent_message', text: 'NOTE: hi' } }),
    { text: 'NOTE: hi' });
  assert.deepEqual(codex({ type: 'turn.completed', usage: {} }), { done: true, failed: false });
  assert.deepEqual(codex({ type: 'turn.failed', error: {} }), { done: true, failed: true });
  assert.equal(codex({ type: 'item.completed', item: { type: 'reasoning' } }), null);
  ok('each harness reads its own event stream');

  // Grok streams a token at a time, so a directive only becomes matchable once buffered to a line.
  const grokRead = harnesses.byId('grok').reader();
  assert.equal(grokRead({ type: 'thought', data: 'hmm' }), null);
  assert.equal(grokRead({ type: 'text', data: 'NO' }), null);
  assert.equal(grokRead({ type: 'text', data: 'TE: hi' }), null);
  assert.deepEqual(grokRead({ type: 'text', data: '\nand more' }), { text: 'NOTE: hi' });
  assert.deepEqual(grokRead({ type: 'end', stopReason: 'EndTurn' }),
    { done: true, text: 'NOTE: hi\nand more', failed: false });
  assert.ok(harnesses.byId('grok').reader()({ type: 'end', stopReason: 'Error' }).failed);
  // Running out of turns ends the run partway and reports it as cancelled, not as an error.
  assert.ok(harnesses.byId('grok').reader()({ type: 'end', stopReason: 'Cancelled' }).failed);
  ok('a token-streamed transcript is buffered into whole lines');

  // A model that never presses return still narrates, and the human should see it as it happens.
  const glued = harnesses.byId('grok').reader();
  assert.equal(glued({ type: 'text', data: 'NOTE: first thing.' }), null);
  assert.deepEqual(glued({ type: 'text', data: 'NOTE: second' }), { text: 'NOTE: first thing.' });
  assert.deepEqual(glued({ type: 'text', data: ' thing.NOTE: third' }), { text: 'NOTE: second thing.' });
  ok('a directive glued onto the last one is released instead of waiting for a newline');

  // Single-turn is the CLI's default for a prompt file, and one turn is only ever a plan.
  assert.ok(harnesses.byId('grok').args('grok-4.5', 'p.txt').includes('--max-turns'),
    'the Grok CLI is given room for more than one turn');
  ok('a harness that defaults to one turn is told to keep going');

  // Reaching a non-xAI endpoint means an alias has to exist in Grok's own config before it starts.
  const { harness: gh, provider: gp, model: gm } = harnesses.resolve('grok', 'ollama', 'ollama-devstral');
  gh.prepare(gp, gm);
  const toml = fs.readFileSync(process.env.GROK_CONFIG, 'utf8');
  assert.match(toml, /\[model\.ollama-devstral\]/);
  assert.match(toml, /model = "devstral"/);
  assert.match(toml, /base_url = "http:\/\/localhost:11434\/v1"/);
  gh.prepare(gp, gm);
  assert.equal(toml, fs.readFileSync(process.env.GROK_CONFIG, 'utf8'), 'writes the alias only once');
  const xai = harnesses.resolve('grok', 'native', 'grok-4.5');
  gh.prepare(xai.provider, xai.model);
  assert.equal(toml, fs.readFileSync(process.env.GROK_CONFIG, 'utf8'), 'a native model needs no alias');
  ok('registers a third-party model with the Grok CLI, without clobbering the config');

  // The alias names one variable, and a key kept under another spelling has to reach it or the far
  // end answers 401 with nothing to say about why.
  const or = harnesses.resolve('grok', 'openrouter', 'openrouter-deepseek-v4-flash');
  const bridged = { OPEN_ROUTER_KEY: ' sk-or-test ' };
  or.harness.env(bridged, or.provider);
  assert.equal(bridged.OPENROUTER_API_KEY, 'sk-or-test');
  const already = { OPENROUTER_API_KEY: 'mine', OPENROUTER_KEY: 'other' };
  or.harness.env(already, or.provider);
  assert.equal(already.OPENROUTER_API_KEY, 'mine', 'a key already under the right name is left alone');
  const none = {};
  or.harness.env(none, or.provider);
  assert.deepEqual(none, {}, 'invents nothing when no key is set anywhere');
  ok('an OpenRouter key set under any of its spellings reaches the name the alias asks for');

  assert.deepEqual((await call('GET', '/api/settings')).body,
    { harness: 'claude', provider: 'native', model: 'claude-opus-5' });
  ok('defaults to the first model of the first harness');

  assert.equal((await call('PUT', '/api/settings', { harness: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { harness: 'codex', model: 'claude-opus-5' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { harness: 'claude', provider: 'ollama' })).status, 400);
  ok('rejects a harness, provider, or model that does not exist');

  const defaults = (await call('PUT', '/api/settings', { harness: 'codex', model: 'gpt-5.6-terra' })).body;
  assert.deepEqual(defaults, { harness: 'codex', provider: 'native', model: 'gpt-5.6-terra' });
  assert.deepEqual((await call('GET', '/api/settings')).body, defaults);
  ok('remembers the default harness, provider, and model');

  const { tasks: taskStore } = require('../db');
  const { forTask } = require('../agent');
  const resolved = (id) => {
    const r = forTask(taskStore.get(id));
    return { harness: r.harness.id, provider: r.provider.id, model: r.model.id };
  };

  const inherits = (await call('POST', `/api/projects/${proj.id}/tasks`, { title: 'Inherits' })).body;
  assert.equal(inherits.harness, null);
  assert.deepEqual(resolved(inherits.id), defaults, 'a task with no choice follows the default');

  const pinned = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'Pinned', harness: 'claude', model: 'claude-haiku-4-5-20251001',
  })).body;
  assert.deepEqual(resolved(pinned.id),
    { harness: 'claude', provider: 'native', model: 'claude-haiku-4-5-20251001' });

  // Naming only a harness must take that harness's own first model, not the default set for Codex.
  const halfPinned = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'Half pinned', harness: 'claude',
  })).body;
  assert.deepEqual(resolved(halfPinned.id),
    { harness: 'claude', provider: 'native', model: 'claude-opus-5' });
  ok('a task can override the harness, the model, or both');

  const viaOllama = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'Local', harness: 'grok', provider: 'ollama', model: 'ollama-qwen3-coder',
  })).body;
  assert.deepEqual(resolved(viaOllama.id),
    { harness: 'grok', provider: 'ollama', model: 'ollama-qwen3-coder' });
  ok('a task can name the provider its model comes from');

  // Pinning only the model is what the dialog sends when you change nothing but the model, so it has
  // to be checked against the default harness rather than rejected as belonging to nothing.
  const modelOnly = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'Model only', model: 'gpt-5.6-luna',
  })).body;
  assert.equal(modelOnly.harness, null);
  assert.deepEqual(resolved(modelOnly.id),
    { harness: 'codex', provider: 'native', model: 'gpt-5.6-luna' });
  ok('a task can pin the model alone and still follow the default harness');

  assert.equal((await call('POST', `/api/projects/${proj.id}/tasks`,
    { title: 'Bad', model: 'claude-opus-5' })).status, 400);
  assert.equal((await call('POST', `/api/projects/${proj.id}/tasks`,
    { title: 'Bad', harness: 'codex', model: 'claude-opus-5' })).status, 400);
  assert.equal((await call('POST', `/api/projects/${proj.id}/tasks`,
    { title: 'Bad', harness: 'grok', provider: 'ollama', model: 'grok-4.5' })).status, 400);
  ok('rejects a task naming a model its harness or provider does not offer');

  await call('PUT', `/api/tasks/${pinned.id}`, { harness: '', provider: '', model: '' });
  assert.deepEqual(resolved(pinned.id), defaults, 'clearing the override returns it to the default');
  await call('PUT', `/api/tasks/${pinned.id}`, { title: 'Pinned again' });
  assert.equal(taskStore.get(pinned.id).harness, null, 'an unrelated edit leaves the choice alone');
  ok('a task can be handed back to the default');

  await call('PUT', '/api/settings', { harness: 'claude', model: 'claude-opus-5' });

  // --- deletes cascade ---
  assert.equal((await call('DELETE', `/api/tasks/${t2.id}`)).status, 200);
  assert.equal((await call('GET', `/api/tasks/${t2.id}`)).status, 404);
  ok('deletes a task');

  await call('DELETE', `/api/projects/${proj.id}`);
  assert.equal((await call('GET', `/api/tasks/${t1.id}`)).status, 404, 'tasks are cascade-deleted');
  ok('deleting a project removes its tasks');

  // --- attachments ---
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const upload = await fetch(`${base}/api/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('my shot (1).png') },
    body: png,
  });
  const saved = await upload.json();
  assert.equal(upload.status, 201);
  assert.match(saved.url, /^\/attachments\/[0-9a-f]{12}-my_shot_1_\.png$/);
  assert.equal(saved.name, 'my shot (1).png');
  ok('stores an upload under a sanitised, collision-proof name');

  const fetched = await fetch(base + saved.url);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png);
  ok('serves an attachment back byte for byte, with sniffing turned off');

  assert.equal((await call('GET', '/attachments/..%2Fdb.js')).status, 404);
  assert.equal((await call('GET', '/attachments/nope.png')).status, 404);
  ok('rejects traversal and unknown attachments');

  assert.equal((await fetch(`${base}/api/attachments`, { method: 'POST' })).status, 400);
  ok('rejects an empty upload');

  const attachments = require('../attachments');
  assert.match(attachments.toLocalPaths(`before ![shot](${saved.url}) after`),
    /^before shot \(local file: .+my_shot_1_\.png\) after$/);
  assert.equal(attachments.toLocalPaths('![gone](/attachments/nope.png)'),
    '![gone](/attachments/nope.png)', 'a reference that no longer resolves is left as written');
  ok('rewrites attachment references to local paths for the agent');

  assert.equal((await call('GET', '/api/nope')).status, 404);
  ok('unknown endpoints 404');

  console.log(`\n${passed} checks passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('\nFAILED:', err); process.exit(1); });
