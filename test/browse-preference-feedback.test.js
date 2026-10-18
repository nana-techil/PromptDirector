import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/library.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('async function saveBrowsePreference(change)'), source.indexOf('\nfunction navigateBrowseProject'));
function fixture() {
  const scope = { disabled: false }, views = [{ disabled: false }, { disabled: false }], pending = [], errors = [];
  const context = vm.createContext({
    uiPreferences: { galleryView: 'waterfall', includeSubprojects: true, galleryZoom: 50 },
    galleryPreferenceWrite: Promise.resolve(), caseOrderManagementActive: false,
    document: { querySelectorAll(selector) { return [...(selector.includes('data-gallery-view') ? views : []), ...(selector.includes('include-subprojects') ? [scope] : [])]; } },
    updateUiPreferences(change) { return new Promise((resolve, reject) => pending.push({ change, resolve, reject })); },
    showFeedback(message) { errors.push(message); }, renderGallery() {},
  });
  vm.runInContext(fn, context);
  return { context, scope, views, pending, errors, save: context.saveBrowsePreference };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('switching gallery view keeps the unrelated project-scope switch stable, including failure', async () => {
  const f = fixture();
  const saving = f.save({ galleryView: 'list' });
  assert.equal(f.scope.disabled, false);
  assert.ok(f.views.every(button => button.disabled));
  await flush(); f.pending[0].reject(new Error('write failed')); await saving;
  assert.equal(f.scope.disabled, false);
  assert.ok(f.views.every(button => !button.disabled));
  assert.equal(f.context.uiPreferences.galleryView, 'waterfall');
  assert.deepEqual(f.errors, ['write failed']);
});

test('independent browse choices serialize writes without losing an in-progress zoom choice', async () => {
  const f = fixture();
  const view = f.save({ galleryView: 'list' });
  const scope = f.save({ includeSubprojects: false });
  await flush(); assert.equal(f.pending.length, 1);
  f.context.uiPreferences.galleryZoom = 75;
  f.pending[0].resolve({ galleryView: 'list', includeSubprojects: true, galleryZoom: 50 });
  await flush(); assert.equal(f.pending.length, 2);
  f.pending[1].resolve({ galleryView: 'list', includeSubprojects: false, galleryZoom: 50 });
  await Promise.all([view, scope]);
  assert.equal(f.context.uiPreferences.galleryView, 'list');
  assert.equal(f.context.uiPreferences.includeSubprojects, false);
  assert.equal(f.context.uiPreferences.galleryZoom, 75);
});
