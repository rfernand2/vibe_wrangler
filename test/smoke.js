'use strict';

/* End-to-end API smoke test. Runs against a throwaway database on a spare port. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { taskAgent, agentName } = require('../public/task-agent');
const { handleCommentKeydown } = require('../public/comment-keys');
const {
  shouldShowDeployBadge, deployButtonState, sidebarDeployButtonState, shouldCloseDeployDialog,
} = require('../public/deploy-ui');
const {
  shouldShowPushBadge, pushBadgeTitle, pushButtonState, sidebarPushButtonState, pushResultMessage,
} = require('../public/push-ui');
const { performanceSeries } = require('../public/performance-chart');
const { harnessLabel } = require('../public/usage-report');
const docLinks = require('../doc-links');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe_wrangler-test-'));
process.env.VIBE_WRANGLER_DB = path.join(tmp, 'test.db');
process.env.VIBE_WRANGLER_LOGS = path.join(tmp, 'logs');
process.env.VIBE_WRANGLER_ATTACHMENTS = path.join(tmp, 'attachments');
process.env.PORT = '38111';
// The board caches each project's git state for a few seconds; these tests want what git says now.
process.env.VIBE_WRANGLER_GIT_TTL_MS = '0';
process.env.CLAUDE_BIN = 'definitely-not-a-real-binary';
process.env.GROK_BIN = 'definitely-not-a-real-binary';
process.env.CURSOR_BIN = 'definitely-not-a-real-binary';
// So writing a Grok model alias in a test never touches the real ~/.grok/config.toml.
process.env.GROK_CONFIG = path.join(tmp, 'grok.toml');
// Which models Ollama offers depends on what the machine has pulled, so it answers for itself here.
process.env.OLLAMA_HOST = 'http://127.0.0.1:38112';

const INSTALLED = ['devstral:latest', 'qwen3-coder:30b'];
const ollama = require('node:http').createServer((req, res) => {
  res.writeHead(req.url === '/api/tags' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ models: INSTALLED.map((name) => ({ name })) }));
}).listen(38112);

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
  assert.match(index.body, /Run local/);
  assert.match(index.body, /Open Local/);
  assert.match(index.body, /Open Prod/);
  assert.match(index.body, /Deploy: 0 pushes/);
  assert.match(index.body, /id="deployProjectBtn"/);
  assert.match(index.body, /id="deployProjectBtn"[^>]*\bdisabled\b/);
  assert.match(index.body, /src="\/push-ui\.js"/);
  assert.match(index.body, /id="pushProjectBtn"[^>]*\bdisabled\b/);
  // Edit, Delete and the deployment buttons all hang off the project "..." menu now.
  assert.match(index.body, /id="projectMenuBtn"/);
  assert.match(index.body, /id="projectMenu"[\s\S]*id="editProjectBtn"[\s\S]*id="deleteProjectBtn"[\s\S]*id="runLocalBtn"[\s\S]*id="openLocalBtn"[\s\S]*id="runProdBtn"[\s\S]*id="pushProjectBtn"[\s\S]*id="deployProjectBtn"/);
  // The app bar is down to the hamburger; Usage, Performance and Agents moved into its menu.
  assert.match(index.body, /<header class="appbar">[\s\S]*?id="menuBtn"[\s\S]*?<\/header>/);
  assert.doesNotMatch(index.body, /<header class="appbar">[\s\S]*?id="usageBtn"[\s\S]*?<\/header>/);
  assert.match(index.body, /id="appMenu"[\s\S]*id="usageMenuBtn"[\s\S]*id="performanceMenuBtn"[\s\S]*id="agentsMenuBtn"[\s\S]*id="settingsMenuBtn"/);
  // The left column lists projects only — the All tasks panel is gone.
  assert.doesNotMatch(index.body, /id="allTasksBtn"/);
  // The task bar: new task, run all ready, a status dropdown, and a "..." menu holding Retry failed.
  assert.match(index.body, /class="toolbar tasks-toolbar"[\s\S]*id="newTaskBtn"[\s\S]*id="runReadyBtn"[\s\S]*id="statusFilter"[\s\S]*id="tasksMenuBtn"/);
  assert.match(index.body, /id="tasksMenu"[\s\S]*id="runFailedBtn"/);
  // Both bars sit in one sticky block, so they hold their place as the task list scrolls.
  assert.match(index.body, /class="pane-sticky"[\s\S]*class="project-head"[\s\S]*class="toolbar tasks-toolbar"/);
  ok('serves the front end');

  const usageScript = (await call('GET', '/usage-report.js')).body;
  assert.match(usageScript, /<th>Model<\/th><th>Harness<\/th>/);
  assert.doesNotMatch(usageScript, /<th>Provider<\/th>/);
  assert.equal(harnessLabel('claude'), 'Claude Code');
  assert.equal(harnessLabel('codex'), 'ChatGPT Codex');
  assert.equal(harnessLabel('grok'), 'Grok Build');
  assert.equal(harnessLabel('custom-cli'), 'custom-cli');
  ok('labels the usage report by harness');

  const appScript = (await call('GET', '/app.js')).body;
  assert.match(index.body, /id="settingsRandomEnabled"/,
    'settings has a separate switch for random harness drawing');
  const settingsSubmit = /\$\('settingsForm'\)\.addEventListener\('submit',[\s\S]*?toast\('Settings saved'\);/.exec(appScript)?.[0] || '';
  assert.match(settingsSubmit, /e\.preventDefault\(\)/,
    'settings stays open until its save request has completed');
  assert.ok(settingsSubmit.indexOf("await api('PUT', '/api/settings'") < settingsSubmit.indexOf("$('settingsDialog').close()"),
    'settings only closes after its save request has completed');
  assert.match(appScript, /textContent = `\$\{h\.name\}: \$\{agentName\(state\.harnesses, \{ harness: h\.id \}\)\}`/,
    'the random-harness checkboxes name the top model after the harness');
  const projectSwitch = /const selectProject = run\(async \(id\) => \{([\s\S]*?)\n\}\);/.exec(appScript)?.[1] || '';
  assert.match(projectSwitch, /renderProjects\(\)/, 'switching immediately redraws the cached selection');
  assert.doesNotMatch(projectSwitch, /loadProjects\(\)/,
    'switching must not wait for repository and listening-port checks');
  assert.match(appScript, /Promise\.all\(\[loadStatuses\(\), loadTags\(\), loadQuickTags\(\)\]\)/,
    'independent switch lookups run concurrently');
  ok('keeps project switching on the fast cached path');

  const saveTask = /\$\('taskForm'\)\.addEventListener\('submit', run\(async \(e\) => \{([\s\S]*?)\n\}\)\);/.exec(appScript)?.[1] || '';
  assert.doesNotMatch(saveTask, /loadProjects\(\)/,
    'saving a task must not wait for repository and listening-port checks');
  const startTaskFn = /async function startTask\(task\) \{([\s\S]*?)\n\}/.exec(appScript)?.[1] || '';
  assert.doesNotMatch(startTaskFn, /loadProjects\(\)/,
    'starting a run must not wait for repository and listening-port checks');
  ok('keeps adding a task and starting a run off the slow project refresh');

  let submitted = 0;
  const form = { requestSubmit() { submitted++; } };
  const key = (overrides = {}) => ({
    key: 'Enter', shiftKey: false, isComposing: false, prevented: false,
    preventDefault() { this.prevented = true; },
    ...overrides,
  });
  const enter = key();
  assert.equal(handleCommentKeydown(enter, form), true);
  assert.equal(enter.prevented, true, 'Return suppresses the textarea newline');
  assert.equal(submitted, 1, 'Return submits the comment form');
  const shiftEnter = key({ shiftKey: true });
  assert.equal(handleCommentKeydown(shiftEnter, form), false);
  assert.equal(shiftEnter.prevented, false, 'Shift-Return keeps the browser newline behavior');
  assert.equal(submitted, 1, 'Shift-Return does not submit the comment form');
  const composingEnter = key({ isComposing: true });
  assert.equal(handleCommentKeydown(composingEnter, form), false);
  assert.equal(submitted, 1, 'confirming composed text does not submit the comment form');
  ok('uses Return to send comments and Shift-Return for new lines');

  const docsDir = path.join(tmp, 'docs-pick');
  fs.mkdirSync(path.join(docsDir, 'reviews'), { recursive: true });
  fs.mkdirSync(path.join(docsDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'reviews', 'report.md'), 'ok');
  fs.writeFileSync(path.join(docsDir, 'docs', 'guide.md'), 'ok');
  fs.writeFileSync(path.join(docsDir, 'server.js'), 'ok');
  fs.writeFileSync(path.join(docsDir, 'a.txt'), 'ok');
  assert.deepEqual(docLinks.mentionedFiles('Please update docs/guide.md and server.js'), ['docs/guide.md']);
  assert.equal(docLinks.wantsDocument('Write a product report'), true);
  assert.equal(docLinks.wantsDocument('Fix the login bug'), false);
  assert.deepEqual(docLinks.selectDocuments({
    brief: 'Write a product report',
    changedFiles: ['reviews/report.md', 'server.js'],
    projectDir: docsDir,
  }), ['reviews/report.md']);
  assert.deepEqual(docLinks.selectDocuments({
    brief: 'Fix the login bug',
    changedFiles: ['server.js', 'a.txt'],
    projectDir: docsDir,
  }), []);
  assert.deepEqual(docLinks.selectDocuments({
    brief: 'Please update docs/guide.md',
    changedFiles: [],
    projectDir: docsDir,
  }), ['docs/guide.md']);
  assert.match(docLinks.commentBody(3, ['reviews/report.md']),
    /You can view the file here: \[reviews\/report\.md\]\(\/api\/projects\/3\/files\?path=reviews%2Freport\.md\)/);
  ok('picks named documents and implicit reports, and leaves ordinary code edits out');

  const DEFAULTS = { harness: 'codex', provider: 'native', model: 'gpt-5.6-sol' };
  const ran = { last_harness: 'claude', last_provider: 'native', last_model: 'claude-opus-5' };
  const chose = { harness: 'grok', provider: 'native', model: 'grok-4.6' };
  assert.deepEqual(taskAgent({ status: 'ready', ...ran }, DEFAULTS), DEFAULTS);
  assert.deepEqual(taskAgent({ status: 'ready', ...chose, ...ran }, DEFAULTS), chose);
  assert.deepEqual(taskAgent({ status: 'active', ...ran }, DEFAULTS),
    { harness: 'claude', provider: 'native', model: 'claude-opus-5' });
  assert.deepEqual(taskAgent({ status: 'completed', ...chose, ...ran }, DEFAULTS),
    { harness: 'claude', provider: 'native', model: 'claude-opus-5' });
  // A task that named only a harness must not borrow the default's model to fill the gap.
  assert.deepEqual(taskAgent({ status: 'ready', harness: 'grok' }, DEFAULTS),
    { harness: 'grok', provider: undefined, model: undefined });
  ok('picks the model whose name is shown beneath each task status');

  // The name on the row is the agent — "Grok 4.6" — never the harness that launched it.
  const cat = require('../harnesses').snapshot();
  assert.equal(agentName(cat, { harness: 'grok', provider: 'native', model: 'grok-4.6' }), 'Grok 4.6');
  assert.equal(agentName(cat, { harness: 'grok' }), 'Grok 4.6');
  assert.equal(agentName(cat, { harness: 'claude', provider: 'native', model: 'claude-opus-5' }), 'Opus 5');
  assert.equal(agentName(cat, taskAgent({ status: 'completed', harness: 'claude' }, DEFAULTS)), 'Opus 5');
  // A model dropped from the catalogue since the run still says more than its harness would.
  assert.equal(agentName(cat, { harness: 'grok', provider: 'native', model: 'grok-3' }), 'grok-3');
  assert.equal(agentName(cat, {}), '');
  ok('names the agent, not the harness that launched it');

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

  const deployment = require('../deploy');
  assert.equal(deployment.looksSuccessful('Visit your newly deployed app at https://x.fly.dev'), true);
  assert.equal(deployment.looksSuccessful('Error: failed to fetch an image'), false);
  ok('a fly warning after a successful release is not treated as a failed deploy');

  let started;
  deployment.start = (project) => {
    started = project;
    return { running: true, output: '==> Verifying app config\n', status: 'running', error: null };
  };
  deployment.snapshot = () => ({ running: false, output: '', status: null, error: null });
  deployment.deploy = async (project) => {
    started = project;
    return { ok: true };
  };

  assert.equal((await call('GET', `/api/projects/${proj.id}`)).body.can_deploy, false);
  const idleDeploy = await call('POST', `/api/projects/${proj.id}/deploy`);
  assert.equal(idleDeploy.status, 400, 'deploy stays off when the folder has no fly.toml');
  assert.equal((await call('GET', `/api/projects/${proj.id}`)).body.needs_deploy, false);

  const flyDir = path.join(tmp, 'fly-app');
  fs.mkdirSync(flyDir);
  fs.writeFileSync(path.join(flyDir, 'fly.toml'), "app = 'demo-app'\n");
  const flyProj = (await call('PUT', `/api/projects/${proj.id}`, { directory: flyDir })).body;
  assert.equal(flyProj.can_deploy, true);

  const { projects: projectStore } = require('../db');
  projectStore.recordMerge(proj.id, 'abc123');
  const waiting = (await call('GET', `/api/projects/${proj.id}`)).body;
  assert.equal(waiting.needs_deploy, true);
  assert.equal(waiting.pending_pushes, 1);
  projectStore.recordMerge(proj.id, 'def456');
  assert.equal((await call('GET', `/api/projects/${proj.id}`)).body.pending_pushes, 2);
  ok('a merge into main that has not been deployed lights the deploy flag');

  const deploymentResult = await call('POST', `/api/projects/${proj.id}/deploy`);
  assert.equal(deploymentResult.status, 202);
  assert.equal(started.id, proj.id);
  assert.equal(started.directory, flyDir);
  assert.equal(deploymentResult.body.running, true);
  assert.match(deploymentResult.body.output, /Verifying app config/);
  assert.equal((await call('POST', '/api/projects/999999/deploy')).status, 404);
  const noDirectory = (await call('POST', '/api/projects', { name: 'No directory' })).body;
  assert.equal((await call('POST', `/api/projects/${noDirectory.id}/deploy`)).status, 400);
  await call('DELETE', `/api/projects/${noDirectory.id}`);
  ok('deploys from the selected project directory');

  projectStore.recordDeploy(proj.id, 'abc123', 1);
  const pushedDuringDeploy = (await call('GET', `/api/projects/${proj.id}`)).body;
  assert.equal(pushedDuringDeploy.needs_deploy, true);
  assert.equal(pushedDuringDeploy.pending_pushes, 1);
  projectStore.recordDeploy(proj.id, 'def456');
  const deployed = (await call('GET', `/api/projects/${proj.id}`)).body;
  assert.equal(deployed.needs_deploy, false);
  assert.equal(deployed.pending_pushes, 0);
  ok('a successful fly deploy clears the deploy flag');

  const deployStatusProject = (await call('POST', '/api/projects', {
    name: 'Deploy status', directory: flyDir,
  })).body;
  assert.equal(deployStatusProject.deployment_needed, 0);
  const shippedChange = (await call('POST', `/api/projects/${deployStatusProject.id}/tasks`, {
    title: 'Shipped change',
  })).body;
  assert.equal((await call('GET', '/api/projects')).body
    .find((project) => project.id === deployStatusProject.id).deployment_needed, 0);
  await call('PUT', `/api/tasks/${shippedChange.id}`, { status: 'completed' });
  let deployStatus = (await call('GET', '/api/projects')).body
    .find((project) => project.id === deployStatusProject.id);
  assert.equal(deployStatus.deployment_needed, 0, 'finishing a task without a merge does not light Deploy');
  projectStore.recordMerge(deployStatusProject.id, 'sha-merge');
  deployStatus = (await call('GET', '/api/projects')).body
    .find((project) => project.id === deployStatusProject.id);
  assert.equal(deployStatus.deployment_needed, 1);
  assert.equal(deployStatus.pending_pushes, 1);
  assert.equal((await call('POST', `/api/projects/${deployStatusProject.id}/deploy`)).status, 202);
  projectStore.recordDeploy(deployStatusProject.id, 'sha-merge');
  projectStore.markDeployed(deployStatusProject.id);
  deployStatus = (await call('GET', '/api/projects')).body
    .find((project) => project.id === deployStatusProject.id);
  assert.equal(deployStatus.deployment_needed, 0);
  assert.equal(deployStatus.pending_pushes, 0);
  await call('DELETE', `/api/projects/${deployStatusProject.id}`);
  await call('PUT', `/api/projects/${proj.id}`, { directory: workdir });
  ok('tracks whether merged work still needs deployment');

  const noFly = { can_deploy: false, pending_pushes: 2, needs_deploy: true, deployment_needed: 1 };
  assert.equal(shouldShowDeployBadge(noFly), false);
  assert.equal(deployButtonState(noFly).disabled, true);
  const due = { can_deploy: true, pending_pushes: 2, needs_deploy: true, deployment_needed: 1 };
  assert.equal(shouldShowDeployBadge(due), true);
  assert.equal(deployButtonState(due).text, 'Deploy: 2 pushes');
  assert.equal(deployButtonState(due).disabled, false);
  const idle = { can_deploy: true, pending_pushes: 0, needs_deploy: false, deployment_needed: 0 };
  assert.equal(shouldShowDeployBadge(idle), false);
  assert.equal(deployButtonState(idle).text, 'Deploy: 0 pushes');
  assert.equal(deployButtonState(idle, { busy: true }).text, 'Deploying…');
  assert.equal(shouldCloseDeployDialog('ok'), true);
  assert.equal(shouldCloseDeployDialog('failed'), false);
  assert.equal(shouldCloseDeployDialog('running'), true);
  ok('hides Deploy without fly.toml and keeps the popup closed unless deploy fails');

  // --- the sidebar column is one button wide, so the count moves into the tooltip ---
  const sidebarDeploy = sidebarDeployButtonState(due);
  assert.equal(sidebarDeploy.text, 'Deploy');
  assert.equal(sidebarDeploy.disabled, false);
  assert.match(sidebarDeploy.title, /2 pushes waiting to be deployed — deploy this project now/);
  assert.match(sidebarDeployButtonState({ can_deploy: true, pending_pushes: 1 }).title, /^1 push waiting/);
  assert.equal(sidebarDeployButtonState(idle).title, 'Deploy this project');
  const busyDeploy = sidebarDeployButtonState(due, { busy: true });
  assert.equal(busyDeploy.text, 'Deploying…');
  assert.equal(busyDeploy.disabled, true, 'a deploy already running cannot be started again');
  ok('the sidebar Deploy button is a verb, with the pending pushes in its tooltip');

  // Only one deploy runs at a time, so every other row's button has to say why it is down rather
  // than look pressable and quietly do nothing.
  const blockedDeploy = sidebarDeployButtonState(due, { blocked: true });
  assert.equal(blockedDeploy.disabled, true, 'a second project cannot deploy alongside the first');
  assert.equal(blockedDeploy.text, 'Deploy');
  assert.equal(blockedDeploy.title, 'Another project is deploying');
  // The project actually deploying still reads as the busy one, not as the blocked one.
  assert.equal(sidebarDeployButtonState(due, { busy: true, blocked: true }).text, 'Deploying…');
  ok('a project cannot be deployed while another deploy is still running');

  const local = require('../local');
  const localDir = path.join(tmp, 'local-app');
  fs.mkdirSync(localDir);
  fs.writeFileSync(path.join(localDir, 'run.bat'), '@echo off\r\nset PORT=38113\r\nnode local-server.js\r\n');
  fs.writeFileSync(path.join(localDir, 'run.sh'), '#!/bin/sh\nPORT=38113\nexport PORT\nexec node local-server.js\n');
  fs.writeFileSync(path.join(localDir, 'local-server.js'),
    "require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT||38113));\n");
  fs.writeFileSync(path.join(localDir, 'fly.toml'), "app = 'demo-app'\nprimary_region = 'sjc'\n");
  assert.equal(local.readPort(localDir), 38113);
  assert.equal(local.readProdUrl(localDir), 'https://demo-app.fly.dev');
  assert.equal(local.readPort(workdir), null);
  assert.equal(local.readProdUrl(workdir), null);
  assert.equal(local.hasFlyConfig(localDir), true);
  assert.equal(local.hasFlyConfig(workdir), false);
  ok('reads the local port and fly URL from the project directory');

  // --- push needed ---
  const gitRun = (cwd, ...args) => {
    const r = require('node:child_process').spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.error?.message}`);
    return r.stdout.trim();
  };
  const gitDir = path.join(tmp, 'git-app');
  fs.mkdirSync(gitDir);
  assert.deepEqual(local.localWork(gitDir), { is_repo: false, has_remote: false, uncommitted: 0, unpushed: 0 });
  gitRun(gitDir, 'init', '--quiet', '--initial-branch=main');
  gitRun(gitDir, 'config', 'user.name', 'test');
  gitRun(gitDir, 'config', 'user.email', 'test@localhost');
  fs.writeFileSync(path.join(gitDir, 'a.txt'), 'one\n');
  assert.equal(local.localWork(gitDir).uncommitted, 1, 'an untracked file counts as uncommitted');
  gitRun(gitDir, 'add', '-A');
  gitRun(gitDir, 'commit', '--quiet', '-m', 'initial');
  // Nothing to push to yet, so a clean repo with no remote is not waiting on anything.
  assert.deepEqual(local.localWork(gitDir), { is_repo: true, has_remote: false, uncommitted: 0, unpushed: 0 });

  const gitRemote = path.join(tmp, 'git-app-remote.git');
  gitRun(gitDir, 'clone', '--bare', '--quiet', gitDir, gitRemote);
  gitRun(gitDir, 'remote', 'add', 'origin', gitRemote);
  gitRun(gitDir, 'push', '-u', '--quiet', 'origin', 'main');
  assert.deepEqual(local.localWork(gitDir), { is_repo: true, has_remote: true, uncommitted: 0, unpushed: 0 });

  fs.writeFileSync(path.join(gitDir, 'a.txt'), 'two\n');
  const dirty = local.localWork(gitDir);
  assert.equal(dirty.uncommitted, 1);
  assert.equal(dirty.unpushed, 0);
  gitRun(gitDir, 'commit', '--quiet', '-am', 'second');
  const ahead = local.localWork(gitDir);
  assert.equal(ahead.uncommitted, 0);
  assert.equal(ahead.unpushed, 1, 'a commit that never reached the remote is still owed');
  gitRun(gitDir, 'push', '--quiet', 'origin', 'main');
  assert.equal(local.localWork(gitDir).unpushed, 0);
  ok('counts uncommitted files and commits that never reached GitHub');

  const gitProj = (await call('POST', '/api/projects', { name: 'Git app', directory: gitDir })).body;
  assert.equal(gitProj.needs_push, false);
  fs.writeFileSync(path.join(gitDir, 'b.txt'), 'new\n');
  const needsPush = (await call('GET', `/api/projects/${gitProj.id}`)).body;
  assert.equal(needsPush.needs_push, true);
  assert.equal(needsPush.uncommitted_changes, 1);
  assert.equal((await call('GET', '/api/projects')).body.find((p) => p.id === gitProj.id).needs_push, true);
  await call('DELETE', `/api/projects/${gitProj.id}`);
  // A project folder that is not a repo at all must never claim work is waiting.
  assert.equal((await call('GET', `/api/projects/${proj.id}`)).body.needs_push, false);
  ok('the project payload says when local work has not been committed or pushed');

  assert.equal(shouldShowPushBadge({ needs_push: false, uncommitted_changes: 0, unpushed_commits: 0 }), false);
  assert.equal(shouldShowPushBadge(null), false);
  assert.equal(shouldShowPushBadge({ needs_push: true, uncommitted_changes: 2, unpushed_commits: 0 }), true);
  assert.equal(shouldShowPushBadge({ unpushed_commits: 3 }), true);
  assert.equal(pushBadgeTitle({ uncommitted_changes: 1, unpushed_commits: 0 }),
    'Push needed — 1 file not committed');
  assert.equal(pushBadgeTitle({ uncommitted_changes: 2, unpushed_commits: 3 }),
    'Push needed — 2 files not committed, 3 commits not pushed to GitHub');
  assert.equal(pushBadgeTitle({ unpushed_commits: 1 }), 'Push needed — 1 commit not pushed to GitHub');
  assert.equal(pushBadgeTitle({ needs_push: true }), 'Push needed');
  ok('the Push needed badge shows only for real local work, and says what is outstanding');

  // --- the badge is a button ---
  assert.equal(pushButtonState(null).disabled, true);
  assert.equal(pushButtonState({ is_repo: true, uncommitted_changes: 0, unpushed_commits: 0 }).text, 'Push');
  assert.equal(pushButtonState({ is_repo: false, uncommitted_changes: 3 }).disabled, true,
    'a folder that is not a repo offers nothing to press');
  const needy = pushButtonState({ is_repo: true, uncommitted_changes: 2, unpushed_commits: 1 });
  assert.equal(needy.disabled, false);
  assert.equal(needy.text, 'Push needed');
  assert.match(needy.title, /2 files not committed, 1 commit not pushed to GitHub — commit and push everything now/);
  const busyPush = pushButtonState({ is_repo: true, uncommitted_changes: 2 }, { busy: true });
  assert.equal(busyPush.disabled, true, 'a push already running cannot be started again');
  assert.equal(busyPush.text, 'Pushing…');
  assert.equal(pushResultMessage({ committed: true, files: 2, pushed: true, commits: 1, remote: 'origin', has_remote: true }),
    'Committed 2 changes, pushed 1 commit to origin');
  assert.equal(pushResultMessage({ pushed: true, commits: 3, remote: 'origin', has_remote: true }),
    'Pushed 3 commits to origin');
  assert.equal(pushResultMessage({ committed: true, files: 1, has_remote: false }),
    'Committed 1 change, no remote to push to');
  assert.equal(pushResultMessage({ has_remote: true }), 'Nothing to commit or push');
  ok('the Push needed button says what it will do, and what it did');

  // --- the sidebar shows this button only when it has work, so its label is just the verb ---
  const sidebarPush = sidebarPushButtonState({ is_repo: true, uncommitted_changes: 2, unpushed_commits: 1 });
  assert.equal(sidebarPush.text, 'Push');
  assert.equal(sidebarPush.disabled, false);
  assert.match(sidebarPush.title, /2 files not committed, 1 commit not pushed to GitHub — commit and push everything now/);
  const sidebarBusy = sidebarPushButtonState({ is_repo: true, uncommitted_changes: 2 }, { busy: true });
  assert.equal(sidebarBusy.text, 'Pushing…');
  assert.equal(sidebarBusy.disabled, true);
  ok('the sidebar Push button is a verb, with what is outstanding in its tooltip');

  const pushProj = (await call('POST', '/api/projects', { name: 'Push app', directory: gitDir })).body;
  assert.equal(pushProj.is_repo, true);
  assert.equal(pushProj.needs_push, true, 'b.txt is still sitting there uncommitted');
  const didPush = await call('POST', `/api/projects/${pushProj.id}/push`);
  assert.equal(didPush.status, 200);
  assert.equal(didPush.body.committed, true);
  assert.equal(didPush.body.pushed, true);
  assert.equal(didPush.body.needs_push, false, 'the badge clears the moment the push lands');
  assert.equal(gitRun(gitDir, 'log', '-1', '--format=%s'), 'push from Vibe Wrangler');
  assert.equal(gitRun(gitRemote, 'log', '-1', '--format=%s'), 'push from Vibe Wrangler',
    'the commit reached the remote, not just the local branch');
  assert.deepEqual(local.localWork(gitDir), { is_repo: true, has_remote: true, uncommitted: 0, unpushed: 0 });
  // Pressing it with nothing outstanding says so rather than failing.
  const againPush = await call('POST', `/api/projects/${pushProj.id}/push`);
  assert.equal(againPush.status, 200);
  assert.equal(againPush.body.committed, false);
  assert.equal(againPush.body.pushed, false);
  await call('DELETE', `/api/projects/${pushProj.id}`);
  assert.equal((await call('POST', '/api/projects/999999/push')).status, 404);
  const notRepo = await call('POST', `/api/projects/${proj.id}/push`);
  assert.equal(notRepo.status, 400);
  assert.match(notRepo.body.error, /not a git repository/);
  const nowhereToPush = (await call('POST', '/api/projects', { name: 'Nowhere' })).body;
  assert.equal((await call('POST', `/api/projects/${nowhereToPush.id}/push`)).status, 400);
  await call('DELETE', `/api/projects/${nowhereToPush.id}`);
  ok('the Push needed button commits everything under one message and pushes it');

  const localProj = (await call('POST', '/api/projects', {
    name: 'Local app', directory: localDir,
  })).body;
  assert.equal(localProj.local_port, 38113);
  assert.equal(localProj.local_running, false);
  assert.equal(localProj.local_url, 'http://localhost:38113');
  assert.equal(localProj.prod_url, 'https://demo-app.fly.dev');
  assert.equal(localProj.can_deploy, true);
  assert.equal((await call('POST', '/api/projects/999999/run-local')).status, 404);
  assert.equal((await call('POST', `/api/projects/${noDirectory?.id || 0}/run-local`)).status, 404);
  const noScript = (await call('POST', '/api/projects', {
    name: 'No script', directory: workdir,
  })).body;
  assert.equal((await call('POST', `/api/projects/${noScript.id}/run-local`)).status, 400);
  await call('DELETE', `/api/projects/${noScript.id}`);

  const startedLocal = await call('POST', `/api/projects/${localProj.id}/run-local`);
  assert.equal(startedLocal.status, 200);
  assert.equal(startedLocal.body.local_running, true);
  assert.equal(startedLocal.body.local_port, 38113);
  const afterStart = (await call('GET', `/api/projects/${localProj.id}`)).body;
  assert.equal(afterStart.local_running, true);
  const stoppedLocal = await call('POST', `/api/projects/${localProj.id}/stop-local`);
  assert.equal(stoppedLocal.status, 200);
  assert.equal(stoppedLocal.body.local_running, false);
  await call('DELETE', `/api/projects/${localProj.id}`);
  ok('starts and stops a local project instance from its run script');

  const selfPort = (await call('GET', `/api/projects/${proj.id}`)).body;
  assert.equal(selfPort.local_running, false, 'this app\'s own port is not treated as a project instance');

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

  // --- user grades and agent performance history ---
  assert.equal((await call('PUT', `/api/tasks/${t2.id}`, { grade: 'A' })).status, 409,
    'an agent cannot be rated before it has run');
  assert.equal((await call('PUT', `/api/tasks/${t1.id}`, { grade: 'excellent' })).status, 400);
  const gradedClaude = (await call('PUT', `/api/tasks/${t1.id}`, { grade: 'b+' })).body;
  assert.equal(gradedClaude.grade, 'B+');
  assert.equal(gradedClaude.graded_model, 'claude-opus-5');
  assert.ok(gradedClaude.graded_at);
  const gradedGrok = (await call('PUT', `/api/tasks/${viaFile.id}`, { grade: 'A+' })).body;
  assert.equal(gradedGrok.grade, 'A+');

  const performance = (await call('GET', '/api/performance')).body;
  assert.deepEqual(performance.map((point) => point.grade), ['B+', 'A+']);
  assert.deepEqual(performance.map((point) => point.model), ['claude-opus-5', 'grok-4.5']);
  assert.ok(performance.every((point) => point.graded_at && point.task_title && point.project_name));
  ok('stores validated task grades with the actual model and publishes chart history');

  // Graded at noon local time, so the day a run belongs to is the same in every time zone.
  const gradedAt = (dayOffset) => {
    const at = new Date();
    at.setHours(12, 0, 0, 0);
    at.setDate(at.getDate() + dayOffset);
    return at.toISOString().replace('T', ' ').slice(0, 19);
  };
  const graded = (dayOffset, grade, model) => ({
    graded_at: gradedAt(dayOffset), grade, model,
    project_name: 'Demo', task_number: 1, task_title: 'A task',
  });

  const daily = performanceSeries([
    graded(0, 'B', 'model-a'), graded(0, 'A+', 'model-a'), graded(2, 'C', 'model-a'),
    graded(1, 'A', 'model-b'),
  ]);
  assert.equal(daily.bucket, 'day');
  assert.equal(daily.periods.length, 3, 'the unused middle day still takes up its place');
  const modelA = daily.series.find((s) => s.label === 'model-a');
  assert.deepEqual(modelA.points.map((p) => [p.period, p.grade, p.count]),
    [[0, 'A-', 2], [2, 'C', 1]], 'two runs in a day average into one point');
  assert.equal(modelA.segments.length, 2, 'a day the model sat out breaks its line');
  assert.deepEqual(daily.series.find((s) => s.label === 'model-b').points.map((p) => p.period), [1]);

  const weekly = performanceSeries([
    graded(0, 'B', 'model-a'), graded(30, 'A', 'model-a'), graded(60, 'C', 'model-a'),
  ]);
  assert.equal(weekly.bucket, 'week', 'more than 50 days of history averages by week');
  assert.equal(weekly.periods.length, 9);
  assert.deepEqual(weekly.series[0].points.map((p) => p.period), [0, 4, 8]);
  assert.equal(weekly.series[0].segments.length, 3, 'every skipped week breaks the line');

  assert.deepEqual(performanceSeries([
    { graded_at: null, grade: 'A', model: 'model-a' },
    { graded_at: gradedAt(0), grade: 'excellent', model: 'model-a' },
  ]).series, [], 'rows without a usable date or grade are left off the chart');
  ok('averages grades per day, switches to weeks over long histories, and gaps unused periods');

  const ungraded = (await call('PUT', `/api/tasks/${t1.id}`, { grade: null })).body;
  assert.equal(ungraded.grade, null);
  assert.deepEqual((await call('GET', '/api/performance')).body.map((point) => point.task_id), [viaFile.id]);
  await call('PUT', `/api/tasks/${t1.id}`, { grade: 'B+' });
  ok('removes and replaces a task grade');

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

  // A reply whose reader died with the app can never land, so it is stopped rather than adopted —
  // and stopping it must leave the finished task it was answering about exactly as it was.
  const chatTask = (await call('POST', `/api/projects/${retryProj.id}/tasks`, { title: 'Asked' })).body;
  await call('PUT', `/api/tasks/${chatTask.id}`, { status: 'completed' });
  const chatter = require('node:child_process').spawn(
    process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const chatRun = runs.start({
    task_id: chatTask.id, pid: chatter.pid, image: proc.imageName(chatter.pid), kind: 'chat',
  });
  db.prepare('UPDATE agent_runs SET server_pid = 1 WHERE id = ?').run(chatRun.id);

  agentMod.adoptOrphans();
  assert.ok(runs.get(chatRun.id).ended_at, 'the run record is closed rather than reattached to');
  for (let i = 0; i < 60 && proc.isAlive(chatter.pid); i++) await sleep(100);
  assert.ok(!proc.isAlive(chatter.pid), 'the orphaned reply is stopped');
  const afterRestart = (await call('GET', `/api/tasks/${chatTask.id}`)).body;
  assert.equal(afterRestart.status, 'completed', 'the task it was answering about is undisturbed');
  assert.match(afterRestart.comments.at(-1).body, /reply was lost/i);
  ok('a reply orphaned by a restart is dropped, and the thread is told to ask again');

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
  assert.deepEqual(config.harnesses.map((h) => h.id), ['claude', 'codex', 'grok', 'cursor']);
  assert.ok(config.harnesses[0].providers[0].models.length, 'each provider offers models');
  const grokCat = config.harnesses.find((h) => h.id === 'grok');
  assert.deepEqual(grokCat.providers.map((p) => p.id), ['native', 'openrouter', 'ollama']);
  ok('publishes the harness catalogue, models grouped under their provider');

  // Newest first, because the head of the list is what a task with no model of its own falls back to.
  const grokNative = grokCat.providers.find((p) => p.id === 'native');
  assert.deepEqual(grokNative.models.map((m) => m.id), ['grok-4.6', 'grok-4.5']);
  assert.equal(harnesses.resolve('grok', 'native', null).model.id, 'grok-4.6');
  ok('offers the current xAI models, the newest one as the default');

  // A local model exists only while it is pulled, so the list is what Ollama says it has, not a guess.
  const ollamaCat = grokCat.providers.find((p) => p.id === 'ollama');
  assert.deepEqual(ollamaCat.models.map((m) => m.name), INSTALLED);
  assert.deepEqual(ollamaCat.models.map((m) => m.id), ['ollama-devstral-latest', 'ollama-qwen3-coder-30b']);
  ok('offers the Ollama models that are actually installed');

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
  const cursorRead = harnesses.byId('cursor').reader();
  assert.deepEqual(cursorRead({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'NOTE: hi' }] },
  }), { text: 'NOTE: hi' });
  assert.deepEqual(cursorRead({ type: 'result', subtype: 'success', result: 'done', is_error: false }),
    { done: true, text: 'done', failed: false });
  const cursorEnv = { CURSOR_API_KEY: 'ck', PATH: '/bin' };
  harnesses.byId('cursor').env(cursorEnv);
  assert.equal(cursorEnv.CURSOR_API_KEY, undefined);
  ok('each harness reads its own event stream');

  const usageMod = require('../usage');
  const claudeUsage = usageMod.parseEvent({
    type: 'result', subtype: 'success', total_cost_usd: 1.25,
    modelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, costUSD: 1.25 } },
  });
  assert.equal(claudeUsage.models[0].model, 'claude-opus-5');
  assert.equal(claudeUsage.models[0].cached, 50);
  assert.equal(claudeUsage.models[0].costUsd, 1.25);
  const codexUsage = usageMod.parseEvent({
    type: 'turn.completed',
    usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10 },
  });
  assert.equal(codexUsage.models[0].input, 600);
  assert.equal(codexUsage.models[0].output, 60);
  const priced = usageMod.finishRow(codexUsage.models[0], { model: 'gpt-5.6-sol', harness: 'codex', provider: 'native' });
  assert.equal(priced.channel, 'subscription');
  assert.ok(priced.costUsd > 0);
  const staleSol = usageMod.finishRow(codexUsage.models[0], {
    model: 'gpt-5.6-sol', harness: 'claude', provider: 'native',
  });
  assert.equal(staleSol.harness, 'codex', 'a Sol row cannot inherit the Claude harness');
  assert.equal(usageMod.inferHarness('cursor', 'grok-4.6'), 'cursor',
    'a model shared by two harnesses keeps the harness recorded by its run');
  ok('usage events are parsed into in/cached/out and a simulated API cost');
  assert.equal(usageMod.parseEvent({ type: 'system', usage: { input_tokens: 2, cached_input_tokens: 99, output_tokens: 3 } }), null);
  const orRow = usageMod.finishRow({ model: 'openai/gpt-5.6-luna', input: 1000, cached: 0, output: 10, costUsd: null, costSource: 'estimate' }, { harness: 'grok' });
  assert.equal(orRow.channel, 'api');
  assert.ok(orRow.costUsd > 0);
  const grokSubRow = usageMod.finishRow({ model: 'grok-4.6', input: 10, cached: 0, output: 2, costUsd: 0.01, costSource: 'cli' }, { harness: 'grok', provider: 'native' });
  assert.equal(grokSubRow.channel, 'api');
  const olRow = usageMod.finishRow({ model: 'qwen3.6:latest', input: 10, cached: 0, output: 2, costUsd: null }, { harness: 'grok' });
  assert.equal(olRow.channel, 'api');
  assert.equal(olRow.costUsd, 0);

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
  const { harness: gh, provider: gp, model: gm } = harnesses.resolve('grok', 'ollama', 'ollama-devstral-latest');
  gh.prepare(gp, gm);
  const toml = fs.readFileSync(process.env.GROK_CONFIG, 'utf8');
  assert.match(toml, /\[model\.ollama-devstral-latest\]/);
  assert.match(toml, /model = "devstral:latest"/);
  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:38112\/v1"/);
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

  // Native runs must use the subscription login. An inherited API key would silently bill per token.
  const claudeEnv = { ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_AUTH_TOKEN: 'tok', PATH: '/bin' };
  harnesses.byId('claude').env(claudeEnv);
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(claudeEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(claudeEnv.PATH, '/bin');
  const codexEnv = { OPENAI_API_KEY: 'sk-openai', CODEX_API_KEY: 'sk-codex', PATH: '/bin' };
  harnesses.byId('codex').env(codexEnv);
  assert.equal(codexEnv.OPENAI_API_KEY, undefined);
  assert.equal(codexEnv.CODEX_API_KEY, undefined);
  const grokSub = harnesses.resolve('grok', 'native', 'grok-4.6');
  const grokEnv = { XAI_API_KEY: 'xai', GROK_API_KEY: 'g', PATH: '/bin' };
  grokSub.harness.env(grokEnv, grokSub.provider);
  assert.equal(grokEnv.XAI_API_KEY, 'xai', 'native Grok uses the xAI API key');
  const orKeep = { OPENROUTER_API_KEY: 'or', XAI_API_KEY: 'xai' };
  or.harness.env(orKeep, or.provider);
  assert.equal(orKeep.OPENROUTER_API_KEY, 'or', 'OpenRouter still uses its own key');
  ok('native Claude and Codex strip API keys so the subscription login is used');

  // Both of these otherwise reach the human as a status code from somewhere else, mid-run.
  assert.match(gh.preflight(or.provider, or.model, {}), /Set one of OPENROUTER_API_KEY/);
  assert.equal(gh.preflight(or.provider, or.model, { OPENROUTER_API_KEY: 'k' }), null);
  assert.match(gh.preflight(gp, { upstream: 'never-pulled' }, {}),
    /has to be downloaded[\s\S]*ollama pull never-pulled/);
  assert.equal(gh.preflight(gp, gm, {}), null, 'an installed model is left to run');
  ok('a run that cannot work is stopped before a worktree is made for it');

  assert.deepEqual((await call('GET', '/api/settings')).body, {
    harness: 'claude', provider: 'native', model: 'claude-opus-5', random: [],
    randomPool: ['claude', 'codex', 'grok', 'cursor'], randomEnabled: false,
  });
  ok('defaults to the first model of the first harness');

  const emptyUsage = (await call('GET', '/api/usage')).body;
  assert.deepEqual(emptyUsage.subscription.models, []);
  assert.equal(emptyUsage.subscription.totals.tasks, 0);
  assert.deepEqual(emptyUsage.api.models, []);
  const { usage: usageStore } = require('../db');
  usageStore.record({
    task_id: null, log_file: 'task-1-test.log', harness: 'claude', provider: 'native',
    model: 'claude-opus-5', channel: 'subscription',
    input_tokens: 100, cached_tokens: 20, output_tokens: 10, cost_usd: 0.5, cost_source: 'cli',
  });
  usageStore.record({
    task_id: null, log_file: 'task-2-test.log', harness: 'grok', provider: 'openrouter',
    model: 'openrouter-gpt-5-6-luna', channel: 'api',
    input_tokens: 30, cached_tokens: 0, output_tokens: 5, cost_usd: 0.02, cost_source: 'cli',
  });
  usageStore.record({
    task_id: null, log_file: 'task-3-test.log', harness: 'claude', provider: 'native',
    model: 'gpt-5.6-sol', channel: 'subscription',
    input_tokens: 40, cached_tokens: 10, output_tokens: 5, cost_usd: 0.03, cost_source: 'estimate',
  });
  const filled = (await call('GET', '/api/usage')).body;
  assert.equal(filled.subscription.models.find((row) => row.model === 'gpt-5.6-sol').harness, 'codex');
  assert.equal(filled.subscription.totals.cost_usd, 0.53);
  assert.equal(filled.api.models[0].channel, 'api');
  assert.equal(filled.api.totals.cost_usd, 0.02);
  ok('the usage report splits subscription and API costs by model');

  assert.equal((await call('PUT', '/api/settings', { harness: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { harness: 'codex', model: 'claude-opus-5' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { harness: 'claude', provider: 'ollama' })).status, 400);
  ok('rejects a harness, provider, or model that does not exist');

  const stored = (await call('PUT', '/api/settings', { harness: 'codex', model: 'gpt-5.6-terra' })).body;
  assert.deepEqual(stored, {
    harness: 'codex', provider: 'native', model: 'gpt-5.6-terra', random: [],
    randomPool: ['claude', 'codex', 'grok', 'cursor'], randomEnabled: false,
  });
  assert.deepEqual((await call('GET', '/api/settings')).body, stored);
  ok('remembers the default harness, provider, and model');

  const { random: _drawOff, randomPool: _pool, randomEnabled: _enabled, ...defaults } = stored;

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
    title: 'Local', harness: 'grok', provider: 'ollama', model: 'ollama-qwen3-coder-30b',
  })).body;
  assert.deepEqual(resolved(viaOllama.id),
    { harness: 'grok', provider: 'ollama', model: 'ollama-qwen3-coder-30b' });
  ok('a task can name the provider its model comes from');

  // What the Tasks view would print for rows exactly as the API hands them back, resolved through
  // the same catalogue the browser is given — the end of the path the row's second line depends on.
  const browserCat = (await call('GET', '/api/config')).body.harnesses;
  const rows = (await call('GET', '/api/tasks')).body;
  const named = (title) =>
    agentName(browserCat, taskAgent(rows.find((r) => r.title === title), defaults));
  assert.equal(named('Inherits'), 'GPT-5.6 Terra');
  assert.equal(named('Half pinned'), 'Opus 5');
  assert.equal(named('Local'), 'qwen3-coder:30b');
  // A task that has run is named by what ran, which is where a since-retargeted task would differ.
  assert.equal(named('File prompt'), 'Grok 4.5');
  ok('the row names the agent for tasks as the API returns them');

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

  // --- a harness dealt out at random, so the grades can be compared ---
  const draw = harnesses.randomChoice();
  assert.ok(harnesses.byId(draw.harness), 'draws one of the harnesses the app can actually drive');
  assert.equal(draw.provider, 'native', 'compares the harnesses, not somebody else\'s endpoint');
  assert.equal(draw.model, harnesses.byId(draw.harness).providers[0].models[0].id,
    'takes the top model of the harness it drew');
  const drawn = new Set();
  for (let i = 0; i < 200; i++) drawn.add(harnesses.randomChoice().harness);
  assert.deepEqual([...drawn].sort(), ['claude', 'codex', 'cursor', 'grok'], 'every harness comes up');
  ok('the draw covers every harness, each on its own top model');

  assert.deepEqual((await call('PUT', '/api/settings',
    { harness: 'codex', model: 'gpt-5.6-terra', random: true })).body.random.sort(), ['claude', 'codex', 'cursor', 'grok']);
  assert.deepEqual((await call('GET', '/api/settings')).body.random.sort(), ['claude', 'codex', 'cursor', 'grok'], 'the choice outlives the request');
  assert.deepEqual((await call('PUT', '/api/settings',
    { harness: 'codex', random: ['claude', 'cursor'] })).body.random.sort(), ['claude', 'cursor']);
  assert.deepEqual((await call('GET', '/api/settings')).body.random.sort(), ['claude', 'cursor'], 'a short list is kept');
  const pausedDraw = (await call('PUT', '/api/settings',
    { harness: 'codex', randomEnabled: false })).body;
  assert.equal(pausedDraw.randomEnabled, false);
  assert.equal(require('../db').settings.get('random_harness'), '0',
    'the disabled switch is persisted rather than kept only in server memory');
  assert.deepEqual(pausedDraw.random, []);
  assert.deepEqual(pausedDraw.randomPool.sort(), ['claude', 'cursor'], 'turning the draw off keeps its pool');
  const resumedDraw = (await call('PUT', '/api/settings',
    { harness: 'codex', randomEnabled: true })).body;
  assert.deepEqual(resumedDraw.random.sort(), ['claude', 'cursor'], 'turning the draw back on restores its pool');
  ok('the random draw switch preserves the selected harnesses');
  await call('PUT', '/api/settings', { harness: 'codex', model: 'gpt-5.6-terra', random: true });

  const dealt = [];
  for (let i = 0; i < 12; i++) {
    dealt.push((await call('POST', `/api/projects/${proj.id}/tasks`, { title: `Dealt ${i}` })).body);
  }
  for (const t of dealt) {
    assert.ok(t.harness, 'a task made under the draw is pinned rather than left following the default');
    assert.equal(t.provider, 'native');
    assert.equal(t.model, harnesses.byId(t.harness).providers[0].models[0].id);
    assert.deepEqual(resolved(t.id), { harness: t.harness, provider: t.provider, model: t.model });
  }
  // Twelve draws over four harnesses landing on one is a fluke, or a broken draw.
  assert.ok(new Set(dealt.map((t) => t.harness)).size > 1, 'the tasks are spread across harnesses');
  ok('each new task is dealt its own harness and keeps it');

  // The point of pinning is that the choice survives — a default moved later must not move it.
  const before = dealt[0].harness;
  await call('PUT', '/api/settings', { harness: 'grok', model: 'grok-4.5', random: true });
  assert.equal(taskStore.get(dealt[0].id).harness, before, 'a task already dealt keeps what it drew');
  ok('moving the default does not re-roll a task that has already been dealt');

  // Picking for yourself has to beat the dice, at any of the three levels.
  const mine = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'My pick', harness: 'claude', model: 'claude-haiku-4-5-20251001',
  })).body;
  assert.deepEqual(resolved(mine.id),
    { harness: 'claude', provider: 'native', model: 'claude-haiku-4-5-20251001' });
  const myModel = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'My model', model: 'grok-4.6',
  })).body;
  assert.equal(myModel.harness, null, 'a model pinned alone still follows the default harness');
  assert.deepEqual(resolved(myModel.id), { harness: 'grok', provider: 'native', model: 'grok-4.6' });
  // The New task dialog draws in the browser and sends what it drew, so a draw that lands on the
  // harness that happens to be the default arrives looking exactly like "the default". It still has
  // to be stored: re-rolling it here would run the task on something other than what was shown.
  const asShown = (await call('POST', `/api/projects/${proj.id}/tasks`, {
    title: 'Drawn in the dialog', harness: 'grok', provider: 'native', model: 'grok-4.5',
  })).body;
  assert.equal(asShown.harness, 'grok', 'a pick matching the default is still a pick, not a re-roll');
  assert.deepEqual(resolved(asShown.id), { harness: 'grok', provider: 'native', model: 'grok-4.5' });
  ok('a harness or model you chose yourself is not overruled by the draw');

  assert.ok((await call('PUT', '/api/settings', { harness: 'grok' })).body.random.length,
    'saving the default alone leaves the draw as it was');
  const off = (await call('PUT', '/api/settings',
    { harness: 'claude', model: 'claude-opus-5', random: [] })).body;
  assert.deepEqual(off.random, []);
  const plain = (await call('POST', `/api/projects/${proj.id}/tasks`, { title: 'Plain' })).body;
  assert.equal(plain.harness, null, 'with the draw off, a task follows the default again');
  ok('the draw can be turned off, and tasks go back to following the default');

  await call('PUT', '/api/settings', { harness: 'claude', model: 'claude-opus-5' });

  // --- a note on a finished task reopens it and the agent continues ---
  const done = (await call('POST', `/api/projects/${proj.id}/tasks`, { title: 'Finished' })).body;
  await call('PUT', `/api/tasks/${done.id}`, { status: 'completed' });
  const posted = (await call('POST', `/api/tasks/${done.id}/comments`, { body: 'what did you change?' })).body;
  assert.equal(posted.replying, true, 'the comment started an agent to continue the task');
  for (let i = 0; i < 60 && ['active', 'ready', 'completed'].includes((await call('GET', `/api/tasks/${done.id}`)).body.status); i++) {
    await sleep(100);
  }
  const answered = (await call('GET', `/api/tasks/${done.id}`)).body;
  assert.equal(answered.status, 'failed', 'a follow-up that cannot start fails like any other run');
  assert.match(answered.comments.at(-1).body, /Claude Code CLI/i, 'a reply that cannot start says so in the thread');
  ok('a comment on a finished task reopens it and the agent runs');

  const canned = (await call('POST', `/api/projects/${proj.id}/tasks`, { title: 'Cancelled' })).body;
  await call('PUT', `/api/tasks/${canned.id}`, { status: 'cancelled' });
  const postedCancel = (await call('POST', `/api/tasks/${canned.id}/comments`, { body: 'please continue' })).body;
  assert.equal(postedCancel.replying, true, 'a cancelled task is reopened by a comment');
  for (let i = 0; i < 60 && ['active', 'ready'].includes((await call('GET', `/api/tasks/${canned.id}`)).body.status); i++) {
    await sleep(100);
  }
  assert.equal((await call('GET', `/api/tasks/${canned.id}`)).body.status, 'failed');
  ok('a comment on a cancelled task starts the agent again');

  const filed = (await call('POST', `/api/tasks/${modelOnly.id}/comments`, { body: 'just a note' })).body;
  assert.equal(filed.replying, false);
  assert.equal((await call('GET', `/api/tasks/${modelOnly.id}`)).body.comments.length, 1,
    'nothing was started, so nothing was said back');
  ok('a note on a task that has not run yet is filed and left alone');

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

  const docsRoot = path.join(tmp, 'view-docs');
  fs.mkdirSync(docsRoot);
  fs.writeFileSync(path.join(docsRoot, 'notes.md'), 'hello from the notes');
  fs.writeFileSync(path.join(docsRoot, 'secret.js'), 'nope');
  const docsProj = (await call('POST', '/api/projects', {
    name: 'Docs', directory: docsRoot,
  })).body;
  const viewed = await call('GET', `/api/projects/${docsProj.id}/files?path=notes.md`);
  assert.equal(viewed.status, 200);
  assert.match(viewed.body, /hello from the notes/);
  assert.equal((await call('GET', `/api/projects/${docsProj.id}/files?path=..%2F..%2Fetc%2Fpasswd`)).status, 404);
  assert.equal((await call('GET', `/api/projects/${docsProj.id}/files?path=secret.js`)).status, 404);
  assert.equal((await call('GET', '/api/projects/999999/files?path=notes.md')).status, 404);
  await call('DELETE', `/api/projects/${docsProj.id}`);
  ok('serves a named document and refuses traversal or code files');

  assert.equal((await call('GET', '/api/nope')).status, 404);
  ok('unknown endpoints 404');

  console.log(`\n${passed} checks passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('\nFAILED:', err); process.exit(1); });
