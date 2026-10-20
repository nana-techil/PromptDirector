import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { bindAppearanceControls } from '../extension/appearance-controls.js';
import { createSelectionWriter } from '../extension/reference-selection.js';

const source = readFileSync(new URL('../extension/library.js', import.meta.url), 'utf8');
const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const selection = program.body.flatMap(node => node.declarations || []).find(node => node.id.name === 'referenceSelectionWriter').init;
const appearance = program.body.find(node => node.expression?.callee?.name === 'bindAppearanceControls').expression;
const feedback = program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'showFeedback');

function fixture({ settingsOpen = false, managerOpen = false, batchOpen = false } = {}) {
  const messages = [];
  const elements = {
    uiTheme: new EventTarget(), uiMotion: new EventTarget(),
    managerDialog: { open: managerOpen }, settingsDialog: { open: settingsOpen },
    textBatchDialog: { open: batchOpen }, batchDialogFeedback: { id: 'batch' },
    feedback: { id: 'page' }, managerFeedback: { id: 'manager' }, librarySettingsFeedback: { id: 'settings' }
  };
  const system = new EventTarget();
  const context = vm.createContext({
    elements, bindAppearanceControls, createSelectionWriter,
    uiPreferences: { theme: 'dark', motion: 'system' }, selectionMode: '',
    document: { querySelector: () => system },
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    updateUiPreferences: async () => { throw new Error('preference write failed'); },
    chrome: { runtime: { sendMessage: async ({ type }) => type === 'GET_REFERENCE_SELECTION'
      ? { ok: true, selection: { revision: 1, caseIds: ['saved'] } }
      : { ok: false, message: 'selection write failed' } } },
    translateUiMessage: message => message,
    transientFeedback: { clear() {}, show(target, message, options) { messages.push({ target: target.id, message, error: options.error }); } }
  });
  vm.runInContext(source.slice(feedback.start, feedback.end), context);
  return { context, elements, messages };
}

test('failed reference writes stay visible in the active browsing or management surface, not closed settings', async () => {
  for (const managerOpen of [false, true]) {
    const view = fixture({ managerOpen });
    const writer = vm.runInContext(source.slice(selection.start, selection.end), view.context);
    await writer.initialize();
    await writer.save(['requested']);
    assert.deepEqual(view.messages, [{ target: managerOpen ? 'manager' : 'page', message: 'selection write failed', error: true }]);
  }
});

test('batch errors stay inside the current analysis dialog above settings', () => {
  const view = fixture({ settingsOpen: true, batchOpen: true });
  vm.runInContext('showFeedback("preview failed", true)', view.context);
  assert.deepEqual(view.messages, [{ target: 'batch', message: 'preview failed', error: true }]);
});

test('failed appearance writes display inside open settings and restore the saved theme choice', async () => {
  const view = fixture({ settingsOpen: true });
  vm.runInContext(source.slice(appearance.start, appearance.end), view.context);
  view.elements.uiTheme.value = 'light';
  view.elements.uiTheme.dispatchEvent(new Event('change'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(view.messages, [{ target: 'settings', message: 'preference write failed', error: true }]);
  assert.equal(view.elements.uiTheme.value, 'dark');
  assert.equal(view.elements.uiTheme.disabled, false);
});
