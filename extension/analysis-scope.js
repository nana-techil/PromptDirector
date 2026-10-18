import { collectionSubtreeEntryIdsById } from "./organizer.js";

export function normalizeAnalysisScope(scope) {
  if (!scope || typeof scope !== "object") return null;
  const ids = value => Array.isArray(value) ? [...new Set(value.map(String))] : [];
  return {
    collectionId: String(scope.collectionId ?? ""),
    includeSubprojects: scope.includeSubprojects === true,
    ...(Array.isArray(scope.entryIds) ? { entryIds: ids(scope.entryIds) } : {}),
    excludedCollectionIds: ids(scope.excludedCollectionIds),
    contentTypeIds: Array.isArray(scope.contentTypeIds) ? ids(scope.contentTypeIds) : null
  };
}

// Scope and completion are independent: a project selection must never imply a paid reanalysis.
export function selectAnalysisScope(entries = [], organizerState = {}, scope) {
  if (!scope) return entries;
  const collections = organizerState.collections ?? [];
  const byId = new Map(collections.map(item => [item.id, item]));
  const subtree = scope.includeSubprojects || scope.excludedCollectionIds?.length
    ? collectionSubtreeEntryIdsById(organizerState) : null;
  if (scope.collectionId && !byId.has(scope.collectionId)) throw new Error("所选项目已不存在，请重新选择分析范围");
  const members = scope.collectionId ? new Set(scope.includeSubprojects
    ? subtree.get(scope.collectionId) : byId.get(scope.collectionId).entryIds) : null;
  const selected = Array.isArray(scope.entryIds) ? new Set(scope.entryIds) : null;
  const excluded = new Set((scope.excludedCollectionIds ?? []).flatMap(id => subtree.get(id) ?? []));
  const types = Array.isArray(scope.contentTypeIds) ? new Set(scope.contentTypeIds) : null;
  return entries.filter(entry => (!selected || selected.has(entry.id)) && (!members || members.has(entry.id))
    && !excluded.has(entry.id) && (!types || (entry.classification?.pathIds ?? []).some(id => types.has(id))));
}

export function sameAnalysisTargets(expected, actual) {
  if (!Array.isArray(expected)) return true;
  const key = item => JSON.stringify([item.entryId, item.assetId || item.visualId || "", item.textRevision ?? "", item.fingerprint ?? ""]);
  const keys = new Set(expected.map(key));
  return keys.size === actual.length && actual.every(item => keys.has(key(item)));
}
