'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const proc = require('./proc');
const events = require('./events');

const IS_WIN = process.platform === 'win32';
const OWN_PORT = Number(process.env.PORT || 3000);

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

function readProdUrl(directory) {
  if (!directory) return null;
  const toml = readIfExists(path.join(directory, 'fly.toml'));
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

function status(project, ports = listeningPorts()) {
  const port = readPort(project?.directory);
  // The board itself occupies PORT. A project that happens to name the same number is not "its"
  // instance — treating it as running would offer Stop local for our own process.
  const running = Boolean(port && port !== OWN_PORT && portInUse(port, ports));
  return {
    local_port: port,
    local_running: running,
    local_url: port ? `http://localhost:${port}` : null,
    prod_url: readProdUrl(project?.directory),
  };
}

function decorate(project, ports) {
  if (!project) return project;
  return { ...project, ...status(project, ports) };
}

function decorateAll(list) {
  const ports = listeningPorts();
  return list.map((p) => decorate(p, ports));
}

function requireDirectory(project) {
  if (!project?.directory) throw new Error('Set a working directory before running this project locally');
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

module.exports = {
  readPort,
  readProdUrl,
  portInUse,
  listeningPorts,
  status,
  decorate,
  decorateAll,
  start,
  stop,
  findScript,
};
