'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tasks, comments, projects } = require('./db');
const git = require('./git');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
const LOG_DIR = process.env.LLM_TASKS_LOGS || path.join(__dirname, 'data', 'logs');
const WORKTREE_DIR = process.env.LLM_TASKS_WORKTREES || path.join(__dirname, 'data', 'worktrees');

/** Base moving under us is expected when tasks finish together; give up after this many rounds. */
const MAX_MERGE_ATTEMPTS = 3;

fs.mkdirSync(LOG_DIR, { recursive: true });

/** taskId -> { child, logFile } */
const running = new Map();
/** taskId -> { root, wtPath, branch, base } — only for tasks isolated in a worktree. */
const isolation = new Map();
/** projectId -> taskId[] — only used for projects we cannot isolate (non-git directories). */
const queues = new Map();

function isRunning(taskId) {
  return running.has(Number(taskId));
}

/** A task left 'active' by a crashed or restarted server has no process behind it any more. */
function recoverStaleTasks() {
  const stale = tasks.list({ status: 'active' });
  for (const t of stale) {
    comments.create({
      task_id: t.id,
      author: 'system',
      body: 'The app restarted while this task was running, so the agent was interrupted. Set back to ready.',
    });
    tasks.setStatus(t.id, 'ready');
  }
  return stale.length;
}

function buildPrompt(task, project, history, iso) {
  const lines = [
    'You are an autonomous coding agent working through a task queue. A human will read only the short',
    'notes you emit — they will not read your tool calls, diffs, or reasoning.',
    '',
    '## Reporting protocol',
    'Whenever you reach a meaningful milestone, emit a line that begins with `NOTE:` followed by one short,',
    'plain-language sentence aimed at a non-technical reader. For example:',
    '  NOTE: Found the bug — the date parser assumed UTC, so evening entries landed on the wrong day.',
    '  NOTE: Fixed it and added a test covering timezones either side of midnight.',
    'Emit 2-5 of these over the course of the task. Do not put code, file paths, or stack traces in a NOTE.',
    'Your final message should be a short summary of what changed and anything the human should check or test.',
    '',
    '## Project',
    `Name: ${project.name}`,
  ];
  if (project.description) lines.push(`About: ${project.description}`);
  lines.push(`Working directory: ${iso ? iso.wtPath : project.directory}`);

  if (iso) {
    lines.push(
      '',
      '## Isolation',
      `You are in a private git worktree on branch \`${iso.branch}\`, branched from \`${iso.base}\`. Another`,
      'agent may be working on the same repository at the same time in a different worktree, so:',
      '- Work only inside your working directory. Never touch the main checkout or another worktree.',
      '- Do not switch branches, rebase, push, or run `git worktree`.',
      '- Do not worry about committing — your work is committed and merged back automatically when you finish.',
      '- Run the build and tests before you finish. Merging is automatic, so broken code lands.',
    );
  }

  lines.push('', '## Task', `Title: ${task.title}`);
  if (task.description) lines.push('', task.description);
  if (history.length) {
    lines.push('', '## Notes already recorded on this task');
    for (const c of history) lines.push(`- [${c.author}] ${c.body}`);
  }
  lines.push('', 'Do the work now, then report back.');
  return lines.join('\n');
}

function buildConflictPrompt(task, iso, files) {
  return [
    'You are an autonomous coding agent resolving a git merge conflict. A human reads only your `NOTE:` lines.',
    '',
    `You are in a git worktree at ${iso.wtPath} on branch \`${iso.branch}\`. Merging \`${iso.base}\` into it`,
    'conflicted, because another change landed on the base branch while you were working.',
    '',
    'Conflicted files:',
    ...files.map((f) => `  ${f}`),
    '',
    'Resolve every conflict so that BOTH changes are preserved — yours and the one that landed on the base',
    'branch. Do not discard either side, and do not take a whole side wholesale unless the two edits are',
    'genuinely the same change. Then run the build and the tests and make sure they pass.',
    '',
    'Do not commit, switch branches, push, or abort the merge — leave the resolved files in the working tree.',
    '',
    `The task being merged was: ${task.title}`,
    '',
    'Emit a `NOTE:` line explaining in one plain sentence what overlapped and how you reconciled it.',
  ].join('\n');
}

function extractNotes(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s*)?NOTE:\s*(.+)$/.exec(raw);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

function stripNotes(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => !/^\s*(?:[-*]\s*)?NOTE:\s*/.test(l))
    .join('\n')
    .trim();
}

function childEnv() {
  const env = { ...process.env };
  // Force subscription auth: an inherited API key would bill per token instead.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  return env;
}

/**
 * Spawns one Claude run. Notes become comments as they stream; the caller decides what
 * happens afterwards, so the same plumbing serves both the task run and conflict resolution.
 */
function spawnAgent({ taskId, cwd, prompt, log, onDone }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--model', MODEL,
  ];

  const child = spawn(CLAUDE_BIN, args, {
    cwd,
    env: childEnv(),
    // Only fixed flags reach the command line; the prompt goes over stdin.
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(CLAUDE_BIN),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  running.set(taskId, { child, log });

  let settled = false;
  const settle = (result) => {
    if (settled) return;
    settled = true;
    running.delete(taskId);
    onDone(result);
  };

  child.on('error', (err) => {
    log.write(`\n[spawn error] ${err.message}\n`);
    settle({ status: 'spawn-error', message: `Could not start the Claude CLI (${err.message}). Is it installed and on your PATH?` });
  });

  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  let buf = '';
  let lastNote = '';
  let finalText = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    log.write(chunk);
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }

      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type !== 'text' || !block.text) continue;
          for (const note of extractNotes(block.text)) {
            if (note === lastNote) continue;
            lastNote = note;
            comments.create({ task_id: taskId, author: 'agent', body: note });
          }
        }
      } else if (evt.type === 'result') {
        finalText = typeof evt.result === 'string' ? evt.result : '';
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    log.write(`[stderr] ${chunk}`);
  });

  child.on('close', (code, signal) => {
    if (signal) return settle({ status: 'stopped' });
    if (code !== 0) {
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 500);
      return settle({ status: 'error', message: `Agent exited with an error${detail ? `: ${detail}` : ` (exit code ${code})`}.` });
    }
    settle({ status: 'ok', summary: stripNotes(finalText), sawNote: Boolean(lastNote) });
  });
}

/**
 * Gives the task its own branch + directory so two agents can work the same repo at once.
 * Returns null for anything git can't isolate (plain directories, empty or detached repos) —
 * those fall back to running one task at a time.
 */
function openIsolation(taskId, project, root) {
  if (!git.isRepo(root)) return null;
  const base = git.currentBranch(root);
  if (!base) return null;

  const branch = `llm-task/${taskId}`;
  const wtPath = path.join(WORKTREE_DIR, `p${project.id}-task-${taskId}`);
  fs.mkdirSync(WORKTREE_DIR, { recursive: true });

  const r = git.addWorktree(root, wtPath, branch, base);
  if (!r.ok) {
    comments.create({
      task_id: taskId,
      author: 'system',
      body: `Could not create an isolated branch for this task (${r.err.slice(0, 200)}). Running in the project directory instead.`,
    });
    return null;
  }
  return { root, wtPath, branch, base };
}

/** Another task holds the project directory, and without git we have nowhere else to work. */
function enqueue(projectId, taskId) {
  const q = queues.get(projectId) || [];
  if (!q.includes(taskId)) q.push(taskId);
  queues.set(projectId, q);
}

function drainQueue(projectId) {
  const q = queues.get(projectId);
  if (!q?.length) return;
  const next = q.shift();
  if (!q.length) queues.delete(projectId);
  try { runTask(next); } catch { /* gone or already running */ }
}

function projectBusyUnisolated(projectId) {
  for (const taskId of running.keys()) {
    if (isolation.has(taskId)) continue;
    const t = tasks.get(taskId);
    if (t && t.project_id === projectId) return true;
  }
  return false;
}

function runTask(taskId) {
  taskId = Number(taskId);
  const task = tasks.get(taskId);
  if (!task) throw new Error('Task not found');
  if (isRunning(taskId)) throw new Error('Agent is already running for this task');

  const project = projects.get(task.project_id);
  const root = (project.directory || '').trim();
  if (!root || !fs.existsSync(root)) {
    comments.create({
      task_id: taskId,
      author: 'system',
      body: `Cannot start: the project directory ${root ? `"${root}" does not exist` : 'is not set'}.`,
    });
    tasks.setStatus(taskId, 'failed');
    return tasks.get(taskId);
  }

  const iso = openIsolation(taskId, project, root);
  if (!iso && projectBusyUnisolated(project.id)) {
    enqueue(project.id, taskId);
    comments.create({
      task_id: taskId,
      author: 'system',
      body: 'Another task is running in this project directory. Queued — it will start when that one finishes.',
    });
    return tasks.get(taskId);
  }

  const cwd = iso ? iso.wtPath : root;
  if (iso) isolation.set(taskId, iso);

  const history = comments.listForTask(taskId);
  const prompt = buildPrompt(task, project, history, iso);

  const logFile = path.join(LOG_DIR, `task-${taskId}-${Date.now()}.log`);
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  log.write(`# agent run for task ${taskId} at ${new Date().toISOString()}\n# cwd: ${cwd}\n\n${prompt}\n\n---\n`);

  tasks.setStatus(taskId, 'active');
  tasks.setLogFile(taskId, path.basename(logFile));
  comments.create({
    task_id: taskId,
    author: 'system',
    body: iso
      ? `Agent started working on this task on its own branch (${iso.branch}).`
      : 'Agent started working on this task.',
  });

  spawnAgent({
    taskId,
    cwd,
    prompt,
    log,
    onDone: (result) => {
      if (result.status === 'spawn-error') return finish(taskId, 'failed', result.message, log);
      if (result.status === 'stopped') return finish(taskId, 'ready', 'Agent run was stopped before it finished.', log);
      if (result.status === 'error') return finish(taskId, 'failed', result.message, log);

      if (result.summary) comments.create({ task_id: taskId, author: 'agent', body: result.summary });
      else if (!result.sawNote) comments.create({ task_id: taskId, author: 'agent', body: 'Finished, but produced no summary.' });

      if (!iso) return finish(taskId, 'completed', null, log);
      mergeBack(taskId, task, iso, log, 1);
    },
  });

  return tasks.get(taskId);
}

/**
 * Commits the worktree, pulls the base branch in (where a conflict can only hurt the worktree),
 * then fast-forwards the real checkout. Fast-forward is the only merge the user's directory ever
 * sees, so it can never leave them with a conflicted tree.
 */
function mergeBack(taskId, task, iso, log, attempt) {
  const commit = git.commitAll(iso.wtPath, `${task.title}\n\nllm_tasks task #${taskId}`);
  if (!commit.ok) {
    log.write(`\n[git] commit failed: ${commit.err}\n`);
    return abandon(taskId, iso, log, `Could not commit the agent's changes (${commit.err.slice(0, 200)}).`);
  }

  if (!git.shortLog(iso.root, iso.base, iso.branch).length) {
    log.write('\n[git] no commits on the task branch; nothing to merge\n');
    git.removeWorktree(iso.root, iso.wtPath, iso.branch);
    isolation.delete(taskId);
    return finish(taskId, 'completed', null, log);
  }

  const merged = git.mergeBaseIn(iso.wtPath, iso.base);

  if (!merged.ok && merged.conflicted) {
    if (attempt > MAX_MERGE_ATTEMPTS) {
      git.abortMerge(iso.wtPath);
      return abandon(taskId, iso, log, 'Gave up merging after repeated conflicts.');
    }
    return resolveConflicts(taskId, task, iso, log, attempt);
  }
  if (!merged.ok) {
    log.write(`\n[git] merge failed: ${merged.err}\n`);
    git.abortMerge(iso.wtPath);
    return abandon(taskId, iso, log, `Could not merge the latest ${iso.base} into this task's branch (${merged.err.slice(0, 200)}).`);
  }

  const ff = git.fastForward(iso.root, iso.branch);
  if (!ff.ok) {
    // Almost always means the base moved while we merged, so try the whole cycle again.
    if (attempt <= MAX_MERGE_ATTEMPTS) return mergeBack(taskId, task, iso, log, attempt + 1);
    log.write(`\n[git] fast-forward failed: ${ff.err}\n`);
    return abandon(taskId, iso, log, `Could not fast-forward ${iso.base} (${ff.err.slice(0, 200)}).`);
  }

  git.removeWorktree(iso.root, iso.wtPath, iso.branch);
  isolation.delete(taskId);
  comments.create({ task_id: taskId, author: 'system', body: `Changes merged into ${iso.base}.` });
  finish(taskId, 'completed', null, log);
}

function resolveConflicts(taskId, task, iso, log, attempt) {
  const files = git.conflictedFiles(iso.wtPath);
  log.write(`\n[git] conflicts in: ${files.join(', ')}\n`);
  comments.create({
    task_id: taskId,
    author: 'system',
    body: `Another change landed on ${iso.base} first, so ${files.length} file(s) overlap. Asking the agent to reconcile them.`,
  });

  spawnAgent({
    taskId,
    cwd: iso.wtPath,
    prompt: buildConflictPrompt(task, iso, files),
    log,
    onDone: (result) => {
      if (result.status !== 'ok') {
        git.abortMerge(iso.wtPath);
        return abandon(taskId, iso, log, result.message || 'Conflict resolution was interrupted.');
      }
      const unresolved = git.stillConflicted(iso.wtPath, files);
      if (unresolved.length) {
        log.write(`\n[git] conflict markers remain in: ${unresolved.join(', ')}\n`);
        git.abortMerge(iso.wtPath);
        return abandon(taskId, iso, log, 'The agent could not fully resolve the merge conflict.');
      }
      mergeBack(taskId, task, iso, log, attempt + 1);
    },
  });
}

/** Merge failed: keep the branch so nothing is lost, but stop touching the user's checkout. */
function abandon(taskId, iso, log, why) {
  const branch = iso.branch;
  git.git(iso.wtPath, ['worktree', 'prune']);
  git.git(iso.root, ['worktree', 'remove', '--force', iso.wtPath]);
  git.git(iso.root, ['worktree', 'prune']);
  isolation.delete(taskId);
  finish(taskId, 'failed', `${why} The work is safe on branch \`${branch}\` — merge it yourself when you're ready.`, log);
}

function finish(taskId, status, message, log) {
  running.delete(taskId);
  isolation.delete(taskId);
  if (message) comments.create({ task_id: taskId, author: 'system', body: message });
  tasks.setStatus(taskId, status);
  log.end();
  const task = tasks.get(taskId);
  if (task) drainQueue(task.project_id);
}

function stopTask(taskId) {
  taskId = Number(taskId);
  const entry = running.get(taskId);
  if (entry) {
    entry.child.kill();
    return true;
  }
  for (const [projectId, q] of queues) {
    const i = q.indexOf(taskId);
    if (i < 0) continue;
    q.splice(i, 1);
    if (!q.length) queues.delete(projectId);
    comments.create({ task_id: taskId, author: 'system', body: 'Removed from the queue before it started.' });
    return true;
  }
  return false;
}

function runReady(projectId) {
  const ready = tasks.list({ projectId: Number(projectId), status: 'ready' });
  const started = [];
  for (const t of ready) {
    try { runTask(t.id); started.push(t.id); } catch { /* already running */ }
  }
  return started;
}

function readLog(taskId) {
  const task = tasks.get(Number(taskId));
  if (!task?.log_file) return null;
  // log_file only ever holds a basename written by runTask, but re-anchor defensively.
  const file = path.join(LOG_DIR, path.basename(task.log_file));
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

module.exports = {
  runTask, stopTask, runReady, isRunning, readLog, recoverStaleTasks,
  MODEL, CLAUDE_BIN, WORKTREE_DIR,
};
