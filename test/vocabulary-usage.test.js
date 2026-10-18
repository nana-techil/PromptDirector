import test from 'node:test';
import assert from 'node:assert/strict';
import { createVocabularyUsageReader } from '../extension/vocabulary-usage.js';

const node = (id, parentId = null, status = 'active', facetId = 'subject') => ({ id, parentId, status, facetId });
const assignment = (nodeId, status = 'confirmed') => ({ nodeId, status });

test('manager counts each case once per group even with sibling, repeated and direct group assignments', () => {
  const catalog = { nodes: [node('group'), node('a', 'group'), node('b', 'group'), node('unused')] };
  const entries = [
    { facetAssignments: [assignment('a'), assignment('a'), assignment('b'), assignment('group')] },
    { facetAssignments: [assignment('b', 'needs_review')] },
    {}
  ];
  const before = structuredClone({ entries, catalog });
  const counts = createVocabularyUsageReader()(entries, catalog);
  assert.equal(counts.get('a'), 1);
  assert.equal(counts.get('b'), 2, 'manager usage includes existing assignments regardless of review state');
  assert.equal(counts.get('group'), 2, 'summing sibling counts would overcount the same case');
  assert.equal(counts.get('unused') ?? 0, 0);
  assert.deepEqual({ entries, catalog }, before, 'usage is derived without editing user data');
});

test('archived, unknown and other-dimension children do not inflate the displayed group count', () => {
  const catalog = { nodes: [node('group'), node('a', 'group'), node('old', 'group', 'archived'), node('other', 'group', 'active', 'style')] };
  const counts = createVocabularyUsageReader()([
    { facetAssignments: [assignment('old'), assignment('unknown'), assignment('other')] },
    { facetAssignments: [assignment('a')] }
  ], catalog);
  assert.equal(counts.get('group'), 1);
  assert.equal(counts.has('old'), false);
  assert.equal(counts.has('unknown'), false);
  assert.equal(counts.get('other'), 1);
});

test('thousands of displayed tag counts share one case traversal and reuse unchanged results', () => {
  const catalog = { nodes: [node('group'), ...Array.from({ length: 3000 }, (_, i) => node(`tag-${i}`, 'group'))] };
  let reads = 0;
  const entries = Array.from({ length: 6000 }, (_, i) => ({
    get facetAssignments() {
      reads++;
      return [assignment(`tag-${i % 3000}`), assignment(`tag-${(i + 1) % 3000}`)];
    }
  }));
  const read = createVocabularyUsageReader();
  const counts = read(entries, catalog);
  for (let i = 0; i < 3000; i++) assert.equal(counts.get(`tag-${i}`), 4);
  assert.equal(counts.get('group'), 6000);
  assert.equal(reads, 6000, 'adding tags must not multiply full-library scans');
  assert.equal(read(entries, catalog), counts);
  assert.equal(read(entries, { ...catalog }), counts, 'unchanged node snapshot reuses counts');
  assert.equal(reads, 6000);
});

test('case edits/deletion and tag moves/archive invalidate counts instead of retaining stale badges', () => {
  const catalog = { nodes: [node('one'), node('two'), node('a', 'one'), node('b', 'one')] };
  const read = createVocabularyUsageReader();
  const entries = [{ facetAssignments: [assignment('a')] }, { facetAssignments: [assignment('b')] }];
  assert.equal(read(entries, catalog).get('one'), 2);
  const edited = [entries[0], { facetAssignments: [assignment('a'), assignment('b')] }];
  assert.equal(read(edited, catalog).get('a'), 2);
  const moved = { nodes: catalog.nodes.map(n => n.id === 'a' ? { ...n, parentId: 'two' } : n) };
  assert.equal(read(edited, moved).get('one'), 1);
  assert.equal(read(edited, moved).get('two'), 2);
  const archived = { nodes: moved.nodes.map(n => n.id === 'a' ? { ...n, status: 'archived' } : n) };
  assert.equal(read(edited, archived).get('two') ?? 0, 0);
  assert.equal(read([edited[0]], archived).get('one') ?? 0, 0);
  assert.equal(read([], archived).size, 0);
});
