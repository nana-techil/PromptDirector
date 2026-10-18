// Both grouping modes share source boundaries and conservation rules; each
// caller still decides what constitutes an independent case.
export function captureSectionRanges(blocks, starts, level) {
  return starts.map((start, index) => {
    const next = starts[index + 1] ?? blocks.length;
    let end = start + 1;
    while (end < next && !(level && blocks[end].kind === 'heading' && blocks[end].level < level)) end++;
    return { start, end };
  });
}

export function captureGroupRemainder(candidate, blocks, usedBlocks, usedMedia, fallbackText = '') {
  const parts = blocks.filter(block => !usedBlocks.has(block.id));
  const referencedMedia = new Set(parts.map(block => block.assetId).filter(Boolean));
  const media = (candidate.media || []).filter(item => !usedMedia.has(item.id) || referencedMedia.has(item.id));
  const possibleOmissions = candidate.possibleOmissions || [];
  const supplements = candidate.supplements || [];
  if (!parts.length && !media.length && !possibleOmissions.length && !supplements.length && !fallbackText) return null;
  return {
    parts: fallbackText ? [{ id: `body:${candidate.id}`, kind: 'paragraph', text: fallbackText }] : parts,
    media, possibleOmissions, supplements
  };
}

// These blocks already belong to a chosen source group. Do not rank or drop
// short source text again; its original kinds remain in articleDocument.
export function captureGroupTextBlocks(blocks, owned) {
  return blocks.filter(block => block.text && !owned.has(block.id))
    .map(block => ({ id: block.id, kind: 'section', text: block.text, sourceOrder: block.sourceOrder }));
}
