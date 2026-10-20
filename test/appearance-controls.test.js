import test from 'node:test';
import assert from 'node:assert/strict';
import { bindAppearanceControls } from '../extension/appearance-controls.js';

function fixture(initial = {}, persist = async () => {}) {
  const controls = Object.fromEntries(['theme', 'motion'].map(key => [key, new EventTarget()]));
  let preferences = { theme: 'dark', motion: 'system', locale: 'zh-CN', galleryZoom: 62, ...initial };
  const writes = [], errors = [];
  const binding = bindAppearanceControls({ ...controls, getPreferences: () => preferences,
    save: async patch => { writes.push(patch); await persist(patch); preferences = { ...preferences, ...patch }; },
    onError: error => errors.push(error.message)
  });
  return { ...controls, ...binding, writes, errors, preferences: () => preferences };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function change(control, value) {
  if (typeof value === 'boolean') control.checked = value;
  else control.value = value;
  control.dispatchEvent(new Event('change'));
}

test('existing theme/motion values render without writing or changing unrelated preferences', () => {
  const view = fixture({ theme: 'system', motion: 'reduced' });
  assert.equal(view.theme.value, 'system');
  assert.equal(view.theme.disabled, false);
  assert.equal(view.motion.checked, true);
  assert.deepEqual(view.writes, []);
  assert.equal(view.preferences().galleryZoom, 62);
});

test('theme selection represents all three stored choices without writing on open', () => {
  for (const theme of ['dark', 'light', 'system']) {
    const view = fixture({ theme });
    assert.equal(view.theme.value, theme);
    assert.deepEqual(view.writes, []);
  }
});

test('theme choices and the reduced-motion switch send only existing preference values', async () => {
  const view = fixture();
  change(view.theme, 'light'); await flush();
  change(view.motion, true); await flush();
  change(view.motion, false); await flush();
  change(view.theme, 'system'); await flush();
  assert.deepEqual(view.writes, [{ theme: 'light' }, { motion: 'reduced' }, { motion: 'system' }, { theme: 'system' }]);
  assert.equal(view.preferences().locale, 'zh-CN');
  assert.equal(view.preferences().galleryZoom, 62);
});

test('failed preference writes restore the persisted choice and expose the failure', async () => {
  const view = fixture({}, async () => { throw new Error('write failed'); });
  change(view.theme, 'light'); await flush();
  assert.equal(view.theme.value, 'dark');
  assert.equal(view.theme.disabled, false);
  assert.equal(view.preferences().theme, 'dark');
  assert.deepEqual(view.errors, ['write failed']);
});

test('pending writes keep the requested visual state and prevent overlapping preference writes', async () => {
  let release;
  const view = fixture({}, () => new Promise(resolve => { release = resolve; }));
  change(view.theme, 'light');
  assert.equal(view.theme.value, 'light');
  assert.equal(view.theme.disabled, true);
  assert.equal(view.motion.disabled, true);
  change(view.motion, true);
  assert.equal(view.writes.length, 1);
  release(); await flush();
  assert.equal(view.theme.value, 'light');
  assert.equal(view.motion.checked, false);
  assert.equal(view.motion.disabled, false);
});
