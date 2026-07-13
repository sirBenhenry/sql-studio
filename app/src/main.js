// SQL Studio (IDE) — app bootstrap: project lifecycle, file tabs, editor,
// console, the embedded builder, and the sync pipeline glue.
'use strict';

import { splitSQL, findCurrentDb, isDbAgnostic, journalEntry, buildDataSnapshot, snapshotTableOrder, explainError } from './sync.js';
import { mountBuilder } from './builder-shim.js';
import { mountGrid } from './grid.js';
import { mountTablesDesigner, createTableDDL, modelFromSchema, diffModels, resolveFixups } from './tables-designer.js';
import { mountCanvasView } from './canvas-view.js';
import { runTour, pressPulse } from './tour.js';

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
    if (LANG !== v) { LANG = v; applyLang(); if (builder) builder.setLang(v); }
  });
  seg('#set-confirm', () => (SETTINGS.confirmDelete ? 'on' : 'off'), v => { SETTINGS.confirmDelete = v === 'on'; });

  $('#set-tour').addEventListener('click', () => {
    openClose(false);
    if (project) startAppTour();
    else toast('Open a project first — the tour walks through a real workspace.');
  });

  $('#set-import').addEventListener('click', async () => {
    openClose(false);
    await importDump();
  });

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
  } catch (e) {
    toast(String(e));
    // a recent that no longer opens (folder gone / no schema.sql) leaves the list
    const rec = getRecents();
    if (rec.some(r => r.root === path)) {
      localStorage.setItem('sqlstudio.recents', JSON.stringify(rec.filter(r => r.root !== path)));
      renderRecents();
    }
  }
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
  // the window says which project it is — two windows, two projects
  try { window.__TAURI__.window.getCurrentWindow().setTitle(p.name + ' — SQL Studio'); }
  catch { /* window API unavailable */ }
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
      content: q.content, savedContent: q.content, readonly: false, closable: true
    }))
  ];
  activateTab('schema');
  logNote('project opened: ' + p.root);

  // first project ever → walk the whole workflow once. Fired only after
  // reconcile finishes so the tour never collides with the name-the-database
  // modal, and the engine is up for the demo.
  let toured = null;
  try { toured = localStorage.getItem('sqlstudio.toured'); } catch { /* ignore */ }
  pendingTour = !toured;
}

let pendingTour = false;
function firePendingTour() {
  if (!pendingTour) return;
  pendingTour = false;
  setTimeout(startAppTour, 500);
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

/* Tab indents in a SQL editor — it must not walk focus away */
editor.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || editor.readOnly) return;
  e.preventDefault();
  const s = editor.selectionStart, epos = editor.selectionEnd;
  editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(epos);
  editor.selectionStart = editor.selectionEnd = s + 2;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
});

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
      x.title = t.id.startsWith('q:') ? 'close (the file stays in queries/)' : 'close';
      x.addEventListener('click', e => { e.stopPropagation(); closeTab(t.id); });
      b.appendChild(x);
    }
    b.addEventListener('click', () => activateTab(t.id));
    if (t.id.startsWith('q:')) {
      b.title = 'double-click to rename';
      b.addEventListener('dblclick', () => renameQueryTab(t));
    }
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
    // the journal's newest entries live at the bottom — start there
    if (t.id === 'journal') { editor.scrollTop = editor.scrollHeight; syncHlScroll(); }
  }
  renderTabs();
}

/* schema model shared by the database view + grids (parsed from schema.sql) */
function schemaModel() {
  const t = tabById('schema');
  try { return window.parseSchema(t ? t.content : ''); }
  catch { return { tables: [], byName: {} }; }
}

/** regenerate schema.sql from the designer's model: the database header
 *  (DROP/CREATE/USE) survives; the table blocks are rewritten cleanly. */
async function writeSchemaFromModel(model) {
  if (tourDemo) return; // the tour's demo never reaches the user's files
  const t = tabById('schema');
  if (!t) return;
  const header = currentDb
    ? 'DROP DATABASE IF EXISTS ' + currentDb + ';\nCREATE DATABASE ' + currentDb + ';\nUSE ' + currentDb + ';\n'
    : '';
  const blocks = [];
  const expect = [];
  for (const tbl of model) {
    // unnamed/empty drafts don't reach the file
    if (!String(tbl.name || '').trim() || !tbl.cols.some(c => String(c.name || '').trim())) continue;
    blocks.push(createTableDDL(tbl) + ';');
    expect.push(tbl.name);
  }
  const text = '-- schema.sql — the database definition. Edited live by SQL Studio;\n-- you can also type here directly.\n\n' +
    header + '\n' + blocks.join('\n\n') + (blocks.length ? '\n' : '');
  // self-check: the file must parse back to every table we meant to write.
  // If it doesn't (a generator/parser mismatch), writing it would silently
  // lose tables — fall back to DB truth instead. This class of bug once ate
  // a table via a truncated DEFAULT (CURDATE()) capture.
  try {
    const back = window.parseSchema(text);
    const missing = expect.filter(n => !back.byName[n]);
    if (missing.length) {
      logErr('schema.sql regeneration failed its self-check (lost: ' + missing.join(', ') + ') — re-syncing from the live database instead');
      await syncSchemaFromDb();
      return;
    }
  } catch (e) {
    logErr('schema.sql regeneration failed its self-check — re-syncing from the live database instead');
    await syncSchemaFromDb();
    return;
  }
  t.content = text;
  try {
    await invoke('file_write', { rel: 'schema.sql', content: text });
    t.savedContent = text;
    if (activeTab === 'schema') setEditorText(text);
    renderTabs();
  } catch (e) { logErr('schema.sql write failed: ' + e); }
  if (builder) builder.setSchema(text);
}


/** Rebuild schema.sql from DB truth (SHOW CREATE TABLE, dependency-ordered).
 *  Used when a partially-applied designer change means the file no longer
 *  matches reality — the database is the only honest source left. */
/** the live database's tables as CREATE TABLE text (SHOW CREATE TABLE) */
async function fetchDbDDL() {
  const shown = await invoke('db_exec', { sql: 'SHOW TABLES', db: currentDb });
  const ddl = {};
  for (const row of shown.rows) {
    try {
      const r = await invoke('db_exec', { sql: 'SHOW CREATE TABLE `' + row[0] + '`', db: currentDb });
      if (r.rows.length) ddl[row[0]] = r.rows[0][1] + ';';
    } catch { /* table vanished mid-fetch — skip */ }
  }
  return ddl;
}

async function syncSchemaFromDb() {
  if (tourDemo) return; // never rebuild the user's schema.sql from the demo db
  if (!engineRunning || !currentDb) return;
  const t = tabById('schema');
  if (!t) return;
  let ddl;
  try { ddl = await fetchDbDDL(); }
  catch { return; }
  const names = Object.keys(ddl);
  // dependency order so the file rebuilds: parse what we got, sort by FK depth
  let order = names;
  try {
    const parsed = window.parseSchema(names.map(n => ddl[n]).join('\n'));
    order = snapshotTableOrder(parsed).concat(names.filter(n => !parsed.byName[n]));
  } catch { /* fall back to SHOW TABLES order */ }
  const header = 'DROP DATABASE IF EXISTS ' + currentDb + ';\nCREATE DATABASE ' + currentDb + ';\nUSE ' + currentDb + ';\n';
  const text = '-- schema.sql — the database definition. Edited live by SQL Studio;\n-- you can also type here directly.\n\n' +
    header + '\n' + order.map(n => ddl[n]).join('\n\n') + (order.length ? '\n' : '');
  t.content = text;
  try {
    await invoke('file_write', { rel: 'schema.sql', content: text });
    t.savedContent = text;
    if (activeTab === 'schema') setEditorText(text);
    renderTabs();
    logNote('schema.sql re-synced from the live database');
  } catch (e) { logErr('schema.sql write failed: ' + e); }
  if (builder) builder.setSchema(text);
}

/** Ctrl+S on schema.sql: the missing sync direction — diff the edited file
 *  against DB truth (name-matched: a rename in text is a drop + add) and
 *  apply, confirmed, through the same machinery the designer uses. */
async function applySchemaFile(t) {
  let fileModel;
  try { fileModel = modelFromSchema(window.parseSchema(t.content)); }
  catch (e) { logErr('schema.sql could not be parsed: ' + e); return false; }

  let dbModel;
  try { dbModel = modelFromSchema(window.parseSchema(Object.values(await fetchDbDDL()).join('\n'))); }
  catch (e) { logErr('could not read the live database: ' + e); return false; }

  // table-level KEY/INDEX lines are kept verbatim but not diffed — be honest
  // about the one thing a file save won't apply live
  for (const ft of fileModel) {
    const dt = dbModel.find(x => x.name === ft.name);
    if (dt && JSON.stringify(ft.extras || []) !== JSON.stringify(dt.extras || [])) {
      logNote('note: changed KEY/INDEX lines in ' + ft.name + ' are not applied live — they take effect on a rebuild from files');
    }
  }

  const { stmts, destructive, fixups } = diffModels(fileModel, dbModel);
  const pre = await resolveFixups(fixups, async sql => await invoke('db_exec', { sql, db: currentDb }));
  const all = pre.concat(stmts);
  if (!all.length) { logNote('schema.sql saved — database already matches'); return true; }

  const headerDb = findCurrentDb(t.content);
  let msg = 'Saving schema.sql will change the live database:\n\n' +
    all.map(s => '  ' + s.replace(/\s+/g, ' ').slice(0, 90)).join('\n');
  if (destructive.length) msg += '\n\n⚠ data is lost by:\n  · ' + destructive.join('\n  · ');
  if (headerDb && currentDb && headerDb !== currentDb) {
    msg += '\n\n(note: the database name change "' + currentDb + '" → "' + headerDb +
      '" is NOT applied live — it only takes effect on a rebuild from files)';
  }
  if (!window.confirm(msg + '\n\nApply?')) return false;

  const ok = await runScript(all.join(';\n') + ';', 'schema.sql saved', {
    journal: true,
    onPartial: async () => { await syncSchemaFromDb(); }
  });
  if (ok) {
    if (builder) builder.setSchema(t.content);
    if (activeTab === 'db') { const v = $('#view-host'); if (v) renderDbTab(v); }
    logOk('database updated from schema.sql');
  }
  return ok;
}

let designer = null;
let dbViewMode = localStorage.getItem('sqlstudio.dbview') || 'view'; // 'view' | 'edit'

function canvasPosKey() {
  return 'sqlstudio.canvas.' + (project ? project.root : '');
}

function renderDbTab(host) {
  host.textContent = '';
  const bar = el('div', 'dbtab-bar');
  const seg = el('div', 'seg');
  for (const [v, label] of [['view', 'View'], ['edit', 'Edit']]) {
    const b = el('button', null, label);
    b.classList.toggle('active', dbViewMode === v);
    b.addEventListener('click', () => {
      if (dbViewMode === v) return;
      dbViewMode = v;
      localStorage.setItem('sqlstudio.dbview', v);
      renderDbTab(host);
    });
    seg.appendChild(b);
  }
  bar.appendChild(seg);
  if (dbViewMode === 'view') {
    bar.appendChild(el('span', 'dz-hint', 'Drag cards by their header, the background to pan · wheel pans, ctrl+wheel zooms · ▦ opens the data'));
    const reset = el('button', 'btn small', 'reset layout');
    reset.title = 'forget dragged positions and lay the diagram out again';
    reset.addEventListener('click', () => {
      localStorage.removeItem(canvasPosKey());
      renderDbTab(host);
    });
    bar.appendChild(reset);
  }
  host.appendChild(bar);

  const body = el('div', 'dbtab-body');
  host.appendChild(body);

  if (dbViewMode === 'view') {
    mountCanvasView(body, schemaModel(), {
      openTable: openTableGrid,
      loadPositions() {
        try { return JSON.parse(localStorage.getItem(canvasPosKey())) || {}; } catch { return {}; }
      },
      savePositions(pos) {
        try { localStorage.setItem(canvasPosKey(), JSON.stringify(pos)); } catch { /* ignore */ }
      }
    });
  } else {
    designer = mountTablesDesigner(body, schemaModel(), {
      runScript,
      query: async sql => await invoke('db_exec', { sql, db: currentDb }),
      writeSchema: writeSchemaFromModel,
      syncFromDb: syncSchemaFromDb,
      openTable: openTableGrid,
      reload: () => { if (activeTab === 'db') renderDbTab(host); },
      toast,
      // undo survives View↔Edit flips; the tour demo gets its own lane
      historyKey: project ? project.root + (tourDemo ? '#demo' : '') : null,
      // a table rename keeps its canvas position and any open grid tab
      onRenames(renamed) {
        try {
          const raw = JSON.parse(localStorage.getItem(canvasPosKey())) || {};
          let changed = false;
          for (const [from, to] of Object.entries(renamed)) {
            if (raw[from] && !raw[to]) { raw[to] = raw[from]; delete raw[from]; changed = true; }
          }
          if (changed) localStorage.setItem(canvasPosKey(), JSON.stringify(raw));
        } catch { /* ignore */ }
        for (const [from, to] of Object.entries(renamed)) {
          const gt = tabById('t:' + from);
          if (gt) {
            gt.id = 't:' + to;
            gt.label = '▦ ' + to;
            if (activeTab === 't:' + from) activeTab = gt.id;
          }
        }
        renderTabs();
      }
    });
  }
}

async function renderViewTab(t, host) {
  if (t.id === 'db') {
    renderDbTab(host);
  } else if (t.id.startsWith('t:')) {
    const name = t.id.slice(2);
    const model = schemaModel();
    const def = model.byName[name];
    if (!def) { host.textContent = ''; host.appendChild(el('p', 'hint pad', 'table ' + name + ' is not in the schema anymore')); return; }
    mountGrid(host, def, {
      exec: async sql => {
        const mutation = !/^SELECT\b/i.test(sql.trim());
        try {
          const res = await invoke('db_exec', { sql, db: currentDb });
          if (mutation) { logStmt(sql); logResult(res); } // grid edits echo like console ones
          return res;
        } catch (e) { logStmt(sql); logErr(String(e)); noteEngineError(e); return null; }
      },
      journal: (source, stmts) => journal(source, stmts),
      shouldConfirm: () => SETTINGS.confirmDelete,
      rowLimit: () => SETTINGS.rowLimit,
      lookupFkRows: fkRowSearch
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
  if (tourDemo && t.id === 'schema') {
    toast('that is the tour demo — it is never saved to your files');
    return;
  }
  // schema.sql saves are the file→database direction of the sync
  if (t.id === 'schema') {
    if (engineRunning && currentDb) {
      const applied = await applySchemaFile(t);
      if (!applied) return; // parse failure or user declined — nothing written
    } else {
      logErr('schema.sql saved to disk ONLY — the engine is not running, so the database was not updated. Ctrl+S again once it is back.');
    }
  }
  try {
    await invoke('file_write', { rel: t.rel, content: t.content });
    t.savedContent = t.content;
    renderTabs();
    toast(t.label + ' saved');
  } catch (e) { toast(String(e)); }
}

async function renameQueryTab(t) {
  const cur = t.id.slice(2);
  const raw = window.prompt('Rename ' + t.label + ' to…', cur);
  if (raw == null) return;
  const name = raw.trim().replace(/\.sql$/i, '').replace(/[^\w$-]+/g, '_');
  if (!name || name === cur) return;
  const newRel = 'queries/' + name + '.sql';
  try {
    await invoke('query_rename', { from: t.rel, to: newRel });
  } catch (e) { toast(String(e)); return; }
  const wasActive = activeTab === t.id;
  t.id = 'q:' + name;
  t.label = name + '.sql';
  t.rel = newRel;
  if (wasActive) activeTab = t.id;
  renderTabs();
  toast('renamed to ' + t.label);
}

async function newQueryTab() {
  const base = 'query';
  let n = 1;
  // a closed tab's file still exists on disk — never clobber it
  const taken = async name => {
    if (tabs.some(t => t.id === 'q:' + name)) return true;
    try { await invoke('file_read', { rel: 'queries/' + name + '.sql' }); return true; }
    catch { return false; }
  };
  while (await taken(base + n)) n++;
  const name = base + n;
  const t = {
    id: 'q:' + name, label: name + '.sql', rel: 'queries/' + name + '.sql',
    content: '-- ' + name + '\n', savedContent: null, readonly: false, closable: true
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
  s.textContent = cls === 'err' ? text + ' — click to restart' : text;
  s.className = 'engine-status' + (cls ? ' ' + cls : '');
}

/* a dead engine shouldn't need an app restart */
$('#engine-status').addEventListener('click', () => {
  if (!project || engineRunning) return;
  if ($('#engine-status').classList.contains('err')) startEngine(project.root);
});

/** an error that smells like the server went away flips the status so the
 *  click-to-restart path lights up */
function noteEngineError(msg) {
  if (!engineRunning) return;
  if (/engine not running|Connection refused|10061|broken pipe|Lost connection|10054/i.test(String(msg))) {
    engineRunning = false;
    setEngineStatus('● engine: lost', 'err');
  }
}

/** run ONE statement with database-context tracking */
async function runStatement(sql) {
  const useM = sql.match(/^USE\s+`?([\w$]+)`?\s*$/i);
  if (useM) {
    // let the server verify it — a typo must error, not poison currentDb
    await invoke('db_exec', { sql, db: null });
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
      noteEngineError(e);
      if (applied.length && opts.journal) await journal(source + ' (partial)', applied);
      if (applied.length && opts.onPartial) opts.onPartial(applied.length);
      return false;
    }
  }
  if (opts.journal) await journal(source, applied);
  return true;
}

/** run a BIG script in one IPC round-trip (single connection, so USE
 *  persists) — seeds and imports; the console gets a summary, not an echo
 *  of every statement. Returns true only if everything applied. */
async function runScriptFast(text, source, opts = {}) {
  const stmts = splitSQL(text || '');
  if (!stmts.length) { logErr('nothing to run'); return false; }
  if (!engineRunning) { logErr('engine not running'); return false; }
  let res;
  try { res = await invoke('db_exec_batch', { stmts, db: currentDb }); }
  catch (e) { logErr(String(e)); noteEngineError(e); return false; }
  const named = findCurrentDb(stmts.slice(0, res.applied).join(';\n'));
  if (named) currentDb = named;
  if (res.error) {
    logErr(res.error);
    logErr('stopped at statement ' + (res.applied + 1) + ' of ' + stmts.length + ':');
    logStmt(stmts[res.applied]);
    if (res.applied && opts.journal) await journal(source + ' (partial)', stmts.slice(0, res.applied));
    return false;
  }
  logOk(source + ' — ' + res.applied + ' statement' + (res.applied === 1 ? '' : 's') + ' · ' + res.elapsed_ms + ' ms');
  if (opts.journal) await journal(source, stmts);
  return true;
}

async function journal(source, statements) {
  if (tourDemo) return; // demo activity is not project history
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
  // every journaled change re-snapshots data.sql — files stay rebuildable
  scheduleSnapshot();
}

/* ---- data snapshot: data.sql always mirrors the live data ---- */

let snapshotTimer = null;
function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotData().catch(e => logErr('data snapshot failed: ' + e));
  }, 800);
}

async function snapshotData() {
  if (tourDemo) return; // demo rows must not land in data.sql
  if (!engineRunning || !currentDb || !project) return;
  const t = tabById('data');
  if (!t) return;
  const model = schemaModel();
  let shown;
  try { shown = await invoke('db_exec', { sql: 'SHOW TABLES', db: currentDb }); }
  catch { return; }
  const dumps = [];
  for (const row of shown.rows) {
    const name = row[0];
    try {
      const d = await invoke('db_exec', { sql: 'SELECT * FROM `' + name + '`', db: currentDb });
      dumps.push({ name, columns: d.columns, rows: d.rows });
    } catch { /* table vanished mid-snapshot — skip */ }
  }
  const text = buildDataSnapshot(model, dumps);
  if (text === t.content) return;
  t.content = text;
  try {
    await invoke('file_write', { rel: 'data.sql', content: text });
    t.savedContent = text;
    if (activeTab === 'data') setEditorText(text);
    renderTabs();
  } catch (e) { logErr('data.sql write failed: ' + e); }
}

let engineStarting = false;
async function startEngine(root) {
  if (engineStarting) return;
  engineStarting = true;
  setEngineStatus('● engine: starting…');
  try {
    const info = await invoke('db_start', { projectRoot: root });
    engineRunning = true;
    setEngineStatus('● engine: running on 127.0.0.1:' + info.port, 'ok');
    $('#status-right').textContent = 'engine :' + info.port;
    logNote('engine ready — this project is a live database');
    await reconcile();
    firePendingTour();
  } catch (e) {
    engineRunning = false;
    setEngineStatus('● engine: failed', 'err');
    logErr(String(e));
    firePendingTour(); // the tour still works, just without the demo db
  } finally {
    engineStarting = false;
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
    const onKey = e => { if (e.key === 'Enter') done(); };
    const done = () => {
      const clean = input.value.trim().replace(/\s+/g, '_').replace(/[^\w$]/g, '') || suggestion;
      modal.hidden = true;
      backdrop.hidden = true;
      $('#dbname-ok').removeEventListener('click', done);
      input.removeEventListener('keydown', onKey);
      resolve(clean);
    };
    $('#dbname-ok').addEventListener('click', done);
    input.addEventListener('keydown', onKey);
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
      const ok = await runScriptFast(schemaText, 'seed: schema.sql', { journal: false });
      const dataText = tabById('data') ? tabById('data').content : '';
      if (ok && splitSQL(dataText).length) {
        await runScriptFast(dataText, 'seed: data.sql', { journal: false });
      }
      if (ok) logOk('project database built from files');
    } else {
      const headerDb = findCurrentDb(schemaText);
      if (headerDb && !userDbs.includes(headerDb) && userDbs.length) {
        // the file names a database the sandbox doesn't have — say so
        logErr('schema.sql names database "' + headerDb + '", but the sandbox has: ' +
          userDbs.join(', ') + ' — using ' + userDbs[0]);
        currentDb = userDbs[0];
      } else {
        currentDb = (headerDb && userDbs.includes(headerDb)) ? headerDb : (headerDb || userDbs[0] || null);
      }
      if (currentDb) logNote('database: ' + currentDb);
    }
  } catch (e) {
    logErr('reconcile failed: ' + e);
  }
  if (builder) builder.setSchema(schemaText);
}

/* ================= console ================= */

/* the console log is capped — a long session must not accumulate thousands
   of DOM nodes and start to crawl */
const CONSOLE_MAX_NODES = 600;
function trimConsole() {
  const log = $('#console-log');
  while (log.childNodes.length > CONSOLE_MAX_NODES) log.removeChild(log.firstChild);
}

function logNote(text) {
  const d = el('div', 'log-note', text);
  $('#console-log').appendChild(d);
  trimConsole();
  d.scrollIntoView({ block: 'end' });
}
function logStmt(sql) {
  const d = el('div', 'log-stmt', '> ' + sql);
  $('#console-log').appendChild(d);
  trimConsole();
  d.scrollIntoView({ block: 'end' });
}
function logErr(text) {
  const d = el('div', 'log-err', text);
  $('#console-log').appendChild(d);
  // a plain-language line under the raw error, when we know what it means
  const hint = explainError(text);
  if (hint) {
    const h = el('div', 'log-hint', '💡 ' + hint);
    $('#console-log').appendChild(h);
    h.scrollIntoView({ block: 'end' });
    return;
  }
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
    trimConsole();
    wrap.scrollIntoView({ block: 'end' });
  } else {
    logOk('ok — ' + res.affected + ' row' + (res.affected === 1 ? '' : 's') + ' affected · ' + res.elapsed_ms + ' ms');
  }
}

const conHist = [];
let conHistIdx = -1;   // -1 = editing a fresh line
let conDraft = '';
const conBox = $('#console-input');
function conResize() {
  conBox.style.height = 'auto';
  conBox.style.height = Math.min(conBox.scrollHeight, 120) + 'px';
}
conBox.addEventListener('input', conResize);
conBox.addEventListener('keydown', e => {
  const box = e.target;
  // history only while the draft is a single line — arrows navigate text otherwise
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !box.value.includes('\n')) {
    if (!conHist.length) return;
    e.preventDefault();
    if (conHistIdx === -1) {
      if (e.key === 'ArrowDown') return;
      conDraft = box.value;
      conHistIdx = conHist.length - 1;
    } else if (e.key === 'ArrowUp') {
      conHistIdx = Math.max(0, conHistIdx - 1);
    } else if (++conHistIdx >= conHist.length) {
      conHistIdx = -1;
      box.value = conDraft;
      conResize();
      return;
    }
    box.value = conHist[conHistIdx];
    conResize();
    return;
  }
  if (e.key !== 'Enter' || e.shiftKey) return; // Shift+Enter = a new line
  e.preventDefault();
  const sql = box.value.trim();
  if (!sql) return;
  if (conHist[conHist.length - 1] !== sql) conHist.push(sql);
  if (conHist.length > 100) conHist.shift();
  conHistIdx = -1;
  conDraft = '';
  box.value = '';
  conResize();
  // typed console statements are ad-hoc: executed but not journaled
  runScript(sql, 'console', { journal: false });
});

/* ================= import a .sql dump ================= */

/** Settings → import: run a picked .sql file against the project database,
 *  then regenerate schema.sql + data.sql from DB truth. The journal gets a
 *  single import note (the snapshot owns the data — journaling ten thousand
 *  INSERTs would just duplicate it). */
async function importDump() {
  if (!project) { toast('Open a project first.'); return; }
  if (!engineRunning) { toast('The engine is not running.'); return; }
  if (tourDemo) { toast('Finish the tour first.'); return; }
  const path = await openDialog({
    title: 'Pick a .sql dump to import',
    filters: [{ name: 'SQL', extensions: ['sql'] }]
  });
  if (!path) return;
  let text;
  try { text = await invoke('import_read', { path }); }
  catch (e) { toast(String(e)); return; }
  const stmts = splitSQL(text);
  if (!stmts.length) { toast('No SQL statements found in that file.'); return; }
  const fname = String(path).split(/[\\/]/).pop();
  if (!window.confirm('Import ' + fname + '?\n\n' + stmts.length + ' statement' + (stmts.length === 1 ? '' : 's') +
    ' will run against this project\'s live database.\nTables with the same names may conflict.\n\n' +
    'Afterwards schema.sql and data.sql are regenerated from the database.')) return;
  logNote('importing ' + fname + ' (' + stmts.length + ' statements)…');
  const ok = await runScriptFast(text, 'import: ' + fname, { journal: false });
  // whatever happened, the files must mirror what the DB is NOW
  await syncSchemaFromDb();
  await snapshotData();
  await journal('import: ' + fname, ['-- imported ' + stmts.length + ' statements from ' + fname]);
  if (activeTab === 'db') { const v = $('#view-host'); if (v) renderDbTab(v); }
  if (ok) { logOk('import complete — files regenerated from the database'); toast(fname + ' imported'); }
  else logErr('import stopped at the first failing statement — files re-synced to what actually applied');
}

/* ================= onboarding tour ================= */

/* ---- tour demo: an empty project borrows the little library to explore.
   It lives ONLY in the sandbox + the schema tab's memory — never in the
   user's files — and is dropped again the moment the tour ends. ---- */
let tourDemo = null; // { prevSchema, prevSaved, prevDb } while active

async function loadTourDemo() {
  const t = tabById('schema');
  if (!t || !engineRunning || typeof DEMO_SQL === 'undefined') return false;
  if (currentDb === 'library') return false; // never touch a real db named library
  tourDemo = { prevSchema: t.content, prevSaved: t.savedContent, prevDb: currentDb };
  for (const stmt of splitSQL(DEMO_SQL)) {
    try { await runStatement(stmt); }
    catch (e) {
      logErr('tour demo failed to load: ' + e);
      await endTourDemo();
      return false;
    }
  }
  t.content = DEMO_SQL;
  t.savedContent = DEMO_SQL; // in-memory only; saving it is blocked below
  if (activeTab === 'schema') setEditorText(t.content);
  renderTabs();
  if (builder) builder.setSchema(DEMO_SQL);
  logNote('tour demo loaded — a small lending library; it disappears when the tour ends');
  return true;
}

async function endTourDemo() {
  if (!tourDemo) return;
  const demo = tourDemo;
  tourDemo = null;
  const t = tabById('schema');
  if (t) {
    t.content = demo.prevSchema;
    t.savedContent = demo.prevSaved;
  }
  tabs = tabs.filter(x => !x.id.startsWith('t:')); // demo grids mean nothing now
  try { await invoke('db_exec', { sql: 'DROP DATABASE IF EXISTS library', db: null }); }
  catch { /* engine gone — nothing left to clean */ }
  currentDb = demo.prevDb;
  if (builder && t) builder.setSchema(t.content);
  activateTab('schema');
  logNote('tour demo removed — your project is exactly as it was');
}

async function startAppTour() {
  const settle = ms => new Promise(r => setTimeout(r, ms));
  // an empty project has nothing to show — borrow the demo library for the
  // duration of the tour (removed again in onEnd)
  let usedDemo = false;
  if (!schemaModel().tables.length) {
    usedDemo = await loadTourDemo();
    if (usedDemo) await settle(150);
  }
  const dbTabBtn = () => [...document.querySelectorAll('#file-tabs .ftab')].find(b => b.textContent.includes('⊞ database'));
  const segBtn = label => [...document.querySelectorAll('.dbtab-bar .seg button')].find(x => x.textContent === label);
  const dbSeg = label => {
    const b = segBtn(label);
    if (b && !b.classList.contains('active')) b.click();
  };
  /* elements inside the builder iframe: click via contentDocument, ring via
     the element's rect offset by the iframe's own position */
  const bFrame = () => document.querySelector('#builder-frame');
  const bEl = sel => {
    const f = bFrame();
    return (f && f.contentDocument) ? f.contentDocument.querySelector(sel) : null;
  };
  const bRect = sel => {
    const f = bFrame();
    const t = bEl(sel);
    if (!f || !t) return null;
    const fr = f.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    return { left: fr.left + r.left, top: fr.top + r.top, width: r.width, height: r.height };
  };
  const bMode = async sel => {
    await pressPulse(bRect(sel));
    const t = bEl(sel);
    if (t) t.click();
    await settle(120);
  };
  runTour([
    {
      target: null,
      title: 'This folder IS a database',
      text: 'Your project is a normal folder with plain files in it — and while it\'s open, ' +
        'a private MySQL server runs on exactly those files. Everything you apply happens ' +
        'in both places at once: the live database and the files. Copy the folder, and ' +
        'you\'ve copied the database.'
    },
    ...(usedDemo ? [{
      target: '#editor-host',
      title: 'A demo to explore',
      prep: () => activateTab('schema'),
      text: 'Your project was empty, so the tour brought a small lending library along — ' +
        'authors, books, members, loans. It exists only during the tour: the moment you ' +
        'finish (or skip), it vanishes and your project is exactly as you left it.'
    }] : []),
    {
      target: '#file-tabs',
      title: 'The files',
      prep: () => activateTab('schema'),
      text: 'schema.sql defines the database — SQL Studio edits it live as you design. ' +
        'data.sql is a snapshot of all the data. journal.sql records every change ever applied. ' +
        '"+ query" adds a file for questions worth keeping.'
    },
    {
      target: '#editor-host',
      title: 'The editor',
      text: 'Files open here with SQL highlighting. You can always just type — Ctrl+S saves.'
    },
    {
      target: '#view-host',
      title: 'Your database, drawn',
      prep: async () => {
        await pressPulse(dbTabBtn());   // show WHERE we're going
        activateTab('db');
        dbSeg('View');
        await settle(120);
      },
      text: 'That was the ⊞ database tab. Every table is a card and every foreign key a ' +
        'real line between them. Drag cards to arrange, drag the background to pan, ' +
        'ctrl+wheel zooms. The ▦ on a card opens that table\'s data.'
    },
    {
      target: '#view-host',
      title: 'The live designer',
      prep: async () => {
        activateTab('db');
        await pressPulse(segBtn('Edit'));
        dbSeg('Edit');
        await settle(120);
      },
      text: 'The View | Edit switch at the top flips to the designer. Change anything — it ' +
        'applies the moment you click away. The properties button on each column holds ' +
        'NOT NULL, defaults, allowed ranges and foreign keys; the black tags show what\'s ' +
        'set, and clicking a tag removes it. Dropping things asks first. Ctrl+Z undoes.'
    },
    {
      target: '#view-host',
      title: 'Tables are spreadsheets',
      when: () => schemaModel().tables.length > 0,
      prep: async () => {
        activateTab('db');
        dbSeg('View');
        await settle(150);
        await pressPulse(document.querySelector('.cv-card .iconbtn'));
        openTableGrid(schemaModel().tables[0].name);
        await settle(250);
      },
      text: 'The ▦ on a card opened this. Double-click a cell to edit — clicking away ' +
        'commits, Escape cancels. The bottom row inserts, ✕ deletes (with a confirm). ' +
        'Foreign-key fields search the referenced table as you type, so you pick the row ' +
        'instead of remembering its id.'
    },
    {
      target: '#builder-pane',
      title: 'The builder',
      text: 'Ask questions and change data with words instead of syntax. The tabs at its top ' +
        'are the four things you can do — let\'s click through each one. (Tables themselves ' +
        'are designed in ⊞ database, so there\'s no CREATE tab here.)'
    },
    {
      target: () => bRect('#tab-select'),
      title: 'SELECT — ask questions',
      prep: () => bMode('#tab-select'),
      text: 'Build a question from the word bank below: pick the table, columns, conditions, ' +
        'grouping, sorting. Foreign keys power join suggestions, and the finished query ' +
        'reads like a sentence.'
    },
    {
      target: () => bRect('#tab-insert'),
      title: 'INSERT — add rows',
      prep: () => bMode('#tab-insert'),
      text: 'Fill a row and apply it. "＋ apply + next row" saves as you go, applied rows ' +
        'stay visible above, and foreign-key fields search the referenced table while ' +
        'you type.'
    },
    {
      target: () => bRect('#tab-update'),
      title: 'UPDATE — change rows',
      prep: () => bMode('#tab-update'),
      text: 'Pick what to set and which rows it hits — the conditions use the same popover ' +
        'as SELECT, including lookups by name and mini-queries.'
    },
    {
      target: () => bRect('#tab-delete'),
      title: 'DELETE — remove rows',
      prep: () => bMode('#tab-delete'),
      text: 'Choose the rows by condition and apply. Like every change, it executes on the ' +
        'live database AND is recorded in your files — nothing happens silently.'
    },
    {
      target: () => bRect('#ide-actionbar'),
      title: 'Run, keep, apply',
      prep: () => bMode('#tab-select'),
      text: 'This bar always shows the SQL the builder built. ▶ Run executes a SELECT and ' +
        'shows results in the console; "+ to file" keeps a good query in queries/. ' +
        '✓ Apply executes changes.'
    },
    {
      target: '#lang-toggle',
      title: 'Two languages, one builder',
      text: 'Natural reads like a sentence; SQL shows the real statement skeleton. It\'s the ' +
        'same query either way — flip whenever you like.'
    },
    {
      target: '#console-pane',
      title: 'The console',
      text: 'Results land here. You can also type SQL directly and press Enter — it runs, but ' +
        'is deliberately NOT recorded in the journal: scratch space. ↑ recalls your history.'
    },
    {
      target: '#engine-status',
      title: 'Your private MySQL',
      text: 'This is the real MySQL server running on your project folder — status and port. ' +
        'Nothing leaves your machine, and any copy of the folder rebuilds the same database ' +
        'from its files.'
    },
    {
      target: '#btn-settings',
      title: 'Make it yours',
      text: 'Theme, builder wording, row limits and delete confirmations live in Settings — ' +
        'and you can replay this tour from there anytime. Have fun!'
    }
  ], {
    onEnd: async () => {
      try { localStorage.setItem('sqlstudio.toured', '1'); } catch { /* ignore */ }
      await endTourDemo(); // no-op unless the demo was borrowed
    }
  });
}

/* ================= FK row search (grid + builder share it) ================= */

/** live rows of a referenced table matching what the user typed: the human
 *  (non-numeric, non-PK) columns are searched, a typed number also matches
 *  the key itself; results labeled "id · name · …" */
async function fkRowSearch(refTable, refCol, q) {
  if (!engineRunning || !currentDb) return [];
  const def = schemaModel().byName[refTable];
  if (!def) return [];
  const human = def.columns.filter(c => !c.pk && !c.numeric).slice(0, 2).map(c => c.name);
  const like = String(q).replace(/([\\%_])/g, '\\$1').replace(/'/g, "''");
  const conds = human.map(c => '`' + c + "` LIKE '%" + like + "%'");
  if (/^\d+$/.test(String(q).trim())) conds.push('`' + refCol + '` = ' + String(q).trim());
  if (!conds.length) return [];
  const cols = ['`' + refCol + '`'].concat(human.map(c => '`' + c + '`'));
  try {
    const res = await invoke('db_exec', {
      sql: 'SELECT ' + cols.join(', ') + ' FROM `' + refTable + '` WHERE ' +
        conds.join(' OR ') + ' LIMIT 8',
      db: currentDb
    });
    return res.rows.map(r => ({
      id: r[0],
      label: r[0] + ' · ' + r.slice(1).filter(v => v != null).join(' · ')
    }));
  } catch { return []; }
}

/* ================= builder mount + sync hooks ================= */

/* builder INSERTs used to append here one by one; data.sql is now a full
   snapshot of the live data, so any applied insert just re-snapshots */
async function appendData() {
  scheduleSnapshot();
}

/* the quiet signal that the builder re-read the schema (replaces the lite
   tool's big toast, which the shim now hides) */
function flashBuilderSync() {
  const s = $('#builder-sync');
  if (!s) return;
  s.classList.add('show');
  clearTimeout(flashBuilderSync._t);
  flashBuilderSync._t = setTimeout(() => s.classList.remove('show'), 1400);
}

builder = mountBuilder($('#builder-host'), {
  runScript,
  appendData,
  /* live values for the FK-by-name autocomplete: real rows, fuzzy-matched */
  async lookupValues(table, column, prefix) {
    if (!engineRunning || !currentDb) return [];
    const tid = String(table).replace(/[^\w$]/g, '');
    const cid = String(column).replace(/[^\w$]/g, '');
    if (!tid || !cid) return [];
    const like = String(prefix).replace(/([\\%_])/g, '\\$1').replace(/'/g, "''");
    try {
      const res = await invoke('db_exec', {
        sql: 'SELECT DISTINCT `' + cid + '` FROM `' + tid + '` WHERE `' + cid +
          "` LIKE '%" + like + "%' LIMIT 8",
        db: currentDb
      });
      return res.rows.map(r => r[0]).filter(v => v != null);
    } catch { return []; }
  },
  /* the grid-style FK row search, for the insert tab: the shim only knows
     the referenced table's name — resolve its key (the PK) here */
  async searchFkRows(refTable, q) {
    const def = schemaModel().byName[refTable];
    const refCol = (def && (def.columns.find(c => c.pk) || {}).name) || 'id';
    return fkRowSearch(refTable, refCol, q);
  },
  /* "+ to file": built queries append to a queries/*.sql tab (or a new one) */
  queryFiles() {
    return tabs.filter(t => t.id.startsWith('q:')).map(t => t.id.slice(2));
  },
  async saveToQueryFile(name, sql) {
    if (!project || !String(sql || '').trim()) return;
    const clean = String(name).trim().replace(/\.sql$/i, '').replace(/[^\w$-]+/g, '_') || 'query';
    const id = 'q:' + clean;
    let t = tabById(id);
    if (!t) {
      t = {
        id, label: clean + '.sql', rel: 'queries/' + clean + '.sql',
        content: '-- ' + clean + '\n', savedContent: null, readonly: false
      };
      tabs.push(t);
    }
    let cur = t.content;
    if (cur && !cur.endsWith('\n')) cur += '\n';
    cur += '\n' + sql.trim() + '\n';
    t.content = cur;
    try {
      await invoke('file_write', { rel: t.rel, content: cur });
      t.savedContent = cur;
      if (activeTab === t.id) setEditorText(cur);
      renderTabs();
      toast('query saved to ' + t.label);
    } catch (e) { toast(String(e)); }
  },
  onReady() {
    builder.setLang(LANG);
    builder.setTheme(SETTINGS.theme);
    if (project) builder.setSchema(tabById('schema') ? tabById('schema').content : '');
  }
});
{
  const _setSchema = builder.setSchema.bind(builder);
  builder.setSchema = text => { _setSchema(text); flashBuilderSync(); };
}

/* ================= splitters ================= */

function wireSplitter(elSel, cssVar, horizontal) {
  const s = $(elSel);
  let dragging = false;
  s.addEventListener('mousedown', e => {
    e.preventDefault(); // don't select text while resizing
    dragging = true;
    // the builder iframe swallows mousemove — without this, the splitter
    // freezes the moment the pointer crosses into it (i.e. when shrinking)
    document.body.classList.add('split-drag');
    document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize';
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.classList.remove('split-drag');
    document.body.style.cursor = '';
  });
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

/* closing with unsaved edits asks first (dirty = content ≠ savedContent;
   view tabs and the tour demo don't count) */
try {
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  appWindow.onCloseRequested(async event => {
    const dirty = tabs.filter(t =>
      t.kind !== 'view' && !t.readonly && t.content !== t.savedContent &&
      !(tourDemo && t.id === 'schema'));
    if (!dirty.length) return;
    const stay = !(await window.__TAURI__.dialog.ask(
      dirty.map(t => '· ' + t.label).join('\n') + '\n\nClose anyway? Unsaved edits are lost.',
      { title: 'Unsaved changes', kind: 'warning', okLabel: 'Close anyway', cancelLabel: 'Keep working' }
    ));
    if (stay) event.preventDefault();
  });
} catch { /* window API unavailable (tests) — no guard */ }

$('#btn-new-project').addEventListener('click', newProject);
$('#btn-open-project').addEventListener('click', openProject);
renderRecents();
wireSettingsUI();
applyTheme();
