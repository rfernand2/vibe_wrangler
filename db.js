'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const events = require('./events');

const DB_PATH = process.env.VIBE_WRANGLER_DB || path.join(__dirname, 'data', 'vibe_wrangler.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    directory   TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'ready',
    log_file    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author      TEXT NOT NULL DEFAULT 'user',
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (task_id, tag)
  );

  CREATE TABLE IF NOT EXISTS checklist_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL DEFAULT 0,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    done_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    pid        INTEGER NOT NULL,
    server_pid INTEGER NOT NULL,
    image      TEXT,
    log_file   TEXT,
    worktree   TEXT,
    branch     TEXT,
    base       TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS quick_tags (
    tag        TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS llm_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER,
    task_id       INTEGER,
    log_file      TEXT,
    harness       TEXT,
    provider      TEXT,
    model         TEXT NOT NULL,
    channel       TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL,
    cost_source   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_model
    ON llm_usage(log_file, model) WHERE log_file IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_runs_open ON agent_runs(ended_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_checklist_task ON checklist_items(task_id);
`);

/** Databases created before run timing existed are upgraded in place rather than rebuilt. */
function addColumn(table, name, decl) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  return !have;
}
addColumn('tasks', 'started_at', 'TEXT');
addColumn('tasks', 'finished_at', 'TEXT');
addColumn('tasks', 'number', 'INTEGER');

/**
 * 'task' for a run doing the work, 'chat' for one answering a comment on a task that already
 * finished. They are recovered differently after a restart, so the difference has to outlive us.
 */
addColumn('agent_runs', 'kind', `TEXT NOT NULL DEFAULT 'task'`);

/** Null on any means "whatever the default is when the task runs", not "whatever it was today". */
addColumn('tasks', 'harness', 'TEXT');
addColumn('tasks', 'provider', 'TEXT');
addColumn('tasks', 'model', 'TEXT');
addColumn('tasks', 'grade', 'TEXT');
addColumn('tasks', 'graded_at', 'TEXT');
addColumn('tasks', 'last_harness', 'TEXT');
addColumn('tasks', 'last_provider', 'TEXT');
addColumn('tasks', 'last_model', 'TEXT');
addColumn('tasks', 'graded_harness', 'TEXT');
addColumn('tasks', 'graded_provider', 'TEXT');
addColumn('tasks', 'graded_model', 'TEXT');

/** The SHA last pushed to GitHub, and the SHA last handed to `fly deploy`. */
addColumn('projects', 'last_pushed_sha', 'TEXT');
addColumn('projects', 'last_deployed_sha', 'TEXT');
const addedPushCount = addColumn('projects', 'push_count', 'INTEGER NOT NULL DEFAULT 0');
const addedDeployedPushCount = addColumn('projects', 'deployed_push_count', 'INTEGER NOT NULL DEFAULT 0');
if (addedPushCount) {
  db.exec(`UPDATE projects SET push_count = 1 WHERE last_pushed_sha IS NOT NULL`);
}
if (addedDeployedPushCount) {
  db.exec(`
    UPDATE projects SET deployed_push_count = 1
    WHERE last_pushed_sha IS NOT NULL AND last_pushed_sha = last_deployed_sha
  `);
}

/** Tasks that predate the numbering are numbered by age, so a project reads like its own history. */
db.exec(`
  UPDATE tasks SET number = (
    SELECT COUNT(*) FROM tasks older
    WHERE older.project_id = tasks.project_id AND older.id <= tasks.id
  )
  WHERE number IS NULL
`);

/**
 * The next number is counted out here rather than from the tasks still present, so deleting the most
 * recent task retires its number instead of handing it to the next one. A number a human has used —
 * in a note, a commit message, "run #7" — should never come to mean a different task.
 */
if (addColumn('projects', 'next_task_number', 'INTEGER NOT NULL DEFAULT 1')) {
  db.exec(`
    UPDATE projects SET next_task_number =
      COALESCE((SELECT MAX(number) + 1 FROM tasks WHERE tasks.project_id = projects.id), 1)
  `);
}
addColumn('projects', 'deployment_needed', 'INTEGER NOT NULL DEFAULT 0');

/**
 * Every write in this file lands through a prepared statement's run(), so hooking it here is the one
 * place that cannot be forgotten. Notifying from each caller instead would mean a new query could
 * quietly stop waking the browser, and there is no Refresh button to fall back on.
 */
const q = (sql) => {
  const stmt = db.prepare(sql);
  const run = stmt.run.bind(stmt);
  stmt.run = (...args) => {
    const result = run(...args);
    if (result.changes) events.changed();
    return result;
  };
  return stmt;
};

/** True when a merge into main has not yet been followed by a successful fly deploy. */
function pendingPushes(row) {
  if (!row) return 0;
  return Math.max(0, Number(row.push_count || 0) - Number(row.deployed_push_count || 0));
}

function needsDeploy(row) {
  if (!row) return false;
  return pendingPushes(row) > 0;
}

function withDeployFlag(row) {
  if (!row) return row;
  return { ...row, pending_pushes: pendingPushes(row), needs_deploy: needsDeploy(row) };
}

const projects = {
  list() {
    return q(`
      SELECT p.*,
             (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
             (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'ready')     AS ready_count,
             (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'active')    AS active_count,
             (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS completed_count
      FROM projects p
      ORDER BY p.name COLLATE NOCASE
    `).all().map(withDeployFlag);
  },
  get(id) {
    return withDeployFlag(q('SELECT * FROM projects WHERE id = ?').get(id));
  },
  create({ name, description = '', directory = '' }) {
    const { lastInsertRowid } = q(
      'INSERT INTO projects (name, description, directory) VALUES (?, ?, ?)'
    ).run(name, description, directory);
    return projects.get(Number(lastInsertRowid));
  },
  update(id, { name, description, directory }) {
    const cur = projects.get(id);
    if (!cur) return null;
    q(`UPDATE projects SET name = ?, description = ?, directory = ?, updated_at = datetime('now')
       WHERE id = ?`).run(
      name ?? cur.name,
      description ?? cur.description,
      directory ?? cur.directory,
      id
    );
    return projects.get(id);
  },
  remove(id) {
    return q('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  },
  /**
   * A merge into the project's main is what lights Deploy. The SHA is the commit that landed;
   * last_pushed_sha stays for the GitHub push that may follow.
   */
  recordMerge(id, sha) {
    if (!sha) return projects.get(id);
    q(`UPDATE projects SET push_count = push_count + 1, deployment_needed = 1,
       updated_at = datetime('now') WHERE id = ?`).run(id);
    return projects.get(id);
  },
  recordPush(id, sha) {
    if (!sha) return projects.get(id);
    q(`UPDATE projects SET last_pushed_sha = ?, push_count = push_count + 1,
       deployment_needed = 1, updated_at = datetime('now') WHERE id = ?`).run(sha, id);
    return projects.get(id);
  },
  recordRemoteSha(id, sha) {
    if (!sha) return projects.get(id);
    q(`UPDATE projects SET last_pushed_sha = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(sha, id);
    return projects.get(id);
  },
  recordDeploy(id, sha, pushCount) {
    const deployedThrough = pushCount ?? projects.get(id)?.push_count ?? 0;
    if (sha) {
      q(`UPDATE projects SET last_deployed_sha = ?,
         deployed_push_count = MAX(deployed_push_count, ?), updated_at = datetime('now') WHERE id = ?`)
        .run(sha, deployedThrough, id);
    } else {
      q(`UPDATE projects SET deployed_push_count = MAX(deployed_push_count, ?),
         updated_at = datetime('now') WHERE id = ?`)
        .run(deployedThrough, id);
    }
    return projects.get(id);
  },
  markDeployed(id) {
    return q(`UPDATE projects SET deployment_needed = 0, updated_at = datetime('now') WHERE id = ?`)
      .run(id).changes > 0;
  },
};

/** Accepts an array or a comma-separated string; returns a sorted, de-duplicated list. */
function normalizeTags(input) {
  const parts = Array.isArray(input) ? input : String(input ?? '').split(',');
  const set = new Set();
  for (const part of parts) {
    // Commas are the separator and would corrupt the group_concat round-trip.
    const tag = String(part).replace(/,/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
    if (tag) set.add(tag);
  }
  return [...set].sort();
}

const TAGS_COLUMN = `(SELECT group_concat(tag) FROM task_tags tt WHERE tt.task_id = t.id) AS tag_list`;

function hydrate(row) {
  if (!row) return row;
  const { tag_list, ...rest } = row;
  return { ...rest, tags: tag_list ? tag_list.split(',').sort() : [] };
}

/** Agents rarely echo a checklist item back verbatim, so compare on the words alone. */
function itemKey(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const checklist = {
  listForTask(taskId) {
    return q('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY position, id').all(taskId)
      .map((r) => ({ ...r, done: Boolean(r.done) }));
  },
  /** One query for a whole page of tasks, keyed by task id. */
  listForTasks(taskIds) {
    const byTask = new Map(taskIds.map((id) => [id, []]));
    if (!taskIds.length) return byTask;
    const holes = taskIds.map(() => '?').join(',');
    for (const r of q(`SELECT * FROM checklist_items WHERE task_id IN (${holes})
                       ORDER BY task_id, position, id`).all(...taskIds)) {
      byTask.get(r.task_id).push({ ...r, done: Boolean(r.done) });
    }
    return byTask;
  },
  add(taskId, text) {
    const clean = String(text).replace(/^\[[ xX]?\]\s*/, '').trim();
    if (!clean) return null;
    const key = itemKey(clean);
    const existing = checklist.listForTask(taskId).find((i) => itemKey(i.text) === key);
    if (existing) return existing;
    const next = q('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM checklist_items WHERE task_id = ?')
      .get(taskId).n;
    const { lastInsertRowid } = q('INSERT INTO checklist_items (task_id, position, text) VALUES (?, ?, ?)')
      .run(taskId, next, clean);
    return q('SELECT * FROM checklist_items WHERE id = ?').get(Number(lastInsertRowid));
  },
  /** Ticks off the item the agent named; an unrecognised one is added already-complete. */
  markDone(taskId, text) {
    const clean = String(text).replace(/^\[[ xX]?\]\s*/, '').trim();
    if (!clean) return null;
    const key = itemKey(clean);
    const open = checklist.listForTask(taskId).filter((i) => !i.done);
    const match = open.find((i) => itemKey(i.text) === key)
      || open.find((i) => itemKey(i.text).includes(key) || key.includes(itemKey(i.text)));
    const id = match ? match.id : checklist.add(taskId, clean)?.id;
    if (!id) return null;
    q(`UPDATE checklist_items SET done = 1, done_at = datetime('now') WHERE id = ?`).run(id);
    return q('SELECT * FROM checklist_items WHERE id = ?').get(id);
  },
  clear(taskId) {
    return q('DELETE FROM checklist_items WHERE task_id = ?').run(taskId).changes;
  },
};

const tasks = {
  list({ projectId = null, status = null, tag = null } = {}) {
    const where = [];
    const args = [];
    if (projectId != null) { where.push('t.project_id = ?'); args.push(projectId); }
    if (status) { where.push('t.status = ?'); args.push(status); }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag = ?)');
      args.push(normalizeTags(tag)[0] ?? tag);
    }
    const sql = `
      SELECT t.*, p.name AS project_name, p.directory AS project_directory,
             (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
             ${TAGS_COLUMN}
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.number DESC, t.id DESC
    `;
    const rows = q(sql).all(...args).map(hydrate);
    const items = checklist.listForTasks(rows.map((r) => r.id));
    for (const row of rows) row.checklist = items.get(row.id);
    return rows;
  },
  get(id) {
    const row = hydrate(q(`
      SELECT t.*, p.name AS project_name, p.directory AS project_directory, ${TAGS_COLUMN}
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = ?
    `).get(id));
    if (row) row.checklist = checklist.listForTask(row.id);
    return row;
  },
  setTags(id, input) {
    const list = normalizeTags(input);
    q('DELETE FROM task_tags WHERE task_id = ?').run(id);
    const insert = q('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)');
    for (const tag of list) insert.run(id, tag);
    return list;
  },
  create({ project_id, title, description = '', status = 'ready', tags = [],
    harness = null, provider = null, model = null }) {
    const { next_task_number: number } = q('SELECT next_task_number FROM projects WHERE id = ?')
      .get(project_id);
    q('UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = ?').run(project_id);
    const { lastInsertRowid } = q(`
      INSERT INTO tasks (project_id, number, title, description, status, harness, provider, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project_id, number, title, description, status, harness, provider, model);
    const id = Number(lastInsertRowid);
    tasks.setTags(id, tags);
    return tasks.get(id);
  },
  update(id, { title, description, status, tags, harness, provider, model }) {
    const cur = tasks.get(id);
    if (!cur) return null;
    q(`UPDATE tasks SET title = ?, description = ?, harness = ?, provider = ?, model = ?,
       updated_at = datetime('now') WHERE id = ?`).run(
      title ?? cur.title,
      description ?? cur.description,
      // Absent leaves the override alone; empty clears it back to following the default.
      harness === undefined ? cur.harness : (harness || null),
      provider === undefined ? cur.provider : (provider || null),
      model === undefined ? cur.model : (model || null),
      id
    );
    if (status !== undefined && status !== cur.status) tasks.setStatus(id, status);
    if (tags !== undefined) tasks.setTags(id, tags);
    return tasks.get(id);
  },
  /** Preserve the resolved agent used by a run, even when the task follows mutable defaults. */
  recordAgent(id, { harness, provider, model }) {
    q(`UPDATE tasks SET last_harness = ?, last_provider = ?, last_model = ? WHERE id = ?`)
      .run(harness, provider, model, id);
    return tasks.get(id);
  },
  /** A grade snapshots the run identity so a later retry cannot rewrite the chart's history. */
  setGrade(id, grade, { harness, provider, model } = {}) {
    if (grade === null) {
      q(`UPDATE tasks SET grade = NULL, graded_at = NULL, graded_harness = NULL,
         graded_provider = NULL, graded_model = NULL, updated_at = datetime('now') WHERE id = ?`)
        .run(id);
    } else {
      q(`UPDATE tasks SET grade = ?, graded_at = datetime('now'), graded_harness = ?,
         graded_provider = ?, graded_model = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(grade, harness, provider, model, id);
    }
    return tasks.get(id);
  },
  /**
   * Entering and leaving 'active' are what bracket a run, so the clock lives here.
   * `resume` is for a comment that reopens a closed task: the elapsed time already on the clock
   * is kept and the timer starts ticking again, rather than starting from zero.
   */
  setStatus(id, status, { resume = false } = {}) {
    const cur = q('SELECT status, started_at, finished_at FROM tasks WHERE id = ?').get(id);
    if (!cur) return null;
    let clock = '';
    const args = [status];
    if (status === 'active' && cur.status !== 'active') {
      if (resume && cur.started_at) {
        // Slide the start forward by the idle gap so the live timer shows prior work + this session.
        const start = Date.parse(String(cur.started_at).replace(' ', 'T') + 'Z');
        const end = cur.finished_at
          ? Date.parse(String(cur.finished_at).replace(' ', 'T') + 'Z')
          : Date.now();
        const elapsedSec = Number.isFinite(start) && Number.isFinite(end)
          ? Math.max(0, Math.round((end - start) / 1000))
          : 0;
        clock = `, started_at = datetime('now', ?), finished_at = NULL`;
        args.push(`-${elapsedSec} seconds`);
      } else {
        clock = `, started_at = datetime('now'), finished_at = NULL`;
      }
    } else if (cur.status === 'active' && status !== 'active') {
      clock = `, finished_at = datetime('now')`;
    }
    args.push(id);
    q(`UPDATE tasks SET status = ?${clock}, updated_at = datetime('now') WHERE id = ?`).run(...args);
    return tasks.get(id);
  },
  setLogFile(id, logFile) {
    q('UPDATE tasks SET log_file = ? WHERE id = ?').run(logFile, id);
  },
  remove(id) {
    return q('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
  },
};

const GRADES = ['F', 'D-', 'D', 'D+', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+'];

const performance = {
  list() {
    return q(`
      SELECT t.id AS task_id, t.number AS task_number, t.title AS task_title,
             p.id AS project_id, p.name AS project_name, t.grade, t.graded_at,
             t.graded_harness AS harness, t.graded_provider AS provider,
             t.graded_model AS model
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.grade IS NOT NULL
      ORDER BY t.graded_at, t.id
    `).all();
  },
};

const comments = {
  listForTask(taskId) {
    return q('SELECT * FROM comments WHERE task_id = ? ORDER BY id').all(taskId);
  },
  create({ task_id, author = 'user', body }) {
    const { lastInsertRowid } = q(
      'INSERT INTO comments (task_id, author, body) VALUES (?, ?, ?)'
    ).run(task_id, author, body);
    return q('SELECT * FROM comments WHERE id = ?').get(Number(lastInsertRowid));
  },
  remove(id) {
    return q('DELETE FROM comments WHERE id = ?').run(id).changes > 0;
  },
};

/**
 * Every agent process is recorded here before it starts, so a later run of the app can find
 * processes its predecessor left behind instead of losing track of them.
 */
const runs = {
  start({ task_id, pid, image = null, log_file = null, worktree = null, branch = null, base = null,
    kind = 'task' }) {
    const { lastInsertRowid } = q(`
      INSERT INTO agent_runs (task_id, pid, server_pid, image, log_file, worktree, branch, base, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task_id, pid, process.pid, image, log_file, worktree, branch, base, kind);
    return runs.get(Number(lastInsertRowid));
  },
  get(id) {
    return q('SELECT * FROM agent_runs WHERE id = ?').get(id);
  },
  end(id) {
    return q(`UPDATE agent_runs SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL`)
      .run(id).changes > 0;
  },
  open() {
    return q(`
      SELECT r.*, t.title AS task_title, t.status AS task_status,
             p.name AS project_name, p.directory AS project_directory
      FROM agent_runs r
      JOIN tasks t ON t.id = r.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE r.ended_at IS NULL
      ORDER BY r.started_at, r.id
    `).all();
  },
};

const BUILTIN_STATUSES = ['ready', 'active', 'completed'];

/** Offered on every task's right-click menu. Stored lower-case like any other tag. */
const BUILTIN_QUICK_TAGS = ['needs review', 'reviewed', 'verified'];

const quickTags = {
  /**
   * Unlike the tag filters, this list is not derived from the tags in use: a tag the user adds here
   * has to keep appearing on the menu even when no task currently carries it.
   */
  list() {
    const custom = q('SELECT tag FROM quick_tags ORDER BY tag').all()
      .map((r) => r.tag)
      .filter((t) => !BUILTIN_QUICK_TAGS.includes(t));
    return { builtin: BUILTIN_QUICK_TAGS, custom };
  },
  add(input) {
    const [tag] = normalizeTags(input);
    if (!tag) return null;
    if (!BUILTIN_QUICK_TAGS.includes(tag)) {
      q('INSERT OR IGNORE INTO quick_tags (tag) VALUES (?)').run(tag);
    }
    return tag;
  },
};

const settings = {
  get(key) {
    return q('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  },
  set(key, value) {
    q(`INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
      .run(key, String(value));
  },
};

function allTags() {
  return q(`
    SELECT tt.tag, COUNT(*) AS count
    FROM task_tags tt
    GROUP BY tt.tag
    ORDER BY tt.tag
  `).all();
}

function allStatuses() {
  const custom = q('SELECT DISTINCT status FROM tasks ORDER BY status').all()
    .map((r) => r.status)
    .filter((s) => !BUILTIN_STATUSES.includes(s));
  return { builtin: BUILTIN_STATUSES, custom };
}

const usageLib = require('./usage');

const emptyTotals = { tasks: 0, runs: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_usd: 0 };

const usage = {
  has(logFile, model) {
    if (!logFile || !model) return false;
    return Boolean(q('SELECT 1 FROM llm_usage WHERE log_file = ? AND model = ?').get(logFile, model));
  },
  record(row) {
    q(`INSERT OR IGNORE INTO llm_usage
       (run_id, task_id, log_file, harness, provider, model, channel,
        input_tokens, cached_tokens, output_tokens, cost_usd, cost_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.run_id ?? null,
      row.task_id ?? null,
      row.log_file ?? null,
      row.harness ?? null,
      row.provider ?? 'native',
      row.model,
      row.channel,
      row.input_tokens || 0,
      row.cached_tokens || 0,
      row.output_tokens || 0,
      row.cost_usd ?? null,
      row.cost_source ?? null,
    );
  },
  recordParsed({ run_id, task_id, log_file, harness, provider, model, parsed }) {
    if (!parsed || !parsed.models || !parsed.models.length) return 0;
    let n = 0;
    for (const raw of parsed.models) {
      const row = usageLib.finishRow(raw, {
        model,
        harness: parsed.harness || harness,
        provider: provider || 'native',
      });
      usage.record({
        run_id,
        task_id,
        log_file,
        harness: row.harness,
        provider: row.provider,
        model: row.model,
        channel: row.channel,
        input_tokens: row.input,
        cached_tokens: row.cached,
        output_tokens: row.output,
        cost_usd: row.costUsd,
        cost_source: row.costSource,
      });
      n++;
    }
    return n;
  },
  report() {
    const models = q(`
      SELECT channel, harness, provider, model,
             COUNT(DISTINCT task_id) AS tasks,
             COUNT(*) AS runs,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             SUM(cost_usd) AS cost_usd
      FROM llm_usage
      GROUP BY channel, harness, provider, model
      ORDER BY COALESCE(cost_usd, 0) DESC, model
    `).all();
    const totals = q(`
      SELECT channel,
             COUNT(DISTINCT task_id) AS tasks,
             COUNT(*) AS runs,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             SUM(cost_usd) AS cost_usd
      FROM llm_usage
      GROUP BY channel
    `).all();
    const pack = (channel) => ({
      models: models.filter((r) => r.channel === channel),
      totals: totals.find((r) => r.channel === channel) || { channel, ...emptyTotals },
    });
    return { subscription: pack('subscription'), api: pack('api') };
  },
};

module.exports = {
  db, projects, tasks, comments, checklist, runs, quickTags, settings, performance, usage,
  allStatuses, allTags, normalizeTags, BUILTIN_STATUSES, BUILTIN_QUICK_TAGS, DB_PATH,
  GRADES,
};
