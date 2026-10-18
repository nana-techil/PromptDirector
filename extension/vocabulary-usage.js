// The manager counts all attached assignments, including those awaiting review.
// Unlike sidebar filtering, a group includes only itself and its active direct children.
export function createVocabularyUsageReader() {
  let previousEntries;
  let previousNodes;
  let counts;
  return (entries, catalog) => {
    if (entries === previousEntries && catalog.nodes === previousNodes) return counts;
    const nodes = new Map(catalog.nodes.filter(node => node.status === 'active').map(node => [node.id, node]));
    counts = new Map();
    for (const entry of entries) {
      const used = new Set();
      for (const assignment of entry.facetAssignments ?? []) {
        const node = nodes.get(assignment.nodeId);
        if (!node) continue;
        used.add(node.id);
        const parent = nodes.get(node.parentId);
        if (parent && !parent.parentId && parent.facetId === node.facetId) used.add(parent.id);
      }
      for (const id of used) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    // Case and catalog updates replace their snapshots; unchanged renders reuse this map.
    previousEntries = entries;
    previousNodes = catalog.nodes;
    return counts;
  };
}
