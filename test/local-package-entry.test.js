import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { importContainerKindForFile } from '../extension/asset-formats.js';

const source = await readFile(new URL('../extension/library.js', import.meta.url), 'utf8');
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.filter(node => node.type === 'FunctionDeclaration');
function load(name, scope) {
  const node = functions.find(node => node.id.name === name);
  vm.runInContext(source.slice(node.start, node.end), scope);
  return scope[name];
}
function fixture() {
  const calls = [];
  const scope = vm.createContext({
    activeImportJob: null, importDragDepth: 1,
    elements: { libraryDropTarget: { hidden: false } },
    eagleDirectorySource: () => null, importContainerKindForFile,
    hasFileTransfer: () => true, droppedLocalFiles: async value => value,
    openLibraryPackageBatch: async (packages, ordinary) => calls.push({ packages, ordinary }),
  });
  return { scope, calls };
}
const zip = { file: new File(['fixture'], 'references.zip', { type: 'application/zip' }), relativePath: 'references.zip' };
const image = { file: new File(['fixture'], 'original.png', { type: 'image/png' }), relativePath: 'original.png' };

test('local-file picker keeps ZIP packages and ordinary originals in the same import batch', async () => {
  const { scope, calls } = fixture();
  await load('prepareLocalImport', scope)([zip, image]);
  assert.deepEqual(calls[0].packages, [zip]);
  assert.deepEqual(calls[0].ordinary, [image]);
});

test('dropping a ZIP with ordinary media preserves both groups for the shared importer', async () => {
  const { scope, calls } = fixture();
  let prevented = false;
  await load('handleLibraryDrop', scope)({ dataTransfer: [image, zip], preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(scope.elements.libraryDropTarget.hidden, true);
  assert.deepEqual(calls[0].packages, [zip]);
  assert.deepEqual(calls[0].ordinary, [image]);
});

test('finishing a package import does not depend on the removed settings file picker', () => {
  let aborted = 0, closed = 0;
  const scope = vm.createContext({
    pendingLibraryPackageBatch: { previewController: { abort() { aborted++; } }, controller: { abort() { aborted++; } } },
    elements: { libraryPackageImportDialog: { open: true, close() { closed++; } } },
    setDataSafetyBusy(active) { assert.equal(active, false); },
  });
  load('finishLibraryPackageBatch', scope)();
  assert.equal(aborted, 2);
  assert.equal(closed, 1);
  assert.equal(scope.pendingLibraryPackageBatch, null);
});
