import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTasks } from '../extension/agent-tasks.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(initial = {}) {
  const data = structuredClone(initial); let libraryId = 'original-library';
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async values => Object.assign(data, structuredClone(values)) };
  return { data, storage, getLibraryId: async () => libraryId, select: id => { libraryId = id; } };
}

test('a delayed job cannot commit or claim completion after the library identity changes', async t => {
  const errors = t.mock.method(console, 'error', () => {});
  const run = fixture(); let resume, committed = 0;
  const tasks = createAgentTasks({ ...run, execute: async (_operation, _input, _id, scope) => {
    await new Promise(resolve => { resume = resolve; });
    await scope.assertCurrent(); committed++;
    return { ok: true };
  } });
  await tasks.submit('save_material', { title: 'keep with original library' }, 'delayed'); await turn();
  run.select('other-library'); resume(); await turn();
  assert.equal(committed, 0);
  assert.equal(run.data['agentTask:delayed'].state, 'running');
  assert.equal(run.data['agentTask:delayed'].libraryId, 'original-library');
  assert.equal(errors.mock.callCount(), 1);
  await assert.rejects(tasks.inspect('delayed'), { code: 'library_mismatch' });
  run.select('original-library');
  assert.equal((await tasks.inspect('delayed')).state, 'interrupted');
  assert.equal(committed, 0, 'Reconnecting must not automatically rerun the operation');
});

test('another library cannot reuse a receipt id even when the operation and content are equal', async () => {
  const run = fixture(), tasks = createAgentTasks({ ...run, execute: async () => ({ ok: true }) });
  await tasks.submit('capture', { url: 'https://example.com' }, 'same-id'); await turn();
  const original = structuredClone(run.data);
  run.select('other-library');
  await assert.rejects(tasks.submit('capture', { url: 'https://example.com' }, 'same-id'), { code: 'library_mismatch' });
  assert.deepEqual(run.data, original);
});

test('only an explicitly opted-in legacy browser backend may adopt receipts without a library id', async () => {
  const run = fixture({ 'agentTask:old': { id: 'old', state: 'running' } });
  const execute = () => assert.fail('An old interrupted request must not be replayed');
  await assert.rejects(createAgentTasks({ ...run, execute }).inspect('old'), { code: 'library_mismatch' });
  await assert.rejects(createAgentTasks({ ...run, execute, allowLegacyTasks: async () => false }).inspect('old'), { code: 'library_mismatch' });
  const receipt = await createAgentTasks({ ...run, execute, allowLegacyTasks: true }).inspect('old');
  assert.equal(receipt.state, 'interrupted'); assert.equal(receipt.libraryId, 'original-library');
  assert.equal(run.data['agentTask:old'].libraryId, 'original-library');
});

test('an unavailable identity prevents enqueueing and execution rather than inventing a library', async () => {
  const run = fixture(); run.select('');
  const tasks = createAgentTasks({ ...run, execute: () => assert.fail('No library') });
  await assert.rejects(tasks.submit('save_material', {}, 'missing'), { code: 'library_identity_invalid' });
  assert.deepEqual(run.data, {});
});

test('late progress cannot overwrite a newer phase or revive a failed task', async () => {
  const run = fixture(); let scope, fail;
  const tasks = createAgentTasks({ ...run, execute: async (_operation, _input, _id, value) => {
    scope = value;
    await new Promise((_resolve, reject) => { fail = reject; });
  } });
  await tasks.submit('save_capture', {}, 'failed-progress'); await turn();
  assert.equal(scope.report({ progress: { phase: 'writing' }, sequence: 2 }), true);
  assert.equal(scope.report({ progress: { phase: 'download', receivedBytes: 99 }, sequence: 1 }), false);
  assert.equal((await tasks.inspect('failed-progress')).progress.phase, 'writing');
  fail(new Error('disk unavailable'));
  const receipt = await tasks.inspect('failed-progress', { waitMs: 1000 });
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.progress, undefined);
  assert.equal(scope.report({ state: 'running', progress: { phase: 'download' }, sequence: 3 }), false);
  assert.equal((await tasks.inspect('failed-progress')).state, 'failed');
});

test('completion during receipt reading cannot be overwritten by a stale interrupted snapshot', async () => {
  const run = fixture(); let complete, returnSnapshot;
  const tasks = createAgentTasks({ ...run, execute: async () => {
    await new Promise(resolve => { complete = resolve; }); return { ok: true, entryId: 'saved' };
  } });
  await tasks.submit('save_capture', {}, 'read-race'); await turn();
  const get = run.storage.get;
  run.storage.get = async key => {
    const snapshot = await get(key);
    run.storage.get = get;
    await new Promise(resolve => { returnSnapshot = resolve; });
    return snapshot;
  };
  const reading = tasks.inspect('read-race'); await turn();
  complete(); await turn(); returnSnapshot();
  const receipt = await reading;
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.result.entryId, 'saved');
  assert.equal(run.data['agentTask:read-race'].state, 'completed');
});
