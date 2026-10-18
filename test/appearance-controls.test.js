import test from 'node:test';
import assert from 'node:assert/strict';
import { bindAppearanceControls } from '../extension/appearance-controls.js';

function fixture(initial = {}, persist = async () => {}) {
  const controls = Object.fromEntries(['dark', 'system', 'motion', 'systemDark'].map(key => [key, new EventTarget()]));
  controls.systemDark.matches = false;
  let preferences = { theme: 'dark', motion: 'system', locale: 'zh-CN', galleryZoom: 62, ...initial };
  const writes = [], errors = [];
  const binding = bindAppearanceControls({ ...controls, getPreferences: () => preferences,
    save: async patch => { writes.push(patch); await persist(patch); preferences = { ...preferences, ...patch }; },
    onError: error => errors.push(error.message)
  });
  return { ...controls, ...binding, writes, errors, preferences: () => preferences };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function change(control, checked) { control.checked = checked; control.dispatchEvent(new Event('change')); }

test('existing theme/motion values render without writing or changing unrelated preferences', () => {
  const view = fixture({ theme: 'system', motion: 'reduced' });
  assert.equal(view.system.checked, true);
  assert.equal(view.dark.checked, false);
  assert.equal(view.dark.disabled, true);
  assert.equal(view.motion.checked, true);
  assert.deepEqual(view.writes, []);
  assert.equal(view.preferences().galleryZoom, 62);
});

test('system appearance follows OS without persisting; turning follow off retains the displayed theme', async () => {
  const view = fixture({ theme: 'system' });
  view.systemDark.matches = true;
  view.systemDark.dispatchEvent(new Event('change'));
  assert.equal(view.dark.checked, true);
  assert.deepEqual(view.writes, []);
  change(view.system, false);
  await flush();
  assert.deepEqual(view.writes, [{ theme: 'dark' }]);
  assert.equal(view.dark.disabled, false);
});

test('manual dark/light and reduced/system switches send only existing preference values', async () => {
  const view = fixture();
  change(view.dark, false); await flush();
  change(view.motion, true); await flush();
  change(view.motion, false); await flush();
  change(view.system, true); await flush();
  assert.deepEqual(view.writes, [{ theme: 'light' }, { motion: 'reduced' }, { motion: 'system' }, { theme: 'system' }]);
  assert.equal(view.preferences().locale, 'zh-CN');
  assert.equal(view.preferences().galleryZoom, 62);
});

test('failed preference writes restore the persisted choice and expose the failure', async () => {
  const view = fixture({}, async () => { throw new Error('write failed'); });
  change(view.dark, false); await flush();
  assert.equal(view.dark.checked, true);
  assert.equal(view.dark.disabled, false);
  assert.equal(view.preferences().theme, 'dark');
  assert.deepEqual(view.errors, ['write failed']);
});

test('pending writes keep the requested visual state and prevent overlapping preference writes', async () => {
  let release;
  const view = fixture({}, () => new Promise(resolve => { release = resolve; }));
  change(view.dark, false);
  assert.equal(view.dark.checked, false);
  assert.equal(view.dark.disabled, true);
  assert.equal(view.system.disabled, true);
  assert.equal(view.motion.disabled, true);
  change(view.motion, true);
  assert.equal(view.writes.length, 1);
  release(); await flush();
  assert.equal(view.dark.checked, false);
  assert.equal(view.motion.checked, false);
  assert.equal(view.motion.disabled, false);
});
