'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { projects } = require('./db');
const events = require('./events');
const git = require('./git');

const running = new Map();
/** Last finished job per project, so the popup can still show the log after fly exits. */
const last = new Map();

function viewOf(job, runningNow) {
  return {
    running: runningNow,
    output: job.output,
    status: job.status,
    error: job.error,
  };
}

function snapshot(projectId) {
  const job = running.get(projectId);
  if (job) return viewOf(job, !job.done);
  const finished = last.get(projectId);
  if (finished) return viewOf(finished, false);
  return { running: false, output: '', status: null, error: null };
}

function append(job, chunk) {
  job.output += chunk.toString();
  if (job.output.length > 40000) job.output = job.output.slice(-40000);
  events.changed();
}

/**
 * Fly sometimes prints a warning (or a non-zero code after the app is already live). Treat the
 * run as a success whenever the log says the release made it out, so the board does not flash
 * "failed" for a deploy that actually landed.
 */
function looksSuccessful(output) {
  return /(?:^|\n)\s*(?:✔|✓|√)\s+deployed|deployed successfully|visit your newly deployed app/i
    .test(String(output || ''));
}

function finish(job, { ok, error }) {
  if (job.done) return;
  job.done = true;
  job.status = ok ? 'ok' : 'failed';
  job.error = ok ? null : (error || 'fly deploy failed');
  if (ok) {
    projects.recordDeploy(job.projectId, job.sha, job.pushCount);
    projects.markDeployed(job.projectId);
  } else events.changed();
  for (const waiter of job.waiters) waiter(ok, job.error);
  job.waiters.length = 0;
  last.set(job.projectId, job);
  running.delete(job.projectId);
}

function start(project) {
  const existing = running.get(project.id);
  if (existing && !existing.done) throw new Error('A deployment is already running for this project');

  const sha = git.isRepo(project.directory) ? git.headSha(project.directory) : null;
  const job = {
    projectId: project.id,
    sha,
    pushCount: project.push_count,
    output: '',
    status: 'running',
    error: null,
    done: false,
    waiters: [],
  };
  running.set(project.id, job);

  const bin = process.env.FLY_BIN || 'fly';
  const child = spawn(bin, ['deploy'], {
    cwd: project.directory,
    windowsHide: true,
    // fly on Windows is usually a .cmd shim; without a shell, spawn fails before deploy starts.
    shell: process.platform === 'win32' && !path.isAbsolute(bin),
  });
  job.child = child;
  events.changed();

  child.stdout.on('data', (chunk) => append(job, chunk));
  child.stderr.on('data', (chunk) => append(job, chunk));
  child.once('error', (err) => {
    finish(job, { ok: false, error: `Could not start fly deploy: ${err.message}` });
  });
  child.once('close', (code) => {
    if (code === 0 || looksSuccessful(job.output)) finish(job, { ok: true });
    else finish(job, { ok: false, error: job.output.trim() || `fly deploy exited with code ${code}` });
  });

  return snapshot(project.id);
}

/** Used by tests that want a finished result rather than a live job. */
function deploy(project) {
  start(project);
  const job = running.get(project.id);
  if (!job) return Promise.reject(new Error('Could not start fly deploy'));
  return new Promise((resolve, reject) => {
    job.waiters.push((ok, error) => {
      if (ok) resolve({ ok: true });
      else reject(new Error(error));
    });
  });
}

module.exports = { start, snapshot, deploy, looksSuccessful };
