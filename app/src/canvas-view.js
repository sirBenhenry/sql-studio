// canvas-view.js — the clean "just show me my database" view: tables as
// compact cards on a canvas, foreign keys drawn as real connection lines
// (SVG bezier) from the FK column to the referenced table. Cards are laid
// out in dependency layers (referenced tables left, dependents right) so
// lines flow left→right without crossing cards; positions are draggable
// and persisted per project.
'use strict';

const CARD_W = 210;
const GAP_X = 110;
const GAP_Y = 26;
const ROW_H = 21;
const HEAD_H = 30;
const PAD = 28;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** dependency layers: a table sits one layer right of everything it references */
function layerize(tables) {
  const layer = {};
  const byName = {};
  for (const t of tables) byName[t.name] = t;
  const depth = (name, seen = new Set()) => {
    if (layer[name] != null) return layer[name];
    if (seen.has(name)) return 0; // FK cycle — break it
    seen.add(name);
    const t = byName[name];
    if (!t) return 0;
    let d = 0;
    for (const fk of t.fks) {
      if (fk.refTable !== name && byName[fk.refTable]) {
        d = Math.max(d, depth(fk.refTable, seen) + 1);
      }
    }
    layer[name] = d;
    return d;
  };
  for (const t of tables) depth(t.name);
  return layer;
}

function cardHeight(t) {
  return HEAD_H + t.columns.length * ROW_H + 8;
}

export function mountCanvasView(host, schema, hooks) {
  // hooks: { openTable(name), loadPositions() -> {name:{x,y}}, savePositions(pos) }
  host.textContent = '';
  const stage = el('div', 'cv-stage');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'cv-lines');
  stage.appendChild(svg);
  host.appendChild(stage);

  const tables = schema.tables || [];
  if (!tables.length) {
    host.textContent = '';
    host.appendChild(el('p', 'hint pad', 'No tables yet — switch to Edit and add your first one.'));
    return;
  }

  /* ---- positions: saved, else layered auto-layout ---- */
  const saved = hooks.loadPositions() || {};
  const layers = layerize(tables);
  const cols = {};
  const pos = {};
  for (const t of tables) {
    if (saved[t.name]) { pos[t.name] = { ...saved[t.name] }; continue; }
    const L = layers[t.name] || 0;
    cols[L] = cols[L] || [];
    const y = cols[L].reduce((acc, name) => acc + cardHeight(tables.find(x => x.name === name)) + GAP_Y, PAD);
    cols[L].push(t.name);
    pos[t.name] = { x: PAD + L * (CARD_W + GAP_X), y };
  }

  /* ---- cards ---- */
  const cardEls = {};
  const rowY = {}; // name -> {col -> y-center within card}
  for (const t of tables) {
    const card = el('div', 'cv-card');
    card.style.left = pos[t.name].x + 'px';
    card.style.top = pos[t.name].y + 'px';
    const head = el('div', 'cv-head');
    head.appendChild(el('span', 'cv-name', t.name));
    const open = el('button', 'iconbtn', '▦');
    open.title = 'open data';
    open.addEventListener('click', e => { e.stopPropagation(); hooks.openTable(t.name); });
    head.appendChild(open);
    card.appendChild(head);

    rowY[t.name] = {};
    t.columns.forEach((c, i) => {
      const row = el('div', 'cv-row');
      const left = el('span', 'cv-colname');
      if (c.pk) left.appendChild(el('b', 'keytag', 'PK'));
      else if (t.fks.some(fk => fk.col === c.name)) left.appendChild(el('b', 'keytag fk', 'FK'));
      left.appendChild(document.createTextNode(c.name));
      row.appendChild(left);
      row.appendChild(el('span', 'cv-coltype', String(c.type || '').replace(/\(.*/, '')));
      card.appendChild(row);
      rowY[t.name][c.name] = HEAD_H + i * ROW_H + ROW_H / 2;
    });

    stage.appendChild(card);
    cardEls[t.name] = card;

    /* drag by the header */
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const ox = pos[t.name].x, oy = pos[t.name].y;
      const move = ev => {
        pos[t.name].x = Math.max(0, ox + ev.clientX - startX);
        pos[t.name].y = Math.max(0, oy + ev.clientY - startY);
        card.style.left = pos[t.name].x + 'px';
        card.style.top = pos[t.name].y + 'px';
        drawLines();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        hooks.savePositions(pos);
        sizeStage();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function sizeStage() {
    let w = 0, h = 0;
    for (const t of tables) {
      w = Math.max(w, pos[t.name].x + CARD_W);
      h = Math.max(h, pos[t.name].y + cardHeight(t));
    }
    stage.style.width = (w + PAD * 2) + 'px';
    stage.style.height = (h + PAD * 2) + 'px';
    svg.setAttribute('width', w + PAD * 2);
    svg.setAttribute('height', h + PAD * 2);
  }

  /* ---- FK lines: from the FK column row to the target table header.
     Anchored on the facing sides, cubic bezier with horizontal pull —
     with the layered layout lines run in the corridor between cards. ---- */
  function drawLines() {
    svg.textContent = '';
    for (const t of tables) {
      for (const fk of t.fks) {
        const from = pos[t.name];
        const to = pos[fk.refTable];
        if (!from || !to) continue;
        const y1 = from.y + (rowY[t.name][fk.col] ?? HEAD_H / 2);
        const y2 = to.y + HEAD_H / 2;
        const fromRight = to.x >= from.x + CARD_W / 2;
        const x1 = fromRight ? from.x + CARD_W : from.x;
        const x2 = fromRight ? to.x : to.x + CARD_W;
        const pull = Math.max(36, Math.abs(x2 - x1) / 2);
        const c1 = fromRight ? x1 + pull : x1 - pull;
        const c2 = fromRight ? x2 - pull : x2 + pull;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`);
        path.setAttribute('class', 'cv-line');
        svg.appendChild(path);

        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', x2);
        dot.setAttribute('cy', y2);
        dot.setAttribute('r', 3.5);
        dot.setAttribute('class', 'cv-dot');
        svg.appendChild(dot);
      }
    }
  }

  sizeStage();
  drawLines();
}
