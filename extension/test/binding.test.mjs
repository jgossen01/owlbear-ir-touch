import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TouchBridge, TOUCH_APPLY_MS, LIFT_ARM_MS, LIFT_DRAG_GRACE_S, PROTOCOL } from '../touch.js';

const DPI = 150, W = 1920, H = 1080;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Fake Owlbear: CHARACTER images with a centre position; bounds derived from it; viewport 1:1 at the origin,
   so canvas units == screen pixels and a screen fraction is simply px / W. */
function fakeObr(tokens) {
  const items = new Map(tokens.map(t => [t.id, { id: t.id, name: t.name, layer: 'CHARACTER', type: 'IMAGE', position: { x: t.x + t.w / 2, y: t.y + t.h / 2 }, w: t.w, h: t.h }]));
  const vp = { x: 0, y: 0, scale: 1 };
  return {
    centre: id => ({ ...items.get(id).position }),
    scene: {
      isReady: async () => true,
      items: {
        getItems: async f => [...items.values()].filter(i => Array.isArray(f) ? f.includes(i.id) : (typeof f === 'function' ? f(i) : true)),
        getItemBounds: async ids => { const i = items.get(ids[0]); return { min: { x: i.position.x - i.w / 2, y: i.position.y - i.h / 2 }, max: { x: i.position.x + i.w / 2, y: i.position.y + i.h / 2 }, width: i.w, height: i.h }; },
        updateItems: async (its, fn) => { fn(its.map(i => items.get(i.id))); },
        onChange: () => () => {},
      },
      grid: { getDpi: async () => DPI, onChange: () => () => {}, snapPosition: async p => ({ x: Math.floor(p.x / DPI) * DPI + DPI / 2, y: Math.floor(p.y / DPI) * DPI + DPI / 2 }) },
    },
    viewport: { getPosition: async () => ({ x: vp.x, y: vp.y }), getScale: async () => vp.scale, setPosition: async p => { vp.x = p.x; vp.y = p.y; }, setScale: async s => { vp.scale = s; }, getWidth: async () => W, getHeight: async () => H },
  };
}
async function bridgeFor(tokens, settings = {}) {
  const obr = fakeObr(tokens); const patches = [];
  const b = new TouchBridge(obr, { physicalScale: false, ...settings }, p => patches.push(p));
  b.mode = 'touch'; b.touch = { frame: { connected: true, name: 'fake' }, calibration: { calibrated: true } };
  await b.refreshTokens(); await b.tick();
  return { obr, b, patches, last: () => Object.assign({}, ...patches) };
}
const touch = (b, id, phase, x, y) => b.handle({ type: 'TOUCH', id, phase, x: x / W, y: y / H });
const settle = async b => { await sleep(TOUCH_APPLY_MS + 30); await b.chain; };
const A = { id: 'a', name: 'Fighter', x: 300, y: 300, w: 150, h: 150 }; // centre 375,375
const B = { id: 'b', name: 'Goblin',  x: 900, y: 600, w: 150, h: 150 }; // centre 975,675

test('1 · a contact on a token drags it, keeping the offset to the token centre', async () => {
  const { obr, b } = await bridgeFor([A]);
  touch(b, 1, 'down', 350, 350);           // 25 px left/above the centre
  touch(b, 1, 'move', 600, 500);
  await settle(b);
  assert.deepEqual(obr.centre('a'), { x: 625, y: 525 });
  assert.equal(b.contacts.size, 1);
});

test('2 · a contact next to the token binds nothing and is reported as lastUnbound', async () => {
  const { obr, b, last } = await bridgeFor([A]);
  touch(b, 1, 'down', 560, 375);           // 0.73 cells beyond the right edge (> BIND_CELLS 0.6)
  touch(b, 1, 'move', 700, 375);
  await settle(b);
  assert.deepEqual(obr.centre('a'), { x: 375, y: 375 });
  assert.equal(b.contacts.size, 0);
  assert.equal(b.counts.ignored, 1);
  assert.match(last().lastUnbound, /%,/);
});

test('3 · lifted rule: a new contact on empty map re-binds the figure lifted last, after LIFT_ARM_MS', async () => {
  const { obr, b } = await bridgeFor([A]);
  touch(b, 1, 'down', 375, 375); touch(b, 1, 'up', 375, 375);
  assert.equal(b.lifted && b.lifted.tokenId, 'a');
  touch(b, 2, 'down', 560, 375);           // 1.23 cells from the centre: outside the grown bounds (right edge 450 + 90), within LIFT_SLACK_CELLS
  assert.equal(b.contacts.size, 1);
  await sleep(LIFT_ARM_MS / 3); await b.chain;
  assert.deepEqual(obr.centre('a'), { x: 375, y: 375 }, 'not moved before the arm time');
  await sleep(LIFT_ARM_MS + 40); await b.chain;
  assert.deepEqual(obr.centre('a'), { x: 560, y: 375 }, 'centred under the contact after arming');
});

test('4 · phantom guard: a lifted-rule contact that dies before LIFT_ARM_MS moves nothing', async () => {
  const { obr, b } = await bridgeFor([A]);
  touch(b, 1, 'down', 375, 375); touch(b, 1, 'up', 375, 375);
  touch(b, 2, 'down', 560, 375);
  await sleep(LIFT_ARM_MS / 3);
  touch(b, 2, 'up', 500, 400);
  await sleep(LIFT_ARM_MS + 40); await b.chain;
  assert.deepEqual(obr.centre('a'), { x: 375, y: 375 });
  assert.equal(b.contacts.size, 0);
});

test('4b · phantom guard holds with snap on: a phantom that dies before LIFT_ARM_MS moves nothing', async () => {
  const { obr, b } = await bridgeFor([A], { snap: true });
  touch(b, 1, 'down', 375, 375); touch(b, 1, 'up', 375, 375);
  touch(b, 2, 'down', 560, 375);
  await sleep(LIFT_ARM_MS / 3);
  touch(b, 2, 'up', 500, 400);                 // the snap on release must not apply an unarmed target either
  await sleep(LIFT_ARM_MS + 40); await b.chain;
  assert.deepEqual(obr.centre('a'), { x: 375, y: 375 });
  assert.equal(b.contacts.size, 0);
});

test('4c · a lifted-rule contact that lives past LIFT_ARM_MS still snaps on release', async () => {
  const { obr, b } = await bridgeFor([A], { snap: true });
  touch(b, 1, 'down', 375, 375); touch(b, 1, 'up', 375, 375);
  touch(b, 2, 'down', 560, 375);
  await sleep(LIFT_ARM_MS + 40); await b.chain;
  touch(b, 2, 'up', 560, 375);
  await settle(b);
  assert.deepEqual(obr.centre('a'), { x: 525, y: 375 }, 'centre of the cell under the contact');
});

test('5 · plausibility: a set-down farther than a hand could carry the figure is not bound', async () => {
  const { obr, b } = await bridgeFor([A]);
  touch(b, 1, 'down', 375, 375); touch(b, 1, 'up', 375, 375);
  touch(b, 2, 'down', 1500, 900);          // ≈ 8.3 cells away within milliseconds (max ≈ 1.5 + 40·t)
  await sleep(LIFT_ARM_MS + 40); await b.chain;
  assert.equal(b.contacts.size, 0);
  assert.deepEqual(obr.centre('a'), { x: 375, y: 375 });
});

test('6 · two figures drag independently; a third contact on empty map during a drag is a hand, not a set-down', async () => {
  const { obr, b } = await bridgeFor([A, B]);
  touch(b, 1, 'down', 375, 375); touch(b, 2, 'down', 975, 675);
  touch(b, 1, 'move', 600, 500); touch(b, 2, 'move', 1200, 800);
  await settle(b);
  assert.deepEqual(obr.centre('a'), { x: 600, y: 500 });
  assert.deepEqual(obr.centre('b'), { x: 1200, y: 800 });
  touch(b, 1, 'up', 600, 500);             // A lifted now
  await sleep(LIFT_DRAG_GRACE_S * 1000 + 100);
  touch(b, 2, 'move', 1210, 810);          // B is actively dragged …
  touch(b, 3, 'down', 600, 720);           // … so this contact 1.47 cells below A (outside its grown bounds) is the other hand, not A being set down
  await sleep(LIFT_ARM_MS + 40); await b.chain;
  assert.equal(b.contacts.size, 1);
  assert.ok(b.contacts.has(2));
  assert.deepEqual(obr.centre('a'), { x: 600, y: 500 });
});

test('7 · a token already held ignores a second contact on it', async () => {
  const { b } = await bridgeFor([A]);
  touch(b, 1, 'down', 375, 375);
  touch(b, 2, 'down', 380, 380);
  assert.equal(b.contacts.size, 1);
  assert.equal(b.counts.ignored, 1);
});

test('8 · snap: on release the token lands on the cell centre', async () => {
  const { obr, b } = await bridgeFor([A], { snap: true });
  touch(b, 1, 'down', 375, 375);
  touch(b, 1, 'move', 610, 470);
  await settle(b);
  touch(b, 1, 'up', 610, 470);
  await settle(b);
  assert.deepEqual(obr.centre('a'), { x: 675, y: 525 });
});

test('10 · the physical-scale correction leaves a usable viewport behind', async () => {
  const { b } = await bridgeFor([A], { physicalScale: true, displayWidthMm: 952 }); // 43″ picture → one cell = one inch
  assert.notEqual(b.lastVp, null, 'a contact arriving right after the correction must not be dropped');
  assert.equal(b.dpiCache, DPI);
  const wanted = W / (952 / 25.4) / DPI;
  assert.ok(Math.abs(b.lastVp.width - W / wanted) < 0.01);
});

test('9 · no HELLO within the timeout → error and socket closed; HELLO → mode touch', async () => {
  const obr = fakeObr([]); const patches = [];
  const b = new TouchBridge(obr, { port: 50000 }, p => patches.push(p));
  b.helloTimeoutMs = 50;
  const fake = { readyState: 1, closed: false, sent: [], close() { this.closed = true; }, send(s) { this.sent.push(s); } };
  b.ws = fake; b.onOpen(fake, 'ws://localhost:50000');
  await sleep(90);
  assert.equal(fake.closed, true);
  assert.match(Object.assign({}, ...patches).error, /not the IR touch service/);

  const ok = { readyState: 1, closed: false, sent: [], close() { this.closed = true; }, send(s) { this.sent.push(s); } };
  b.ws = ok; b.onOpen(ok, 'ws://localhost:50000');
  b.handle({ type: 'HELLO', protocol: PROTOCOL, version: '1.0.0', frame: { connected: true, name: 'x' }, calibration: { calibrated: false } });
  await sleep(90);
  assert.equal(ok.closed, false);
  assert.equal(b.mode, 'touch');
  assert.match(ok.sent[0], /"client":"owlbear-ir-touch"/);
});
