// SQL Studio (IDE) — app bootstrap: project lifecycle, file tabs, editor,
// console shell. The visual builder + sync engine mount here in later phases.
'use strict';

const { invoke } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ================= state ================= */

let project = null;      // {root, name, schema, data, journal, queries:[{name,content}]}
let tabs = [];           // {id, label, rel, content, savedContent, readonly}
let activeTab = null;

/* ================= language toggle (persisted) ================= */

let LANG = localStorage.getItem('sqlstudio.lang') === 'plain' ? 'plain' : 'natural';
function applyLang() {
  document.querySelectorAll('#lang-toggle .lang-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === LANG));
}
$('#lang-toggle').addEventListener('click', e => {
  const opt = e.target.closest('.lang-opt');
  if (!opt || opt.dataset.lang === LANG) return;
  LANG = opt.dataset.lang;
  localStorage.setItem('sqlstudio.lang', LANG);
  applyLang();
  // builder re-render hooks in on port (P3)
});
applyLang();

/* ================= recents ================= */

function getRecents() {
  try { return JSON.parse(localStorage.getItem('sqlstudio.recents')) || []; } catch { return []; }
}
function pushRecent(root, name) {
  const rec = getRecents().filter(r => r.root !== root);
  rec.unshift({ root, name, at: Date.now() });
  localStorage.setItem('sqlstudio.recents', JSON.stringify(rec.slice(0, 8)));
}
function renderRecents() {
  const box = $('#recent-list');
  box.textContent = '';
  const rec = getRecents();
  if (!rec.length) return;
  const lab = el('div', 'hint', 'recent');
  lab.style.marginBottom = '4px';
  box.appendChild(lab);
  for (const r of rec) {
    const item = el('button', 'recent-item');
    item.appendChild(el('span', 'rname', r.name));
    item.appendChild(el('span', 'rpath', r.root));
    item.addEventListener('click', () => openProjectAt(r.root));
    box.appendChild(item);
  }
}

/* ================= project lifecycle ================= */

async function pickFolder(title) {
  return await openDialog({ directory: true, title });
}

async function newProject() {
  const dir = await pickFolder('Choose (or create) an empty folder for the project');
  if (!dir) return;
  try {
    enterProject(await invoke('project_create', { path: dir }));
    toast('Project created — schema.sql is yours.');
  } catch (e) { toast(String(e)); }
}

async function openProjectAt(path) {
  try {
    enterProject(await invoke('project_open', { path }));
  } catch (e) { toast(String(e)); }
}

async function openProject() {
  const dir = await pickFolder('Open a SQL Studio project folder');
  if (!dir) return;
  await openProjectAt(dir);
}

function enterProject(p) {
  project = p;
  pushRecent(p.root, p.name);
  $('#project-label').textContent = p.root;
  $('#status-left').textContent = p.name;
  $('#welcome').hidden = true;
  $('#workspace').hidden = false;
  startEngine(p.root);

  tabs = [
    { id: 'schema', label: 'schema.sql', rel: 'schema.sql', content: p.schema, savedContent: p.schema, readonly: false },
    { id: 'data', label: 'data.sql', rel: 'data.sql', content: p.data, savedContent: p.data, readonly: false },
    { id: 'journal', label: 'journal.sql', rel: 'journal.sql', content: p.journal, savedContent: p.journal, readonly: true },
    ...p.queries.map(q => ({
      id: 'q:' + q.name, label: q.name + '.sql', rel: 'queries/' + q.name + '.sql',
      content: q.content, savedContent: q.content, readonly: false
    }))
  ];
  activateTab('schema');
  logNote('project opened: ' + p.root);
}

/* ================= tabs + editor ================= */

const editor = $('#editor');

function tabById(id) { return tabs.find(t => t.id === id); }

function renderTabs() {
  const bar = $('#file-tabs');
  bar.textContent = '';
  for (const t of tabs) {
    const b = el('button', 'ftab' + (activeTab === t.id ? ' active' : ''));
    b.appendChild(el('span', null, t.label));
    if (t.content !== t.savedContent) b.appendChild(el('span', 'dirty', '●'));
    b.addEventListener('click', () => activateTab(t.id));
    bar.appendChild(b);
  }
  const add = el('button', 'ftab add-tab', '+ query');
  add.title = 'new saved query tab';
  add.addEventListener('click', newQueryTab);
  bar.appendChild(add);
}

function activateTab(id) {
  const t = tabById(id);
  if (!t) return;
  activeTab = id;
  editor.value = t.content;
  editor.readOnly = !!t.readonly;
  renderTabs();
}

editor.addEventListener('input', () => {
  const t = tabById(activeTab);
  if (!t || t.readonly) return;
  t.content = editor.value;
  renderTabs();
});

async function saveActive() {
  const t = tabById(activeTab);
  if (!t || t.readonly) return;
  try {
    await invoke('file_write', { rel: t.rel, content: t.content });
    t.savedContent = t.content;
    renderTabs();
    toast(t.label + ' saved');
  } catch (e) { toast(String(e)); }
}

async function newQueryTab() {
  const base = 'query';
  let n = 1;
  while (tabs.some(t => t.id === 'q:' + base + n)) n++;
  const name = base + n;
  const t = {
    id: 'q:' + name, label: name + '.sql', rel: 'queries/' + name + '.sql',
    content: '-- ' + name + '\n', savedContent: null, readonly: false
  };
  tabs.push(t);
  try { await invoke('file_write', { rel: t.rel, content: t.content }); t.savedContent = t.content; }
  catch (e) { toast(String(e)); }
  activateTab(t.id);
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveActive();
  }
});

/* ================= engine ================= */

let engineRunning = false;

function setEngineStatus(text, cls) {
  const s = $('#engine-status');
  s.textContent = text;
  s.className = 'engine-status' + (cls ? ' ' + cls : '');
}

async function startEngine(root) {
  setEngineStatus('● engine: starting…');
  try {
    const info = await invoke('db_start', { projectRoot: root });
    engineRunning = true;
    setEngineStatus('● engine: running on 127.0.0.1:' + info.port, 'ok');
    $('#status-right').textContent = 'engine :' + info.port;
    logNote('engine ready — this project is now a live database');
  } catch (e) {
    engineRunning = false;
    setEngineStatus('● engine: failed', 'err');
    logErr(String(e));
  }
}

/* ================= console ================= */

function logNote(text) {
  const d = el('div', 'log-note', text);
  $('#console-log').appendChild(d);
  d.scrollIntoView({ block: 'end' });
}
function logStmt(sql) {
  const d = el('div', 'log-stmt', '> ' + sql);
  $('#console-log').appendChild(d);
  d.scrollIntoView({ block: 'end' });
}
function logErr(text) {
  const d = el('div', 'log-err', text);
  $('#console-log').appendChild(d);
  d.scrollIntoView({ block: 'end' });
}
function logOk(text) {
  const d = el('div', 'log-ok', text);
  $('#console-log').appendChild(d);
  d.scrollIntoView({ block: 'end' });
}

function logResult(res) {
  if (res.columns.length) {
    const wrap = el('div');
    const table = el('table', 'result-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const c of res.columns) hr.appendChild(el('th', null, c));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    const MAX = 500;
    for (const row of res.rows.slice(0, MAX)) {
      const tr = el('tr');
      for (const cell of row) {
        const td = el('td', cell == null ? 'null' : null, cell == null ? 'NULL' : cell);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    let note = res.rows.length + ' row' + (res.rows.length === 1 ? '' : 's') + ' · ' + res.elapsed_ms + ' ms';
    if (res.rows.length > MAX) note += ' (showing first ' + MAX + ')';
    wrap.appendChild(el('div', 'log-note', note));
    $('#console-log').appendChild(wrap);
    wrap.scrollIntoView({ block: 'end' });
  } else {
    logOk('ok — ' + res.affected + ' row' + (res.affected === 1 ? '' : 's') + ' affected · ' + res.elapsed_ms + ' ms');
  }
}

export async function runSQL(sql) {
  logStmt(sql);
  if (!engineRunning) { logErr('engine not running'); return null; }
  try {
    const res = await invoke('db_exec', { sql });
    logResult(res);
    return res;
  } catch (e) {
    logErr(String(e));
    return null;
  }
}

$('#console-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const sql = e.target.value.trim();
  if (!sql) return;
  e.target.value = '';
  runSQL(sql);
});

/* ================= splitters ================= */

function wireSplitter(elSel, cssVar, horizontal) {
  const s = $(elSel);
  let dragging = false;
  s.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize'; });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const ws = $('#workspace').getBoundingClientRect();
    if (horizontal) {
      const h = Math.min(Math.max(ws.bottom - e.clientY, 80), ws.height - 160);
      document.documentElement.style.setProperty('--console-h', h + 'px');
    } else {
      const w = Math.min(Math.max(ws.right - e.clientX, 300), ws.width - 360);
      document.documentElement.style.setProperty('--builder-w', w + 'px');
    }
  });
}
wireSplitter('#splitter-v', '--builder-w', false);
wireSplitter('#splitter-h', '--console-h', true);

/* ================= boot ================= */

$('#btn-new-project').addEventListener('click', newProject);
$('#btn-open-project').addEventListener('click', openProject);
renderRecents();
