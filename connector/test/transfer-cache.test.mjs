import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyCachedFile, recordCacheFile, leaseCacheFile, sweepTransferCache, CACHE_IDLE_MS } from '../transfer-cache.mjs';

test('unchanged originals reuse a verified digest; same-size edits invalidate it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'original'), bytes = Buffer.from('original');
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path, bytes);
  let reads = 0;
  const digest = async handle => { reads++; return createHash('sha256').update(await handle.readFile()).digest('hex'); };
  const verify = async () => { const handle = await open(path); try { return await verifyCachedFile(path, handle, hash, digest); } finally { await handle.close(); } };
  assert.equal(await verify(), true);
  assert.equal(await verify(), true);
  assert.equal(reads, 1, 'a repeated Agent read must not reread the original bytes');
  await writeFile(path, 'modified');
  assert.equal(await verify(), false);
  assert.equal(reads, 2);
});

test('cleanup removes only idle owned copies, preserving active, recently returned, edited and unknown files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.now(), old = now - CACHE_IDLE_MS - 1;
  const paths = Object.fromEntries(['idle', 'active', 'recent', 'edited', 'unknown'].map(name => [name, join(directory, name)]));
  for (const [name, path] of Object.entries(paths)) {
    await writeFile(path, 'original');
    if (name !== 'unknown') await recordCacheFile(path, { owned: true, now: old });
  }
  const release = await leaseCacheFile(paths.active);
  await recordCacheFile(paths.recent, { now });
  await writeFile(paths.edited, 'modified');
  // Revalidating an edited legacy copy cannot silently enroll it for deletion.
  await recordCacheFile(paths.edited, { now: old });
  const result = await sweepTransferCache(directory, { now });
  assert.deepEqual(result, { removed: 1, bytes: 8, failed: 0 });
  await assert.rejects(readFile(paths.idle), { code: 'ENOENT' });
  for (const name of ['active', 'recent', 'edited', 'unknown']) assert.equal((await readFile(paths[name])).length, 8);
  await release();
  assert.equal((await sweepTransferCache(directory, { now })).removed, 1);
});

test('a replaced file or symlink is not deleted using an older ownership receipt', async t => {
  if (process.platform === 'win32') return t.skip('symlinks require Windows developer privileges');
  const directory = await mkdtemp(join(tmpdir(), 'pd-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'copy'), original = join(directory, 'source');
  await writeFile(original, 'keep'); await writeFile(path, 'copy');
  await recordCacheFile(path, { owned: true, now: Date.now() - CACHE_IDLE_MS - 1 });
  await rm(path); await symlink(original, path);
  assert.equal((await sweepTransferCache(directory)).removed, 0);
  assert.equal(await readFile(original, 'utf8'), 'keep');
});

test('a dead owner lease is reclaimed without waiting or deleting its original; a live owner remains protected', async t => {
  const { mkdir } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'pd-cache-lease-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'original'); await writeFile(path, 'keep');
  await mkdir(path + '.lease');
  await writeFile(join(path + '.lease', 'owner.json'), JSON.stringify({ pid: process.pid, token: 'dead' }));
  const release = await leaseCacheFile(path, { ownerAlive: () => false });
  assert.equal(typeof release, 'function');
  assert.equal(await readFile(path, 'utf8'), 'keep');
  assert.equal(await leaseCacheFile(path), null, 'the newly acquired current-process lease cannot be stolen');
  await release();
});

test('concurrent crash-lease recovery grants at most one reader and preserves a live owner regardless of age', async t => {
  const { mkdir, utimes } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'pd-cache-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'original'); await writeFile(path, 'keep'); await mkdir(path + '.lease');
  await writeFile(join(path + '.lease', 'owner-dead.json'), JSON.stringify({ pid: 2147483647 }));
  const results = await Promise.all(Array.from({ length: 10 }, () => leaseCacheFile(path)));
  assert.equal(results.filter(Boolean).length, 1);
  const old = new Date(Date.now() - CACHE_IDLE_MS * 2); await utimes(path + '.lease', old, old);
  assert.equal(await leaseCacheFile(path), null, 'long running real readers stay protected');
  await results.find(Boolean)();
});
