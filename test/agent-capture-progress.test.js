import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAgentTasks } from '../extension/agent-tasks.js';
import { createCaptureSaveProgress } from '../extension/capture-save-progress.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const start = source.indexOf('const agentTasks = createAgentTasks(');
const registration = source.slice(start, source.indexOf('\n});', start) + 4);
const queueStart = source.indexOf('function enqueueCapture(task)');
const queue = source.slice(queueStart, source.indexOf('\n}', queueStart) + 2);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Execute the real background registration and queue, with only browser/network
// boundaries stubbed. This catches lost wiring between save progress and receipts.
function fixture(execute) {
  const data = {}, writes = [], sent = [], controllers = new Map(), assets = new Set();
  let libraryId = 'library', time = 0;
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async values => { writes.push(structuredClone(values)); Object.assign(data, structuredClone(values)); } };
  const context = vm.createContext({ libraryStorage: storage, libraryIdentity: { read: async () => ({ libraryId }) },
    createAgentTasks, captureAssistantControllers: controllers, activeCaptureAssetIds: assets,
    agentCapturePreview: { execute }, chrome: { runtime: { sendMessage: async message => { sent.push(message); } } },
    createCaptureSaveProgress: options => createCaptureSaveProgress({ ...options, now: () => time }) });
  const tasks = vm.runInContext(`let captureWriteQueue = Promise.resolve();\n${queue}\n${registration}\nagentTasks`, context);
  return { tasks, data, writes, sent, controllers, assets, storage,
    getLibraryId: async () => libraryId, select: id => { libraryId = id; }, tick: () => { time += 200; } };
}

test('external capture receipts distinguish queued work and show actual download bytes without rewriting requests', async () => {
  const hold = deferred(), calls = []; let progress, savedScope;
  const run = fixture(async (operation, _input, id, scope, update) => {
    calls.push(id);
    if (operation === 'save_capture') {
      progress = update; savedScope = scope;
      progress.stage('download', { kind: 'video', index: 1, count: 7 });
      await hold.promise;
      await progress.retain(['original']);
      assert(run.assets.has('original'));
      await progress.commit();
    }
    return { ok: true, saved: id };
  });
  await run.tasks.submit('save_capture', { captureId: 'preview' }, 'large-save'); await turn();
  await run.tasks.submit('prepare_capture', { url: 'https://example.com/video' }, 'next-page'); await turn();
  assert.deepEqual(calls, ['large-save']);
  assert.equal((await run.tasks.inspect('next-page')).state, 'queued');
  assert.equal((await run.tasks.inspect('next-page')).progress.phase, 'queued');
  const writeCount = run.writes.length;
  for (const receivedBytes of [100, 300, 700]) {
    run.tick(); progress.update({ receivedBytes, totalBytes: 1000 });
    const receipt = await run.tasks.inspect('large-save');
    assert.equal(receipt.state, 'running'); assert.equal(receipt.progress.receivedBytes, receivedBytes);
    assert.equal(receipt.progress.totalBytes, 1000); assert.equal(receipt.progress.count, 7);
    assert.equal(receipt.input, undefined);
  }
  assert.equal(run.writes.length, writeCount, 'Byte updates must not rewrite the full request or library');
  const replay = await run.tasks.submit('save_capture', { captureId: 'preview' }, 'large-save');
  assert.equal(replay.replayed, true); assert.equal(replay.progress.receivedBytes, 700);
  await assert.rejects(run.tasks.submit('save_capture', { captureId: 'different' }, 'large-save'), { code: 'request_conflict' });
  hold.resolve();
  assert.equal((await run.tasks.inspect('large-save', { waitMs: 1000 })).state, 'completed');
  assert.equal((await run.tasks.inspect('next-page', { waitMs: 1000 })).state, 'completed');
  assert.deepEqual(calls, ['large-save', 'next-page']); assert.equal(run.assets.size, 0);
  progress.update({ receivedBytes: 999 });
  assert.equal(savedScope.report({ state: 'running', progress: { receivedBytes: 999 } }), false);
  const completed = await run.tasks.submit('save_capture', { captureId: 'preview' }, 'large-save');
  assert.equal(completed.state, 'completed'); assert.equal(completed.progress, undefined);
});

test('Assistant parent receives progress while the child task keeps its own receipt and commit signal', async () => {
  const hold = deferred(); let progress;
  const run = fixture(async (_operation, _input, _id, _scope, update) => {
    progress = update; update.stage('download', { kind: 'video' }); await hold.promise;
    await update.commit(); return { ok: false, message: 'media unavailable' };
  });
  const controller = new AbortController(); run.controllers.set('assistant-parent', controller);
  await run.tasks.submit('save_capture', { captureAssistantRequestId: 'assistant-parent' }, 'child-save'); await turn();
  run.tick(); progress.update({ receivedBytes: 50 });
  assert.equal((await run.tasks.inspect('child-save')).progress.receivedBytes, 50);
  assert.equal(run.sent.at(-1).requestId, 'assistant-parent');
  assert.equal(run.sent.at(-1).progress.receivedBytes, 50);
  assert.equal(progress.signal, controller.signal);
  hold.resolve();
  const failed = await run.tasks.inspect('child-save', { waitMs: 1000 });
  assert.equal(failed.state, 'failed'); assert.equal(failed.progress, undefined);
  assert.equal(controller.committing, true);
  assert.equal(run.sent.at(-1).type, 'CAPTURE_ASSIST_CHANGED');
});

test('progress cannot cross libraries and restarting a running download reports interruption', async () => {
  const hold = deferred(); let progress;
  const run = fixture(async (_operation, _input, _id, _scope, update) => {
    progress = update; update.stage('download'); await hold.promise; return { ok: true };
  });
  await run.tasks.submit('save_capture', {}, 'original-save'); await turn();
  run.select('other-library'); run.tick(); progress.update({ receivedBytes: 40 });
  await assert.rejects(run.tasks.inspect('original-save'), { code: 'library_mismatch' });
  await assert.rejects(run.tasks.submit('save_capture', {}, 'original-save'), { code: 'library_mismatch' });
  run.select('library');
  const restarted = createAgentTasks({ storage: run.storage, getLibraryId: run.getLibraryId,
    execute: () => assert.fail('An interrupted download must never be automatically replayed') });
  const receipt = await restarted.inspect('original-save');
  assert.equal(receipt.state, 'interrupted'); assert.equal(receipt.progress, undefined);
  assert.equal(receipt.error.code, 'worker_restarted');
  hold.resolve(); await run.tasks.inspect('original-save', { waitMs: 1000 });
});

test('a queued capture rechecks the library before reading the next page', async t => {
  t.mock.method(console, 'error', () => {});
  const hold = deferred(), calls = [];
  const run = fixture(async (_operation, _input, id) => { calls.push(id); await hold.promise; return { ok: true }; });
  await run.tasks.submit('save_capture', {}, 'first'); await turn();
  await run.tasks.submit('prepare_capture', {}, 'second'); await turn();
  run.select('other-library'); hold.resolve(); await turn(); await turn();
  assert.deepEqual(calls, ['first']);
  run.select('library');
  assert.equal((await run.tasks.inspect('second')).state, 'interrupted');
});
