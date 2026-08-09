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

  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
`);

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

const tasks = {
  list({ projectId = null, status = null } = {}) {
    const where = [];
    const args = [];
    if (projectId != null) { where.push('t.project_id = ?'); args.push(projectId); }
    if (status) { where.push('t.status = ?'); args.push(status); }
    const sql = `
      SELECT t.*, p.name AS project_name, p.directory AS project_directory,
             (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.updated_at DESC, t.id DESC
    `;
    return q(sql).all(...args);
  },
  get(id) {
    return q(`
      SELECT t.*, p.name AS project_name, p.directory AS project_directory
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = ?
    `).get(id);
  },
  create({ project_id, title, description = '', status = 'ready' }) {
    const { lastInsertRowid } = q(
      'INSERT INTO tasks (project_id, title, description, status) VALUES (?, ?, ?, ?)'
    ).run(project_id, title, description, status);
    return tasks.get(Number(lastInsertRowid));
  },
  update(id, { title, description, status }) {
    const cur = tasks.get(id);
    if (!cur) return null;
    q(`UPDATE tasks SET title = ?, description = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`).run(
      title ?? cur.title,
      description ?? cur.description,
      status ?? cur.status,
      id
    );
    return tasks.get(id);
  },
  setStatus(id, status) {
    q(`UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
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

function allStatuses() {
  const custom = q('SELECT DISTINCT status FROM tasks ORDER BY status').all()
    .map((r) => r.status)
    .filter((s) => !BUILTIN_STATUSES.includes(s));
  return { builtin: BUILTIN_STATUSES, custom };
}

module.exports = { db, projects, tasks, comments, allStatuses, BUILTIN_STATUSES, DB_PATH };
