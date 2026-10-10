import { mediaIdentity } from './library-duplicates.js';
import { sameDuplicateAsset } from './case-dedupe-operations.js';
import { caseRecordKey } from './library-case-records.js';
import { sha256Blob } from './blob-digest.js';
import { RESOURCE_POLICY } from './resource-policy.js';

// One record read and one guarded commit per batch; each shared original is hashed once.
export function createDedupeMediaVerifier({ storage, readBlob, commit, enqueue }) {
  return async message => {
    const requests = message.assets ?? [{ assetId: message.assetId, entryIds: message.entryIds ?? [message.entryId] }];
    const grouped = new Map();
    for (const row of requests) {
      if (!grouped.has(row.assetId)) grouped.set(row.assetId, new Set());
      for (const id of row.entryIds || []) if (id) grouped.get(row.assetId).add(id);
    }
    const ids = [...new Set([...grouped.values()].flatMap(set => [...set]))];
    const stored = await storage.get(ids.map(caseRecordKey));
    const snapshots = new Map(ids.filter(id => stored[caseRecordKey(id)]).map(id => [id, stored[caseRecordKey(id)]]));
    if (snapshots.size < ids.length) {
      const missing = new Set(ids.filter(id => !snapshots.has(id)));
      const legacy = await storage.get('entries');
      for (const entry of legacy.entries ?? []) if (missing.has(entry.id)) snapshots.set(entry.id, entry);
    }
    const results = [], patches = new Map(), queue = [...grouped];
    async function worker() {
      while (queue.length) {
        const [assetId, entryIds] = queue.shift();
        const result = { assetId, updatedIds: [], failedIds: [] }; results.push(result);
        try {
          const originals = [...entryIds].map(id => ({ id, asset: snapshots.get(id)?.mediaAssets?.find(a => a.id === assetId) }))
            .filter(row => row.asset && row.asset.storageMode !== 'reference');
          if (!originals.length) throw new Error([...entryIds].some(id => snapshots.get(id)?.mediaAssets?.some(a => a.id === assetId && a.storageMode === 'reference'))
            ? '原件仅保留外部引用，尚未保存到本机' : '案例中的这份媒体已变化，请重新比较');
          const proven = originals.find(row => mediaIdentity(row.asset) && row.asset.byteSize > 0);
          const blob = proven ? null : await readBlob(assetId);
          if (!proven && !blob) throw new Error('本机原件未找到，可打开案例检查来源');
          if (!proven && !blob.size) throw new Error('本机原件为空，无法核对');
          result.contentHash = proven?.asset.contentHash ?? await sha256Blob(blob);
          result.byteSize = proven?.asset.byteSize ?? blob.size;
          const available = new Set(originals.map(row => row.id));
          result.failedIds.push(...[...entryIds].filter(id => !available.has(id)));
          for (const { id, asset } of originals) {
            if (!patches.has(id)) patches.set(id, []);
            patches.get(id).push({ asset, result });
          }
        } catch (error) { result.error = error.message; result.failedIds = [...entryIds]; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(queue.length, RESOURCE_POLICY.mediaDownloadConcurrency) }, worker));
    if (patches.size) await enqueue(() => commit.updateCases([...patches.keys()], (current, id) => {
      const valid = new Map();
      for (const { asset, result } of patches.get(id)) {
        const now = current?.mediaAssets?.find(a => a.id === asset.id);
        if (now && sameDuplicateAsset(asset, now)) { valid.set(asset.id, result); result.updatedIds.push(id); }
        else result.failedIds.push(id);
      }
      return valid.size ? { ...current, mediaAssets: current.mediaAssets.map(asset => {
        const result = valid.get(asset.id);
        return result ? { ...asset, contentHash: result.contentHash, byteSize: result.byteSize } : asset;
      }) } : null;
    }));
    if (!message.assets) {
      if (results[0]?.error) throw new Error(results[0].error);
      return { ok: true, ...results[0] };
    }
    return { ok: true, results };
  };
}
