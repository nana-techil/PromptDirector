import { compareDuplicateCases, duplicateProjects, duplicateRevision, duplicateJson } from './library-duplicates.js';
import { moveEntriesToTrash, normalizeTrashState } from './trash.js';
import { caseOperationFingerprint } from './case-operations.js';

export function duplicateReferenceBlockers(state, requestedIds) {
  const requested = new Set(requestedIds), blocked = new Set();
  const walk = (value, key = '') => {
    if (Array.isArray(value)) { value.forEach(v => walk(v, key)); return; }
    if (value && typeof value === 'object') { Object.entries(value).forEach(([k, v]) => walk(v, k)); return; }
    if (typeof value !== 'string' || !/(case|entry|reference|member|source).*ids?$/i.test(key)) return;
    if (requested.has(value)) blocked.add(value);
    if (key === 'referenceId') for (const id of requested) if (value.startsWith(`${id}:`)) blocked.add(id);
  };
  for (const c of state.compoundCases || []) for (const id of c.memberEntryIds || []) if (requested.has(id)) blocked.add(id);
  for (const key of ['composerSessions', 'creativeRuns', 'creativeJobs', 'creativeSkills', 'activeCreativeResult']) walk(state[key]);
  for (const entry of state.entries || []) {
    // The entry's own identity is not an inbound reference; provenance may refer to another case.
    walk(entry.agentProvenance); walk(entry.sourceCorrections);
  }
  return blocked;
}

export async function planDuplicateCleanup(state, groups) {
  if (!Array.isArray(groups) || !groups.length) throw new Error('请先勾选要清理的案例');
  if (groups.some(g => !g || typeof g.keepId !== 'string' || !g.keepRevision || !Array.isArray(g.remove) || g.remove.some(r => !r?.id || !r.revision))) throw new Error('请先勾选要清理的案例');
  const byId = new Map(state.entries.map(e => [e.id, e])), projects = duplicateProjects(state);
  const keepIds = new Set(groups.map(g => g.keepId)), removeIds = new Set(groups.flatMap(g => (g.remove || []).map(r => r.id)));
  if ([...removeIds].some(id => keepIds.has(id))) throw new Error('同一案例不能同时保留和清理');
  const blocked = duplicateReferenceBlockers(state, removeIds), trash = normalizeTrashState(state.trashState);
  const accepted = [], skipped = [], revisions = new Map();
  const revision = async entry => {
    if (!revisions.has(entry.id)) revisions.set(entry.id, await duplicateRevision(entry, projects.get(entry.id)));
    return revisions.get(entry.id);
  };
  for (const group of groups) {
    const keep = byId.get(group.keepId);
    for (const row of group.remove || []) {
      const entry = byId.get(row.id);
      let reason = '';
      if (!keep || !entry) reason = '案例已不存在，请刷新排重结果';
      else if (await revision(keep) !== group.keepRevision || await revision(entry) !== row.revision) reason = '案例或项目归属已变化，请重新比较';
      else if (blocked.has(row.id)) reason = '案例正被组合或创作资料引用，请先处理引用关系';
      else if (trash.items.some(item => item.kind === 'entry' && item.targetId === row.id)) reason = '回收站已有同编号案例，请先核对';
      else {
        const compared = compareDuplicateCases(keep, entry, projects);
        if (!compared.mediaExact) reason = '图片或视频原件不完全相同，不能作为重复案例清理';
        else if (!compared.exact && group.allowDifferent !== true) reason = '案例有差异或原件尚未核对，未自动清理';
        if (!compared.sameProjects && group.allowCrossProject !== true) reason = '跨项目副本需要明确选择';
      }
      if (reason) skipped.push({ id: row.id, title: entry?.title || row.id, reason });
      else if (!accepted.includes(row.id)) accepted.push(row.id);
    }
  }
  return { accepted, skipped };
}

export function createCaseDedupeOperations({ loadState, storage, commit, enqueue }) {
  return {
    preview: groups => enqueue(async () => planDuplicateCleanup(await loadState(), groups)),
    execute: input => enqueue(async () => {
      if (!input || typeof input.requestId !== 'string' || !input.requestId.trim()) throw new Error('缺少清理请求编号');
      const key = `caseOperation:${input.requestId}`, fingerprint = await caseOperationFingerprint({ operation: 'dedupe', input });
      const previous = (await storage.get(key))[key];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('此请求编号已用于其他操作');
        return { ...previous.result, replayed: true };
      }
      const state = await loadState(), planned = await planDuplicateCleanup(state, input.groups);
      const moved = moveEntriesToTrash(state, planned.accepted);
      const visionAnalysisUndo = { ...(await storage.get('visionAnalysisUndo')).visionAnalysisUndo };
      planned.accepted.forEach(id => delete visionAnalysisUndo[id]);
      const result = { ok: true, movedEntryIds: planned.accepted, movedItemIds: moved.movedItemIds, skipped: planned.skipped };
      await commit({ entries: moved.entries, organizerState: moved.organizerState, compoundCases: moved.compoundCases,
        trashState: moved.trashState, visionAnalysisUndo, [key]: { fingerprint, result } });
      return result;
    })
  };
}

// Fingerprints describe immutable managed originals. Never reuse them for a linked file that can change outside the library.
export function sameDuplicateAsset(left, right) { return duplicateJson(left) === duplicateJson(right); }
