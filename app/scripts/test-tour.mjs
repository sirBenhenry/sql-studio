// Tour engine tests: step flow, when-filtering, prep hooks, keyboard, cleanup.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="a">A</div><div id="b">B</div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const { runTour } = await import('../src/tour.js');

let fail = 0;
const ck = (n, c, e) => { if (c) console.log('ok:', n); else { fail++; console.log('FAIL:', n, e ?? ''); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const boxTitle = () => document.querySelector('.tour-box h4') && document.querySelector('.tour-box h4').textContent;
const clickBtn = label => [...document.querySelectorAll('.tour-box button')].find(b => b.textContent === label).click();

/* ---- flow: next/back, when-skips, prep, done ---- */
{
  const prepped = [];
  let ended = 0;
  runTour([
    { target: '#a', title: 'One', text: 'first' },
    { target: '#missing', title: 'Ghost', text: 'skipped', when: () => false },
    { target: null, title: 'Two', text: 'centered', prep: async () => prepped.push('two') },
    { target: '#b', title: 'Three', text: 'last' }
  ], { onEnd: () => { ended++; } });
  await tick(20);

  ck('ring + box mounted', !!document.querySelector('.tour-ring') && !!document.querySelector('.tour-box'));
  ck('first step shows', boxTitle() === 'One', boxTitle());
  ck('step counter respects when-filtering', document.querySelector('.tour-step').textContent === '1 / 3',
    document.querySelector('.tour-step').textContent);

  clickBtn('next');
  await tick(20);
  ck('when:false step skipped entirely', boxTitle() === 'Two', boxTitle());
  ck('prep ran before showing', prepped.includes('two'));

  clickBtn('back');
  await tick(20);
  ck('back returns', boxTitle() === 'One', boxTitle());

  clickBtn('next');
  await tick(20);
  clickBtn('next');
  await tick(20);
  ck('last step labeled done', [...document.querySelectorAll('.tour-box button')].some(b => b.textContent === 'done'));
  clickBtn('done');
  await tick(20);
  ck('done cleans up', !document.querySelector('.tour-ring') && !document.querySelector('.tour-box'));
  ck('onEnd fired once', ended === 1, ended);
}

/* ---- escape skips; skip link works; no double-run ---- */
{
  let ended = 0;
  runTour([{ target: '#a', title: 'Solo', text: 'x' }], { onEnd: () => { ended++; } });
  await tick(20);
  runTour([{ target: '#a', title: 'Intruder', text: 'y' }]); // must be ignored
  await tick(20);
  ck('second concurrent tour ignored', boxTitle() === 'Solo', boxTitle());
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(20);
  ck('Escape ends the tour', !document.querySelector('.tour-box') && ended === 1, ended);

  runTour([{ target: '#a', title: 'Again', text: 'z' }, { target: '#b', title: 'B', text: 'b' }]);
  await tick(20);
  ck('tour can run again after cleanup', boxTitle() === 'Again', boxTitle());
  [...document.querySelectorAll('.tour-box button, .tour-box .tour-skiplink')]
    .find(b => b.textContent === 'skip the tour').click();
  await tick(20);
  ck('skip link ends the tour', !document.querySelector('.tour-box'));
}

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
