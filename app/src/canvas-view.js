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

/** The diagram as a standalone .svg — exactly the current arrangement,
 *  drawn on white so it drops into docs/slides regardless of app theme. */
export function buildDiagramSvg(tables, pos) {
  const INK = '#111111', MUTED = '#737373', LINE = '#e2e2e2', ACCENT = '#e8342c';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  for (const t of tables) {
    const p = pos[t.name];
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + CARD_W);
    maxY = Math.max(maxY, p.y + cardHeight(t));
  }
  if (!isFinite(minX)) return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const ox = PAD - minX, oy = PAD - minY;
  const W = maxX - minX + PAD * 2, H = maxY - minY + PAD * 2;
  const out = [];
  out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
    '" viewBox="0 0 ' + W + ' ' + H + '" font-family="Helvetica, Arial, sans-serif">');
  out.push('<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>');

  /* lines first (under the cards) — same geometry the live view uses */
  for (const t of tables) {
    for (const fk of t.fks) {
      const from = pos[t.name], to = pos[fk.refTable];
      if (!from || !to) continue;
      const idx = t.columns.findIndex(c => c.name === fk.col);
      const y1 = from.y + oy + (idx >= 0 ? HEAD_H + idx * ROW_H + ROW_H / 2 : HEAD_H / 2);
      const y2 = to.y + oy + HEAD_H / 2;
      const fromRight = to.x >= from.x + CARD_W / 2;
      const x1 = (fromRight ? from.x + CARD_W : from.x) + ox;
      const x2 = (fromRight ? to.x : to.x + CARD_W) + ox;
      const pull = Math.max(36, Math.abs(x2 - x1) / 2);
      const c1 = fromRight ? x1 + pull : x1 - pull;
      const c2 = fromRight ? x2 - pull : x2 + pull;
      out.push('<path d="M ' + x1 + ' ' + y1 + ' C ' + c1 + ' ' + y1 + ', ' + c2 + ' ' + y2 + ', ' + x2 + ' ' + y2 +
        '" fill="none" stroke="' + ACCENT + '" stroke-width="1.5"/>');
      out.push('<circle cx="' + x2 + '" cy="' + y2 + '" r="3.5" fill="' + ACCENT + '"/>');
    }
  }

  for (const t of tables) {
    const p = pos[t.name];
    if (!p) continue;
    const x = p.x + ox, y = p.y + oy, h = cardHeight(t);
    out.push('<rect x="' + x + '" y="' + y + '" width="' + CARD_W + '" height="' + h +
      '" fill="#ffffff" stroke="' + LINE + '"/>');
    out.push('<line x1="' + x + '" y1="' + (y + 2) + '" x2="' + (x + CARD_W) + '" y2="' + (y + 2) +
      '" stroke="' + INK + '" stroke-width="3"/>');
    out.push('<line x1="' + x + '" y1="' + (y + HEAD_H) + '" x2="' + (x + CARD_W) + '" y2="' + (y + HEAD_H) +
      '" stroke="' + LINE + '"/>');
    out.push('<text x="' + (x + 10) + '" y="' + (y + 20) + '" font-size="11" font-weight="800" ' +
      'letter-spacing="0.6" fill="' + INK + '">' + esc(t.name.toUpperCase()) + '</text>');
    t.columns.forEach((c, i) => {
      const cy = y + HEAD_H + i * ROW_H + ROW_H / 2 + 3.5;
      let cx = x + 10;
      const isPk = c.pk;
      const isFk = t.fks.some(f => f.col === c.name);
      if (isPk || isFk) {
        out.push('<text x="' + cx + '" y="' + cy + '" font-size="7.5" font-weight="700" fill="' +
          (isPk ? ACCENT : MUTED) + '">' + (isPk ? 'PK' : 'FK') + '</text>');
        cx += 17;
      }
      out.push('<text x="' + cx + '" y="' + cy + '" font-size="10" fill="' + INK + '">' + esc(c.name) + '</text>');
      out.push('<text x="' + (x + CARD_W - 10) + '" y="' + cy + '" font-size="8" text-anchor="end" ' +
        'font-family="Consolas, monospace" fill="' + MUTED + '">' +
        esc(String(c.type || '').replace(/\(.*/, '').toLowerCase()) + '</text>');
    });
  }
  out.push('</svg>');
  return out.join('\n');
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

  /* ---- positions: saved, else layered auto-layout; the stage pans & zooms ---- */
  const saved = hooks.loadPositions() || {};
  const pan = (saved.__pan && typeof saved.__pan.x === 'number') ? { ...saved.__pan } : { x: 0, y: 0 };
  pan.z = (typeof pan.z === 'number' && pan.z > 0) ? pan.z : 1;
  delete saved.__pan;
  stage.style.transformOrigin = '0 0';
  const applyPan = () => {
    stage.style.transform = 'translate(' + pan.x + 'px,' + pan.y + 'px) scale(' + pan.z + ')';
  };
  applyPan();

  const layers = layerize(tables);
  const cols = {};
  const pos = {};
  // never auto-place on top of cards the user positioned by hand
  let baseY = PAD;
  for (const t of tables) {
    if (saved[t.name]) baseY = Math.max(baseY, saved[t.name].y + cardHeight(t) + GAP_Y);
  }
  for (const t of tables) {
    if (saved[t.name]) { pos[t.name] = { ...saved[t.name] }; continue; }
    const L = layers[t.name] || 0;
    cols[L] = cols[L] || [];
    const y = cols[L].reduce((acc, name) => acc + cardHeight(tables.find(x => x.name === name)) + GAP_Y, baseY);
    cols[L].push(t.name);
    pos[t.name] = { x: PAD + L * (CARD_W + GAP_X), y };
  }

  const persist = () => hooks.savePositions({ ...pos, __pan: { ...pan } });

  /* drag the empty canvas to pan — wide schemas stay reachable without
     sideways scrollbars (which this app bans) */
  host.style.cursor = 'grab';

  /* the wheel pans (shift = sideways); ctrl+wheel zooms on the cursor */
  let wheelSaveT = null;
  host.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey) {
      const r = host.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const oldZ = pan.z;
      const z = Math.min(2.5, Math.max(0.25, oldZ * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      // keep the diagram point under the cursor exactly where it is
      pan.x = cx - ((cx - pan.x) / oldZ) * z;
      pan.y = cy - ((cy - pan.y) / oldZ) * z;
      pan.z = z;
    } else {
      pan.x -= e.shiftKey ? e.deltaY : e.deltaX;
      pan.y -= e.shiftKey ? 0 : e.deltaY;
    }
    applyPan();
    clearTimeout(wheelSaveT);
    wheelSaveT = setTimeout(persist, 250);
  }, { passive: false });
  host.addEventListener('pointerdown', e => {
    if (e.target.closest('.cv-card')) return;
    e.preventDefault();
    host.style.cursor = 'grabbing';
    const sx = e.clientX, sy = e.clientY, ox = pan.x, oy = pan.y;
    const move = ev => {
      pan.x = ox + ev.clientX - sx;
      pan.y = oy + ev.clientY - sy;
      applyPan();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      host.style.cursor = 'grab';
      persist();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  /* ---- cards ---- */
  const cardEls = {};
  const rowY = {}; // name -> {col -> y-center within card}
  for (const t of tables) {
    const card = el('div', 'cv-card');
    card.style.left = pos[t.name].x + 'px';
    card.style.top = pos[t.name].y + 'px';
    const head = el('div', 'cv-head');
    head.appendChild(el('span', 'cv-name', t.name));
    const count = el('span', 'cv-count', '');
    count.dataset.table = t.name;
    head.appendChild(count);
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
        // pointer deltas are screen pixels — divide by zoom for stage coords
        pos[t.name].x = Math.max(0, ox + (ev.clientX - startX) / pan.z);
        pos[t.name].y = Math.max(0, oy + (ev.clientY - startY) / pan.z);
        card.style.left = pos[t.name].x + 'px';
        card.style.top = pos[t.name].y + 'px';
        drawLines();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        persist();
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

  /* live row counts, filled in as they arrive (cards render immediately) */
  if (hooks.loadCounts) {
    hooks.loadCounts(tables.map(t => t.name)).then(counts => {
      for (const [name, n] of Object.entries(counts || {})) {
        const e = stage.querySelector('.cv-count[data-table="' + name + '"]');
        if (e) e.textContent = n + (n === 1 ? ' row' : ' rows');
      }
    }).catch(() => { /* engine offline — cards stay countless */ });
  }

  return { svg: () => buildDiagramSvg(tables, pos) };
}
