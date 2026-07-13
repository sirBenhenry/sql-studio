// tour.js — the IDE's onboarding: a spotlight ring + explainer box stepping
// through the whole workflow. Steps are { target, title, text, prep?, when? }:
// `prep` runs before the step shows (and may drive the UI — switch tabs, open
// views), `when` decides at start whether the step applies at all.
// `target` may be a selector, an element, a {left,top,width,height} rect
// (e.g. an element inside the builder iframe, offset by the iframe's rect),
// or a function returning any of those.
'use strict';

let running = false;

/** flash a "this is being clicked" pulse on a control, so tour-driven UI
 *  switches are traceable — resolves when the pulse ends */
export function pressPulse(target, doc = document) {
  let t = typeof target === 'function' ? target() : target;
  if (typeof t === 'string') t = doc.querySelector(t);
  if (!t) return Promise.resolve();
  const r = t.getBoundingClientRect ? t.getBoundingClientRect() : t;
  if (!r || !('left' in r)) return Promise.resolve();
  const p = doc.createElement('div');
  p.className = 'tour-press';
  p.style.left = (r.left - 4) + 'px';
  p.style.top = (r.top - 4) + 'px';
  p.style.width = (r.width + 8) + 'px';
  p.style.height = (r.height + 8) + 'px';
  doc.body.appendChild(p);
  return new Promise(res => setTimeout(() => { p.remove(); res(); }, 1000));
}

export function runTour(allSteps, opts = {}) {
  if (running) return;
  running = true;
  const doc = opts.document || document;
  const win = doc.defaultView || window;
  const steps = allSteps.filter(s => !s.when || s.when());
  let idx = 0;

  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const ring = el('div', 'tour-ring');
  const box = el('div', 'tour-box');
  doc.body.appendChild(ring);
  doc.body.appendChild(box);

  function cleanup() {
    if (!running) return;
    running = false;
    ring.remove();
    box.remove();
    doc.removeEventListener('keydown', onKey, true);
    win.removeEventListener('resize', onResize);
    if (opts.onEnd) opts.onEnd();
  }

  function rectOf(s) {
    let t = s.target;
    if (typeof t === 'function') t = t();
    if (!t) return null;
    if (typeof t === 'string') t = doc.querySelector(t);
    if (!t) return null;
    if (t.getBoundingClientRect) t = t.getBoundingClientRect();
    if (!('left' in t)) return null;
    return {
      left: t.left, top: t.top, width: t.width, height: t.height,
      right: t.right != null ? t.right : t.left + t.width,
      bottom: t.bottom != null ? t.bottom : t.top + t.height
    };
  }

  function position(s) {
    const r = rectOf(s);
    const vw = doc.documentElement.clientWidth || 1200;
    const vh = doc.documentElement.clientHeight || 800;
    if (r) {
      ring.style.left = (r.left - 6) + 'px';
      ring.style.top = (r.top - 6) + 'px';
      ring.style.width = (r.width + 12) + 'px';
      ring.style.height = (r.height + 12) + 'px';
      // the box goes under the target when there's room, else above,
      // else beside — never off screen
      const bw = box.offsetWidth || 340;
      const bh = box.offsetHeight || 180;
      let left = Math.min(Math.max(r.left, 12), vw - bw - 12);
      let top;
      if (r.bottom + bh + 20 < vh) top = r.bottom + 14;
      else if (r.top - bh - 20 > 0) top = r.top - bh - 14;
      else { top = Math.max(12, (vh - bh) / 2); left = r.left > vw / 2 ? Math.max(12, r.left - bw - 20) : Math.min(vw - bw - 12, r.right + 20); }
      box.style.left = left + 'px';
      box.style.top = top + 'px';
    } else {
      // no target: dim everything, center the box
      ring.style.left = '50%';
      ring.style.top = '45%';
      ring.style.width = '0px';
      ring.style.height = '0px';
      const bw = box.offsetWidth || 340;
      const bh = box.offsetHeight || 180;
      box.style.left = Math.max(12, (vw - bw) / 2) + 'px';
      box.style.top = Math.max(12, (vh - bh) / 2.4) + 'px';
    }
  }

  async function show(i) {
    if (i < 0) i = 0;
    if (i >= steps.length) { cleanup(); return; }
    idx = i;
    const s = steps[i];
    if (s.prep) {
      try { await s.prep(); } catch { /* the step still shows */ }
    }
    box.textContent = '';
    box.appendChild(el('div', 'tour-step', (idx + 1) + ' / ' + steps.length));
    box.appendChild(el('h4', null, s.title));
    box.appendChild(el('p', null, s.text));
    const row = el('div', 'tour-actions');
    const skip = el('button', 'tour-skiplink', 'skip the tour');
    skip.addEventListener('click', cleanup);
    row.appendChild(skip);
    row.appendChild(el('span', 'tour-spacer'));
    if (idx > 0) {
      const back = el('button', 'btn small', 'back');
      back.addEventListener('click', () => show(idx - 1));
      row.appendChild(back);
    }
    const next = el('button', 'btn small primary', idx === steps.length - 1 ? 'done' : 'next');
    next.addEventListener('click', () => show(idx + 1));
    row.appendChild(next);
    box.appendChild(row);
    position(s);
    next.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); show(idx + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1); }
  }
  function onResize() { position(steps[idx]); }
  doc.addEventListener('keydown', onKey, true);
  win.addEventListener('resize', onResize);

  show(0);
  return { stop: cleanup };
}
