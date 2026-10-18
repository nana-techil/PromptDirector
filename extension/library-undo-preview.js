import { COMPOSER_STATE_REVISION_KEY } from './composer-tool-storage.js';
import { sameUndoState } from './undo-state.js';

// Only case identities/titles leave the worker; originals and case bodies stay local.
export function replacementImpact(current, target) {
  const currentById = new Map(current.entries.map(entry => [entry.id, entry]));
  const targetById = new Map(target.entries.map(entry => [entry.id, entry]));
  const identify = entry => ({ id: entry.id, title: entry.title || entry.id });
  const sessions = current.composerSessions || [], previousSessions = target.composerSessions || [];
  const currentChats = new Map(sessions.map(session => [session.id, session]));
  const targetChats = new Map(previousSessions.map(session => [session.id, session]));
  const conversations = {
    removed: sessions.filter(session => !targetChats.has(session.id)).map(identify),
    changed: sessions.filter(session => targetChats.has(session.id) && !sameUndoState(session, targetChats.get(session.id))).map(identify),
    restored: previousSessions.filter(session => !currentChats.has(session.id)).map(identify)
  };
  return {
    ...(current.composerSessions || target.composerSessions ? { conversations, drafts: {
      currentCount: sessions.filter(session => session.currentInstruction?.trim()).length,
      targetCount: previousSessions.filter(session => session.currentInstruction?.trim()).length
    } } : {}),
    currentCount: current.entries.length,
    targetCount: target.entries.length,
    removed: current.entries.filter(entry => !targetById.has(entry.id)).map(identify),
    changed: current.entries.filter(entry => targetById.has(entry.id) && !sameUndoState(entry, targetById.get(entry.id))).map(identify),
    restored: target.entries.filter(entry => !currentById.has(entry.id)).map(identify)
  };
}

// One pending confirmation per action. A worker restart or a newer preview requires a fresh
// confirmation. The write checks the same small metadata inside the storage write lock.
export function createUndoConfirmations(storage) {
  const pending = new Map();
  const signature = (stored, keys) => JSON.stringify(keys.map(key =>
    key === 'libraryReplacementRecoveryPoint' ? stored[key]?.id : stored[key]));
  const changed = () => new Error('确认期间资料已变化，请重新查看影响范围；尚未撤销任何内容');
  return {
    async prepare(action, keys, build, retryChangedRead = true) {
      if (keys.includes('composerSessions') && storage.prepareComposerConfirmation) {
        await storage.prepareComposerConfirmation();
        keys = keys.map(key => key === 'composerSessions' ? COMPOSER_STATE_REVISION_KEY : key);
      }
      const before = signature(await storage.get(keys), keys);
      const preview = await build();
      const after = signature(await storage.get(keys), keys);
      if (before !== after) {
        // readState may complete a migration. Re-read the preview once, before displaying any
        // scope to the user; a confirmed operation is never retried against newer content.
        if (retryChangedRead) return this.prepare(action, keys, build, false);
        throw changed();
      }
      const confirmationToken = crypto.randomUUID();
      pending.set(action, { confirmationToken, keys, signature: after, jobId: preview.jobId });
      return { ...preview, confirmationToken };
    },
    guard(action, token, jobId) {
      const plan = pending.get(action);
      if (!token || plan?.confirmationToken !== token || plan.jobId !== jobId) throw new Error('请先查看撤销影响并确认；尚未撤销任何内容');
      return { keys: plan.keys, check(stored) {
        if (pending.get(action) !== plan || signature(stored, plan.keys) !== plan.signature) throw changed();
      } };
    }
  };
}
