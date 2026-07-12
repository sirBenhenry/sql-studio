// SQL Studio (IDE) — app bootstrap: project lifecycle, file tabs, editor,
// console, the embedded builder, and the sync pipeline glue.
'use strict';

import { splitSQL, findCurrentDb, isDbAgnostic, journalEntry } from './sync.js';
import { mountBuilder } from './builder-shim.js';
import { mountGrid } from './grid.js';
import { renderOverview } from './overview.js';

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

/* ================= settings ================= */

const DEFAULT_SETTINGS = { theme: 'system', lang: 'natural', rowLimit: 500, confirmDelete: true };

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem('sqlstudio.settings')) || {}) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
let SETTINGS = loadSettings();

function saveSettings() {
  localStorage.setItem('sqlstudio.settings', JSON.stringify(SETTINGS));
}

function applyTheme() {
  const root = document.documentElement;
  if (SETTINGS.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', SETTINGS.theme);
  if (builder && builder.setTheme) builder.setTheme(SETTINGS.theme);
}

function wireSettingsUI() {
  const modal = $('#settings-modal');
  const backdrop = $('#settings-backdrop');
  const openClose = show => { modal.hidden = !show; backdrop.hidden = !show; };
  $('#btn-settings').addEventListener('click', () => { syncSettingsUI(); openClose(modal.hidden); });
  backdrop.addEventListener('click', () => openClose(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') openClose(false); });

  const seg = (sel, get, set) => {
    const box = $(sel);
    box.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      set(b.dataset.v);
      saveSettings();
      syncSettingsUI();
    });
    box._sync = () => {
      for (const b of box.querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === get());
    };
  };
  seg('#set-theme', () => SETTINGS.theme, v => { SETTINGS.theme = v; applyTheme(); });
  seg('#set-lang', () => SETTINGS.lang, v => {
    SETTINGS.lang = v;
    if (LANG !== v) { LANG = v; localStorage.setItem('sqlstudio.lang', v); applyLang(); if (builder) builder.setLang(v); }
  });
  seg('#set-confirm', () => (SETTINGS.confirmDelete ? 'on' : 'off'), v => { SETTINGS.confirmDelete = v === 'on'; });

  $('#set-rowlimit').addEventListener('change', e => {
    const n = parseInt(e.target.value, 10);
    SETTINGS.rowLimit = Number.isFinite(n) ? Math.min(Math.max(n, 10), 10000) : DEFAULT_SETTINGS.rowLimit;
    saveSettings();
    syncSettingsUI();
  });
}

function syncSettingsUI() {
  for (const sel of ['#set-theme', '#set-lang', '#set-confirm']) {
    const box = $(sel);
    if (box && box._sync) box._sync();
  }
  $('#set-rowlimit').value = SETTINGS.rowLimit;
}

/* ================= language toggle (persisted) ================= */

let LANG = SETTINGS.lang === 'plain' ? 'plain' : 'natural';
function applyLang() {
  document.querySelectorAll('#lang-toggle .lang-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === LANG));
}
$('#lang-toggle').addEventListener('click', e => {
  const opt = e.target.closest('.lang-opt');
  if (!opt || opt.dataset.lang === LANG) return;
  LANG = opt.dataset.lang;
  SETTINGS.lang = LANG;
  saveSettings();
  applyLang();
  if (builder) builder.setLang(LANG);
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
    { id: 'db', label: '⊞ database', kind: 'view' },
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
const editorHl = $('#editor-hl');
const editorHlCode = $('#editor-hl-code');

/* live SQL highlighting: the pre behind the textarea repaints on every
   change (SqlGen.highlightStatic — same tokenizer as the lite tool) */
function updateHighlight() {
  // trailing newline keeps the pre's height in sync with the textarea
  editorHlCode.innerHTML = window.SqlGen.highlightStatic(editor.value) + '\n';
  syncHlScroll();
}
function syncHlScroll() {
  editorHl.scrollTop = editor.scrollTop;
}
editor.addEventListener('scroll', syncHlScroll);

function setEditorText(text) {
  editor.value = text;
  updateHighlight();
}

function tabById(id) { return tabs.find(t => t.id === id); }

function renderTabs() {
  const bar = $('#file-tabs');
  bar.textContent = '';
  for (const t of tabs) {
    const b = el('button', 'ftab' + (activeTab === t.id ? ' active' : '') + (t.kind === 'view' ? ' view-tab' : ''));
    b.appendChild(el('span', null, t.label));
    if (t.kind !== 'view' && t.content !== t.savedContent) b.appendChild(el('span', 'dirty', '●'));
    if (t.closable) {
      const x = el('span', 'tab-x', '✕');
      x.addEventListener('click', e => { e.stopPropagation(); closeTab(t.id); });
      b.appendChild(x);
    }
    b.addEventListener('click', () => activateTab(t.id));
    bar.appendChild(b);
  }
  const add = el('button', 'ftab add-tab', '+ query');
  add.title = 'new saved query tab';
  add.addEventListener('click', newQueryTab);
  bar.appendChild(add);
}

function closeTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (activeTab === id) activateTab(tabs[Math.max(0, i - 1)].id);
  else renderTabs();
}

const viewHost = () => {
  let v = $('#view-host');
  if (!v) {
    v = el('div');
    v.id = 'view-host';
    $('#editor-host').appendChild(v);
  }
  return v;
};

function activateTab(id) {
  const t = tabById(id);
  if (!t) return;
  activeTab = id;
  if (t.kind === 'view') {
    editor.style.display = 'none';
    editorHl.style.display = 'none';
    const v = viewHost();
    v.style.display = '';
    renderViewTab(t, v);
  } else {
    const v = $('#view-host');
    if (v) v.style.display = 'none';
    editor.style.display = '';
    editorHl.style.display = '';
    setEditorText(t.content);
    editor.readOnly = !!t.readonly;
  }
  renderTabs();
}

/* schema model shared by the database view + grids (parsed from schema.sql) */
function schemaModel() {
  const t = tabById('schema');
  try { return window.parseSchema(t ? t.content : ''); }
  catch { return { tables: [], byName: {} }; }
}

async function tableCounts(model) {
  const counts = {};
  for (const t of model.tables) {
    try {
      const r = await invoke('db_exec', { sql: 'SELECT COUNT(*) FROM `' + t.name + '`', db: currentDb });
      counts[t.name] = r.rows[0] ? r.rows[0][0] : '?';
    } catch { counts[t.name] = '–'; }
  }
  return counts;
}

async function renderViewTab(t, host) {
  if (t.id === 'db') {
    const model = schemaModel();
    const counts = engineRunning ? await tableCounts(model) : null;
    renderOverview(host, model, counts, { openTable: openTableGrid });
  } else if (t.id.startsWith('t:')) {
    const name = t.id.slice(2);
    const model = schemaModel();
    const def = model.byName[name];
    if (!def) { host.textContent = ''; host.appendChild(el('p', 'hint pad', 'table ' + name + ' is not in the schema anymore')); return; }
    mountGrid(host, def, {
      exec: async sql => {
        try {
          const res = await invoke('db_exec', { sql, db: currentDb });
          return res;
        } catch (e) { logStmt(sql); logErr(String(e)); return null; }
      },
      journal: (source, stmts) => journal(source, stmts),
      shouldConfirm: () => SETTINGS.confirmDelete
    });
  }
}

function openTableGrid(name) {
  const id = 't:' + name;
  if (!tabById(id)) {
    tabs.push({ id, label: '▦ ' + name, kind: 'view', closable: true });
  }
  activateTab(id);
}

editor.addEventListener('input', () => {
  updateHighlight();
  const t = tabById(activeTab);
  if (!t || t.readonly || t.kind === 'view') return;
  t.content = editor.value;
  renderTabs();
  // schema edits flow into the builder's understanding (debounced)
  if (t.id === 'schema' && builder) {
    clearTimeout(editor._schemaT);
    editor._schemaT = setTimeout(() => builder.setSchema(t.content), 600);
  }
});

async function saveActive() {
  const t = tabById(activeTab);
  if (!t || t.readonly || t.kind === 'view') return;
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

/* ================= engine + sync pipeline ================= */

let engineRunning = false;
let currentDb = null;   // the project's active database (tracked client-side)
let builder = null;     // the embedded builder's api (mounted at boot)

const SYSTEM_DBS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

function setEngineStatus(text, cls) {
  const s = $('#engine-status');
  s.textContent = text;
  s.className = 'engine-status' + (cls ? ' ' + cls : '');
}

/** run ONE statement with database-context tracking */
async function runStatement(sql) {
  const useM = sql.match(/^USE\s+`?([\w$]+)`?\s*$/i);
  if (useM) {
    currentDb = useM[1];
    logOk('database: ' + currentDb);
    return { columns: [], rows: [], affected: 0, elapsed_ms: 0 };
  }
  const res = await invoke('db_exec', {
    sql,
    db: isDbAgnostic(sql) ? null : currentDb
  });
  const cdb = sql.match(/^CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([\w$]+)`?/i);
  if (cdb) currentDb = cdb[1];
  const ddb = sql.match(/^DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?`?([\w$]+)`?/i);
  if (ddb && currentDb === ddb[1]) currentDb = null;
  return res;
}

/** run a whole script (splits statements); logs everything; optional journal.
 *  Returns true only if every statement succeeded. */
async function runScript(text, source, opts = {}) {
  const stmts = splitSQL(text || '');
  if (!stmts.length) { logErr('nothing to run'); return false; }
  if (!engineRunning) { logErr('engine not running'); return false; }
  const applied = [];
  for (const stmt of stmts) {
    logStmt(stmt);
    try {
      const res = await runStatement(stmt);
      logResult(res);
      applied.push(stmt);
    } catch (e) {
      logErr(String(e));
      if (applied.length && opts.journal) await journal(source + ' (partial)', applied);
      return false;
    }
  }
  if (opts.journal) await journal(source, applied);
  return true;
}

async function journal(source, statements) {
  const entry = journalEntry(source, statements);
  try {
    await invoke('journal_append', { entry });
    const t = tabById('journal');
    if (t) {
      t.content += entry;
      t.savedContent = t.content;
      if (activeTab === 'journal') setEditorText(t.content);
    }
  } catch (e) { logErr('journal write failed: ' + e); }
}

async function startEngine(root) {
  setEngineStatus('● engine: starting…');
  try {
    const info = await invoke('db_start', { projectRoot: root });
    engineRunning = true;
    setEngineStatus('● engine: running on 127.0.0.1:' + info.port, 'ok');
    $('#status-right').textContent = 'engine :' + info.port;
    logNote('engine ready — this project is a live database');
    await reconcile();
  } catch (e) {
    engineRunning = false;
    setEngineStatus('● engine: failed', 'err');
    logErr(String(e));
  }
}

/** Modal: ask for the database name (used on brand-new projects).
 *  Resolves with a sanitized identifier. */
function askDbName(suggestion) {
  return new Promise(resolve => {
    const modal = $('#dbname-modal');
    const backdrop = $('#dbname-backdrop');
    const input = $('#dbname-input');
    input.value = suggestion;
    modal.hidden = false;
    backdrop.hidden = false;
    input.focus();
    input.select();
    const done = () => {
      const clean = input.value.trim().replace(/\s+/g, '_').replace(/[^\w$]/g, '') || suggestion;
      modal.hidden = true;
      backdrop.hidden = true;
      $('#dbname-ok').removeEventListener('click', done);
      resolve(clean);
    };
    $('#dbname-ok').addEventListener('click', done);
    input.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Enter') { input.removeEventListener('keydown', onKey); done(); }
    });
  });
}

/** On open: a fresh sandbox gets built from schema.sql + data.sql; a brand-new
 *  project first asks for a database name and writes the CREATE DATABASE
 *  header itself; an existing one just resolves the current database. */
async function reconcile() {
  let schemaText = tabById('schema') ? tabById('schema').content : '';
  try {
    const res = await invoke('db_exec', { sql: 'SHOW DATABASES', db: null });
    const userDbs = res.rows.map(r => r[0]).filter(d => d && !SYSTEM_DBS.has(d));

    // brand-new project: schema has no database yet → name it, write the header
    if (!userDbs.length && !findCurrentDb(schemaText)) {
      const suggestion = (project ? project.name : 'my_database')
        .trim().replace(/\s+/g, '_').replace(/[^\w$]/g, '').toLowerCase() || 'my_database';
      const name = await askDbName(suggestion);
      const header = 'DROP DATABASE IF EXISTS ' + name + ';\nCREATE DATABASE ' + name + ';\nUSE ' + name + ';\n';
      const t = tabById('schema');
      let cur = t.content;
      if (cur && !cur.endsWith('\n')) cur += '\n';
      t.content = cur + header;
      schemaText = t.content;
      await invoke('file_write', { rel: 'schema.sql', content: t.content });
      t.savedContent = t.content;
      if (activeTab === 'schema') setEditorText(t.content);
      renderTabs();
    }

    if (!userDbs.length && splitSQL(schemaText).length) {
      logNote('fresh sandbox — building the database from schema.sql…');
      const ok = await runScript(schemaText, 'seed: schema.sql', { journal: false });
      const dataText = tabById('data') ? tabById('data').content : '';
      if (ok && splitSQL(dataText).length) {
        await runScript(dataText, 'seed: data.sql', { journal: false });
      }
      if (ok) logOk('project database built from files');
    } else {
      currentDb = findCurrentDb(schemaText) || userDbs[0] || null;
      if (currentDb) logNote('database: ' + currentDb);
    }
  } catch (e) {
    logErr('reconcile failed: ' + e);
  }
  if (builder) builder.setSchema(schemaText);
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
    const MAX = SETTINGS.rowLimit;
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

$('#console-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const sql = e.target.value.trim();
  if (!sql) return;
  e.target.value = '';
  // typed console statements are ad-hoc: executed but not journaled
  runScript(sql, 'console', { journal: false });
});

/* ================= builder mount + sync hooks ================= */

async function appendData(sql) {
  const t = tabById('data');
  if (!t) return;
  let cur = t.content;
  if (!cur.endsWith('\n')) cur += '\n';
  cur += sql.trim() + '\n';
  t.content = cur;
  try {
    await invoke('file_write', { rel: 'data.sql', content: cur });
    t.savedContent = cur;
    if (activeTab === 'data') setEditorText(cur);
    renderTabs();
  } catch (e) { logErr('data.sql write failed: ' + e); }
}

/** the builder applied schema statements (CREATE/ALTER): append them to
 *  schema.sql — never replace the file — and re-feed the builder's model */
async function appendSchema(sql) {
  const t = tabById('schema');
  if (!t) return;
  let cur = t.content;
  if (cur && !cur.endsWith('\n')) cur += '\n';
  cur += '\n' + sql.trim() + '\n';
  t.content = cur;
  try {
    await invoke('file_write', { rel: 'schema.sql', content: cur });
    t.savedContent = cur;
    if (activeTab === 'schema') setEditorText(cur);
    renderTabs();
    logNote('schema.sql updated');
  } catch (e) { logErr('schema.sql write failed: ' + e); }
  if (builder) builder.setSchema(cur);
}

builder = mountBuilder($('#builder-host'), {
  runScript,
  appendData,
  appendSchema,
  onReady() {
    builder.setLang(LANG);
    builder.setTheme(SETTINGS.theme);
    if (project) builder.setSchema(tabById('schema') ? tabById('schema').content : '');
  }
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
wireSettingsUI();
applyTheme();
