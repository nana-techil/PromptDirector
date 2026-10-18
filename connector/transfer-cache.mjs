import { mkdir, readdir, readFile, writeFile, rename, unlink, rmdir, lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RESOURCE_POLICY } from '../extension/resource-policy.js';

// Receipt files identify connector-owned disposable copies. Existing files,
// edited downloads and user files are never adopted just because of their name.
const verified = new Map();
const sweeps = new Map();
const suffix = '.receipt.json';
export const CACHE_IDLE_MS = RESOURCE_POLICY.temporaryIdleMs;
export function fileSignature(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}
export async function verifyCachedFile(path, handle, expectedHash, digest) {
  const before = await handle.stat({ bigint: true });
  const signature = fileSignature(before);
  const prior = verified.get(path);
  if (prior?.signature === signature && prior.hash === expectedHash) {
    prior.usedAt = Date.now();
    return true;
  }
  verified.delete(path);
  if (await digest(handle) !== expectedHash) return false;
  const after = await handle.stat({ bigint: true });
  if (signature !== fileSignature(after)) return false;
  verified.set(path, { signature, hash: expectedHash, usedAt: Date.now() });
  return true;
}
export async function rememberVerifiedFile(path, handle, hash) {
  verified.set(path, { signature: fileSignature(await handle.stat({ bigint: true })), hash, usedAt: Date.now() });
}

// Leases retain live readers, but an exited process must not pin a disposable
// copy forever. Unique owner filenames let only one contender remove that owner.
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export async function leaseCacheFile(path, { ownerAlive = processAlive, now = Date.now() } = {}) {
  const lease = `${path}.lease`;
  try { await mkdir(lease, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const names = await readdir(lease);
      const ownerName = names.find(name => /^owner(?:-[\w-]+)?\.json$/u.test(name));
      if (ownerName) {
        const owner = JSON.parse(await readFile(join(lease, ownerName), 'utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || ownerAlive(owner.pid)) return null;
        // A competing reclaimer that already removed this exact owner wins.
        await unlink(join(lease, ownerName));
      } else {
        // Legacy empty directories have no process identity. Only retire them
        // after the existing temporary-resource idle policy, never on a read race.
        if (names.length || now - (await lstat(lease)).mtimeMs < CACHE_IDLE_MS) return null;
      }
      await rmdir(lease);
    } catch (error) {
      if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return null;
      throw error;
    }
    return leaseCacheFile(path, { ownerAlive, now });
  }
  const ownerName = `owner-${process.pid}-${randomUUID()}.json`;
  try { await writeFile(join(lease, ownerName), JSON.stringify({ pid: process.pid, createdAt: now }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { await rmdir(lease).catch(() => {}); throw error; }
  return async () => {
    try { await unlink(join(lease, ownerName)); await rmdir(lease); }
    catch { /* Auxiliary lease cleanup cannot invalidate an already read original. */ }
  };
}
export async function recordCacheFile(path, { owned = false, now = Date.now() } = {}) {
  const receiptPath = path + suffix;
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch (error) { if (!owned) return; if (error.code !== 'ENOENT') throw error; }
  const info = await lstat(path, { bigint: true });
  if (!info.isFile()) return;
  const signature = fileSignature(info);
  if (!owned && receipt?.signature !== signature) return;
  const temporary = `${receiptPath}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, JSON.stringify({ name: basename(path), signature, accessedAt: now }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, receiptPath);
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function sweepTransferCache(directory, { now = Date.now(), idleMs = CACHE_IDLE_MS } = {}) {
  const result = { removed: 0, bytes: 0, failed: 0 };
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith(suffix)) continue;
    const path = join(directory, item.name.slice(0, -suffix.length));
    const release = await leaseCacheFile(path).catch(() => null);
    if (!release) continue;
    try {
      const receipt = JSON.parse(await readFile(path + suffix, 'utf8'));
      if (receipt.name !== basename(path) || !Number.isFinite(receipt.accessedAt) || now - receipt.accessedAt < idleMs) continue;
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || fileSignature(info) !== receipt.signature) continue;
      await unlink(path);
      verified.delete(path);
      await unlink(path + suffix);
      result.removed++; result.bytes += Number(info.size);
    } catch (error) { if (error.code !== 'ENOENT') result.failed++; }
    finally { await release(); }
  }
  for (const [path, entry] of verified) if (now - entry.usedAt >= idleMs) verified.delete(path);
  return result;
}
export async function maintainTransferCache(directory) {
  const now = Date.now(), prior = sweeps.get(directory);
  if (prior && now - prior.at < CACHE_IDLE_MS) return prior.promise;
  const promise = sweepTransferCache(directory).catch(() => ({ failed: 1 }));
  sweeps.set(directory, { at: now, promise });
  return promise;
}
