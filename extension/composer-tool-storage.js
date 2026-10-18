// Tool originals are immutable journal records. Canonical session reads, sync
// and exports join them; ordinary tool calls never rewrite chat histories.
export const COMPOSER_STATE_REVISION_KEY = 'composerStateRevision';
export const COMPOSER_TOOLS_KEY = 'composerToolJournal';
const prefix = 'composerToolRecord:';
const fields = ['toolContext', 'toolContinuations', 'toolSkillVersionIds'];
const empty = () => ({ toolContext: [], toolContinuations: {}, toolSkillVersionIds: [] });
export function createComposerToolStorage({ backend, revision, cleanup }) {
  // Keep only the most recently used conversation hot. Other originals stay
  // durable; browsing many chats must not pin all tool histories in memory.
  let cached;
  const ownedKeys = index => Object.values(index?.sessions || {}).flatMap(item => [
    ...Object.values(item.records || {}), ...Object.values(item.continuations || {})
  ]);
  async function load(id, index, retryChangedRead = true) {
    const item = index?.sessions?.[id];
    const version = item?.revision || index?.generation;
    const prior = cached?.id === id ? cached : null;
    if (version && prior?.version === version) return prior.state;
    let state;
    if (!item) {
      const session = (await backend.get('composerSessions')).composerSessions?.find(session => session.id === id);
      if (!session) throw new Error('工作对话已不存在，未保存工具进度');
      state = Object.fromEntries(fields.map(field => [field, session[field] || empty()[field]]));
    } else {
      const values = await backend.get([...Object.values(item.records), ...Object.values(item.continuations)]);
      if ([...Object.values(item.records), ...Object.values(item.continuations)].some(key => !Object.hasOwn(values, key))) {
        const latest = (await backend.get(COMPOSER_TOOLS_KEY))[COMPOSER_TOOLS_KEY];
        if (retryChangedRead && (latest?.sessions?.[id]?.revision || latest?.generation) !== version) return load(id, latest, false);
        throw new Error('工具原文记录读取不到，已停止；请从备份恢复，未重放任何动作');
      }
      state = { toolContext: item.order.map(identity => values[item.records[identity]]),
        toolContinuations: Object.fromEntries(Object.entries(item.continuations).map(([turn, key]) => [turn, values[key]])),
        toolSkillVersionIds: item.toolSkillVersionIds || [] };
    }
    cached = { id, version, state };
    return state;
  }
  return {
    async confirmationVersion() {
      const stored = await backend.get(COMPOSER_STATE_REVISION_KEY);
      if (!stored[COMPOSER_STATE_REVISION_KEY]) await backend.set({ [COMPOSER_STATE_REVISION_KEY]: revision() });
    },
    async get(id) { return structuredClone(await load(id, (await backend.get(COMPOSER_TOOLS_KEY))[COMPOSER_TOOLS_KEY])); },
    async update(id, transform, markDirty) {
      const stored = await backend.get([COMPOSER_TOOLS_KEY, 'composerSessionSummaries', 'syncMeta']);
      const exists = stored.composerSessionSummaries ? stored.composerSessionSummaries.some(session => session.id === id)
        : (await backend.get('composerSessions')).composerSessions?.some(session => session.id === id);
      if (!exists) throw new Error('工作对话已不存在，未保存工具进度');
      const index = stored[COMPOSER_TOOLS_KEY] || { generation: revision(), sessions: {} };
      const before = await load(id, index), next = transform(before), prior = index.sessions[id];
      const writes = {}, records = {}, continuations = {}, obsolete = [];
      const originalRecords = new Map(before.toolContext.map((record, index) => [JSON.stringify([record.turnId, record.callId, index]), record]));
      for (const [index, record] of (next.toolContext || []).entries()) {
        const identity = JSON.stringify([record.turnId, record.callId, index]);
        const key = record === originalRecords.get(identity) && prior?.records[identity] || prefix + revision();
        records[identity] = key;
        if (key !== prior?.records[identity]) writes[key] = record;
      }
      for (const [turn, value] of Object.entries(next.toolContinuations || {})) {
        const key = value === before.toolContinuations?.[turn] && prior?.continuations[turn] || prefix + revision();
        continuations[turn] = key;
        if (key !== prior?.continuations[turn]) writes[key] = value;
      }
      const kept = new Set([...Object.values(records), ...Object.values(continuations)]);
      for (const key of [...Object.values(prior?.records || {}), ...Object.values(prior?.continuations || {})]) if (!kept.has(key)) obsolete.push(key);
      const item = { revision: revision(), order: Object.keys(records), records, continuations, toolSkillVersionIds: next.toolSkillVersionIds || [] };
      await backend.set({ ...writes, [COMPOSER_TOOLS_KEY]: { ...index, sessions: { ...index.sessions, [id]: item } },
        syncMeta: markDirty(stored.syncMeta), [COMPOSER_STATE_REVISION_KEY]: item.revision });
      cached = { id, version: item.revision, state: next };
      await cleanup(obsolete);
    },
    async join(stored) {
      if (!Array.isArray(stored.composerSessions)) return stored;
      const index = stored[COMPOSER_TOOLS_KEY] || (await backend.get(COMPOSER_TOOLS_KEY))[COMPOSER_TOOLS_KEY];
      if (index?.sessions) stored.composerSessions = await Promise.all(stored.composerSessions.map(async session =>
        index.sessions[session.id] ? { ...session, ...structuredClone(await load(session.id, index)) } : session));
      return stored;
    },
    async replacement() {
      const index = (await backend.get(COMPOSER_TOOLS_KEY))[COMPOSER_TOOLS_KEY];
      return { update: { [COMPOSER_TOOLS_KEY]: { generation: revision(), sessions: {} } }, obsolete: ownedKeys(index) };
    },
    strip(stored) {
      delete stored[COMPOSER_TOOLS_KEY]; delete stored[COMPOSER_STATE_REVISION_KEY];
      for (const key of Object.keys(stored)) if (key.startsWith(prefix)) delete stored[key];
      return stored;
    }
  };
}
