'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  projects: [],
  projectId: null,
  filter: 'all',
  tasks: [],
  task: null,
  statuses: { builtin: ['ready', 'active', 'completed'], custom: [] },
};

let poll = null;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

const run = (fn) => (...args) => fn(...args).catch((e) => toast(e.message, true));

function statusClass(s) {
  return ['ready', 'active', 'completed', 'failed'].includes(s) ? s : '';
}

function when(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  return isNaN(d) ? ts : d.toLocaleString();
}

/* ---------- Projects ---------- */

async function loadProjects() {
  state.projects = await api('GET', '/api/projects');
  const list = $('projectList');
  list.replaceChildren();
  for (const p of state.projects) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = p.id === state.projectId ? 'selected' : '';
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;
    const count = document.createElement('span');
    count.className = 'pcount';
    count.textContent = `${p.task_count} task${p.task_count === 1 ? '' : 's'} · ${p.ready_count} ready` +
      (p.active_count ? ` · ${p.active_count} active` : '');
    btn.append(name, count);
    btn.onclick = () => selectProject(p.id);
    li.append(btn);
    list.append(li);
  }
  if (state.projectId && !state.projects.some((p) => p.id === state.projectId)) state.projectId = null;
  if (!state.projectId && state.projects.length) state.projectId = state.projects[0].id;
}

const selectProject = run(async (id) => {
  state.projectId = id;
  state.filter = 'all';
  await loadProjects();
  await loadTasks();
});

/* ---------- Tasks ---------- */

async function loadStatuses() {
  state.statuses = await api('GET', '/api/statuses');
  const dl = $('statusOptions');
  dl.replaceChildren();
  for (const s of [...state.statuses.builtin, 'failed', ...state.statuses.custom]) {
    const o = document.createElement('option');
    o.value = s;
    dl.append(o);
  }
}

function renderFilters() {
  const known = [...new Set([...state.statuses.builtin, ...state.statuses.custom,
    ...state.tasks.map((t) => t.status)])];
  const box = $('statusFilters');
  box.replaceChildren();
  for (const f of ['all', ...known]) {
    const b = document.createElement('button');
    b.className = 'btn btn-sm' + (state.filter === f ? ' active' : '');
    const n = f === 'all' ? state.tasks.length : state.tasks.filter((t) => t.status === f).length;
    b.textContent = `${f} (${n})`;
    b.onclick = () => { state.filter = f; renderTasks(); renderFilters(); };
    box.append(b);
  }
}

async function loadTasks() {
  const p = state.projects.find((x) => x.id === state.projectId);
  $('emptyState').hidden = !!p;
  $('projectPane').hidden = !p;
  if (!p) return;

  $('projectName').textContent = p.name;
  $('projectMeta').textContent = [p.directory || '(no directory set)', p.description].filter(Boolean).join(' — ');

  state.tasks = await api('GET', `/api/projects/${p.id}/tasks`);
  await loadStatuses();
  renderFilters();
  renderTasks();
}

function renderTasks() {
  const list = $('taskList');
  list.replaceChildren();
  const shown = state.filter === 'all' ? state.tasks : state.tasks.filter((t) => t.status === state.filter);

  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = state.tasks.length ? 'No tasks with this status.' : 'No tasks yet — create one.';
    list.append(li);
    return;
  }

  for (const t of shown) {
    const li = document.createElement('li');
    li.className = 'task-item';
    li.onclick = () => openTask(t.id);

    const pill = document.createElement('span');
    pill.className = `pill ${statusClass(t.status)}`;
    pill.textContent = t.status;

    const main = document.createElement('div');
    main.className = 'task-main';
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = t.title;
    const sub = document.createElement('div');
    sub.className = 'task-sub';
    sub.textContent = `${t.comment_count} comment${t.comment_count === 1 ? '' : 's'} · updated ${when(t.updated_at)}`;
    main.append(title, sub);

    li.append(pill, main);
    if (t.status === 'active') {
      const sp = document.createElement('span');
      sp.className = 'spinner';
      li.append(sp);
    }
    list.append(li);
  }
}

/* ---------- Task drawer ---------- */

const openTask = run(async (id) => {
  state.task = await api('GET', `/api/tasks/${id}`);
  renderTask();
  $('drawer').hidden = false;
  $('drawerScrim').hidden = false;
  startPolling();
});

function closeDrawer() {
  $('drawer').hidden = true;
  $('drawerScrim').hidden = true;
  state.task = null;
  stopPolling();
}

function renderTask() {
  const t = state.task;
  if (!t) return;
  $('detailStatus').className = `pill ${statusClass(t.status)}`;
  $('detailStatus').textContent = t.status;
  $('detailTitle').textContent = t.title;
  $('detailMeta').textContent = `${t.project_name} · created ${when(t.created_at)} · updated ${when(t.updated_at)}`;
  $('detailDesc').textContent = t.description || '';

  const busy = t.status === 'active';
  $('detailRunBtn').hidden = busy;
  $('detailRunBtn').disabled = t.status === 'completed' && false;
  $('detailStopBtn').hidden = !busy;
  $('detailLogBtn').hidden = !t.log_file;

  const list = $('commentList');
  list.replaceChildren();
  if (!t.comments.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No comments yet.';
    list.append(li);
  }
  for (const c of t.comments) {
    const li = document.createElement('li');
    li.className = `comment ${c.author}`;
    const head = document.createElement('div');
    head.className = 'comment-head';
    const who = document.createElement('strong');
    who.textContent = c.author;
    const at = document.createElement('span');
    at.textContent = when(c.created_at);
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.style.width = del.style.height = '22px';
    del.style.fontSize = '15px';
    del.textContent = '\u00d7';
    del.title = 'Delete comment';
    del.onclick = run(async () => {
      await api('DELETE', `/api/comments/${c.id}`);
      await refreshTask();
    });
    head.append(who, at, spacer, del);
    const body = document.createElement('div');
    body.className = 'comment-body';
    body.textContent = c.body;
    li.append(head, body);
    list.append(li);
  }
}

async function refreshTask() {
  if (!state.task) return;
  state.task = await api('GET', `/api/tasks/${state.task.id}`);
  renderTask();
}

function startPolling() {
  stopPolling();
  poll = setInterval(async () => {
    try {
      if (state.task) await refreshTask();
      const active = state.tasks.some((t) => t.status === 'active') || state.task?.status === 'active';
      if (active) { await loadProjects(); await loadTasks(); }
    } catch { /* transient */ }
  }, 2500);
}
function stopPolling() {
  if (poll) clearInterval(poll);
  poll = null;
}

/* ---------- Dialogs ---------- */

function openDialog(id) { $(id).showModal(); }

document.addEventListener('click', (e) => {
  const id = e.target.dataset?.close;
  if (id) $(id).close();
});

let editingProject = null;
$('newProjectBtn').onclick = () => {
  editingProject = null;
  $('projectDialogTitle').textContent = 'New project';
  $('projectForm').reset();
  openDialog('projectDialog');
};
$('editProjectBtn').onclick = () => {
  const p = state.projects.find((x) => x.id === state.projectId);
  if (!p) return;
  editingProject = p;
  $('projectDialogTitle').textContent = 'Edit project';
  const f = $('projectForm');
  f.name.value = p.name;
  f.directory.value = p.directory;
  f.description.value = p.description;
  openDialog('projectDialog');
};
$('projectForm').addEventListener('submit', run(async (e) => {
  const f = e.target;
  const payload = {
    name: f.name.value.trim(),
    directory: f.directory.value.trim(),
    description: f.description.value.trim(),
  };
  const saved = editingProject
    ? await api('PUT', `/api/projects/${editingProject.id}`, payload)
    : await api('POST', '/api/projects', payload);
  state.projectId = saved.id;
  await loadProjects();
  await loadTasks();
  toast('Project saved');
}));

$('deleteProjectBtn').onclick = run(async () => {
  const p = state.projects.find((x) => x.id === state.projectId);
  if (!p) return;
  if (!confirm(`Delete project "${p.name}" and all of its tasks?`)) return;
  await api('DELETE', `/api/projects/${p.id}`);
  state.projectId = null;
  await loadProjects();
  await loadTasks();
  toast('Project deleted');
});

let editingTask = null;
$('newTaskBtn').onclick = () => {
  editingTask = null;
  $('taskDialogTitle').textContent = 'New task';
  $('taskForm').reset();
  $('taskForm').status.value = 'ready';
  openDialog('taskDialog');
};
$('detailEditBtn').onclick = () => {
  editingTask = state.task;
  $('taskDialogTitle').textContent = 'Edit task';
  const f = $('taskForm');
  f.title.value = state.task.title;
  f.description.value = state.task.description;
  f.status.value = state.task.status;
  openDialog('taskDialog');
};
$('taskForm').addEventListener('submit', run(async (e) => {
  const f = e.target;
  const payload = {
    title: f.title.value.trim(),
    description: f.description.value.trim(),
    status: f.status.value.trim() || 'ready',
  };
  if (editingTask) await api('PUT', `/api/tasks/${editingTask.id}`, payload);
  else await api('POST', `/api/projects/${state.projectId}/tasks`, payload);
  await loadProjects();
  await loadTasks();
  if (state.task) await refreshTask();
  toast('Task saved');
}));

$('detailDeleteBtn').onclick = run(async () => {
  if (!confirm(`Delete task "${state.task.title}"?`)) return;
  await api('DELETE', `/api/tasks/${state.task.id}`);
  closeDrawer();
  await loadProjects();
  await loadTasks();
  toast('Task deleted');
});

$('detailRunBtn').onclick = run(async () => {
  state.task = await api('POST', `/api/tasks/${state.task.id}/run`);
  renderTask();
  await loadProjects();
  await loadTasks();
  toast('Agent started');
});

$('detailStopBtn').onclick = run(async () => {
  await api('POST', `/api/tasks/${state.task.id}/stop`);
  await refreshTask();
  toast('Stopping agent');
});

$('detailLogBtn').onclick = run(async () => {
  const text = await api('GET', `/api/tasks/${state.task.id}/log`);
  $('logContent').textContent = text;
  openDialog('logDialog');
});

$('runReadyBtn').onclick = run(async () => {
  const { started } = await api('POST', `/api/projects/${state.projectId}/run-ready`);
  await loadProjects();
  await loadTasks();
  startPolling();
  toast(started.length ? `Started ${started.length} task(s)` : 'No ready tasks');
});

$('commentForm').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  const ta = e.target.body;
  if (!ta.value.trim()) return;
  await api('POST', `/api/tasks/${state.task.id}/comments`, { body: ta.value });
  ta.value = '';
  await refreshTask();
  await loadTasks();
}));

$('closeDrawerBtn').onclick = closeDrawer;
$('drawerScrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer();
});

$('refreshBtn').onclick = run(async () => {
  await loadProjects();
  await loadTasks();
  if (state.task) await refreshTask();
});

/* ---------- Boot ---------- */

run(async () => {
  const cfg = await api('GET', '/api/config');
  $('agentInfo').textContent = `agent: ${cfg.claudeBin} · ${cfg.permissionMode}`;
  await loadProjects();
  await loadTasks();
  startPolling();
})();
