'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const proc = require('./proc');
const events = require('./events');
const git = require('./git');

const IS_WIN = process.platform === 'win32';
const OWN_PORT = Number(process.env.PORT || 3000);
// Two git calls per project on every repaint is a lot of spawning; a few seconds stale is fine.
const GIT_TTL_MS = Number(process.env.VIBE_WRANGLER_GIT_TTL_MS ?? 3000);
// Every commit the board makes on the user's behalf says where it came from, and says it the same way.
const PUSH_MESSAGE = 'push from Vibe Wrangler';

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The port the project's own start script binds. Taken from run.bat / run.sh rather than guessed,
 * so a project that never names a port is not mistaken for whatever happens to be on 3000.
 */
function parsePort(text) {
  if (!text) return null;
  let found = null;
  // run.bat uses `set PORT=3000`; run.sh uses `PORT="${PORT:-3000}"`.
  const re = /PORT\s*=\s*["']?(?:\$\{PORT:-)?(\d+)/gi;
  let m;
  while ((m = re.exec(text))) found = Number(m[1]);
  return Number.isInteger(found) && found > 0 ? found : null;
}

function readPort(directory) {
  if (!directory) return null;
  return parsePort(readIfExists(path.join(directory, 'run.bat')))
    || parsePort(readIfExists(path.join(directory, 'run.sh')));
}

function flyTomlPath(directory) {
  return directory ? path.join(directory, 'fly.toml') : null;
}

/** True when the project folder has a fly.toml, so Deploy is a real action rather than a guess. */
function hasFlyConfig(directory) {
  const file = flyTomlPath(directory);
  if (!file) return false;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readProdUrl(directory) {
  if (!directory) return null;
  const toml = readIfExists(flyTomlPath(directory));
  if (!toml) return null;
  const m = /^\s*app\s*=\s*['"]([^'"]+)['"]/m.exec(toml);
  return m ? `https://${m[1]}.fly.dev` : null;
}

function findScript(directory) {
  if (!directory) return null;
  const bat = path.join(directory, 'run.bat');
  const sh = path.join(directory, 'run.sh');
  if (IS_WIN && fs.existsSync(bat)) return { file: bat, win: true };
  if (fs.existsSync(sh)) return { file: sh, win: false };
  if (fs.existsSync(bat)) return { file: bat, win: true };
  return null;
}

/** Ports currently accepting connections on this machine. */
function listeningPorts() {
  const ports = new Set();
  if (IS_WIN) {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const re = /:(\d+)\s+\S+\s+LISTENING/gi;
    let m;
    while ((m = re.exec(r.stdout || ''))) ports.add(Number(m[1]));
    return ports;
  }
  const r = spawnSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { encoding: 'utf8' });
  const re = /:(\d+)\s+\(LISTEN\)/gi;
  let m;
  while ((m = re.exec(r.stdout || ''))) ports.add(Number(m[1]));
  if (ports.size) return ports;
  // Busybox / some Linux images have ss but not lsof.
  const ss = spawnSync('ss', ['-lnt'], { encoding: 'utf8' });
  const ssRe = /:(\d+)\s/g;
  while ((m = ssRe.exec(ss.stdout || ''))) ports.add(Number(m[1]));
  return ports;
}

function portInUse(port, ports = listeningPorts()) {
  return Number.isInteger(port) && port > 0 && ports.has(port);
}

function listeners(port) {
  if (!Number.isInteger(port) || port <= 0) return [];
  if (IS_WIN) {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const pids = new Set();
    const onPort = new RegExp(`[:\\[]${port}(?:\\s|\\])`);
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      if (!/LISTENING/i.test(line) || !onPort.test(line)) continue;
      const m = /(\d+)\s*$/.exec(line);
      if (m) pids.add(Number(m[1]));
    }
    return [...pids];
  }
  const r = spawnSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return (r.stdout || '').trim().split(/\s+/).map(Number).filter((n) => n > 0);
}

const workCache = new Map();

/** git.localWork behind a short cache, so listing projects does not spawn git over and over. */
function localWork(directory) {
  if (!directory) return git.localWork(null);
  const hit = workCache.get(directory);
  if (hit && Date.now() - hit.at < GIT_TTL_MS) return hit.value;
  const value = git.localWork(directory);
  workCache.set(directory, { at: Date.now(), value });
  return value;
}

function status(project, ports = listeningPorts()) {
  const port = readPort(project?.directory);
  const work = localWork(project?.directory);
  // The board itself occupies PORT. A project that happens to name the same number is not "its"
  // instance — treating it as running would offer Stop local for our own process.
  const running = Boolean(port && port !== OWN_PORT && portInUse(port, ports));
  return {
    local_port: port,
    local_running: running,
    local_url: port ? `http://localhost:${port}` : null,
    prod_url: readProdUrl(project?.directory),
    can_deploy: hasFlyConfig(project?.directory),
    is_repo: work.is_repo,
    uncommitted_changes: work.uncommitted,
    unpushed_commits: work.unpushed,
    // Work that only exists on this machine — either never committed, or committed but not pushed.
    needs_push: work.uncommitted > 0 || work.unpushed > 0,
  };
}

function decorate(project, ports) {
  if (!project) return project;
  const extra = status(project, ports);
  // Without a fly.toml there is nothing to ship, so the board must not claim a deploy is due.
  if (!extra.can_deploy) return { ...project, ...extra, needs_deploy: false };
  return { ...project, ...extra };
}

function decorateAll(list) {
  const ports = listeningPorts();
  return list.map((p) => decorate(p, ports));
}

function requireDirectory(project, action = 'running this project locally') {
  if (!project?.directory) throw new Error(`Set a working directory before ${action}`);
  let stat;
  try { stat = fs.statSync(project.directory); } catch { /* handled below */ }
  if (!stat?.isDirectory()) throw new Error('The project working directory does not exist');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(project) {
  requireDirectory(project);
  const script = findScript(project.directory);
  if (!script) throw new Error('No run.bat (or run.sh) in the project directory');

  const current = status(project);
  if (current.local_running) return current;

  // The board's own PORT must not leak into the project script. If we know the
  // project's port, pin it; otherwise drop PORT so the script's default applies.
  const env = { ...process.env };
  if (current.local_port) env.PORT = String(current.local_port);
  else delete env.PORT;

  const child = script.win
    ? spawn('cmd.exe', ['/c', script.file], {
      cwd: project.directory,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    : spawn('sh', [script.file], {
      cwd: project.directory,
      env,
      detached: true,
      stdio: 'ignore',
    });
  child.unref();

  if (current.local_port && current.local_port !== OWN_PORT) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !portInUse(current.local_port)) await sleep(150);
  }
  events.changed();
  return status(project);
}

async function stop(project) {
  const port = readPort(project?.directory);
  if (!port) throw new Error('Could not tell which port this project uses');
  if (port === OWN_PORT) throw new Error('That port belongs to Vibe Wrangler itself');
  if (!portInUse(port)) return status(project);

  for (const pid of listeners(port)) {
    if (pid === process.pid) continue;
    proc.killTree(pid);
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && portInUse(port)) await sleep(50);
  events.changed();
  return status(project);
}

/**
 * What the "Push needed" button does: commit everything in the project repo under one fixed
 * message and push it. The cached git state is dropped first, so the badge the board repaints
 * straight afterwards reflects the push rather than the few-seconds-old count that prompted it.
 */
function pushAll(project) {
  requireDirectory(project, 'pushing');
  const result = git.commitAndPush(project.directory, PUSH_MESSAGE);
  workCache.delete(project.directory);
  if (!result.ok) throw new Error(result.error);
  events.changed();
  return { ...result, ...status(project) };
}

module.exports = {
  PUSH_MESSAGE,
  pushAll,
  readPort,
  readProdUrl,
  hasFlyConfig,
  localWork,
  portInUse,
  listeningPorts,
  status,
  decorate,
  decorateAll,
  start,
  stop,
  findScript,
};
