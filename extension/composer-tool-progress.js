import { markSyncMetaDirty } from './sync-model.js';
import { createAgentContextRuntime } from './agent-runtime-context.js';

// Continuations belong to user work. Keeping them in the canonical session
// makes backup/sync retain the same identity; gallery reads exclude sessions.
export function createComposerToolProgress({ storage, sessionId, userMessageId }) {
  if (!sessionId || !userMessageId) throw new Error('未完成工具任务缺少对话或用户要求编号');
  const update = (transform, versionIds = []) => storage.update(['composerSessions', 'syncMeta'], stored => {
    const sessions = Array.isArray(stored.composerSessions) ? stored.composerSessions : [];
    if (!sessions.some(session => session.id === sessionId)) throw new Error('工作对话尚未持久保存，不能保存工具续接进度');
    return {
      composerSessions: sessions.map(session => session.id === sessionId
        ? { ...session, toolContinuations: transform({ ...(session.toolContinuations || {}) }),
          toolSkillVersionIds: [...new Set([...(session.toolSkillVersionIds || []), ...versionIds])] } : session),
      syncMeta: markSyncMetaDirty(stored.syncMeta)
    };
  });
  return {
    ...createAgentContextRuntime({ turnId: userMessageId,
      load: async () => (await storage.get('composerSessions')).composerSessions?.find(session => session.id === sessionId),
      update: transform => storage.update(['composerSessions', 'syncMeta'], stored => {
        if (!stored.composerSessions?.some(session => session.id === sessionId)) throw new Error('工作对话已不存在，未保存工具事实');
        return { composerSessions: stored.composerSessions.map(session => session.id === sessionId ? transform(session) : session),
          syncMeta: markSyncMetaDirty(stored.syncMeta) };
      }) }),
    retainSkillVersions: versionIds => versionIds.length ? update(values => values, versionIds) : undefined
  };
}

export async function discardComposerToolProgress(storage, sessionId) {
  await storage.update('composerSessions', stored => ({
    composerSessions: (stored.composerSessions || []).map(session => session.id === sessionId ? { ...session, toolContinuations: {} } : session)
  }));
}
