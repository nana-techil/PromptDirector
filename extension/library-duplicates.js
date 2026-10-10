import { sha256Blob } from './blob-digest.js';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, stable(value[k])])) : value;
export const duplicateJson = value => JSON.stringify(stable(value));
const digest = value => sha256Blob(new Blob([duplicateJson(value)]));
const LOCAL = new Set(['id', 'caseInstanceId', 'importBatchId', 'importSource', 'copyOrigin', 'savedAt', 'libraryAddedAt', 'libraryUpdatedAt', 'schemaVersion', 'textRevision', 'contentRole', 'contentTypeName']);
const ASSET_LOCAL = new Set(['id', 'assetPath', 'relativePath', 'storageMode', 'capturedAt', 'linkStatus', 'sourceLastModified', 'reviewStatus']);
const MEANING = {
  title: 'title', text: 'text', mediaPrompts: 'prompts', articleDocument: 'document',
  customLabels: 'labels', metadataLabels: 'labels', classification: 'labels', facetAssignments: 'labels',
  timeNotes: 'notes', videoAnalyses: 'analysis', visualSetAnalyses: 'analysis', analysisBreakdown: 'analysis',
  analysisCandidates: 'analysis', analysisMeta: 'analysis', url: 'source', sourceFacts: 'source', sourcePages: 'source',
  primaryMediaId: 'media'
};
export function mediaIdentity(asset) {
  return /^[a-f0-9]{64}$/iu.test(asset.contentHash || '') && Number.isSafeInteger(asset.byteSize) && asset.byteSize >= 0
    && asset.storageMode !== 'reference' ? `${asset.byteSize}:${asset.contentHash.toLowerCase()}` : '';
}
// A case is a duplicate only when its full image/video originals match.
// Posters and documents are supporting material, never matching evidence.
export const duplicateVisualAssets = entry => (entry.mediaAssets || []).filter(a => ['image', 'video'].includes(a.kind) && a.usage !== 'poster');
export function duplicateMediaSignature(entry) {
  const assets = duplicateVisualAssets(entry);
  if (!assets.length || assets.some(a => !mediaIdentity(a) || a.byteSize === 0)) return '';
  return duplicateJson(assets.map(a => `${a.kind}:${mediaIdentity(a)}`).sort());
}
export function duplicateProjects(state) {
  const projects = new Map();
  for (const c of state.organizerState?.collections || []) for (const id of c.entryIds || []) {
    if (!projects.has(id)) projects.set(id, []);
    projects.get(id).push(c.id);
  }
  return projects;
}
export function duplicateContent(entry) {
  const replacements = new Map();
  (entry.mediaAssets || []).forEach((a, i) => replacements.set(a.id, `$media:${i}:${mediaIdentity(a) || 'unknown'}`));
  // Canonicalize media references only; literal IDs in user text remain content.
  const referenceKey = key => /^(?:asset|visual|primaryMedia|posterAsset|coverVisual|derivedFromAsset|frameAsset)Ids?$/u.test(key);
  const rewrite = (value, key = '') => typeof value === 'string' ? referenceKey(key) ? replacements.get(value) || value : value
    : Array.isArray(value) ? value.map(v => rewrite(v, key)) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k)])) : value;
  const fields = {};
  for (const [key, value] of Object.entries(entry)) {
    if (LOCAL.has(key) || key === 'mediaAssets') continue;
    const section = MEANING[key] || 'other';
    (fields[section] ||= {})[key] = rewrite(value, key);
  }
  fields.media ||= {};
  fields.media.assets = (entry.mediaAssets || []).map(a => Object.fromEntries(Object.entries(a)
    .filter(([key]) => !ASSET_LOCAL.has(key)).map(([key, value]) => [key, rewrite(value, key)])));
  // Source observation time and classifier implementation do not alter the saved content.
  if (fields.source?.sourceFacts) { fields.source.sourceFacts = { ...fields.source.sourceFacts }; delete fields.source.sourceFacts.capturedAt; }
  if (fields.labels?.classification) {
    fields.labels.classification = { ...fields.labels.classification };
    delete fields.labels.classification.reason; delete fields.labels.classification.classifierVersion;
  }
  return fields;
}
export function compareDuplicateCases(a, b, projects = new Map()) {
  const left = duplicateContent(a), right = duplicateContent(b);
  const differences = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(key => duplicateJson(left[key]) !== duplicateJson(right[key]));
  const leftMedia = duplicateMediaSignature(a), rightMedia = duplicateMediaSignature(b);
  const mediaExact = Boolean(leftMedia && rightMedia && leftMedia === rightMedia);
  const complete = Boolean(leftMedia && rightMedia) && [...(a.mediaAssets || []), ...(b.mediaAssets || [])].every(asset => Boolean(mediaIdentity(asset)));
  const sameProjects = duplicateJson([...(projects.get(a.id) || [])].sort()) === duplicateJson([...(projects.get(b.id) || [])].sort());
  const exact = mediaExact && complete && differences.length === 0;
  return { exact, mediaExact, complete, sameProjects, differences,
    category: exact ? sameProjects ? 'exact' : 'projects' : 'different' };
}
export async function duplicateRevision(entry, projects = []) {
  const { contentRole: _role, contentTypeName: _name, ...stored } = entry;
  return digest({ entry: stored, projects: [...projects].sort() });
}

// Yield after every case: callers decide scheduling and can pause without restarting.
export async function* scanDuplicateCases(state, { cache = new WeakMap() } = {}) {
  const projects = duplicateProjects(state), profiles = new Map(), buckets = new Map();
  let checked = 0, unknown = 0;
  for (const entry of state.entries || []) {
    let profile = cache.get(entry);
    if (!profile) {
      const assets = duplicateVisualAssets(entry);
      profile = { signature: duplicateMediaSignature(entry),
        unknown: assets.filter(a => !mediaIdentity(a) || a.byteSize === 0).length };
      cache.set(entry, profile);
    }
    profiles.set(entry.id, profile); unknown += profile.unknown;
    if (profile.signature) {
      if (!buckets.has(profile.signature)) buckets.set(profile.signature, []);
      buckets.get(profile.signature).push(entry.id);
    }
    yield { checked: ++checked, total: state.entries.length, unknown };
  }
  const mediaGroups = [...buckets.values()].filter(ids => ids.length > 1)
    .map(ids => ({ id: [...ids].sort().join('\n'), caseIds: ids }));
  return { mediaGroups, duplicateCount: mediaGroups.length, checked, unknown, profiles, projects };
}

export function chooseDuplicateKeeper(entries, rule, projectId, projects = new Map(), previous) {
  if (rule === 'project') {
    const found = entries.filter(e => (projects.get(e.id) || []).includes(projectId));
    return { id: found.length === 1 ? found[0].id : previous || entries[0]?.id, uncertain: found.length !== 1 };
  }
  const field = rule === 'edited' ? 'libraryUpdatedAt' : 'libraryAddedAt';
  const dated = entries.map(e => ({ id: e.id, time: Date.parse(e[field]) }));
  if (dated.some(e => !Number.isFinite(e.time))) return { id: previous || entries[0]?.id, uncertain: true };
  dated.sort((a, b) => rule === 'oldest' ? a.time - b.time : b.time - a.time);
  const tied = dated.filter(e => e.time === dated[0].time);
  return { id: tied.find(e => e.id === previous)?.id || dated[0].id, uncertain: tied.length > 1 };
}

export function duplicateOrigin(entries) {
  if (entries.some(e => e.copyOrigin && entries.some(other => other.id === e.copyOrigin.caseId))) return 'copy';
  const batches = new Set(entries.map(e => e.importBatchId).filter(Boolean));
  if (batches.size > 1) return 'imports';
  if (entries.some(e => e.agentProvenance?.references?.some(r => entries.some(other => other.id === r.caseId)))) return 'reference';
  return 'unknown';
}

// Partition exact-media matches by project unless the user explicitly includes cross-project copies.
// These disjoint groups make bulk selection independent of the visible page and keep/delete conflicts impossible.
export function bulkDuplicateGroups(result, entries, acrossProjects = false) {
  const groups = [];
  for (const mediaGroup of result.mediaGroups) {
    const locations = new Map();
    for (const id of mediaGroup.caseIds) {
      const key = acrossProjects ? '*' : duplicateJson([...(result.projects.get(id) || [])].sort());
      if (!locations.has(key)) locations.set(key, []);
      locations.get(key).push(id);
    }
    for (const ids of locations.values()) if (ids.length > 1) {
      groups.push({ id: [...ids].sort().join('\n'), caseIds: ids });
    }
  }
  return groups;
}
