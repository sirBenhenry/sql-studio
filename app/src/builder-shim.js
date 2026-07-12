// builder-shim.js — mounts the lite tool (core/builder.html, extracted
// verbatim) as a same-origin iframe inside the builder pane and adapts it
// from the OUTSIDE: hides its standalone chrome, feeds it the project
// schema, and adds Run/Apply buttons that route into the IDE's sync
// pipeline. The lite tool's code is never modified — zero drift.
'use strict';

import { splitSQL } from './sync.js';

const HIDE_CSS = `
  .hero, footer, #tour, #tour-ring, #tour-backdrop, #tour-box,
  #schema-section, #lang-toggle, #tour-replay { display: none !important; }
  main { padding: 0 14px 40px; max-width: none; }
  /* mode tabs must fit the narrow pane: wrap, compact, no descriptions */
  .mode-tabs {
    margin-top: 8px;
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 2px 14px !important;
    overflow: hidden !important;
  }
  .mode-tab { font-size: .82rem !important; padding: 0 1px 8px !important; white-space: nowrap; }
  .mode-tab span { display: none !important; }   /* hide "— query data" descriptions */
  /* stack builder over SQL — the pane is a narrow column */
  .workbench { grid-template-columns: 1fr !important; gap: 0 !important; }
  .sql-card { position: static !important; }
  /* no sideways scrolling inside the pane; slim scrollbars */
  html, body { overflow-x: hidden !important; }
  .sql-box { white-space: pre-wrap !important; overflow-x: hidden !important; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(127,127,127,.35); border-radius: 4px; }
  ::-webkit-scrollbar-corner { background: transparent; }
`;

/* the lite tool's empty-state notes talk about its own step-1 upload panel,
   which the IDE hides — reword them for the IDE world */
const LOCK_NOTE = 'No tables yet — design one in the CREATE tab, or type CREATE TABLE statements into schema.sql.';

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
    }
  };

  frame.addEventListener('load', () => {
    const d = frame.contentDocument;

    const style = d.createElement('style');
    style.textContent = HIDE_CSS;
    d.head.appendChild(style);

    // reword the lite tool's "load a database in step 1" empty-state notes
    for (const n of d.querySelectorAll('.lock-note')) n.textContent = LOCK_NOTE;

    const btn = (label, title) => {
      const b = d.createElement('button');
      b.className = 'btn small primary';
      b.textContent = label;
      if (title) b.title = title;
      return b;
    };
    const panelText = sel => (d.querySelector(sel) ? d.querySelector(sel).textContent : '');

    // ---- SELECT: Run → console ----
    {
      const head = d.querySelector('#sql-section .step-head');
      if (head) {
        const run = btn('▶ Run', 'execute this query against the project database');
        run.addEventListener('click', () => hooks.runScript(panelText('#sql-output'), 'builder: select', { journal: false }));
        head.appendChild(run);
      }
    }

    // ---- INSERT: Apply → execute + journal + data.sql ----
    {
      const head = d.querySelector('#insert-section .sql-card .step-head');
      if (head) {
        const b = btn('✓ Apply', 'execute and record in data.sql');
        b.addEventListener('click', async () => {
          const sql = panelText('#insert-sql');
          const ok = await hooks.runScript(sql, 'builder: insert', { journal: true });
          if (ok) hooks.appendData(sql);
        });
        head.appendChild(b);
      }
    }

    // ---- UPDATE / DELETE: Apply → execute + journal ----
    for (const [sec, label] of [['update', 'builder: update'], ['delete', 'builder: delete']]) {
      const head = d.querySelector('#' + sec + '-section .sql-card .step-head');
      if (head) {
        const b = btn('✓ Apply', 'execute against the project database');
        b.addEventListener('click', () => hooks.runScript(panelText('#' + sec + '-sql'), label, { journal: true }));
        head.appendChild(b);
      }
    }

    // ---- ALTER: Apply → execute + journal + fold into schema.sql ----
    {
      const head = d.querySelector('#alter-section .sql-card .step-head');
      const liteApply = d.querySelector('#btn-apply-alter');
      if (head && liteApply) {
        // the lite tool's own apply button would only edit its local textarea —
        // replace it with the IDE flow (execute → journal → schema.sql)
        liteApply.style.display = 'none';
        const b = btn('✓ Apply', 'run the ALTERs, journal them, and update schema.sql');
        b.addEventListener('click', async () => {
          const sql = panelText('#alter-sql');
          if (!splitSQL(sql).length) { return; }
          const ok = await hooks.runScript(sql, 'builder: alter', { journal: true });
          if (!ok) return;
          liteApply.click(); // lite folds the change into its schema text + model
          hooks.schemaChanged(api.readSchemaText());
        });
        head.appendChild(b);
      }
    }

    // ---- CREATE: Apply → execute + journal + schema.sql ----
    {
      const head = d.querySelector('#create-section .sql-card .step-head');
      const toSelect = d.querySelector('#btn-to-select');
      if (head && toSelect) {
        const b = btn('✓ Apply', 'create these tables in the project database and schema.sql');
        b.addEventListener('click', async () => {
          const sql = panelText('#create-sql');
          if (!splitSQL(sql).length) return;
          const ok = await hooks.runScript(sql, 'builder: create', { journal: true });
          if (!ok) return;
          toSelect.click(); // lite merges the new tables into its schema text
          hooks.schemaChanged(api.readSchemaText());
        });
        head.appendChild(b);
      }
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
