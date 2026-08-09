'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { projects, tasks, comments, allStatuses, allTags, quickTags } = require('./db');
const agent = require('./agent');
const events = require('./events');
const attachments = require('./attachments');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) return reject(new Error('Attachment is too large'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
  send(res, 200, fs.readFileSync(file), { 'Content-Type': attachments.mimeFor(file) });
}

function serveAttachment(res, pathname) {
  const file = attachments.resolve(pathname);
  if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  send(res, 200, fs.readFileSync(file), {
    'Content-Type': attachments.mimeFor(file),
    // Uploads are user content served from the app's own origin: stop the browser sniffing a type we
    // did not intend, and stop an SVG or HTML upload running script if it is opened directly.
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
}

function withComments(task) {
  return { ...task, comments: comments.listForTask(task.id), running: agent.isRunning(task.id) };
}

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, a, b, c] = seg;
  const method = req.method;

  // /api/events — the open stream that keeps every tab current
  if (a === 'events' && method === 'GET') return events.subscribe(req, res);

  // /api/attachments — the body is the file itself, so there is no multipart envelope to parse.
  // The name rides in a header, percent-encoded because header values cannot carry arbitrary text.
  if (a === 'attachments' && method === 'POST') {
    let name = 'file';
    try { name = decodeURIComponent(req.headers['x-filename'] || '') || 'file'; } catch { /* keep the default */ }
    const buf = await readRaw(req, attachments.MAX_BYTES);
    if (!buf.length) return json(res, 400, { error: 'Attachment is empty' });
    return json(res, 201, attachments.save(name, buf));
  }

  const body = method === 'POST' || method === 'PUT' ? await readBody(req) : {};

  // /api/statuses
  if (a === 'statuses' && method === 'GET') return json(res, 200, allStatuses());

  // /api/tags
  if (a === 'tags' && method === 'GET') return json(res, 200, allTags());

  // /api/quick-tags — the set offered on a task's right-click menu
  if (a === 'quick-tags') {
    if (method === 'GET') return json(res, 200, quickTags.list());
    if (method === 'POST') {
      const tag = quickTags.add(body.tag);
      if (!tag) return json(res, 400, { error: 'Tag cannot be empty' });
      // The tag comes back normalised, so the caller can apply it without guessing at the rules.
      return json(res, 201, { tag, ...quickTags.list() });
    }
  }

  // /api/config
  if (a === 'config' && method === 'GET') {
    return json(res, 200, { model: agent.MODEL, claudeBin: agent.CLAUDE_BIN });
  }

  // /api/projects...
  if (a === 'projects') {
    if (!b) {
      if (method === 'GET') return json(res, 200, projects.list());
      if (method === 'POST') {
        if (!body.name?.trim()) return json(res, 400, { error: 'Project name is required' });
        return json(res, 201, projects.create({
          name: body.name.trim(),
          description: body.description || '',
          directory: body.directory || '',
        }));
      }
    } else {
      const id = Number(b);
      if (!Number.isInteger(id)) return json(res, 400, { error: 'Invalid project id' });

      if (!c) {
        if (method === 'GET') {
          const p = projects.get(id);
          return p ? json(res, 200, p) : json(res, 404, { error: 'Project not found' });
        }
        if (method === 'PUT') {
          const p = projects.update(id, body);
          return p ? json(res, 200, p) : json(res, 404, { error: 'Project not found' });
        }
        if (method === 'DELETE') {
          return projects.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Project not found' });
        }
      }

      if (c === 'tasks') {
        if (method === 'GET') {
          return json(res, 200, tasks.list({
            projectId: id,
            status: url.searchParams.get('status') || null,
            tag: url.searchParams.get('tag') || null,
          }));
        }
        if (method === 'POST') {
          if (!projects.get(id)) return json(res, 404, { error: 'Project not found' });
          if (!body.title?.trim()) return json(res, 400, { error: 'Task title is required' });
          return json(res, 201, tasks.create({
            project_id: id,
            title: body.title.trim(),
            description: body.description || '',
            status: (body.status || 'ready').trim() || 'ready',
            tags: body.tags ?? [],
          }));
        }
      }

      if (c === 'run-ready' && method === 'POST') {
        if (!projects.get(id)) return json(res, 404, { error: 'Project not found' });
        return json(res, 200, { started: agent.runReady(id) });
      }

      if (c === 'run-failed' && method === 'POST') {
        if (!projects.get(id)) return json(res, 404, { error: 'Project not found' });
        return json(res, 200, { started: agent.runFailed(id) });
      }
    }
  }

  // /api/tasks...
  if (a === 'tasks') {
    if (!b && method === 'GET') {
      return json(res, 200, tasks.list({
        status: url.searchParams.get('status') || null,
        tag: url.searchParams.get('tag') || null,
      }));
    }
    const id = Number(b);
    if (!Number.isInteger(id)) return json(res, 400, { error: 'Invalid task id' });

    if (!c) {
      if (method === 'GET') {
        const t = tasks.get(id);
        return t ? json(res, 200, withComments(t)) : json(res, 404, { error: 'Task not found' });
      }
      if (method === 'PUT') {
        if (body.title !== undefined && !body.title.trim()) {
          return json(res, 400, { error: 'Task title is required' });
        }
        const t = tasks.update(id, body);
        return t ? json(res, 200, withComments(t)) : json(res, 404, { error: 'Task not found' });
      }
      if (method === 'DELETE') {
        if (agent.isRunning(id)) return json(res, 409, { error: 'Stop the agent before deleting this task' });
        return tasks.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Task not found' });
      }
    }

    if (c === 'comments' && method === 'POST') {
      if (!tasks.get(id)) return json(res, 404, { error: 'Task not found' });
      if (!body.body?.trim()) return json(res, 400, { error: 'Comment cannot be empty' });
      return json(res, 201, comments.create({
        task_id: id,
        author: body.author === 'agent' ? 'agent' : 'user',
        body: body.body.trim(),
      }));
    }

    if (c === 'run' && method === 'POST') {
      try {
        return json(res, 200, withComments(agent.runTask(id)));
      } catch (err) {
        return json(res, 409, { error: err.message });
      }
    }

    if (c === 'stop' && method === 'POST') {
      return agent.stopTask(id)
        ? json(res, 200, { ok: true })
        : json(res, 409, { error: 'No agent is running for this task' });
    }

    if (c === 'log' && method === 'GET') {
      const log = agent.readLog(id);
      return log === null
        ? send(res, 404, 'No log recorded for this task yet.', { 'Content-Type': 'text/plain; charset=utf-8' })
        : send(res, 200, log, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  }

  // /api/agents
  if (a === 'agents') {
    if (!b && method === 'GET') return json(res, 200, agent.listAgents());
    if (b && c === 'stop' && method === 'POST') {
      return agent.killAgent(Number(b))
        ? json(res, 200, { ok: true })
        : json(res, 409, { error: 'That agent is no longer running' });
    }
  }

  // /api/comments/:id
  if (a === 'comments' && b && method === 'DELETE') {
    return comments.remove(Number(b)) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Comment not found' });
  }

  json(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (url.pathname.startsWith(attachments.URL_PREFIX)) serveAttachment(res, url.pathname);
    else serveStatic(req, res, url.pathname);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  const r = agent.adoptOrphans();
  if (r.adopted) console.log(`reattached to ${r.adopted} agent(s) still running from a previous session`);
  if (r.closed) console.log(`closed ${r.closed} stale agent run record(s)`);
  if (r.reset) console.log(`reset ${r.reset} task(s) left active by a previous run`);
  console.log(`Vibe Wrangler running at http://localhost:${PORT}`);
  console.log(`agent: ${agent.CLAUDE_BIN} --model ${agent.MODEL} --dangerously-skip-permissions`);
});

module.exports = server;
