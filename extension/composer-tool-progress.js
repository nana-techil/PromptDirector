import { markSyncMetaDirty } from './sync-model.js';
import { createAgentContextRuntime } from './agent-runtime-context.js';

// Continuations belong to user work. Canonical session reads join the journal
// for backup/sync with the same identity; gallery reads exclude tool originals.
export function createComposerToolProgress({ storage, sessionId, userMessageId }) {
  if (!sessionId || !userMessageId) throw new Error('未完成工具任务缺少对话或用户要求编号');
  const updateState = transform => storage.updateComposerToolState
    ? storage.updateComposerToolState(sessionId, transform, markSyncMetaDirty)
    : storage.update(['composerSessions', 'syncMeta'], stored => {
      if (!stored.composerSessions?.some(session => session.id === sessionId)) throw new Error('工作对话已不存在，未保存工具事实');
      return { composerSessions: stored.composerSessions.map(session => session.id === sessionId ? { ...session, ...transform(session) } : session),
        syncMeta: markSyncMetaDirty(stored.syncMeta) };
    });
  return {
    ...createAgentContextRuntime({ turnId: userMessageId,
      load: async () => storage.getComposerToolState ? storage.getComposerToolState(sessionId)
        : (await storage.get('composerSessions')).composerSessions?.find(session => session.id === sessionId),
      update: updateState }),
    retainSkillVersions: versionIds => versionIds.length ? updateState(state => ({ ...state, toolSkillVersionIds: [...new Set([...(state.toolSkillVersionIds || []), ...versionIds])] })) : undefined
  };
}

export async function discardComposerToolProgress(storage, sessionId) {
  if (storage.updateComposerToolState) return storage.updateComposerToolState(sessionId, state => ({ ...state, toolContinuations: {} }), markSyncMetaDirty);
  await storage.update('composerSessions', stored => ({
    composerSessions: (stored.composerSessions || []).map(session => session.id === sessionId ? { ...session, toolContinuations: {} } : session)
  }));
}
