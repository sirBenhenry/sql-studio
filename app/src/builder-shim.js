// builder-shim.js — mounts the lite tool (core/builder.html, extracted
// verbatim) as a same-origin iframe inside the builder pane and adapts it
// from the OUTSIDE into an integrated IDE panel: the website chrome, SQL
// copy-posters, hints and practice sections are hidden — the builder is
// just the building controls plus ONE contextual action bar at the bottom
// (▶ Run in SELECT, ✓ Apply in the write modes). Changes flow straight
// into the project (files + database + journal); nothing is copied.
// The lite tool's code is never modified — zero drift.
'use strict';

import { splitSQL } from './sync.js';

const HIDE_CSS = `
  .hero, footer, #tour, #tour-ring, #tour-backdrop, #tour-box,
  #schema-section, #lang-toggle, #tour-replay { display: none !important; }

  /* the lite tool's toasts ("Database loaded — build away!" on every schema
     re-feed) are website chrome — the IDE signals sync its own quiet way */
  #toast { display: none !important; }

  /* the IDE owns SQL display (files + console): no posters, no copy,
     no practice lists, no long explainer hints */
  .sql-card, .practice { display: none !important; }
  .card > .hint, #builder-section > .hint { display: none !important; }
  /* the project IS the database — no start-from-scratch toggle; and the
     CREATE/ALTER modes live in the IDE's Tables designer (⊞ database tab),
     so the builder keeps only the data modes */
  .boiler-row, #extend-note, #tab-create, #tab-alter { display: none !important; }

  main { padding: 0 12px 64px; max-width: none; }
  .card { padding-top: 14px; padding-bottom: 16px; margin-top: 10px; }
  .step-head .step-badge { display: none !important; }   /* no step numbers in the IDE */

  /* mode tabs: ONE compact row that always fits the narrow pane */
  .mode-tabs {
    margin-top: 8px;
    display: flex !important;
    flex-wrap: nowrap !important;
    gap: 0 !important;
    justify-content: space-between !important;
    overflow: hidden !important;
  }
  .mode-tab {
    font-size: .64rem !important;
    letter-spacing: .04em !important;
    padding: 0 2px 7px !important;
    white-space: nowrap;
    flex: 0 1 auto !important;
  }
  .mode-tab span { display: none !important; }

  .workbench { grid-template-columns: 1fr !important; gap: 0 !important; }

  /* no sideways scrolling inside the pane; slim scrollbars */
  html, body { overflow-x: hidden !important; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(127,127,127,.35); border-radius: 4px; }
  ::-webkit-scrollbar-corner { background: transparent; }

  /* the IDE action bar (shim-owned) */
  #ide-actionbar {
    position: fixed; left: 0; right: 0; bottom: 0;
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px;
    background: var(--bg);
    border-top: 2px solid var(--rule);
    z-index: 50;
  }
  #ide-actionbar .sqlpeek {
    flex: 1; min-width: 0;
    font-family: ui-monospace, Consolas, monospace;
    font-size: .68rem; color: var(--muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* live-value suggestions under FK-by-name inputs (shim-owned) */
  #ide-suggest {
    position: fixed; z-index: 999; display: none;
    background: var(--bg); border: 1px solid var(--rule);
    box-shadow: 0 8px 20px rgba(0,0,0,.22);
    max-height: 180px; overflow-y: auto; overflow-x: hidden;
    font-size: .78rem;
  }
  .ide-sug-item { padding: 5px 10px; cursor: pointer; white-space: nowrap; }
  .ide-sug-item:hover, .ide-sug-item.active { background: var(--ink); color: var(--bg); }
`;

/* forced-theme overrides for the lite tool (it only knows the OS media
   query) — same palettes, attribute-driven so Settings can force a side */
const THEME_CSS = `
  :root[data-theme="light"] {
    --bg:#ffffff; --ink:#111111; --muted:#737373; --line:#e2e2e2;
    --rule:#111111; --accent:#e8342c;
    --cat-table:#c2410c; --cat-col:#1d4ed8; --cat-agg:#0e7490; --cat-cond:#15803d;
    --cat-group:#be185d; --cat-sort:#6d28d9; --cat-limit:#737373;
    --sql-bg:#0d0d0d; --sql-line:#0d0d0d;
  }
  :root[data-theme="dark"] {
    --bg:#0e0e0e; --ink:#f2f2f2; --muted:#8f8f8f; --line:#272727;
    --rule:#f2f2f2; --accent:#ff5347;
    --cat-table:#fb923c; --cat-col:#60a5fa; --cat-agg:#22d3ee; --cat-cond:#4ade80;
    --cat-group:#f472b6; --cat-sort:#a78bfa; --cat-limit:#9ca3af;
    --sql-bg:#000000; --sql-line:#2a2a2a;
  }
`;

/* the lite tool's empty-state notes talk about its own step-1 upload panel,
   which the IDE hides — reword them for the IDE world */
const LOCK_NOTE = 'No tables yet — design one in the ⊞ database tab, or type CREATE TABLE statements into schema.sql.';

/** Wire a loaded builder document into the IDE: hide chrome, add the action
 *  bar, live-value autocomplete for FK-by-name lookups, and the semi-live
 *  INSERT flow. Exported separately so tests can run it against jsdom. */
export function wireBuilder(d, win, hooks) {
  const style = d.createElement('style');
  style.textContent = HIDE_CSS + THEME_CSS;
  d.head.appendChild(style);

  // reword the lite tool's "load a database in step 1" empty-state notes
  for (const n of d.querySelectorAll('.lock-note')) n.textContent = LOCK_NOTE;

  // CREATE always extends the project's database — never "from scratch"
  const boiler = d.querySelector('#chk-boiler');
  if (boiler && boiler.checked) {
    boiler.checked = false;
    boiler.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  const panelText = sel => (d.querySelector(sel) ? d.querySelector(sel).textContent : '');

  /* ---- semi-live INSERT: rows apply as you go ---- */

  /** collapse the insert builder back to one clean empty row (the lite tool
   *  resets to a fresh row when the last one is removed) */
  function clearInsertRows() {
    for (let guard = 0; guard < 60; guard++) {
      const rows = [...d.querySelectorAll('#insert-rows .set-row')];
      if (!rows.length) break;
      if (rows.length === 1) {
        const filled = [...rows[0].querySelectorAll('input')].some(i => i.value) ||
          rows[0].querySelector('.chip');
        if (!filled) break;
      }
      const del = [...rows[0].querySelectorAll('button.iconbtn')].filter(b => b.textContent === '✕').pop();
      if (!del) break;
      del.click();
    }
  }

  /* ---- the mode-contextual actions (executed through the IDE hooks) ---- */
  const ACTIONS = {
    select: {
      label: '▶ Run',
      title: 'execute this query against the project database',
      sqlSel: '#sql-output',
      run: sql => hooks.runScript(sql, 'builder: select', { journal: false })
    },
    insert: {
      label: '✓ Apply',
      title: 'execute and record in data.sql',
      sqlSel: '#insert-sql',
      run: async sql => {
        const ok = await hooks.runScript(sql, 'builder: insert', { journal: true });
        if (ok) {
          if (hooks.appendData) hooks.appendData(sql);
          clearInsertRows(); // applied rows must not apply twice
        }
        return ok;
      }
    },
    update: {
      label: '✓ Apply',
      title: 'execute against the project database',
      sqlSel: '#update-sql',
      run: sql => hooks.runScript(sql, 'builder: update', { journal: true })
    },
    delete: {
      label: '✓ Apply',
      title: 'execute against the project database',
      sqlSel: '#delete-sql',
      run: sql => hooks.runScript(sql, 'builder: delete', { journal: true })
    },
    // CREATE and ALTER live in the IDE's Tables designer (⊞ database tab)
  };

  const currentMode = () => {
    const t = d.querySelector('.mode-tab.active');
    const m = t ? t.id.replace('tab-', '') : 'select';
    return ACTIONS[m] ? m : 'select';
  };

  /* generated SQL, comment lines stripped (placeholders/warnings) */
  const currentSQL = () => {
    const a = ACTIONS[currentMode()];
    return panelText(a.sqlSel).split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
  };

  /* ---- the single action bar ---- */
  const bar = d.createElement('div');
  bar.id = 'ide-actionbar';
  const peek = d.createElement('span');
  peek.className = 'sqlpeek';
  const actBtn = d.createElement('button');
  actBtn.className = 'btn primary small';
  bar.appendChild(peek);
  bar.appendChild(actBtn);
  d.body.appendChild(bar);

  function refreshBar() {
    const a = ACTIONS[currentMode()];
    actBtn.textContent = a.label;
    actBtn.title = a.title;
    const sql = currentSQL();
    peek.textContent = sql.replace(/\s+/g, ' ');
    actBtn.disabled = !splitSQL(sql).length;
  }

  actBtn.addEventListener('click', async () => {
    const a = ACTIONS[currentMode()];
    const sql = currentSQL();
    if (!splitSQL(sql).length) return;
    actBtn.disabled = true;
    try { await a.run(sql); } finally { refreshBar(); }
  });

  /* "+ add row" first applies what's built (Ben's rule: adding the next one
     commits the last one) — so a by-name lookup can find the row before it */
  d.addEventListener('click', e => {
    const btn = e.target && e.target.closest && e.target.closest('#btn-add-insert-row');
    if (!btn || currentMode() !== 'insert') return;
    const sql = currentSQL();
    if (!splitSQL(sql).length) return; // nothing built yet — plain add
    e.stopPropagation();
    e.preventDefault();
    (async () => {
      const ok = await hooks.runScript(sql, 'builder: insert', { journal: true });
      if (ok) {
        if (hooks.appendData) hooks.appendData(sql);
        clearInsertRows(); // leaves one fresh empty row — that IS the new row
      }
      refreshBar();
    })();
  }, true);
  const addRowBtn = d.querySelector('#btn-add-insert-row');
  if (addRowBtn) addRowBtn.title = 'applies this row to the database, then starts the next';

  // keep the bar current: mode switches + any change inside the builder
  d.addEventListener('click', () => setTimeout(refreshBar, 0));
  d.addEventListener('input', () => setTimeout(refreshBar, 0));
  d.addEventListener('change', () => setTimeout(refreshBar, 0));
  refreshBar();

  /* ---- live-value autocomplete for FK-by-name lookups: typing "ann" in
     a "Look up member by…" popover suggests real values from the live DB ---- */
  const sug = d.createElement('div');
  sug.id = 'ide-suggest';
  let sugFor = null;
  let sugIdx = -1;
  let sugT = null;

  function hideSug() {
    sug.style.display = 'none';
    sugFor = null;
    sugIdx = -1;
  }
  function sugEls() { return [...sug.querySelectorAll('.ide-sug-item')]; }
  function pick(v) {
    const t = sugFor;
    hideSug();
    if (!t) return;
    t.value = v;
    t.dispatchEvent(new win.Event('input', { bubbles: true }));
    clearTimeout(sugT); // no point suggesting what was just picked
    t.focus();
  }
  function showSug(input, values) {
    if (!values.length) { hideSug(); return; }
    sug.textContent = '';
    for (const v of values) {
      const it = d.createElement('div');
      it.className = 'ide-sug-item';
      it.textContent = v;
      it.addEventListener('mousedown', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        sugFor = input;
        pick(v);
      });
      sug.appendChild(it);
    }
    // live INSIDE the popover — the lite tool closes popovers on any
    // outside mousedown, and the dropdown must not count as outside
    const parent = input.closest('.popover') || d.body;
    if (sug.parentNode !== parent) parent.appendChild(sug);
    const r = input.getBoundingClientRect();
    sug.style.left = r.left + 'px';
    sug.style.top = (r.bottom + 2) + 'px';
    sug.style.minWidth = r.width + 'px';
    sug.style.display = 'block';
    sugFor = input;
    sugIdx = -1;
  }
  /** which live table/column a lookup-popover value input is matching */
  function lookupCtx(input) {
    if (!input || input.placeholder !== 'value') return null;
    const pop = input.closest('.popover');
    const h = pop && pop.querySelector('h4');
    const m = h && h.textContent.match(/^Look up ([\w$]+) by/);
    if (!m) return null;
    const rowEl = input.closest('.row');
    const sel = rowEl && rowEl.querySelector('select');
    return (sel && sel.value) ? { table: m[1], column: sel.value } : null;
  }

  d.addEventListener('input', e => {
    const t = e.target;
    if (!t || t.tagName !== 'INPUT') return;
    const ctx = lookupCtx(t);
    if (!ctx || !hooks.lookupValues) { if (sugFor === t) hideSug(); return; }
    clearTimeout(sugT);
    const q = t.value.trim();
    if (!q) { hideSug(); return; }
    sugT = setTimeout(async () => {
      try {
        const vals = await hooks.lookupValues(ctx.table, ctx.column, q);
        if (d.activeElement === t && t.value.trim() === q) showSug(t, vals.map(String));
      } catch { hideSug(); }
    }, 150);
  });
  d.addEventListener('keydown', e => {
    if (!sugFor || e.target !== sugFor || sug.style.display === 'none') return;
    const items = sugEls();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sugIdx = e.key === 'ArrowDown' ? Math.min(items.length - 1, sugIdx + 1) : Math.max(0, sugIdx - 1);
      items.forEach((it, i) => it.classList.toggle('active', i === sugIdx));
    } else if (e.key === 'Enter' && sugIdx >= 0) {
      e.preventDefault();
      e.stopPropagation();
      pick(items[sugIdx].textContent);
    } else if (e.key === 'Escape') {
      hideSug();
    }
  }, true);
  d.addEventListener('focusout', () => {
    setTimeout(() => { if (sugFor && d.activeElement !== sugFor) hideSug(); }, 120);
  });

  return { refreshBar, clearInsertRows };
}

export function mountBuilder(host, hooks) {
  // Neutralize the lite tool's own persistence before it boots: no tour,
  // start in SELECT, and no stale schema/query state from a previous run —
  // the IDE is the source of truth and feeds the schema explicitly.
  try {
    localStorage.setItem('selectstudio.toured', '1');
    localStorage.setItem('selectstudio.mode', 'select');
    for (const k of ['selectstudio.schema', 'selectstudio.create', 'selectstudio.insert',
                     'selectstudio.update', 'selectstudio.delete', 'selectstudio.alter']) {
      localStorage.removeItem(k);
    }
  } catch { /* ignore */ }

  const frame = document.createElement('iframe');
  frame.id = 'builder-frame';
  frame.src = 'core/builder.html';
  frame.style.cssText = 'border:0;width:100%;height:100%;display:block;background:transparent;';
  host.textContent = '';
  host.appendChild(frame);

  const api = {
    ready: false,
    setSchema(text) {
      if (!api.ready) { api._pending = text; return; }
      const d = frame.contentDocument;
      d.querySelector('#schema-input').value = text;
      d.querySelector('#btn-parse').click();
    },
    setLang(lang) {
      if (!api.ready) return;
      const b = frame.contentDocument.querySelector('#lang-toggle .lang-opt[data-lang="' + lang + '"]');
      if (b) b.click();
    },
    readSchemaText() {
      return api.ready ? frame.contentDocument.querySelector('#schema-input').value : '';
    },
    setTheme(mode) {
      api._theme = mode;
      if (!api.ready) return;
      const root = frame.contentDocument.documentElement;
      if (mode === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', mode);
    }
  };

  frame.addEventListener('load', () => {
    const d = frame.contentDocument;

    wireBuilder(d, frame.contentWindow, hooks);
    if (api._theme && api._theme !== 'system') {
      d.documentElement.setAttribute('data-theme', api._theme);
    }

    api.ready = true;
    if (api._pending != null) {
      api.setSchema(api._pending);
      api._pending = null;
    }
    if (hooks.onReady) hooks.onReady();
  });

  return api;
}
