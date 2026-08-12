'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tasks, comments, projects, checklist, runs, settings } = require('./db');
const git = require('./git');
const proc = require('./proc');
const attachments = require('./attachments');
const harnesses = require('./harnesses');

const LOG_DIR = process.env.VIBE_WRANGLER_LOGS || path.join(__dirname, 'data', 'logs');
const WORKTREE_DIR = process.env.VIBE_WRANGLER_WORKTREES || path.join(__dirname, 'data', 'worktrees');

/** Logs are stored by name so the directory can move; anything touching the file needs it back. */
const logPath = (name) => (name ? path.join(LOG_DIR, name) : null);

/** Base moving under us is expected when tasks finish together; give up after this many rounds. */
const MAX_MERGE_ATTEMPTS = 3;

/** How long the CLI may take to exit after reporting its result before we stop waiting for it. */
const LINGER_GRACE_MS = Number(process.env.AGENT_EXIT_GRACE_MS) || 20_000;

fs.mkdirSync(LOG_DIR, { recursive: true });

/** taskId -> { child, log, runId, stopping } — agents this instance spawned. */
const running = new Map();
/** taskId -> run row — agents inherited from an earlier instance of the app. */
const adopted = new Map();
/** taskId -> { root, wtPath, branch, base } — only for tasks isolated in a worktree. */
const isolation = new Map();
/** projectId -> taskId[] — only used for projects we cannot isolate (non-git directories). */
const queues = new Map();
/** taskIds whose agent is answering a comment rather than working — these never touch the status. */
const replying = new Set();

function isRunning(taskId) {
  taskId = Number(taskId);
  return running.has(taskId) || adopted.has(taskId);
}

function isReplying(taskId) {
  return replying.has(Number(taskId));
}

/**
 * A finished task is still a conversation: a note added to it after the run is a question for whoever
 * did the work, and there is no run coming that would answer it. Only these two statuses get a reply —
 * a task that has not started, or is working now, has an agent reaching its thread anyway.
 */
const CHAT_STATUSES = ['completed', 'failed'];

const canChat = (task) => Boolean(task) && CHAT_STATUSES.includes(task.status);

/**
 * `plan` is set only when a previous run answered with its plan and stopped without doing anything.
 * Grok's loop ends on any message that carries no tool call, so a text-only plan can end a run
 * before it starts — intermittently, and more often the more context it is holding. Handing the plan
 * straight back is cheaper than making the human notice and press the button again.
 */
function buildPrompt(task, project, history, iso, plan) {
  const lines = [
    'You are an autonomous coding agent working through a task queue. A human will read only the short',
    'notes you emit — they will not read your tool calls, diffs, or reasoning.',
    '',
    'Nobody is at the keyboard. This is one turn: there is no reply coming, so anything you leave for',
    'later never happens. Do not stop to describe what you are about to do, offer to begin, or wait for',
    'a go-ahead — read files, edit them, and run commands until the task is actually finished.',
    '',
    '## Reporting protocol',
    'Whenever you reach a meaningful milestone, emit a line that begins with `NOTE:` followed by one short,',
    'plain-language sentence aimed at a non-technical reader. For example:',
    '  NOTE: Found the bug — the date parser assumed UTC, so evening entries landed on the wrong day.',
    '  NOTE: Fixed it and added a test covering timezones either side of midnight.',
    'Emit 2-5 of these over the course of the task. Do not put code, file paths, or stack traces in a NOTE.',
    'The prefix is the only channel you have. Prose without it is discarded unread, so anything you would',
    'narrate — a finding, a fix, a thing you verified — has to go out as a `NOTE:` line or the human never',
    'sees it. If you catch yourself writing a sentence about progress, that sentence is a NOTE.',
    'Your final message should be a short summary of what changed and anything the human should check or test.',
    '',
    '## Checklist protocol',
    ...(plan.length ? [
      'You have already broken this task down, and the human is looking at the result. This is your plan:',
      ...plan.map((item) => `  PLAN: ${item}`),
      'You emitted it and then stopped without doing any of it. Do not plan again and do not repeat those',
      'lines — carry them out, starting with the first, and reach for a tool in your very first message.',
    ] : [
      'Break the task into 3-8 concrete sub-tasks and emit one `PLAN:` line each, in the same message as',
      'your first tool call — a message that is only text ends the run before any work happens:',
      '  PLAN: Reproduce the wrong-day bug in the date parser',
      '  PLAN: Fix the timezone handling',
      '  PLAN: Add tests either side of midnight',
      'Emit the whole plan up front so the human can see where you are going, then tick items off as you go',
      'rather than all at the end. The plan is not the deliverable and emitting it does not end your turn —',
      'keep going straight into the first item without pausing. A plan and no work is a failed run.',
    ]),
    'The moment a sub-task is finished, echo it back with `DONE:` and the same wording:',
    '  DONE: Fix the timezone handling',
    'Keep each item to one short line a non-technical reader would understand.',
    'If the plan changes, emit a `PLAN:` line for the new sub-task — earlier items stay as they are.',
    'An item you finished but never ticked reads as work still outstanding, so tick it before you move on.',
    '',
    '## Knowing when to stop',
    'Bound the effort you spend proving a reported problem exists. If two or three honest attempts to',
    'reproduce it all show the behaviour already working correctly, stop there. Do not keep writing larger',
    'or more elaborate tests to settle it — that is unfalsifiable, and it burns the whole run.',
    'Say so instead: emit a `NOTE:` describing what you tried and what you saw, tick off the items that no',
    'longer apply, and finish. A task whose premise does not hold is a finished task, not a failed one —',
    'the human has context you do not and will take it from there.',
    'The same bound applies to any dead end. Two or three attempts, then report and finish.',
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
  const description = attachments.toLocalPaths(task.description);
  if (description) lines.push('', description);
  const notes = history.map((c) => `- [${c.author}] ${attachments.toLocalPaths(c.body)}`);
  if (notes.length) lines.push('', '## Notes already recorded on this task', ...notes);
  if ([description, ...notes].some((t) => t.includes(attachments.LOCAL_FILE_TAG))) {
    lines.push('', `Anything marked \`(${attachments.LOCAL_FILE_TAG}…)\` above is a file the human attached.`
      + ' Open it from that path with your file tools; screenshots and logs there are part of the brief.');
  }
  lines.push('', 'Do the work now, then report back.');
  return lines.join('\n');
}

/**
 * The one prompt that asks for a conversation rather than a piece of work. There is no reporting
 * protocol in it: nothing here is a run, so the whole reply is what gets posted to the thread. It is
 * told not to write anything, because the task's own worktree is long gone — the only directory left
 * to answer from is the user's checkout, which another agent may be working in right now.
 */
function buildChatPrompt(task, project, history, message, cwd) {
  const lines = [
    'You are the coding agent that worked on the task below, answering a follow-up. The run is over:',
    "the human has added a message to the task's comment thread and is waiting for a reply.",
    '',
    '## How to answer',
    '- Write plain prose, as a short message to a person. Your whole reply is posted to the thread as',
    '  it stands, so there is no `NOTE:`/`PLAN:`/`DONE:` protocol here — do not use those prefixes.',
    '- Read whatever you need in the working directory to answer accurately, and run read-only commands',
    '  (`git log`, `git show`, a test) where they help.',
    '- Change nothing: no edits, no new files, no commits, no branches. This is a conversation, not',
    '  another run of the task, and another agent may be working in this directory at the same time.',
    '- If they are asking for more work, say in a sentence what you would do and that running the task',
    '  again is what starts it. Do not start it here.',
    '- Answer what was asked and stop, in a few sentences unless they asked for more.',
    '',
    '## Project',
    `Name: ${project.name}`,
  ];
  if (project.description) lines.push(`About: ${project.description}`);
  lines.push(`Working directory: ${cwd}`);

  lines.push('', '## Task', `Title: ${task.title}`, `Status: ${task.status}`);
  const description = attachments.toLocalPaths(task.description);
  if (description) lines.push('', description);
  const notes = history.map((c) => `- [${c.author}] ${attachments.toLocalPaths(c.body)}`);
  if (notes.length) lines.push('', '## The thread so far', ...notes);
  const text = attachments.toLocalPaths(message);
  if ([description, text, ...notes].some((t) => t.includes(attachments.LOCAL_FILE_TAG))) {
    lines.push('', `Anything marked \`(${attachments.LOCAL_FILE_TAG}…)\` above is a file the human attached.`
      + ' Open it from that path with your file tools.');
  }
  // Last, so the thing being answered is the closest text to the reply.
  lines.push('', '## The message to answer', text);
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

const DIRECTIVE = /^\s*(?:[-*]\s*)?(NOTE|PLAN|DONE):\s*(.+)$/;

/**
 * The same rule a streaming harness cuts its buffer on, so a directive is read exactly where it was
 * released. Only a prefix glued straight onto a non-space is broken out, which leaves a directive
 * merely named in a sentence part of that sentence.
 */
const directiveLines = (text) => String(text).split(harnesses.DIRECTIVE_BOUNDARY);

function extractDirectives(text) {
  const out = [];
  for (const raw of directiveLines(text)) {
    const m = DIRECTIVE.exec(raw);
    if (m && m[2].trim()) out.push({ kind: m[1], text: m[2].trim() });
  }
  return out;
}

function stripDirectives(text) {
  return directiveLines(text)
    .filter((l) => !DIRECTIVE.test(l))
    .join('\n')
    .trim();
}

/**
 * A harness that hands back the whole transcript rather than the closing message buries the summary
 * under everything the agent narrated on the way — prose the reporting protocol promises is discarded
 * unread. The summary is what comes after the last directive. If nothing does, the agent signed off
 * with a `DONE:` and the best that is left is the prose from the whole run.
 */
function finalSummary(text) {
  const lines = directiveLines(text);
  let last = -1;
  lines.forEach((line, i) => { if (DIRECTIVE.test(line)) last = i; });
  return lines.slice(last + 1).join('\n').trim() || stripDirectives(text);
}

function childEnv(harness, provider) {
  const env = { ...process.env };
  harness.env(env, provider);
  return env;
}

/**
 * A provider pointed at somebody else's endpoint is useless without its credential, and the CLI only
 * reports that as a 401 from the far end after the run has already been billed a task's setup. Note
 * the restart: the app reads the environment it was started with, so a variable set afterwards is
 * invisible to it however permanently it was set.
 */
function missingKeyMessage(provider, env) {
  const key = provider.register?.env_key;
  if (!key || env[key]) return null;
  const names = [key, ...(provider.register.env_alts || [])].join(', ');
  return `No ${provider.name} API key in the environment, so the request would be rejected as`
    + ` unauthorized. Set one of ${names} and restart Vibe Wrangler.`;
}

/** What the app will run with when neither the task nor anything else has an opinion. */
function defaults() {
  return harnesses.resolve(
    settings.get('harness') || process.env.AGENT_HARNESS,
    settings.get('provider') || process.env.AGENT_PROVIDER,
    settings.get('model') || process.env.AGENT_MODEL
  );
}

/**
 * A task naming a harness but no model takes that harness's own first model — never the one picked
 * for a different harness, which would not exist there. The same goes for a provider.
 */
function forTask(task) {
  const base = defaults();
  if (task.harness) return harnesses.resolve(task.harness, task.provider, task.model);
  return harnesses.resolve(
    base.harness.id,
    task.provider || base.provider.id,
    task.model || base.model.id
  );
}

/**
 * Spawns one agent run. Notes become comments as they stream; the caller decides what
 * happens afterwards, so the same plumbing serves the task run, conflict resolution and a reply to a
 * comment. `directives: false` turns the reporting protocol off for a run that was never asked to
 * follow one — a stray `NOTE:` in a reply is a sentence, not a note to file.
 */
function spawnAgent({ taskId, cwd, prompt, log, iso, logFile, harness, provider, model, onDone,
  directives = true, kind = 'task' }) {
  // A harness reaching somebody else's endpoint may need setting up before it can be started.
  harness.prepare?.(provider, model);

  const env = childEnv(harness, provider);
  const missingKey = missingKeyMessage(provider, env);
  if (missingKey) {
    log.write(`\n[config] ${missingKey}\n`);
    return onDone({ status: 'spawn-error', message: missingKey });
  }

  // Harnesses that cannot read stdin get the prompt as a file rather than an argument, which a
  // long prompt would overflow on Windows. It sits beside the log so it outlives the run.
  const promptFile = harness.input === 'file' && logFile ? `${logFile}.prompt.txt` : null;
  if (promptFile) fs.writeFileSync(promptFile, prompt);

  const child = spawn(harness.bin, harness.args(model.id, promptFile), {
    cwd,
    env,
    // Only fixed flags reach the command line; the prompt never does.
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(harness.bin),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Recorded before anything else can go wrong, so a crash here still leaves a trail to follow.
  const record = child.pid
    ? runs.start({
      task_id: taskId,
      pid: child.pid,
      image: proc.imageName(child.pid),
      log_file: logFile ? path.basename(logFile) : null,
      worktree: iso?.wtPath ?? null,
      branch: iso?.branch ?? null,
      base: iso?.base ?? null,
      kind,
    })
    : null;

  const entry = { child, log, runId: record?.id ?? null, stopping: false };
  running.set(taskId, entry);

  let settled = false;
  let lingerTimer = null;
  const settle = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(lingerTimer);
    running.delete(taskId);
    if (record) runs.end(record.id);
    onDone(result);
  };

  /**
   * The CLI reports a terminal `result` event and then exits. Anything it left running in the
   * background inherits the stdout pipe, and while that pipe is open `close` never fires — so a
   * finished run would otherwise sit `active` forever. The result already tells us the outcome,
   * so past a grace period we take it, kill the tree and stop waiting for an exit that isn't coming.
   */
  const armLingerTimer = (failed) => {
    clearTimeout(lingerTimer);
    lingerTimer = setTimeout(() => {
      log.write(`\n[linger] Agent reported its result but has not exited after ${Math.round(LINGER_GRACE_MS / 1000)}s.`
        + ' Killing it and its background processes.\n');
      proc.killTree(child.pid);
      if (entry.stopping) return settle({ status: 'stopped' });
      settle(failed
        ? { status: 'error', message: 'The agent reported a failed run.' }
        : { status: 'ok', text: finalText, summary: finalSummary(finalText), sawNote: Boolean(lastNote) });
    }, LINGER_GRACE_MS);
  };

  child.on('error', (err) => {
    log.write(`\n[spawn error] ${err.message}\n`);
    settle({ status: 'spawn-error', message: `Could not start the ${harness.name} CLI (${err.message}). Is it installed and on your PATH?` });
  });

  child.stdin.on('error', () => {});
  child.stdin.end(promptFile ? '' : prompt);

  let buf = '';
  let lastNote = '';
  let lastText = '';
  let finalText = '';
  let stderr = '';
  // Per run, not per harness: a token-streaming CLI has to buffer, and that state cannot be shared.
  const read = harness.reader();

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

      const ev = read(evt);
      if (!ev) continue;

      if (ev.done) {
        // Not every harness puts the summary in its terminal event; the last message always has it.
        finalText = ev.text || lastText;
        armLingerTimer(ev.failed);
        continue;
      }

      lastText = ev.text;
      if (!directives) continue;
      for (const d of extractDirectives(ev.text)) {
        if (d.kind === 'PLAN') { checklist.add(taskId, d.text); continue; }
        if (d.kind === 'DONE') { checklist.markDone(taskId, d.text); continue; }
        if (d.text === lastNote) continue;
        lastNote = d.text;
        comments.create({ task_id: taskId, author: 'agent', body: d.text });
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    log.write(`[stderr] ${chunk}`);
  });

  child.on('close', (code, signal) => {
    // A tree kill on Windows reports a plain non-zero exit, so the flag is what marks it deliberate.
    if (signal || entry.stopping) return settle({ status: 'stopped' });
    if (code !== 0) {
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 500);
      return settle({ status: 'error', message: `Agent exited with an error${detail ? `: ${detail}` : ` (exit code ${code})`}.` });
    }
    settle({ status: 'ok', text: finalText, summary: finalSummary(finalText), sawNote: Boolean(lastNote) });
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

  const branch = git.pickTaskBranch(root, base, taskId);
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
  if (isReplying(taskId)) throw new Error('The agent is answering a comment on this task. Try again once it has replied.');
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
  const { harness, provider, model } = forTask(task);

  const logFile = path.join(LOG_DIR, `task-${taskId}-${Date.now()}.log`);
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  log.write(`# agent run for task ${taskId} at ${new Date().toISOString()}\n`
    + `# cwd: ${cwd}\n# harness: ${harness.bin} (${model.id} via ${provider.name})\n`);

  // The checklist describes the run in progress, so a re-run starts from a blank one.
  checklist.clear(taskId);
  tasks.setStatus(taskId, 'active');
  tasks.setLogFile(taskId, path.basename(logFile));
  comments.create({
    task_id: taskId,
    author: 'system',
    body: `${harness.name} (${model.name}) started working on this task`
      + (iso ? ` on its own branch (${iso.branch}).` : '.'),
  });

  const attempt = (plan) => {
    const prompt = buildPrompt(task, project, history, iso, plan);
    log.write(`\n${prompt}\n\n---\n`);
    spawnAgent({
      taskId,
      cwd,
      prompt,
      log,
      iso,
      logFile,
      harness,
      provider,
      model,
      onDone: (result) => {
        if (result.status === 'spawn-error') return finish(taskId, 'failed', result.message, log);
        if (result.status === 'stopped') return finish(taskId, 'ready', 'Agent run was stopped before it finished.', log);
        if (result.status === 'error') return finish(taskId, 'failed', result.message, log);

        // Exiting cleanly is not the same as having done the work. An agent that reported nothing at
        // all — no summary, no note, not one item ticked — answered with its plan and ended the turn.
        const items = checklist.listForTask(taskId);
        if (!result.summary && !result.sawNote && !items.some((i) => i.done)) {
          // It told us what it meant to do, so give that back to it rather than making the human ask
          // twice. Only once: a second silent stop is a real failure and not a slow loop.
          if (!plan.length && items.length) {
            comments.create({
              task_id: taskId,
              author: 'system',
              body: 'The agent planned the work and then stopped. Handing its plan back and asking it to carry it out.',
            });
            return attempt(items.map((i) => i.text));
          }
          // Completing the task on this would take it off the board and merge an empty branch, so it
          // is failed instead, with whatever it did write kept on the branch.
          return finish(taskId, 'failed', 'The agent stopped without doing the work —'
            + ' it answered with a plan twice and never started. Try running it again.', log);
        }
        if (result.summary) comments.create({ task_id: taskId, author: 'agent', body: result.summary });

        if (!iso) return finish(taskId, 'completed', null, log);
        mergeBack(taskId, task, iso, log, 1);
      },
    });
  };

  attempt([]);
  return tasks.get(taskId);
}

/**
 * Answers a comment left on a task that has already finished, then stops again. Nothing about the
 * task moves: the status, the checklist and the clock all stay as the run that finished it left them,
 * because this is a question about that run and not a new one.
 *
 * Returns false when there is nothing to answer with — a status that gets no reply, an agent already
 * on this task, or a directory that has since gone. Silence is only acceptable in the first two: the
 * user is watching the thread, so anything that stops a reply arriving has to say so there.
 */
function reply(taskId, comment) {
  taskId = Number(taskId);
  const task = tasks.get(taskId);
  if (!canChat(task) || isRunning(taskId)) return false;

  const project = projects.get(task.project_id);
  const root = (project.directory || '').trim();
  if (!root || !fs.existsSync(root)) {
    comments.create({
      task_id: taskId,
      author: 'system',
      body: `Cannot answer: the project directory ${root ? `"${root}" does not exist` : 'is not set'}.`,
    });
    return false;
  }

  // The reply belongs with the run it is about, so it is appended to that run's transcript rather
  // than starting a new one the task's Raw log would then point at instead.
  const existing = logPath(task.log_file);
  const logFile = existing && fs.existsSync(existing)
    ? existing
    : path.join(LOG_DIR, `task-${taskId}-${Date.now()}.log`);
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  if (logFile !== existing) tasks.setLogFile(taskId, path.basename(logFile));

  const history = comments.listForTask(taskId).filter((c) => c.id < comment.id);
  const { harness, provider, model } = forTask(task);
  const prompt = buildChatPrompt(task, project, history, comment.body, root);
  log.write(`\n# reply to a comment on task ${taskId} at ${new Date().toISOString()}\n`
    + `# cwd: ${root}\n# harness: ${harness.bin} (${model.id} via ${provider.name})\n\n${prompt}\n\n---\n`);

  replying.add(taskId);
  spawnAgent({
    taskId,
    cwd: root,
    prompt,
    log,
    iso: null,
    logFile,
    harness,
    provider,
    model,
    // Nothing here was asked to follow the reporting protocol, and there is no checklist to build.
    directives: false,
    kind: 'chat',
    onDone: (result) => {
      replying.delete(taskId);
      // The whole closing message is the reply. A directive that slipped in anyway is dropped, since
      // it would read as protocol noise to whoever asked the question.
      const answer = result.status === 'ok' ? stripDirectives(result.text || '') : '';
      if (answer) {
        comments.create({ task_id: taskId, author: 'agent', body: answer });
      } else if (result.status === 'stopped') {
        comments.create({ task_id: taskId, author: 'system', body: 'The reply was stopped before it was finished.' });
      } else {
        comments.create({
          task_id: taskId,
          author: 'system',
          body: result.message || 'The agent finished without saying anything. Try asking again.',
        });
      }
      log.end();
      // A reply holds the project directory like any other run, so whatever was waiting on it goes now.
      drainQueue(task.project_id);
    },
  });
  return true;
}

/**
 * Commits the worktree, pulls the base branch in (where a conflict can only hurt the worktree),
 * then fast-forwards the real checkout. Fast-forward is the only merge the user's directory ever
 * sees, so it can never leave them with a conflicted tree.
 */
function mergeBack(taskId, task, iso, log, attempt) {
  const commit = git.commitAll(iso.wtPath, `${task.title}\n\nvibe_wrangler task #${taskId}`);
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

  const { harness, provider, model } = forTask(task);
  spawnAgent({
    taskId,
    cwd: iso.wtPath,
    prompt: buildConflictPrompt(task, iso, files),
    log,
    iso,
    // A full path, not the stored basename: a prompt written beside the log has to land there and
    // not wherever the process happens to be running.
    logFile: logPath(tasks.get(taskId)?.log_file),
    harness,
    provider,
    model,
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
    entry.stopping = true;
    // Kill the tree, not just the child: on Windows the CLI runs under a shell shim.
    if (!entry.child.pid || !proc.killTree(entry.child.pid)) entry.child.kill();
    return true;
  }
  if (adopted.has(taskId)) return proc.killTree(adopted.get(taskId).pid);
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

function runStatus(projectId, status) {
  const started = [];
  for (const t of tasks.list({ projectId: Number(projectId), status })) {
    try { runTask(t.id); started.push(t.id); } catch { /* already running */ }
  }
  return started;
}

const runReady = (projectId) => runStatus(projectId, 'ready');
const runFailed = (projectId) => runStatus(projectId, 'failed');

/* ---------- Agents inherited from an earlier instance of the app ---------- */

const ADOPT_POLL_MS = 4000;

/**
 * A restart severs the pipe to any agent still running, so its output is gone for good — but the
 * process, and the worktree it is writing into, are not. Adopting it means we can still tell the
 * user it is alive, let them stop it, and keep whatever it produces.
 */
function adoptOrphans() {
  const result = { adopted: 0, closed: 0, reset: 0 };

  for (const r of runs.open()) {
    // A reply is only worth anything to the pipe that died with the app, so it is dropped rather
    // than adopted — and dropping it must not disturb the finished task it was answering about.
    if (r.kind === 'chat') {
      discardReply(r);
      result.closed++;
    } else if (proc.looksLike(r.pid, r.image)) {
      adopt(r);
      result.adopted++;
    } else {
      runs.end(r.id);
      result.closed++;
    }
  }

  for (const t of tasks.list({ status: 'active' })) {
    if (adopted.has(t.id)) continue;
    comments.create({
      task_id: t.id,
      author: 'system',
      body: 'The app restarted while this task was running and its agent is gone. Set back to ready.',
    });
    tasks.setStatus(t.id, 'ready');
    result.reset++;
  }
  return result;
}

/** Its answer can no longer reach anyone, so stop it burning tokens and tell the thread to ask again. */
function discardReply(record) {
  if (proc.looksLike(record.pid, record.image)) proc.killTree(record.pid);
  runs.end(record.id);
  comments.create({
    task_id: record.task_id,
    author: 'system',
    body: 'The app restarted while the agent was writing a reply here, so the reply was lost. Ask again.',
  });
}

function adopt(record) {
  adopted.set(record.task_id, record);
  if (record.task_status !== 'active') tasks.setStatus(record.task_id, 'active');
  comments.create({
    task_id: record.task_id,
    author: 'system',
    body: `The app restarted, but this agent (process ${record.pid}) is still running. Reattached to it — `
      + 'its progress notes were lost with the restart, so the thread will stay quiet until it exits.',
  });

  const timer = setInterval(() => {
    if (proc.isAlive(record.pid)) return;
    clearInterval(timer);
    finishAdopted(record);
  }, ADOPT_POLL_MS);
  timer.unref?.();
}

/**
 * We never saw this process's exit code, so we cannot claim it succeeded. Commit whatever it left
 * in its worktree, park it on the branch, and let the user decide.
 */
function finishAdopted(record) {
  adopted.delete(record.task_id);
  runs.end(record.id);

  const task = tasks.get(record.task_id);
  if (!task) return;

  let where = 'It was not merged, because the app could not see whether it finished cleanly.';
  if (record.worktree && fs.existsSync(record.worktree)) {
    git.commitAll(record.worktree, `${task.title}\n\nvibe_wrangler task #${task.id} (interrupted by an app restart)`);
    const kept = git.shortLog(record.project_directory, record.base, record.branch).length;
    git.git(record.project_directory, ['worktree', 'remove', '--force', record.worktree]);
    git.git(record.project_directory, ['worktree', 'prune']);
    where = kept
      ? `Its work is committed on branch \`${record.branch}\` — review and merge it, or run the task again.`
      : 'It had not changed anything, so there is nothing to merge.';
  }

  comments.create({
    task_id: task.id,
    author: 'system',
    body: `The agent inherited from the previous app session has exited. ${where}`,
  });
  tasks.setStatus(task.id, 'failed');
  drainQueue(task.project_id);
}

/** Every agent this app knows about, whether this instance started it or inherited it. */
function listAgents() {
  const out = [];
  for (const r of runs.open()) {
    const alive = adopted.has(r.task_id) || running.has(r.task_id)
      ? proc.isAlive(r.pid)
      : proc.looksLike(r.pid, r.image);
    if (!alive) { runs.end(r.id); continue; }
    out.push({
      id: r.id,
      task_id: r.task_id,
      task_title: r.task_title,
      project_name: r.project_name,
      pid: r.pid,
      branch: r.branch,
      started_at: r.started_at,
      kind: r.kind,
      mine: r.server_pid === process.pid,
    });
  }
  return out;
}

function killAgent(runId) {
  const record = runs.get(Number(runId));
  if (!record || record.ended_at) return false;
  if (running.has(record.task_id) || adopted.has(record.task_id)) return stopTask(record.task_id);
  if (!proc.looksLike(record.pid, record.image)) {
    runs.end(record.id);
    return false;
  }
  return proc.killTree(record.pid);
}

function readLog(taskId) {
  const task = tasks.get(Number(taskId));
  if (!task?.log_file) return null;
  // log_file only ever holds a basename written by runTask, but re-anchor defensively.
  const file = path.join(LOG_DIR, path.basename(task.log_file));
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

module.exports = {
  runTask, stopTask, runReady, runFailed, isRunning, readLog,
  reply, canChat, isReplying, CHAT_STATUSES,
  adoptOrphans, listAgents, killAgent,
  defaults, forTask, WORKTREE_DIR,
};
