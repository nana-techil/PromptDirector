import test from 'node:test';
import assert from 'node:assert/strict';
import { replacementImpact, createUndoConfirmations } from '../extension/library-undo-preview.js';
import { createLibraryStorage, createLibraryCommitter } from '../extension/library-storage.js';

test('whole-library impact names later cases that disappear, overwritten edits and restored cases without returning their bodies', () => {
  const impact = replacementImpact({entries:[{id:'same',text:'keep'},{id:'edited',title:'Edited',text:'latest'},{id:'new',title:'New',text:'new'}]},
    {entries:[{id:'same',text:'keep'},{id:'edited',text:'old'},{id:'previous',title:'Previous',text:'past'}]});
  assert.deepEqual(impact, {currentCount:3,targetCount:3,removed:[{id:'new',title:'New'}],changed:[{id:'edited',title:'Edited'}],restored:[{id:'previous',title:'Previous'}]});
});

function fixture() {
  const data = { caseLibraryRevision:'before', entries:[{id:'later',text:'latest'}], setting:'current' };
  const backend = {async get(keys) {return structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,data[key]])));},
    async set(update) {Object.assign(data, structuredClone(update));}, async remove(keys) {for(const key of keys) delete data[key];}};
  let pending = Promise.resolve();
  const lock = fn => {const result = pending.then(fn);pending = result.catch(()=>{});return result;};
  const storage = createLibraryStorage({backend,lock});
  const confirmations = createUndoConfirmations(storage);
  const commit = createLibraryCommitter({storage,syncedKeys:new Set(['entries']),syncMetaKey:'syncMeta',markDirty:()=>({localDirty:true}),isSyncApplying:()=>false});
  return {data, storage, confirmations, commit};
}

test('P0: a later case edit between preview and write prevents the old library snapshot from replacing it', async () => {
  const {data,storage,confirmations,commit}=fixture();
  const preview=await confirmations.prepare('restore',['caseLibraryRevision','setting'],async()=>({count:1}));
  const guard=confirmations.guard('restore',preview.confirmationToken);
  const later=storage.set({entries:[{id:'later',text:'must survive'},{id:'new',text:'also survive'}]});
  const undo=commit({entries:[]},{guard});
  await later;
  await assert.rejects(undo,/确认期间资料已变化/);
  assert.deepEqual((await storage.get('entries')).entries.map(e=>e.id),['later','new']);
  assert.equal((await storage.get('entries')).entries[0].text,'must survive');
  assert.equal(data.syncMeta,undefined,'rejected undo must not write even sync metadata');
});

test('P0: changes outside cases and a newer preview invalidate the confirmation', async () => {
  const {data,confirmations,commit}=fixture();
  const preview=await confirmations.prepare('restore',['setting'],async()=>({}));
  data.setting='edited notes or settings';
  await assert.rejects(commit({entries:[]},{guard:confirmations.guard('restore',preview.confirmationToken)}),/确认期间资料已变化/);
  await confirmations.prepare('restore',['setting'],async()=>({}));
  assert.throws(()=>confirmations.guard('restore',preview.confirmationToken),/请先查看/);
  assert.throws(()=>confirmations.guard('restore',''),/请先查看/);
});

test('unchanged confirmed operation commits normally; a restarted worker refuses an old token',async()=>{
  const {data,storage,confirmations,commit}=fixture();
  const preview=await confirmations.prepare('restore',['caseLibraryRevision'],async()=>({}));
  assert.throws(()=>createUndoConfirmations(storage).guard('restore',preview.confirmationToken),/请先查看/);
  await commit({setting:'restored'},{guard:confirmations.guard('restore',preview.confirmationToken),markSyncDirty:false});
  assert.equal(data.setting,'restored');
});

test('an initial migration rebuilds the undisplayed preview, but continuing changes never yield a confirmation',async()=>{
  const {data,confirmations}=fixture();let reads=0;
  const preview=await confirmations.prepare('restore',['setting'],async()=>{if(!reads++)data.setting='migrated';return {count:reads};});
  assert.equal(preview.count,2);
  await assert.rejects(confirmations.prepare('restore',['setting'],async()=>{data.setting+='changed';return {};}),/确认期间资料已变化/);
});

test('a confirmed import or analysis batch cannot authorize undoing another batch', async()=>{
  const {confirmations}=fixture();
  const preview=await confirmations.prepare('import',['caseLibraryRevision'],async()=>({jobId:'first'}));
  assert.throws(()=>confirmations.guard('import',preview.confirmationToken,'second'),/请先查看/);
  assert.doesNotThrow(()=>confirmations.guard('import',preview.confirmationToken,'first'));
});
