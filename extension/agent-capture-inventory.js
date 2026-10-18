// Frozen module identities and durable save receipts, independent of model prose.
export function captureInventories(records) {
  const inventories = new Map();
  for (const record of records) {
    const data = record.data;
    if (record.name !== 'read_capture' || data?.ok === false || data?.part !== 'modules'
      || !data.captureId || !Array.isArray(data.modules) || !Number.isInteger(data.total)) continue;
    const revision = data.revision ?? data.captureRevision;
    const total = data.inventoryTotal ?? data.total;
    let inventory = inventories.get(data.captureId);
    if (!inventory || inventory.revision !== revision || inventory.total !== total) {
      inventory = { captureId: data.captureId, revision, sourceUrl: data.sourceUrl, total, positions: new Map() };
      inventories.set(data.captureId, inventory);
    }
    data.modules.forEach((module, index) => inventory.positions.set(data.moduleIndices?.[index] ?? (data.offset || 0) + index, module));
  }
  return [...inventories.values()].map(({ positions, ...inventory }) => ({ ...inventory,
    complete: Array.from({ length: inventory.total }, (_, index) => positions.has(index)).every(Boolean),
    modules: [...positions.entries()].sort(([a], [b]) => a - b).map(([, module]) => module)
  }));
}

export function captureScopeProgress(records, scope, contentTypeId) {
  const inventory = captureInventories(records).find(item => item.captureId === scope.captureId);
  if (!inventory?.sourceUrl) return { valid: false, reason: '目标目录尚未取得；先读取实际模块目录，不猜测编号。' };
  const modules = scope.selectors.map(selector => inventory.modules.find(module => module.selector === selector));
  if (modules.some(module => !module?.sources?.length)) return { valid: false, reason: '目标须来自该冻结目录且有原文来源；未取得的模块先读取，不用标题代替实际选择器。' };
  const urls = new Map();
  const receipts = [];
  for (const record of records) {
    const data = record.data;
    if (data?.ok !== false && data?.captureId && data?.sourceUrl) urls.set(data.captureId, data.sourceUrl);
    if (record.name !== 'save_capture' || urls.get(data?.captureId || record.args?.captureId) !== inventory.sourceUrl
      || (data?.collectionId ?? record.args?.project ?? '') !== scope.project) continue;
    const mode = data?.saveMode || record.args?.saveMode;
    if (modules.length > 1 && mode && mode !== scope.saveMode) continue;
    // A partial batch can still contain individually verified durable results.
    for (const item of data?.results || []) {
      if (item.entryId && ['saved', 'duplicate'].includes(item.status) && item.originalVerification?.status === 'verified'
        && (!contentTypeId || (item.contentTypeId ?? record.args?.contentTypeId) === contentTypeId)) receipts.push(item);
    }
  }
  const covers = (receipt, module) => module.sources.every(source => receipt.originalVerification.sources?.some(actual =>
    (actual.resolvedSelector || actual.selector) === source.selector && actual.completeness === 'complete'
    && (!Number.isFinite(source.characters) || source.characters === actual.totalCharacters)));
  const combined = scope.saveMode === 'combined' ? receipts.find(receipt => modules.every(module => covers(receipt, module))) : undefined;
  const separate = scope.saveMode !== 'combined' ? receipts.filter(receipt => modules.filter(module => covers(receipt, module)).length === 1) : [];
  const saved = [], pending = [], usedEntries = new Set();
  for (const module of modules) {
    const receipt = scope.saveMode === 'combined' ? combined : separate.find(item => !usedEntries.has(item.entryId) && covers(item, module));
    const identity = { selector: module.selector, title: module.title };
    if (receipt) { saved.push({ ...identity, entryId: receipt.entryId }); usedEntries.add(receipt.entryId); }
    else pending.push(identity);
  }
  return { valid: true, captureId: scope.captureId, sourceUrl: inventory.sourceUrl, project: scope.project,
    total: modules.length, saved, pending, complete: !pending.length };
}
