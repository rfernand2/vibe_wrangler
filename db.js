'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.LLM_TASKS_DB || path.join(__dirname, 'data', 'llm_tasks.db');

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
}
addColumn('tasks', 'started_at', 'TEXT');
addColumn('tasks', 'finished_at', 'TEXT');

const q = (sql) => db.prepare(sql);

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
    `).all();
  },
  get(id) {
    return q('SELECT * FROM projects WHERE id = ?').get(id);
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
      ORDER BY t.updated_at DESC, t.id DESC
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
  create({ project_id, title, description = '', status = 'ready', tags = [] }) {
    const { lastInsertRowid } = q(
      'INSERT INTO tasks (project_id, title, description, status) VALUES (?, ?, ?, ?)'
    ).run(project_id, title, description, status);
    const id = Number(lastInsertRowid);
    tasks.setTags(id, tags);
    return tasks.get(id);
  },
  update(id, { title, description, status, tags }) {
    const cur = tasks.get(id);
    if (!cur) return null;
    q(`UPDATE tasks SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?`).run(
      title ?? cur.title,
      description ?? cur.description,
      id
    );
    if (status !== undefined && status !== cur.status) tasks.setStatus(id, status);
    if (tags !== undefined) tasks.setTags(id, tags);
    return tasks.get(id);
  },
  /** Entering and leaving 'active' are what bracket a run, so the clock lives here. */
  setStatus(id, status) {
    const cur = q('SELECT status FROM tasks WHERE id = ?').get(id);
    if (!cur) return null;
    let clock = '';
    if (status === 'active' && cur.status !== 'active') clock = `, started_at = datetime('now'), finished_at = NULL`;
    else if (cur.status === 'active' && status !== 'active') clock = `, finished_at = datetime('now')`;
    q(`UPDATE tasks SET status = ?${clock}, updated_at = datetime('now') WHERE id = ?`).run(status, id);
    return tasks.get(id);
  },
  setLogFile(id, logFile) {
    q('UPDATE tasks SET log_file = ? WHERE id = ?').run(logFile, id);
  },
  remove(id) {
    return q('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
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

const BUILTIN_STATUSES = ['ready', 'active', 'completed'];

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

module.exports = {
  db, projects, tasks, comments, checklist,
  allStatuses, allTags, normalizeTags, BUILTIN_STATUSES, DB_PATH,
};
