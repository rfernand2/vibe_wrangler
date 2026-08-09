'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to somebody else.
    return err.code === 'EPERM';
  }
}

/** Best-effort executable name, used to tell a real survivor from a recycled pid. */
function imageName(pid) {
  if (!isAlive(pid)) return null;
  if (IS_WIN) {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { encoding: 'utf8', windowsHide: true });
    const m = /^"([^"]+)"/m.exec(r.stdout || '');
    return m ? m[1].toLowerCase() : null;
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  return out ? path.basename(out).toLowerCase() : null;
}

/**
 * True when the pid still looks like the process we started. Pids are recycled, and killing or
 * adopting a stranger's process would be far worse than losing track of our own.
 */
function looksLike(pid, image) {
  if (!isAlive(pid)) return false;
  if (!image) return false;
  return imageName(pid) === image;
}

/** The CLI usually sits under a shell shim on Windows, so signalling the child alone leaks it. */
function killTree(pid) {
  if (!isAlive(pid)) return false;
  if (IS_WIN) {
    return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'],
      { encoding: 'utf8', windowsHide: true }).status === 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

module.exports = { isAlive, imageName, looksLike, killTree };
