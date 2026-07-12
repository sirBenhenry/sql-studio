// overview.js — the "Database" view: every table as a card (columns, keys,
// FK arrows as text for now — SVG lines come with the full canvas), click a
// card to open its data grid. Schema comes from the shared parser model.
'use strict';

export function renderOverview(host, schema, counts, hooks) {
  // hooks: { openTable(name) }
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  host.textContent = '';
  const wrap = el('div', 'ov-wrap');

  if (!schema || !schema.tables.length) {
    wrap.appendChild(el('p', 'hint pad', 'No tables yet — create some in the builder (CREATE tab) or type into schema.sql.'));
    host.appendChild(wrap);
    return;
  }

  const grid = el('div', 'ov-grid');
  for (const t of schema.tables) {
    const card = el('div', 'ov-card');
    const head = el('div', 'ov-card-head');
    head.appendChild(el('span', 'ov-name', t.name));
    if (counts && counts[t.name] != null) {
      head.appendChild(el('span', 'ov-count', counts[t.name] + ' rows'));
    }
    card.appendChild(head);

    const ul = el('ul', 'ov-cols');
    for (const c of t.columns) {
      const li = el('li');
      const left = el('span');
      if (c.pk) left.appendChild(el('b', 'keytag', 'PK'));
      else if (t.fks.some(fk => fk.col === c.name)) left.appendChild(el('b', 'keytag fk', 'FK'));
      left.appendChild(document.createTextNode(c.name));
      li.appendChild(left);
      li.appendChild(el('span', 'ov-type', c.type));
      ul.appendChild(li);
    }
    card.appendChild(ul);

    if (t.fks.length) {
      const fkn = el('div', 'ov-fks');
      fkn.textContent = t.fks.map(fk => fk.col + ' → ' + fk.refTable + '.' + fk.refCol).join('  ·  ');
      card.appendChild(fkn);
    }

    card.addEventListener('click', () => hooks.openTable(t.name));
    card.title = 'open ' + t.name + ' as a spreadsheet';
    grid.appendChild(card);
  }
  wrap.appendChild(grid);
  host.appendChild(wrap);
}
