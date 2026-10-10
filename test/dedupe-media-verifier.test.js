import test from 'node:test';
import assert from 'node:assert/strict';
import { createDedupeMediaVerifier } from '../extension/dedupe-media-verifier.js';
import { caseRecordKey } from '../extension/library-case-records.js';
const asset = id => ({ id, kind: 'image', storageMode: 'managed' });
function fixture(entries, beforeCommit = () => {}, readBlob = id => new Blob([id])) {
  const current = new Map(entries.map(e => [e.id, structuredClone(e)]));
  const reads = [], writes = [], blobs = [];
  const verify = createDedupeMediaVerifier({
    storage: { get: async keys => {
      reads.push(keys);
      return Object.fromEntries([...current.values()].filter(e => keys.includes(caseRecordKey(e.id))).map(e => [caseRecordKey(e.id), structuredClone(e)]));
    } },
    readBlob: async id => { blobs.push(id); return readBlob(id); }, enqueue: task => task(),
    commit: { updateCases: async (ids, transform) => {
      writes.push(ids); beforeCommit(current);
      const changes = ids.map(id => transform(current.get(id) ?? null, id)).filter(Boolean);
      changes.forEach(entry => current.set(entry.id, entry));
    } }
  });
  return { current, reads, writes, blobs, verify };
}
test('a shared original is read once and all case fingerprints commit in one batch',async()=>{
 const f=fixture(Array.from({length:1000},(_,i)=>({id:'e'+i,text:'Original '+i,mediaAssets:[asset('shared')]})));
 const result=await f.verify({assets:[{assetId:'shared',entryIds:[...f.current.keys()]}]});
 assert.equal(f.reads.length,1);assert.equal(f.writes.length,1);assert.deepEqual(f.blobs,['shared']);
 assert.equal(result.results[0].updatedIds.length,1000);
 assert.equal(f.current.get('e999').text,'Original 999');assert.match(f.current.get('e999').mediaAssets[0].contentHash,/^[a-f0-9]{64}$/);
});
test('known fingerprints are reused without reading original bytes again',async()=>{
 const known={...asset('shared'),byteSize:6,contentHash:'a'.repeat(64)};
 const f=fixture([{id:'a',mediaAssets:[known]},{id:'b',mediaAssets:[asset('shared')]}]);
 await f.verify({assets:[{assetId:'shared',entryIds:['a','b']}]});
 assert.equal(f.blobs.length,0);assert.equal(f.current.get('b').mediaAssets[0].contentHash,known.contentHash);
});
test('concurrent text edits survive; replaced or deleted originals cannot receive stale proof',async()=>{
 const f=fixture(['a','b','c'].map(id=>({id,text:'Old',mediaAssets:[asset('shared')]})),current=>{
  current.get('a').text='New';current.get('b').mediaAssets[0].sourceUrl='changed';current.delete('c');
 });
 const result=await f.verify({assets:[{assetId:'shared',entryIds:['a','b','c']}]});
 assert.deepEqual(result.results[0].updatedIds,['a']);assert.deepEqual(result.results[0].failedIds,['b','c']);
 assert.equal(f.current.get('a').text,'New');assert.equal(f.current.get('b').mediaAssets[0].contentHash,undefined);assert.equal(f.current.has('c'),false);
});
test('a missing original does not prevent other originals in the batch from saving',async()=>{
 const f=fixture([{id:'a',mediaAssets:[asset('ok')]},{id:'b',mediaAssets:[{...asset('external'),storageMode:'reference'}]}]);
 const result=await f.verify({assets:[{assetId:'external',entryIds:['b']},{assetId:'ok',entryIds:['a']}]});
 assert.deepEqual(result.results.find(r=>r.assetId==='ok').updatedIds,['a']);assert.deepEqual(result.results.find(r=>r.assetId==='external').failedIds,['b']);
});


test('missing, empty and external originals have actionable distinct reasons without fabricating proof', async () => {
 const entries = ['missing','empty','external'].map(id=>({id,mediaAssets:[{...asset(id),storageMode:id==='external'?'reference':'managed'}]}));
 const f=fixture(entries,()=>{},id=>id==='empty'?new Blob([]):null);
 const {results}=await f.verify({assets:entries.map(e=>({assetId:e.id,entryIds:[e.id]}))});
 assert.match(results.find(r=>r.assetId==='missing').error,/未找到/);
 assert.match(results.find(r=>r.assetId==='empty').error,/为空/);
 assert.match(results.find(r=>r.assetId==='external').error,/外部引用/);
 assert.equal(f.writes.length,0);
});
