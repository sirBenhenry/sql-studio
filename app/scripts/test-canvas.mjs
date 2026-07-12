// Canvas-view tests: layered layout, saved-position respect, background pan.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const sb = { window: {} };
vm.createContext(sb);
vm.runInContext(readFileSync(join(here, '..', 'src', 'core', 'parser.js'), 'utf8'), sb);
const parseSchema = sb.window.parseSchema;

const { mountCanvasView } = await import('../src/canvas-view.js');

let fail = 0;
const ck = (n, c, e) => { if (c) console.log('ok:', n); else { fail++; console.log('FAIL:', n, e ?? ''); } };

const schema = parseSchema(`
CREATE TABLE person (id INT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(40), PRIMARY KEY(id));
CREATE TABLE category (id INT UNSIGNED NOT NULL AUTO_INCREMENT, label VARCHAR(30), PRIMARY KEY(id));
CREATE TABLE task (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 person_id INT UNSIGNED NOT NULL,
 category_id INT UNSIGNED NOT NULL,
 PRIMARY KEY(id),
 FOREIGN KEY(person_id) REFERENCES person(id),
 FOREIGN KEY(category_id) REFERENCES category(id)
);`);

/* ---- fresh mount: dependency layers, FK lines ---- */
{
  const host = document.querySelector('#host');
  let savedOut = null;
  mountCanvasView(host, schema, {
    openTable: () => {},
    loadPositions: () => ({}),
    savePositions: p => { savedOut = p; }
  });
  const cards = [...host.querySelectorAll('.cv-card')];
  ck('three cards', cards.length === 3, cards.length);
  const left = name => parseInt([...cards].find(c => c.querySelector('.cv-name').textContent === name).style.left, 10);
  ck('task sits a layer right of person', left('task') > left('person'), left('task') + ' vs ' + left('person'));
  ck('two FK lines drawn', host.querySelectorAll('.cv-line').length === 2, host.querySelectorAll('.cv-line').length);

  /* background pan: drag empty stage, expect transform + persisted __pan */
  const stage = host.querySelector('.cv-stage');
  stage.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 500, clientY: 300 }));
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 440, clientY: 320 }));
  window.dispatchEvent(new window.MouseEvent('pointerup', {}));
  ck('pan translates the stage', stage.style.transform === 'translate(-60px,20px) scale(1)', stage.style.transform);
  ck('pan persisted as __pan', savedOut && savedOut.__pan && savedOut.__pan.x === -60 && savedOut.__pan.y === 20,
    JSON.stringify(savedOut && savedOut.__pan));
  ck('positions persisted alongside pan', savedOut && !!savedOut.task, JSON.stringify(Object.keys(savedOut || {})));

  /* ctrl+wheel zooms (cursor-centered); plain wheel pans */
  const host_ = document.querySelector('#host');
  host_.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, ctrlKey: true, deltaY: -100, clientX: 0, clientY: 0 }));
  ck('ctrl+wheel zooms in', stage.style.transform.includes('scale(1.12'), stage.style.transform);
  host_.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
  ck('plain wheel pans, keeps zoom',
    stage.style.transform.includes('scale(1.12') && !stage.style.transform.includes('translate(-60px,20px)'),
    stage.style.transform);
  await new Promise(r => setTimeout(r, 350));
  ck('zoom persisted in __pan.z', savedOut.__pan && Math.abs(savedOut.__pan.z - 1.12) < 1e-9,
    JSON.stringify(savedOut.__pan));
}

/* ---- saved positions respected; unsaved cards placed below them ---- */
{
  const host = document.querySelector('#host');
  mountCanvasView(host, schema, {
    openTable: () => {},
    loadPositions: () => ({ person: { x: 40, y: 60 }, __pan: { x: 5, y: 6 } }),
    savePositions: () => {}
  });
  const cards = [...host.querySelectorAll('.cv-card')];
  const cardOf = name => cards.find(c => c.querySelector('.cv-name').textContent === name);
  ck('saved position honored', cardOf('person').style.left === '40px' && cardOf('person').style.top === '60px',
    cardOf('person').style.left + ',' + cardOf('person').style.top);
  const personBottom = 60 + 30 + 2 * 21 + 8; // y + HEAD_H + rows + pad
  ck('auto-placed card starts below the saved one',
    parseInt(cardOf('category').style.top, 10) >= personBottom, cardOf('category').style.top);
  ck('saved pan restored', host.querySelector('.cv-stage').style.transform === 'translate(5px,6px) scale(1)',
    host.querySelector('.cv-stage').style.transform);
}

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
