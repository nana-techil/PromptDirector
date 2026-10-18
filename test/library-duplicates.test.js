import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDuplicateCases, compareDuplicateCases, duplicateRevision, duplicateProjects, chooseDuplicateKeeper, duplicateOrigin, bulkDuplicateGroups } from '../extension/library-duplicates.js';
import { planDuplicateCleanup, createCaseDedupeOperations } from '../extension/case-dedupe-operations.js';
import { collectRetainedLocalAssetIds } from '../extension/import-staging.js';
import { normalizeTagColors } from '../extension/tag-color-values.js';
import { textDifference } from '../extension/case-dedupe-diff.js';
const asset = id => ({ id, kind:'image', storageMode:'managed', contentHash:'a'.repeat(64), byteSize:9, capturedAt:id });
const entry = (id, changes={}) => ({ id, title:'Test case', text:'Keep the original prompt', mediaAssets:[asset(`media:${id}`)], savedAt:id, libraryAddedAt:'2026-10-08', ...changes });
const state = () => ({ entries:[entry('a'),entry('b')], organizerState:{collections:[]}, compoundCases:[], trashState:{items:[]} });
async function scan(s) { const iterator=scanDuplicateCases(s); let step; do {step=await iterator.next();}while(!step.done);return step.value; }
async function proposal(s, keepId='a', id='b', flags={}) { const p=duplicateProjects(s);return [{keepId,keepRevision:await duplicateRevision(s.entries.find(e=>e.id===keepId),p.get(keepId)),remove:[{id,revision:await duplicateRevision(s.entries.find(e=>e.id===id),p.get(id))}],...flags}]; }
test('supporting data affects cleanup eligibility, while extra originals prevent a media match', async()=>{
 const s=state(); assert.equal(compareDuplicateCases(...s.entries).exact,true);
 s.entries[1].text+='!'; assert.deepEqual(compareDuplicateCases(...s.entries).differences,['text']);
 s.entries[1].mediaAssets.push({...asset('extra'),contentHash:'b'.repeat(64)});
 const result=await scan(s);assert.equal(result.mediaGroups.length,0);
 assert.equal(compareDuplicateCases(...s.entries).exact,false);
});
test('unverified, empty, external files and reordered media cannot be auto-cleaned',()=>{
 for(const change of [{mediaAssets:[{id:'missing'}]},{mediaAssets:[{...asset('m'),storageMode:'reference'}]}])assert.equal(compareDuplicateCases(entry('a'),entry('b',change)).exact,false);
 assert.equal(compareDuplicateCases(entry('a',{text:'',mediaAssets:[]}),entry('b',{text:'',mediaAssets:[]})).exact,false);
 const m=[asset('one'),{...asset('two'),contentHash:'b'.repeat(64)}];
 assert.equal(compareDuplicateCases(entry('a',{mediaAssets:m}),entry('b',{mediaAssets:m.toReversed()})).exact,false);
});
test('shared document in larger case is not a case duplicate and same-case repeats do not create a group',async()=>{
 const s=state();s.entries[1].mediaAssets.push({...asset('extra'),contentHash:'b'.repeat(64)});
 assert.equal((await scan(s)).mediaGroups.length,0);
 assert.equal((await scan({...s,entries:[{...s.entries[0],mediaAssets:[asset('1'),asset('2')]}]})).mediaGroups.length,0);
});
test('cross-project identities are separate, protected unless selected explicitly',async()=>{
 const s=state();s.organizerState.collections=[{id:'p',name:'P',entryIds:['b']}];
 assert.equal(bulkDuplicateGroups(await scan(s),s.entries).length,0);
 assert.equal(bulkDuplicateGroups(await scan(s),s.entries,true).length,1);
 assert.equal((await planDuplicateCleanup(s,await proposal(s))).accepted.length,0);
 assert.deepEqual((await planDuplicateCleanup(s,await proposal(s,'a','b',{allowCrossProject:true}))).accepted,['b']);
});
test('one changed word remains protected and the actual change is visible',async()=>{
 const s=state();s.entries[1].text='Keep the revised prompt';
 const diff=textDifference(s.entries[0].text,s.entries[1].text);assert.equal(diff.left,'original');assert.equal(diff.right,'revised');
 assert.equal((await planDuplicateCleanup(s,await proposal(s))).accepted.length,0);
 assert.deepEqual((await planDuplicateCleanup(s,await proposal(s,'a','b',{allowDifferent:true}))).accepted,['b']);
});
test('later edits to either kept or removed case invalidate the preview',async()=>{
 for(const id of ['a','b']){const s=state(),p=await proposal(s);s.entries.find(e=>e.id===id).text+='later';assert.equal((await planDuplicateCleanup(s,p)).accepted.length,0);}
});
test('composition, creation and skill references block removal',async()=>{
 for(const references of [{compoundCases:[{memberEntryIds:['b','a']}]},{composerSessions:[{references:[{entryId:'b'}]}]},{creativeSkills:{items:[{sources:[{caseId:'b'}]}]}}]){
 const s={...state(),...references};assert.equal((await planDuplicateCleanup(s,await proposal(s))).accepted.length,0);
 }
});
test('a kept case cannot be deleted through a second group',async()=>{
 const s=state();await assert.rejects(planDuplicateCleanup(s,[...await proposal(s),...await proposal(s,'b','a')]),/同时/);
});
test('cleanup receipts protect restored cases on retry and commit retains original snapshots',async()=>{
 let s=state(),data={};const storage={get:async key=>({[key]:data[key]})};
 const service=createCaseDedupeOperations({loadState:async()=>s,storage,enqueue:fn=>fn(),commit:async patch=>{s={...s,...patch};data={...data,...patch};}});
 const input={requestId:'request',groups:await proposal(s)},res=await service.execute(input);
 assert.deepEqual(res.movedEntryIds,['b']);assert.equal(s.entries.length,1);assert.equal(s.trashState.items[0].snapshot.text,'Keep the original prompt');
 s.entries.push(entry('b'));assert.equal((await service.execute(input)).replayed,true);assert.equal(s.entries.length,2);
 await assert.rejects(service.execute({...input,groups:[]}),/编号/);
});
test('keep rules distinguish added vs edited, and missing/equal dates are explicit',()=>{
 const rows=[entry('a',{libraryAddedAt:'2020-01-01',libraryUpdatedAt:'2026-01-01'}),entry('b',{libraryAddedAt:'2025-01-01',libraryUpdatedAt:'2025-01-01'})];
 assert.equal(chooseDuplicateKeeper(rows,'newest').id,'b');assert.equal(chooseDuplicateKeeper(rows,'oldest').id,'a');assert.equal(chooseDuplicateKeeper(rows,'edited').id,'a');
 assert.equal(chooseDuplicateKeeper([entry('a'),entry('b')],'newest').uncertain,true);
 assert.equal(duplicateOrigin(rows),'unknown');assert.equal(duplicateOrigin(rows.map((e,i)=>({...e,importBatchId:String(i)}))),'imports');
});
test('tag colors normalize equivalent names and reject invalid CSS values',()=>assert.deepEqual(normalizeTagColors({' Ｃｉｎｅｍａ ':'#AaBbCC',Bad:'red; color:red'}),{cinema:'#aabbcc'}));
test('identical pictures do not erase which copy a note or cover refers to',()=>{
 const a=entry('a',{mediaAssets:[asset('one'),asset('two')],primaryMediaId:'one'});
 const b=entry('b',{mediaAssets:[asset('three'),asset('four')],primaryMediaId:'four'});
 assert.equal(compareDuplicateCases(a,b).exact,false);
});
test('literal record or asset IDs in original text are never normalized away',()=>{
 for(const field of ['text','title']) {
  assert.equal(compareDuplicateCases(entry('a',{[field]:'a'}),entry('b',{[field]:'b'})).exact,false);
  assert.equal(compareDuplicateCases(entry('a',{[field]:'media:a'}),entry('b',{[field]:'media:b'})).exact,false);
 }
 const a=entry('a',{mediaPrompts:[{assetId:'media:a',text:'a'}]}),b=entry('b',{mediaPrompts:[{assetId:'media:b',text:'b'}]});
 assert.equal(compareDuplicateCases(a,b).exact,false);
 b.mediaPrompts[0].text='a';assert.equal(compareDuplicateCases(a,b).exact,true);
});
test('same-project duplicates stay selectable even if another copy belongs to a different project',async()=>{
 const s=state();s.entries.push(entry('c'));s.organizerState.collections=[{id:'p',entryIds:['c']}];
 const result=await scan(s);assert.deepEqual(bulkDuplicateGroups(result,s.entries).map(g=>g.caseIds),[['a','b']]);assert.deepEqual(bulkDuplicateGroups(result,s.entries,true).map(g=>g.caseIds),[['a','b','c']]);
});

test('same title, URL and prompt never make different images duplicate', async()=>{
 const a=entry('a',{url:'https://example.com/same'}),b=entry('b',{url:a.url});
 b.mediaAssets[0].contentHash='b'.repeat(64);
 assert.equal(compareDuplicateCases(a,b).mediaExact,false);
 assert.equal((await scan({...state(),entries:[a,b]})).mediaGroups.length,0);
 const s={...state(),entries:[a,b]};
 assert.equal((await planDuplicateCleanup(s,await proposal(s,'a','b',{allowDifferent:true}))).accepted.length,0);
});
test('only complete originals of matching media types identify duplicate cases',async()=>{
 for(const kind of ['image','video']) {
  const a=entry('a'),b=entry('b',{title:'Renamed',text:'A different prompt',url:'https://example.com/elsewhere'});
  a.mediaAssets[0].kind=kind;b.mediaAssets[0].kind=kind;
  assert.equal(compareDuplicateCases(a,b).mediaExact,true);
  assert.equal((await scan({...state(),entries:[a,b]})).mediaGroups.length,1);assert.equal(compareDuplicateCases(a,b).exact,false);
  b.mediaAssets[0].contentHash='b'.repeat(64);
  assert.equal((await scan({...state(),entries:[a,b]})).mediaGroups.length,0);
 }
 const a=entry('a'),b=entry('b');b.mediaAssets[0].kind='video';
 assert.equal((await scan({...state(),entries:[a,b]})).mediaGroups.length,0);
});
test('identical documents, text and video posters are not duplicate image/video cases',async()=>{
 for(const assets of [[],[{...asset('doc'),kind:'document'}],[{...asset('poster'),usage:'poster'}]]) {
  assert.equal((await scan({...state(),entries:[entry('a',{mediaAssets:assets}),entry('b',{mediaAssets:assets})]})).mediaGroups.length,0);
 }
 const a=entry('a',{mediaAssets:[{...asset('v1'),kind:'video'}, {...asset('p1'),usage:'poster'}]});
 const b=entry('b',{mediaAssets:[{...asset('v2'),kind:'video',contentHash:'b'.repeat(64)}, {...asset('p2'),usage:'poster'}]});
 assert.equal((await scan({...state(),entries:[a,b]})).mediaGroups.length,0);
});
test('all image/video originals and multiplicities must match, but their order is secondary information',async()=>{
 const a=entry('a',{mediaAssets:[asset('one'),{...asset('two'),contentHash:'b'.repeat(64)}]});
 const b=entry('b',{mediaAssets:a.mediaAssets.toReversed()});
 assert.equal(compareDuplicateCases(a,b).mediaExact,true);
 assert.equal((await scan({...state(),entries:[a,b]})).mediaGroups.length,1);
 b.mediaAssets=[asset('three'),asset('four')];
 assert.equal((await scan({...state(),entries:[a,b]})).mediaGroups.length,0);
});
test('matching visuals do not authorize automatic loss of unchecked supporting documents',async()=>{
 const s=state();for(const e of s.entries)e.mediaAssets.push({id:'unknown-document',kind:'document',sourceTitle:'Notes'});
 assert.equal(compareDuplicateCases(...s.entries).mediaExact,true);
 assert.equal(compareDuplicateCases(...s.entries).exact,false);
 assert.equal((await scan(s)).mediaGroups.length,1);
 assert.equal((await planDuplicateCleanup(s,await proposal(s))).accepted.length,0);
});

test('bulk groups include differing notes and keep projects separate until explicitly combined',async()=>{
 const s=state();s.entries.push(entry('c',{text:'Different note'}),entry('d'));
 s.organizerState.collections=[{id:'p',entryIds:['d']}];
 const result=await scan(s);
 assert.deepEqual(bulkDuplicateGroups(result,s.entries).map(g=>g.caseIds),[['a','b','c']]);
 assert.deepEqual(bulkDuplicateGroups(result,s.entries,true).map(g=>g.caseIds),[['a','b','c','d']]);
 assert.equal(compareDuplicateCases(s.entries[0],s.entries[2]).exact,false);
});
test('bulk groups never overlap when metadata subgroups and project copies share an original',async()=>{
 const s=state();s.entries.push(entry('c'),entry('d',{text:'Different note'}),entry('e',{text:'Different note'}));
 s.organizerState.collections=[{id:'p',entryIds:['c','e']}];
 const result=await scan(s),groups=bulkDuplicateGroups(result,s.entries);
 const ids=groups.flatMap(g=>g.caseIds);assert.equal(new Set(ids).size,ids.length);
 assert.equal(groups.length,2);assert.equal(result.mediaGroups.length,1);
});

// Matching originals must not read or hash prompt/document bodies at all.
test('large-library discovery and project grouping never traverse case text',async()=>{
 const s=state();for(const e of s.entries)Object.defineProperty(e,'text',{get(){throw new Error('Full text accessed during media scan');}});
 const result=await scan(s);assert.equal(result.mediaGroups.length,1);
 assert.equal(bulkDuplicateGroups(result,s.entries).length,1);
});

test('an independent project copy keeps its full content, shared original and provenance when the source enters trash', async () => {
  let s = state(); s.entries[1].mediaAssets = structuredClone(s.entries[0].mediaAssets);
  s.entries[1].copyOrigin = { caseId: 'a', title: 'Source case' };
  const copy = structuredClone(s.entries[1]);
  const service = createCaseDedupeOperations({ loadState: async () => s, storage: { get: async () => ({}) }, enqueue: fn => fn(), commit: async patch => { s = { ...s, ...patch }; } });
  const result = await service.execute({ requestId: 'copy-source', groups: await proposal(s, 'b', 'a', { allowDifferent: true }) });
  assert.deepEqual(result.movedEntryIds, ['a']);
  assert.deepEqual(s.entries.find(e => e.id === 'b'), copy);
  assert.equal(s.trashState.items[0].snapshot.mediaAssets[0].id, copy.mediaAssets[0].id);
  assert.equal(s.trashState.items[0].snapshot.text, copy.text);
  assert.ok(collectRetainedLocalAssetIds({ ...s, trashState: { items: [] } }).has(copy.mediaAssets[0].id), 'the independent copy protects its shared original even after trash is emptied');
});

test('real references identify the owning composition or session while preserving protection', async () => {
  for (const reference of [
    { compoundCases: [{ id: 'group', title: 'Storyboard', memberEntryIds: ['b', 'a'] }] },
    { composerSessions: [{ id: 'session', title: 'Film draft', referenceSnapshots: [{ caseId: 'b', text: 'Frozen original' }] }] }
  ]) {
    const s = { ...state(), ...reference };
    const result = await planDuplicateCleanup(s, await proposal(s));
    assert.deepEqual(result.accepted, []);
    assert.equal(result.skipped[0].references.length, 1);
    assert.ok(['Storyboard', 'Film draft'].includes(result.skipped[0].references[0].title));
  }
});

test('an entirely blocked cleanup does not rewrite cases or trash and its receipt is replayable', async () => {
  const s = { ...state(), compoundCases: [{ id: 'group', memberEntryIds: ['a', 'b'] }] };
  let patch;
  const service = createCaseDedupeOperations({ loadState: async () => s, storage: { get: async key => ({ [key]: patch?.[key] }) }, enqueue: fn => fn(), commit: async value => { patch = value; } });
  const input = { requestId: 'blocked', groups: await proposal(s) };
  const result = await service.execute(input);
  assert.deepEqual(result.movedEntryIds, []);
  assert.equal(Object.hasOwn(patch, 'entries'), false);
  assert.equal(Object.hasOwn(patch, 'trashState'), false);
  assert.equal((await service.execute(input)).replayed, true);
});
