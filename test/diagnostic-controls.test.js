import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bindDiagnosticControls } from '../extension/diagnostic-controls.js';
import { normalizeUiPreferences, updateLayoutPreferences } from '../extension/preferences.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(initial = {}) {
  let saved = normalizeUiPreferences(initial), fail = false;
  const listeners = new Set(), writes = [], errors = [];
  const storage = { local: { get: async () => ({ uiPreferences: saved }) }, onChanged: {
    addListener: value => listeners.add(value), removeListener: value => listeners.delete(value)
  }};
  const notify = value => {
    const oldValue = saved; saved = normalizeUiPreferences(value);
    for (const listener of listeners) listener({ uiPreferences: { oldValue, newValue: saved } }, 'local');
  };
  const save = async patch => {
    writes.push(patch);
    if (fail) throw new Error('保存失败');
    notify({ ...saved, ...patch }); return saved;
  };
  function page(withToggle = false) {
    const controls = [{ hidden: false }, { hidden: false }], toggle = withToggle ? new EventTarget() : undefined;
    let closed = 0;
    const binding = bindDiagnosticControls({ controls, toggle, storage, save,
      onError: error => errors.push(error.message), onDisable: () => closed++ });
    return { controls, toggle, ...binding, closed: () => closed };
  }
  return { page, writes, errors, notify, saved: () => saved, fail: () => { fail = true; } };
}

test('diagnostics default off without treating stored log arrays or obsolete fields as an enabled preference', () => {
  for (const value of [{}, { analysisDiagnostics: true }, { diagnosticsEnabled: 'true' }, { diagnosticsEnabled: [] }]) {
    assert.equal(normalizeUiPreferences(value).diagnosticsEnabled, false);
  }
  const prefs = normalizeUiPreferences({ diagnosticsEnabled: true });
  assert.equal(updateLayoutPreferences(prefs, {}, true).diagnosticsEnabled, true);
});

test('one saved setting enables all open surfaces, persists for reopening and hides them immediately when switched off', async () => {
  const f = fixture({ theme: 'light', galleryZoom: 76 });
  const settings = f.page(true), assistant = f.page(), composer = f.page();
  assert.ok(assistant.controls.every(control => control.hidden));
  await Promise.all([settings.ready, assistant.ready, composer.ready]);
  settings.toggle.checked = true; settings.toggle.dispatchEvent(new Event('change')); await flush();
  assert.deepEqual(f.writes, [{ diagnosticsEnabled: true }]);
  for (const page of [settings, assistant, composer]) assert.ok(page.controls.every(control => !control.hidden));
  const reopened = f.page(); await reopened.ready;
  assert.ok(reopened.controls.every(control => !control.hidden));
  settings.toggle.checked = false; settings.toggle.dispatchEvent(new Event('change')); await flush();
  for (const page of [settings, assistant, composer, reopened]) assert.ok(page.controls.every(control => control.hidden));
  assert.equal(composer.closed(), 3);
  assert.equal(f.saved().theme, 'light'); assert.equal(f.saved().galleryZoom, 76);
});

test('failed save restores the persisted switch and keeps its inline error available', async () => {
  const f = fixture(); const settings = f.page(true); await settings.ready; f.fail();
  settings.toggle.checked = true; settings.toggle.dispatchEvent(new Event('change')); await flush();
  assert.equal(settings.toggle.checked, false); assert.equal(settings.toggle.disabled, false);
  assert.deepEqual(f.errors, ['保存失败']); assert.ok(settings.controls.every(control => control.hidden));
});

test('a stale initial read cannot undo a live change from settings', async () => {
  let finish, listener;
  const control = {};
  const view = bindDiagnosticControls({ controls: [control], storage: {
    local: { get: () => new Promise(resolve => { finish = resolve; }) },
    onChanged: { addListener: value => { listener = value; }, removeListener() {} }
  }});
  listener({ uiPreferences: { newValue: { diagnosticsEnabled: true } } }, 'local');
  finish({ uiPreferences: { diagnosticsEnabled: false } }); await view.ready;
  assert.equal(control.hidden, false);
});

test('production entry points share the preference without hiding generation choices or removing export handlers', async () => {
  const [library, composer, assistant, html] = await Promise.all(['library.js', 'composer-page.js', 'collector-capture-assistant.js', 'composer.html'].map(file => readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8')));
  assert.match(library, /controls: \[elements.copyAnalysisDiagnostics\], toggle: document.querySelector\('#ui-diagnostics'\)/);
  assert.match(composer, /controls: \[elements.composerDiagnosticExport, elements.composerAssemblyOpen\]/);
  assert.match(composer, /onDisable:.*composerAssemblyDialog.close\(\)/);
  assert.match(assistant, /bindDiagnosticControls\(\{ controls: \[diagnosticButton\]/);
  assert.match(composer, /composerDiagnosticExport.addEventListener\("click", safely\(exportComposerDiagnostic\)\)/);
  for (const id of ['composer-diagnostic-export', 'composer-assembly-open']) assert.match(html, new RegExp(`id="${id}" hidden`));
  assert.doesNotMatch(html, /id="composer-(?:thinking|production-review|create-image)" hidden/);
});
