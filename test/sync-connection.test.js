import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeSyncMeta, normalizeSyncSettings, createRevisionSnapshot } from '../extension/sync-model.js';
import { createManualSyncController } from '../extension/manual-sync.js';

const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const library = await readFile(new URL('../extension/library.js', import.meta.url), 'utf8');
const connectionSource = background.slice(background.indexOf('async function connectSyncFolder('), background.indexOf('async function unlockSyncVault('));
const chooserSource = library.slice(library.indexOf('async function chooseSyncFolder('), library.indexOf('async function startManualSync('));

async function fixture({ sameVault = false } = {}) {
  const oldDirectory = { kind: 'directory', name: 'old' };
  const newDirectory = { kind: 'directory', name: 'new' };
  const oldKey = { type: 'secret', extractable: false, name: 'old' };
  const newKey = { type: 'secret', extractable: false, name: 'new' };
  const state = { entries: [{ id: 'case', title: 'Preserve the original', text: 'Full original text', mediaAssets: [{ id: 'image', kind: 'image', storageMode: 'managed', mimeType: 'image/png' }] }] };
  const prepared = structuredClone(state);
  prepared.entries[0].mediaAssets[0].syncObjectId = 'a'.repeat(64);
  const previous = await createRevisionSnapshot(prepared, { deviceId: 'device-a', logicalClock: 1 });
  const stored = {
    syncSettings: normalizeSyncSettings({ enabled: true, vaultId: 'vault-old', deviceId: 'device-a', lastSyncAt: '2026-01-01T00:00:00Z' }),
    syncMeta: normalizeSyncMeta({ records: previous.records, logicalClock: 1, assetRefs: { image: { objectId: 'a'.repeat(64), contentType: 'image/png' } } })
  };
  const baseline = structuredClone(stored);
  const pending = new Map();
  let directory = oldDirectory, key = oldKey, rejectPassword = false, failCommit = false, failPrivateWrite = false;
  const scope = {
    normalizeSyncMeta, normalizeSyncSettings, STORAGE_KEYS: { syncSettings: 'syncSettings', syncMeta: 'syncMeta' },
    getSyncDirectoryHandle: async () => directory,
    getSyncCryptoKey: async () => key,
    saveSyncCryptoKey: async value => { key = value; },
    saveSyncDirectoryHandle: async value => { directory = value; },
    stageSyncDirectoryHandle: async value => { const id = 'candidate'; pending.set(id, value); return id; },
    getStagedSyncDirectoryHandle: async id => pending.get(id),
    clearStagedSyncDirectoryHandle: async id => { pending.delete(id); },
    saveSyncConnection: async value => {
      if (failPrivateWrite) { failPrivateWrite = false; throw Error('private storage failed'); }
      directory = value.directory; key = value.key;
    },
    requireDirectoryPermission: async () => {},
    createOrUnlockSyncVault: async selected => {
      if (rejectPassword) throw Error('wrong password');
      return { directory: selected, key: newKey, header: { vaultId: sameVault ? 'vault-old' : 'vault-new' } };
    },
    libraryStorage: { get: async () => structuredClone(stored) },
    commitLocalChanges: async update => {
      if (failCommit) { failCommit = false; throw Error('settings storage failed'); }
      Object.assign(stored, structuredClone(update));
    }
  };
  const connect = vm.runInNewContext(`${connectionSource}\nconnectSyncFolder`, scope);
  const chooser = vm.runInNewContext(`${chooserSource}\nchooseSyncFolder`, {
    ...scope, dataSafetyOperationActive: false, t: value => value,
    elements: { syncPassword: { value: 'valid-password', focus() {} }, connectSyncFolder: { disabled: false } },
    window: { showDirectoryPicker: async () => newDirectory },
    showDataSafetyFeedback() {},
    runDataSafetyAction: async (_button, message) => {
      try { return await connect(message.password, message.directoryId); } catch { return null; }
    }
  });
  return { connect, chooser, stored, baseline, state, previous, pending, oldDirectory, oldKey, newDirectory, newKey,
    get directory() { return directory; }, get key() { return key; },
    rejectPassword(value) { rejectPassword = value; }, failCommit() { failCommit = true; }, failPrivateWrite() { failPrivateWrite = true; },
    stage: () => scope.stageSyncDirectoryHandle(newDirectory)
  };
}

test('a rejected password keeps the previous folder key and sync history, and a retry connects', async () => {
  const f = await fixture();
  f.rejectPassword(true);
  await f.chooser();
  assert.equal(f.directory, f.oldDirectory);
  assert.equal(f.key, f.oldKey);
  assert.deepEqual(f.stored, f.baseline);
  assert.equal(f.pending.size, 0);
  f.rejectPassword(false);
  await f.chooser();
  assert.equal(f.directory, f.newDirectory);
  assert.equal(f.stored.syncSettings.vaultId, 'vault-new');
});

test('a new vault receives originals on its first sync instead of reusing another vault receipts', async () => {
  const f = await fixture();
  await f.chooser();
  assert.deepEqual(f.stored.syncMeta.records, {});
  assert.deepEqual(f.stored.syncMeta.assetRefs, {});
  assert.equal(f.stored.syncSettings.lastSyncAt, '');
  let writes = 0, reads = 0;
  const snapshots = [];
  const controller = createManualSyncController({
    readState: async () => structuredClone(f.state), readMeta: async () => structuredClone(f.stored.syncMeta),
    listSnapshots: async () => snapshots,
    readMedia: async () => { reads++; return new Blob(['original'], { type: 'image/png' }); },
    writeMedia: async () => {}, deleteMedia: async () => {},
    writeObject: async () => { writes++; return 'b'.repeat(64); },
    readObject: async () => { throw Error('no remote object should be needed'); },
    writeSnapshot: async (_vault, snapshot) => snapshots.push(snapshot),
    commit: async ({ meta }) => { f.stored.syncMeta = meta; }
  });
  const result = await controller.start({ vault: { header: { vaultId: 'vault-new' } }, settings: f.stored.syncSettings });
  assert.equal(result.upToDate, false);
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(snapshots.length, 1);
  assert.equal(f.state.entries[0].text, 'Full original text');
});

test('re-authorizing the same vault keeps its revision and media cache', async () => {
  const f = await fixture({ sameVault: true });
  await f.chooser();
  assert.equal(f.directory, f.newDirectory);
  assert.deepEqual(f.stored.syncMeta, f.baseline.syncMeta);
  assert.equal(f.stored.syncSettings.lastSyncAt, f.baseline.syncSettings.lastSyncAt);
  const unexpected = async () => { throw Error('unchanged reconnection must reuse verified originals'); };
  const controller = createManualSyncController({
    readMeta: async () => f.stored.syncMeta, listSnapshots: async () => [f.previous],
    readState: unexpected, readMedia: unexpected, writeMedia: unexpected, deleteMedia: unexpected,
    writeObject: unexpected, readObject: unexpected, writeSnapshot: unexpected, commit: unexpected
  });
  const result = await controller.start({ vault: { header: { vaultId: 'vault-old' } }, settings: f.stored.syncSettings });
  assert.equal(result.upToDate, true);
});

for (const failure of ['failCommit', 'failPrivateWrite']) {
  test(`connection ${failure} preserves the previous connection and supports retry`, async () => {
    const f = await fixture();
    f[failure]();
    await f.chooser();
    assert.equal(f.directory, f.oldDirectory);
    assert.equal(f.key, f.oldKey);
    assert.deepEqual(f.stored, f.baseline);
    assert.equal(f.pending.size, 0);
    await f.chooser();
    assert.equal(f.directory, f.newDirectory);
    assert.equal(f.stored.syncSettings.vaultId, 'vault-new');
  });
}

test('a missing or expired selection never reconnects the previously stored folder', async () => {
  const f = await fixture();
  await assert.rejects(f.connect('valid-password', 'missing'));
  assert.deepEqual(f.stored, f.baseline);
});
