'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  view: 'project', // 'project' | 'all'
  projects: [],
  projectId: null,
  filter: 'all',
  tagFilter: null,
  tasks: [],
  tags: [],
  task: null,
  statuses: { builtin: ['ready', 'active', 'completed'], custom: [] },
  showChecklists: localStorage.getItem('showChecklists') === '1',
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

/** SQLite hands back naive UTC ("2026-08-09 14:03:11"), so pin the zone before parsing. */
function parseTs(ts) {
  if (!ts) return null;
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
}

function when(ts) {
  const d = parseTs(ts);
  return d ? d.toLocaleString() : (ts || '');
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Live element for active runs, frozen total once the run has ended. */
function elapsedEl(task) {
  const started = parseTs(task.started_at);
  if (!started) return null;
  const running = task.status === 'active';
  const finished = parseTs(task.finished_at);
  if (!running && !finished) return null;

  const el = document.createElement('span');
  el.className = 'elapsed' + (running ? ' running' : '');
  if (running) {
    el.dataset.since = started.toISOString();
    el.textContent = fmtElapsed(Date.now() - started);
  } else {
    el.textContent = fmtElapsed(finished - started);
  }
  return el;
}

function tickElapsed() {
  const now = Date.now();
  for (const el of document.querySelectorAll('.elapsed[data-since]')) {
    el.textContent = fmtElapsed(now - new Date(el.dataset.since));
  }
}

/* ---------- Projects ---------- */

async function loadProjects() {
  state.projects = await api('GET', '/api/projects');

  const total = state.projects.reduce((n, p) => n + p.task_count, 0);
  const ready = state.projects.reduce((n, p) => n + p.ready_count, 0);
  $('allTasksCount').textContent =
    `${total} task${total === 1 ? '' : 's'} in ${state.projects.length} project${state.projects.length === 1 ? '' : 's'} · ${ready} ready`;
  $('allTasksBtn').classList.toggle('selected', state.view === 'all');

  const list = $('projectList');
  list.replaceChildren();
  for (const p of state.projects) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = state.view === 'project' && p.id === state.projectId ? 'selected' : '';
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
  state.view = 'project';
  state.projectId = id;
  state.filter = 'all';
  state.tagFilter = null;
  await loadProjects();
  await loadTasks();
});

const selectAllTasks = run(async () => {
  state.view = 'all';
  state.filter = 'all';
  state.tagFilter = null;
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

async function loadTags() {
  state.tags = await api('GET', '/api/tags');
  const dl = $('tagOptions');
  dl.replaceChildren();
  for (const t of state.tags) {
    const o = document.createElement('option');
    o.value = t.tag;
    dl.append(o);
  }
}

function renderTagFilters() {
  const present = [...new Set(state.tasks.flatMap((t) => t.tags))].sort();
  $('tagLabel').hidden = present.length === 0;
  const box = $('tagFilters');
  box.replaceChildren();
  if (!present.length) return;

  const mk = (label, value, count) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm' + (state.tagFilter === value ? ' active' : '');
    b.textContent = count === null ? label : `${label} (${count})`;
    b.onclick = () => {
      state.tagFilter = state.tagFilter === value ? null : value;
      renderTasks();
      renderTagFilters();
      renderFilters();
    };
    return b;
  };
  box.append(mk('any', null, null));
  for (const tag of present) {
    box.append(mk(tag, tag, state.tasks.filter((t) => t.tags.includes(tag)).length));
  }
}

function checklistEl(items, mini) {
  const ul = document.createElement('ul');
  ul.className = 'checklist' + (mini ? ' checklist-mini' : '');
  for (const item of items) {
    const li = document.createElement('li');
    li.className = item.done ? 'done' : '';
    const mark = document.createElement('span');
    mark.className = 'check-mark';
    mark.textContent = item.done ? '\u2713' : '\u25cb';
    const text = document.createElement('span');
    text.className = 'check-text';
    text.textContent = item.text;
    li.append(mark, text);
    ul.append(li);
  }
  return ul;
}

const checklistProgress = (items) => `${items.filter((i) => i.done).length}/${items.length}`;

const taggedTasks = () =>
  state.tagFilter ? state.tasks.filter((t) => t.tags.includes(state.tagFilter)) : state.tasks;

const visibleTasks = () =>
  taggedTasks().filter((t) => state.filter === 'all' || t.status === state.filter);

function renderFilters() {
  const pool = taggedTasks();
  const known = [...new Set([...state.statuses.builtin, ...state.statuses.custom,
    ...state.tasks.map((t) => t.status)])];
  const box = $('statusFilters');
  box.replaceChildren();
  for (const f of ['all', ...known]) {
    const b = document.createElement('button');
    b.className = 'btn btn-sm' + (state.filter === f ? ' active' : '');
    const n = f === 'all' ? pool.length : pool.filter((t) => t.status === f).length;
    b.textContent = `${f} (${n})`;
    b.onclick = () => { state.filter = f; renderTasks(); renderFilters(); renderTagFilters(); };
    box.append(b);
  }
}

async function loadTasks() {
  const projectOnly = ['editProjectBtn', 'deleteProjectBtn', 'runReadyBtn', 'runFailedBtn', 'newTaskBtn'];

  if (state.view === 'all') {
    $('emptyState').hidden = true;
    $('projectPane').hidden = false;
    for (const id of projectOnly) $(id).hidden = true;
    $('projectName').textContent = 'All tasks';
    state.tasks = await api('GET', '/api/tasks');
    const projectCount = new Set(state.tasks.map((t) => t.project_id)).size;
    $('projectMeta').textContent =
      `${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'} across ${projectCount} project${projectCount === 1 ? '' : 's'}`;
  } else {
    const p = state.projects.find((x) => x.id === state.projectId);
    $('emptyState').hidden = !!p;
    $('projectPane').hidden = !p;
    if (!p) return;
    for (const id of projectOnly) $(id).hidden = false;
    $('projectName').textContent = p.name;
    $('projectMeta').textContent = [p.directory || '(no directory set)', p.description].filter(Boolean).join(' — ');
    state.tasks = await api('GET', `/api/projects/${p.id}/tasks`);
  }

  if (state.tagFilter && !state.tasks.some((t) => t.tags.includes(state.tagFilter))) state.tagFilter = null;

  await loadStatuses();
  await loadTags();
  renderFilters();
  renderTagFilters();
  renderTasks();
}

function renderTasks() {
  const list = $('taskList');
  list.replaceChildren();
  const shown = visibleTasks();

  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = state.tasks.length ? 'No tasks match these filters.' : 'No tasks yet — create one.';
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
    const parts = [
      state.view === 'all' ? t.project_name : null,
      `${t.comment_count} comment${t.comment_count === 1 ? '' : 's'}`,
      t.checklist.length ? `checklist ${checklistProgress(t.checklist)}` : null,
      `updated ${when(t.updated_at)}`,
    ].filter(Boolean);
    sub.textContent = parts.join(' · ');

    const elapsed = elapsedEl(t);
    if (elapsed) {
      sub.append(document.createTextNode(t.status === 'active' ? ' · running ' : ' · took '), elapsed);
    }
    main.append(title, sub);

    if (state.showChecklists && t.checklist.length) main.append(checklistEl(t.checklist, true));

    if (t.tags.length) {
      const tagRow = document.createElement('div');
      tagRow.className = 'task-tags';
      for (const tag of t.tags) {
        const chip = document.createElement('span');
        chip.className = 'tag';
        chip.textContent = tag;
        tagRow.append(chip);
      }
      main.append(tagRow);
    }

    li.append(pill, main);
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
  $('detailMeta').replaceChildren(
    document.createTextNode(`${t.project_name} · created ${when(t.created_at)} · updated ${when(t.updated_at)}`)
  );
  const elapsed = elapsedEl(t);
  if (elapsed) {
    $('detailMeta').append(document.createTextNode(t.status === 'active' ? ' · running ' : ' · took '), elapsed);
  }
  $('detailDesc').textContent = t.description || '';

  $('detailChecklistBlock').hidden = !t.checklist.length;
  if (t.checklist.length) {
    $('detailChecklistCount').textContent = checklistProgress(t.checklist);
    $('detailChecklist').replaceWith(Object.assign(checklistEl(t.checklist, false), { id: 'detailChecklist' }));
  }

  const tagRow = $('detailTags');
  tagRow.replaceChildren();
  for (const tag of t.tags) {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = tag;
    tagRow.append(chip);
  }

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
    who.className = 'comment-author';
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

$('allTasksBtn').onclick = selectAllTasks;

function renderChecklistToggle() {
  $('checklistToggle').checked = state.showChecklists;
}
$('checklistToggle').onchange = (e) => {
  state.showChecklists = e.target.checked;
  localStorage.setItem('showChecklists', state.showChecklists ? '1' : '0');
  renderTasks();
};

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
  $('taskForm').tags.value = state.tagFilter || '';
  openDialog('taskDialog');
};
$('detailEditBtn').onclick = () => {
  editingTask = state.task;
  $('taskDialogTitle').textContent = 'Edit task';
  const f = $('taskForm');
  f.title.value = state.task.title;
  f.description.value = state.task.description;
  f.status.value = state.task.status;
  f.tags.value = state.task.tags.join(', ');
  openDialog('taskDialog');
};
$('taskForm').addEventListener('submit', run(async (e) => {
  const f = e.target;
  const payload = {
    title: f.title.value.trim(),
    description: f.description.value.trim(),
    status: f.status.value.trim() || 'ready',
    tags: f.tags.value,
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

$('runFailedBtn').onclick = run(async () => {
  const { started } = await api('POST', `/api/projects/${state.projectId}/run-failed`);
  await loadProjects();
  await loadTasks();
  startPolling();
  toast(started.length ? `Retrying ${started.length} task(s)` : 'No failed tasks');
});

async function renderAgents() {
  const list = $('agentList');
  const agents = await api('GET', '/api/agents');
  list.textContent = '';
  if (!agents.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No agents are running.';
    list.append(li);
    return;
  }
  for (const a of agents) {
    const li = document.createElement('li');
    li.className = 'agent-item';

    const main = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'agent-title';
    title.textContent = a.task_title;
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = [
      a.project_name,
      `pid ${a.pid}`,
      a.branch,
      `since ${when(a.started_at)}`,
      a.mine ? null : 'inherited from an earlier session',
    ].filter(Boolean).join(' · ');
    main.append(title, meta);

    const stop = document.createElement('button');
    stop.className = 'btn btn-danger btn-sm';
    stop.textContent = 'Stop';
    stop.onclick = run(async () => {
      await api('POST', `/api/agents/${a.id}/stop`);
      toast('Stopping agent');
      await renderAgents();
      await loadTasks();
    });

    li.append(main, stop);
    list.append(li);
  }
}

$('agentsBtn').onclick = run(async () => {
  openDialog('agentsDialog');
  await renderAgents();
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
  $('agentInfo').textContent = `agent: ${cfg.claudeBin} · ${cfg.model}`;
  renderChecklistToggle();
  await loadProjects();
  await loadTasks();
  startPolling();
  setInterval(tickElapsed, 1000);
})();
