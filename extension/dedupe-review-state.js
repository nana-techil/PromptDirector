import { duplicateVisualAssets, mediaIdentity } from './library-duplicates.js';

export const DEDUPE_REVIEW_KEY = 'dedupeReviewDismissals';
// Only the unverified originals identify a reminder. Editing titles/tags should not revive it.
export function unverifiedCase(entry) {
  const assets = duplicateVisualAssets(entry).filter(asset => !mediaIdentity(asset) || asset.byteSize === 0);
  if (!assets.length) return null;
  const signature = JSON.stringify(assets.map(asset => [asset.id, asset.kind, asset.storageMode,
    asset.contentHash, asset.byteSize, asset.sourceUrl, asset.url, asset.reference?.url,
    asset.assetPath, asset.sourceLastModified, asset.localReferenceId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  return { entry, assets, signature };
}

export function unverifiedCases(entries, dismissed = {}) {
  return entries.flatMap(entry => {
    const row = unverifiedCase(entry);
    return row ? [{ ...row, dismissed: dismissed[entry.id] === row.signature }] : [];
  });
}

export function updateReviewDismissals(stored, entries, row, dismiss) {
  const next = Object.fromEntries(unverifiedCases(entries, stored).filter(item => item.dismissed)
    .map(item => [item.entry.id, item.signature]));
  if (dismiss) next[row.entry.id] = row.signature;
  else delete next[row.entry.id];
  return next;
}
