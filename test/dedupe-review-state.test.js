import test from 'node:test';
import assert from 'node:assert/strict';
import { unverifiedCases, updateReviewDismissals } from '../extension/dedupe-review-state.js';
const entry = { id: 'one', title: 'Original', mediaAssets: [{ id: 'image', kind: 'image', storageMode: 'managed' }] };
test('dismissal hides only this unverified original, survives unrelated edits and never becomes media proof', () => {
  const row = unverifiedCases([entry])[0];
  const stored = updateReviewDismissals({}, [entry], row, true);
  const edited = { ...entry, title: 'New title', customLabels: ['New label'] };
  assert.equal(unverifiedCases([edited], stored)[0].dismissed, true);
  assert.equal(entry.mediaAssets[0].contentHash, undefined);
  assert.equal(unverifiedCases([{ ...entry, mediaAssets: [{ ...entry.mediaAssets[0], id: 'replacement' }] }], stored)[0].dismissed, false);
  assert.equal(unverifiedCases([entry], updateReviewDismissals(stored, [entry], row, false))[0].dismissed, false);
});
test('successful verification removes the pending case; unrelated missing originals and zero byte files remain', () => {
  const known = { ...entry.mediaAssets[0], byteSize: 1, contentHash: 'a'.repeat(64) };
  assert.equal(unverifiedCases([{ ...entry, mediaAssets: [known] }]).length, 0);
  assert.equal(unverifiedCases([{ ...entry, mediaAssets: [known, { id: 'second', kind: 'video' }] }])[0].assets.length, 1);
  assert.equal(unverifiedCases([{ ...entry, mediaAssets: [{ ...known, byteSize: 0 }] }]).length, 1);
  assert.equal(unverifiedCases([{ ...entry, mediaAssets: [{ ...known, storageMode: 'reference' }] }]).length, 1);
});
test('dismissal updates prune obsolete records without touching other still-dismissed cases', () => {
  const other = { ...entry, id: 'other' }, row = unverifiedCases([entry])[0];
  const stored = { obsolete: 'old', other: unverifiedCases([other])[0].signature };
  const next = updateReviewDismissals(stored, [entry, other], row, true);
  assert.deepEqual(Object.keys(next).sort(), ['one', 'other']);
});
