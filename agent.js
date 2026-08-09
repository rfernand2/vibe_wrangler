'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tasks, comments, projects } = require('./db');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const PERMISSION_MODE = process.env.AGENT_PERMISSION_MODE || 'acceptEdits';
const LOG_DIR = process.env.LLM_TASKS_LOGS || path.join(__dirname, 'data', 'logs');

fs.mkdirSync(LOG_DIR, { recursive: true });

/** taskId -> { child, logFile } */
const running = new Map();

function isRunning(taskId) {
  return running.has(Number(taskId));
}

function buildPrompt(task, project, history) {
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
  lines.push(`Working directory: ${project.directory}`, '', '## Task', `Title: ${task.title}`);
  if (task.description) lines.push('', task.description);
  if (history.length) {
    lines.push('', '## Notes already recorded on this task');
    for (const c of history) lines.push(`- [${c.author}] ${c.body}`);
  }
  lines.push('', 'Do the work now, then report back.');
  return lines.join('\n');
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

function runTask(taskId) {
  taskId = Number(taskId);
  const task = tasks.get(taskId);
  if (!task) throw new Error('Task not found');
  if (isRunning(taskId)) throw new Error('Agent is already running for this task');

  const project = projects.get(task.project_id);
  const cwd = (project.directory || '').trim();
  if (!cwd || !fs.existsSync(cwd)) {
    comments.create({
      task_id: taskId,
      author: 'system',
      body: `Cannot start: the project directory ${cwd ? `"${cwd}" does not exist` : 'is not set'}.`,
    });
    tasks.setStatus(taskId, 'failed');
    return tasks.get(taskId);
  }

  const history = comments.listForTask(taskId);
  const prompt = buildPrompt(task, project, history);

  const logFile = path.join(LOG_DIR, `task-${taskId}-${Date.now()}.log`);
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  log.write(`# agent run for task ${taskId} at ${new Date().toISOString()}\n# cwd: ${cwd}\n\n${prompt}\n\n---\n`);

  tasks.setStatus(taskId, 'active');
  tasks.setLogFile(taskId, path.basename(logFile));
  comments.create({ task_id: taskId, author: 'system', body: 'Agent started working on this task.' });

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', PERMISSION_MODE,
  ];

  const child = spawn(CLAUDE_BIN, args, {
    cwd,
    env: childEnv(),
    // Only fixed flags reach the command line; the prompt goes over stdin.
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(CLAUDE_BIN),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  running.set(taskId, { child, logFile });

  child.on('error', (err) => {
    log.write(`\n[spawn error] ${err.message}\n`);
    finish(taskId, 'failed', `Could not start the Claude CLI (${err.message}). Is it installed and on your PATH?`, log);
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
    if (!running.has(taskId)) return; // already finalized by an error handler
    running.delete(taskId);

    if (signal) {
      finish(taskId, 'ready', 'Agent run was stopped before it finished.', log);
      return;
    }
    if (code !== 0) {
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 500);
      finish(taskId, 'failed', `Agent exited with an error${detail ? `: ${detail}` : ` (exit code ${code})`}.`, log);
      return;
    }

    const summary = stripNotes(finalText);
    if (summary) comments.create({ task_id: taskId, author: 'agent', body: summary });
    else if (!lastNote) comments.create({ task_id: taskId, author: 'agent', body: 'Finished, but produced no summary.' });
    finish(taskId, 'completed', null, log);
  });

  return tasks.get(taskId);
}

function finish(taskId, status, message, log) {
  running.delete(taskId);
  if (message) comments.create({ task_id: taskId, author: 'system', body: message });
  tasks.setStatus(taskId, status);
  log.end();
}

function stopTask(taskId) {
  const entry = running.get(Number(taskId));
  if (!entry) return false;
  entry.child.kill();
  return true;
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

module.exports = { runTask, stopTask, runReady, isRunning, readLog, PERMISSION_MODE, CLAUDE_BIN };
