'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  view: 'project', // 'project' | 'all'
  version: '',
  harnesses: [],
  settings: { harness: '', provider: '', model: '' },
  projects: [],
  projectId: null,
  filter: 'all',
  tagFilter: null,
  tasks: [],
  tags: [],
  task: null,
  statuses: { builtin: ['ready', 'active', 'completed'], custom: [] },
  quickTags: { builtin: [], custom: [] },
  checklistOpen: new Map(),
};

/**
 * Checklists open themselves while a task is active and stay shut otherwise, until the user says
 * otherwise. The choice is remembered against the run it was made for, so starting a fresh run
 * reveals its new checklist instead of honouring a decision about the previous one.
 */
function checklistOpen(t) {
  const choice = state.checklistOpen.get(t.id);
  if (choice && choice.run === (t.started_at || '')) return choice.open;
  return t.status === 'active';
}

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

/* ---------- Attachments ---------- */

/** The one shape the app writes for an attachment, and the only markup it renders back. */
const ATTACHMENT_REF = /(!?)\[([^\]\n]*)\]\((\/attachments\/[^)\s]+)\)/g;

async function uploadFile(file) {
  // A pasted screenshot often arrives nameless, so give it one the agent can make sense of later.
  const name = file.name || `pasted-${Date.now()}.${(file.type.split('/')[1] || 'bin').replace(/\W/g, '')}`;
  const res = await fetch('/api/attachments', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(name),
    },
    body: file,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function insertAtCursor(ta, text) {
  const start = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  ta.value = before + lead + text + ta.value.slice(ta.selectionEnd ?? start);
  ta.selectionStart = ta.selectionEnd = (before + lead + text).length;
  ta.focus();
}

async function attachFiles(ta, fileList) {
  const files = [...fileList];
  if (!files.length) return;
  toast(files.length === 1 ? `Uploading ${files[0].name || 'image'}…` : `Uploading ${files.length} files…`);
  for (const file of files) {
    const { name, url } = await uploadFile(file);
    // Brackets and parens in the name would break the reference we are writing.
    const label = name.replace(/[[\]()]/g, '_');
    insertAtCursor(ta, `${file.type.startsWith('image/') ? '!' : ''}[${label}](${url})\n`);
  }
  toast(files.length === 1 ? 'Attached' : `Attached ${files.length} files`);
}

/** Paste, drop and the button all end the same way: a reference in the text where the caret was. */
function wireAttachments(ta, btn, input) {
  ta.addEventListener('paste', (e) => {
    if (!e.clipboardData?.files.length) return;
    e.preventDefault();
    run(attachFiles)(ta, e.clipboardData.files);
  });
  ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.classList.add('dropping'); });
  ta.addEventListener('dragleave', () => ta.classList.remove('dropping'));
  ta.addEventListener('drop', (e) => {
    ta.classList.remove('dropping');
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    run(attachFiles)(ta, e.dataTransfer.files);
  });
  btn.onclick = () => input.click();
  input.onchange = run(async () => {
    await attachFiles(ta, input.files);
    input.value = '';
  });
}

/**
 * Only the app's own attachment references become elements; every other character stays a text node.
 * That keeps images and downloads inline without opening the door to arbitrary markup in a comment.
 */
function renderBody(el, text) {
  const src = String(text || '');
  el.replaceChildren();
  let last = 0;
  for (const m of src.matchAll(ATTACHMENT_REF)) {
    if (m.index > last) el.append(document.createTextNode(src.slice(last, m.index)));
    const [, isImage, label, url] = m;
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = isImage ? 'att-image' : 'att-file';
    if (isImage) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = label;
      link.append(img);
    } else {
      link.textContent = label || url;
    }
    el.append(link);
    last = m.index + m[0].length;
  }
  if (last < src.length) el.append(document.createTextNode(src.slice(last)));
}

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

async function loadQuickTags() {
  state.quickTags = await api('GET', '/api/quick-tags');
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
  await loadQuickTags();
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

    const open = t.checklist.length && checklistOpen(t);
    let gizmo;
    if (t.checklist.length) {
      gizmo = document.createElement('button');
      gizmo.className = 'icon-btn disclosure';
      gizmo.textContent = open ? '\u25be' : '\u25b8';
      gizmo.title = open ? 'Hide checklist' : 'Show checklist';
      gizmo.setAttribute('aria-expanded', String(open));
      gizmo.onclick = (e) => {
        e.stopPropagation(); // the row itself opens the task
        state.checklistOpen.set(t.id, { run: t.started_at || '', open: !open });
        renderTasks();
      };
    } else {
      gizmo = document.createElement('span');
      gizmo.className = 'disclosure-gap';
    }

    const pill = document.createElement('span');
    pill.className = `pill ${statusClass(t.status)}`;
    pill.textContent = t.status;

    const main = document.createElement('div');
    main.className = 'task-main';
    const title = document.createElement('div');
    title.className = 'task-title';
    const num = document.createElement('span');
    num.className = 'task-number';
    num.textContent = `#${t.number}`;
    title.append(num, document.createTextNode(t.title));
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

    if (open) main.append(checklistEl(t.checklist, true));

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

    li.oncontextmenu = (e) => { e.preventDefault(); openTagMenu(e, t); };

    li.append(gizmo, pill, main);
    list.append(li);
  }
}

/* ---------- Tag menu ---------- */

const closeTagMenu = () => { $('tagMenu').hidden = true; };

function openTagMenu(e, task) {
  const menu = $('tagMenu');
  menu.replaceChildren();

  const row = (label, on, onPick) => {
    const b = document.createElement('button');
    b.className = 'menu-item' + (on ? ' on' : '');
    b.setAttribute('role', 'menuitemcheckbox');
    b.setAttribute('aria-checked', String(on));
    const mark = document.createElement('span');
    mark.className = 'menu-mark';
    mark.textContent = on ? '\u2713' : '';
    const text = document.createElement('span');
    text.className = 'menu-text';
    text.textContent = label;
    b.append(mark, text);
    b.onclick = run(async () => { closeTagMenu(); await onPick(); });
    return b;
  };

  for (const tag of [...state.quickTags.builtin, ...state.quickTags.custom]) {
    menu.append(row(tag, task.tags.includes(tag), () => toggleTaskTag(task, tag)));
  }

  const sep = document.createElement('div');
  sep.className = 'menu-sep';
  const add = row('New tag\u2026', false, async () => {
    const entered = prompt('Tag to add to this task (it joins the menu for every task):');
    if (!entered?.trim()) return;
    const { tag, builtin, custom } = await api('POST', '/api/quick-tags', { tag: entered });
    state.quickTags = { builtin, custom };
    if (!task.tags.includes(tag)) await toggleTaskTag(task, tag);
  });
  add.classList.add('menu-add');
  menu.append(sep, add);

  // Rendered off-screen first so the size is known before it is clamped into the viewport.
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - height - 8)}px`;
}

async function toggleTaskTag(task, tag) {
  const tags = task.tags.includes(tag)
    ? task.tags.filter((t) => t !== tag)
    : [...task.tags, tag];
  await api('PUT', `/api/tasks/${task.id}`, { tags });
  await loadTasks();
  if (state.task?.id === task.id) await refreshTask();
}

document.addEventListener('click', (e) => { if (!e.target.closest('#tagMenu')) closeTagMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTagMenu(); });
window.addEventListener('resize', closeTagMenu);
window.addEventListener('scroll', closeTagMenu, true);

/* ---------- App menu ---------- */

const closeAppMenu = () => { $('appMenu').hidden = true; };

$('menuBtn').onclick = () => {
  const menu = $('appMenu');
  if (!menu.hidden) return closeAppMenu();
  const r = $('menuBtn').getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.hidden = false;
};

// The button toggles itself, so a click on it must not also count as a click outside.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#appMenu, #menuBtn')) closeAppMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAppMenu(); });
window.addEventListener('resize', closeAppMenu);
window.addEventListener('scroll', closeAppMenu, true);

/* ---------- Harnesses ---------- */

const harnessById = (id) => state.harnesses.find((h) => h.id === id);
const harnessName = (id) => harnessById(id)?.name || id;
const providerById = (harnessId, providerId) =>
  harnessById(harnessId)?.providers.find((p) => p.id === providerId);
const modelName = (harnessId, providerId, modelId) =>
  providerById(harnessId, providerId)?.models.find((m) => m.id === modelId)?.name || modelId;

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

/** A provider worth naming is one the human chose; "Native" is just where the models live. */
const describe = (harnessId, providerId, modelId) => {
  const provider = providerById(harnessId, providerId);
  const via = provider && provider.id !== 'native' ? ` via ${provider.name}` : '';
  return `${harnessName(harnessId)} · ${modelName(harnessId, providerId, modelId)}${via}`;
};

const defaultLabel = () =>
  describe(state.settings.harness, state.settings.provider, state.settings.model);

/** What a task will actually run with — its own choice, or the default it is still following. */
function harnessLabel(t) {
  if (!t.harness) return `${defaultLabel()} (default)`;
  const provider = providerById(t.harness, t.provider) || harnessById(t.harness)?.providers[0];
  return describe(t.harness, provider?.id, t.model || provider?.models[0].id);
}

/**
 * The three selects cascade: a provider belongs to a harness and a model to a provider, so each list
 * is rebuilt from the one above it, and a choice that does not exist under the new parent falls back
 * to its first entry rather than leaving the select on something unrunnable.
 */
const TASK_SELECTS = { harness: 'taskHarness', provider: 'taskProvider', model: 'taskModel' };
const SETTINGS_SELECTS = {
  harness: 'settingsHarness', provider: 'settingsProvider', model: 'settingsModel',
};

function fillModels(ids, model) {
  const p = providerById($(ids.harness).value, $(ids.provider).value);
  const sel = $(ids.model);
  sel.replaceChildren(...p.models.map((m) => option(m.id, m.name)));
  sel.value = p.models.some((m) => m.id === model) ? model : p.models[0].id;
}

function fillProviders(ids, provider, model) {
  const h = harnessById($(ids.harness).value);
  const sel = $(ids.provider);
  sel.replaceChildren(...h.providers.map((p) => option(p.id, p.name)));
  sel.value = h.providers.some((p) => p.id === provider) ? provider : h.providers[0].id;
  fillModels(ids, model);
  sel.onchange = () => fillModels(ids, null);
}

function fillHarness(ids, { harness, provider, model }) {
  const sel = $(ids.harness);
  sel.replaceChildren(...state.harnesses.map((h) => option(h.id, h.name)));
  sel.value = harnessById(harness) ? harness : state.harnesses[0].id;
  fillProviders(ids, provider, model);
  sel.onchange = () => fillProviders(ids, null, null);
}

/** A task that has not chosen opens showing the default, which is what it would run with today. */
const fillTaskHarness = (task) => fillHarness(TASK_SELECTS, {
  harness: task?.harness || state.settings.harness,
  provider: task?.provider || state.settings.provider,
  model: task?.model || state.settings.model,
});

/** The harnesses the app can drive at all — a fact about the build, not about the current default. */
function showAgentInfo() {
  $('agentInfo').textContent = state.harnesses.map((h) => h.name).join(', ');
}

/* ---------- Task drawer ---------- */

const openTask = run(async (id) => {
  state.task = await api('GET', `/api/tasks/${id}`);
  renderTask();
  $('drawer').hidden = false;
  $('drawerScrim').hidden = false;
});

function closeDrawer() {
  $('drawer').hidden = true;
  $('drawerScrim').hidden = true;
  state.task = null;
}

function renderTask() {
  const t = state.task;
  if (!t) return;
  $('detailStatus').className = `pill ${statusClass(t.status)}`;
  $('detailStatus').textContent = t.status;
  const detailNum = document.createElement('span');
  detailNum.className = 'task-number';
  detailNum.textContent = `#${t.number}`;
  $('detailTitle').replaceChildren(detailNum, document.createTextNode(t.title));
  $('detailMeta').replaceChildren(
    document.createTextNode(`${t.project_name} · created ${when(t.created_at)}`
      + ` · updated ${when(t.updated_at)} · ${harnessLabel(t)}`)
  );
  const elapsed = elapsedEl(t);
  if (elapsed) {
    $('detailMeta').append(document.createTextNode(t.status === 'active' ? ' · running ' : ' · took '), elapsed);
  }
  renderBody($('detailDesc'), t.description);

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
    renderBody(body, c.body);
    li.append(head, body);
    list.append(li);
  }
}

async function refreshTask() {
  if (!state.task) return;
  state.task = await api('GET', `/api/tasks/${state.task.id}`);
  renderTask();
}

let syncing = false;
let syncAgain = false;

/**
 * Refetches whatever is on screen. Every server notification lands here.
 *
 * A notification that arrives mid-sync cannot simply be ignored: the fetches already in flight may
 * have read the server before that write landed, and the server never repeats itself. So it is
 * remembered and the whole pass runs again — otherwise the board keeps whatever it happened to read
 * and stays wrong until the next write or the 30s backstop, which is what "started the agent but the
 * task still says ready" looked like.
 */
async function syncAll() {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    do {
      syncAgain = false;
      await loadProjects();
      await loadTasks();
      if (state.task) await refreshTask();
    } while (syncAgain);
  } catch { /* the stream will tell us again */ } finally {
    syncing = false;
  }
}

/**
 * The server greets every connection with a frame before it sends any real ones, so reconnecting
 * after a dropped stream resyncs on its own — we never have to reason about what we missed.
 */
function connectEvents() {
  new EventSource('/api/events').onmessage = syncAll;
  // There is no Refresh button any more, so this is the only way back from a notification that
  // never arrived — from a write made outside this server, say.
  setInterval(syncAll, 30000);
}

/* ---------- Dialogs ---------- */

function openDialog(id) { $(id).showModal(); }

document.addEventListener('click', (e) => {
  const id = e.target.dataset?.close;
  if (id) $(id).close();
});

$('allTasksBtn').onclick = selectAllTasks;

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
  fillTaskHarness(null);
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
  fillTaskHarness(state.task);
  openDialog('taskDialog');
};
$('taskForm').addEventListener('submit', run(async (e) => {
  const f = e.target;
  // A pick that matches the default is stored as no pick at all, so the task goes on following
  // Settings instead of freezing today's answer the moment anyone opens this dialog.
  const choice = (name) => (f[name].value === state.settings[name] ? '' : f[name].value);
  const payload = {
    title: f.title.value.trim(),
    description: f.description.value.trim(),
    status: f.status.value.trim() || 'ready',
    tags: f.tags.value,
    harness: choice('harness'),
    provider: choice('provider'),
    model: choice('model'),
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
  toast(started.length ? `Started ${started.length} task(s)` : 'No ready tasks');
});

$('runFailedBtn').onclick = run(async () => {
  const { started } = await api('POST', `/api/projects/${state.projectId}/run-failed`);
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

function openSettings() {
  fillHarness(SETTINGS_SELECTS, state.settings);
  openDialog('settingsDialog');
}

$('settingsForm').addEventListener('submit', run(async () => {
  state.settings = await api('PUT', '/api/settings', {
    harness: $('settingsHarness').value,
    provider: $('settingsProvider').value,
    model: $('settingsModel').value,
  });
  showAgentInfo();
  // Every task following the default now reads differently, on the board and in the drawer.
  await loadTasks();
  if (state.task) renderTask();
  toast('Settings saved');
}));

function openAbout() {
  $('aboutVersion').textContent = state.version;
  $('aboutHarnesses').textContent = state.harnesses.map((h) => h.name).join(', ');
  $('aboutDefault').textContent = defaultLabel();
  openDialog('aboutDialog');
}

$('settingsMenuBtn').onclick = () => { closeAppMenu(); openSettings(); };
$('aboutMenuBtn').onclick = () => { closeAppMenu(); openAbout(); };

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

/* ---------- Boot ---------- */

wireAttachments($('taskForm').description, $('taskAttachBtn'), $('taskAttachInput'));
wireAttachments($('commentForm').body, $('commentAttachBtn'), $('commentAttachInput'));

run(async () => {
  const cfg = await api('GET', '/api/config');
  state.version = cfg.version;
  state.harnesses = cfg.harnesses;
  state.settings = await api('GET', '/api/settings');
  showAgentInfo();
  await loadProjects();
  await loadTasks();
  connectEvents();
  setInterval(tickElapsed, 1000);
})();
