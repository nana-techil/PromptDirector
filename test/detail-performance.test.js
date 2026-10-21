import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../extension/library-model.js';

function fixture() {
  let reads = 0;
  const nodes = Array.from({length: 3000}, (_, i) => ({id:`n${i}`, get name() { reads++; return `Tag ${i}`; },
    facetId:'style', parentId:i ? 'n0' : null, status:'active', aliases:[], patterns:[]}));
  const catalog = {facets:[{id:'style',name:'Style',status:'active'}],nodes};
  const entry = {facetAssignments:Array.from({length:12},(_,i)=>({facetId:'style',nodeId:`n${i+1}`,status:'confirmed',source:'manual',importance:i/12}))};
  return {catalog,entry,reads:()=>reads};
}

test('many detail tags traverse the catalog once, not once per tag path', () => {
  const {catalog,entry,reads} = fixture();
  const trim = String.prototype.trim; let normalizedNames=0;
  String.prototype.trim = function() { if (String(this).startsWith('Tag ')) normalizedNames++; return trim.call(this); };
  let result;
  try { result = model.groupEntryAssignments(entry,catalog).get('style'); }
  finally { String.prototype.trim=trim; }
  assert.equal(normalizedNames,catalog.nodes.length,'tag paths must not normalize the entire catalog again');
  assert.equal(result.length,12);
  assert.equal(result[0].path,'Tag 0 / Tag 1');
  assert.equal(reads(),catalog.nodes.length,'one normalization of the unchanged tag catalog');
});

test('detail sections share a catalog snapshot while edits to assignments and a new catalog are visible', () => {
  const {catalog,entry,reads} = fixture();
  const read = model.createEntryAssignmentReader(catalog);
  const a = read(entry); const b = read(entry);
  assert.deepEqual(a,b); assert.equal(reads(),catalog.nodes.length);
  a.get('style')[0].name='caller changed result';
  assert.equal(read(entry).get('style')[0].name,'Tag 1');
  entry.facetAssignments[0].nodeId='n20';
  assert.equal(read(entry).get('style')[0].name,'Tag 20');
  const next = structuredClone(catalog);next.nodes[20].name='Renamed';next.nodes[20].parentId='n2';
  const updated=model.createEntryAssignmentReader(next);
  assert.equal(updated(entry).get('style')[0].path,'Tag 0 / Tag 2 / Renamed');
  next.nodes[20].status='archived';
  assert.equal(model.createEntryAssignmentReader(next)(entry).get('style').length,11);
});

test('prepared tag reads preserve cycles, missing parents, pending status and entry data', () => {
  const catalog={facets:[{id:'s',name:'Style'}],nodes:[
    {id:'a',name:'A',facetId:'s',parentId:'b'}, {id:'b',name:'B',facetId:'s',parentId:'a'},
    {id:'c',name:'C',facetId:'s',parentId:'missing'}]};
  const entry={facetAssignments:[{nodeId:'a',status:'confirmed'},{nodeId:'c',status:'pending'},{nodeId:'missing',status:'confirmed'}]};
  const before=structuredClone({catalog,entry}); const read=model.createEntryAssignmentReader(catalog);
  assert.equal(read(entry).get('s')[0].path,'B / A');
  assert.equal(read(entry,'pending').get('s')[0].path,'C');
  assert.deepEqual({catalog,entry},before);
});
