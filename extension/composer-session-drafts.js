// Draft edits are durable small patches. Canonical readers and exports join
// them; the next conversation write folds them back into composerSessions.
export const COMPOSER_DRAFTS_KEY = 'composerSessionDrafts';

export function withComposerDrafts(sessions, drafts) {
  return (Array.isArray(sessions) ? sessions : []).map(session => {
    const draft = drafts?.[session.id];
    return draft && draft.chatRevision > (session.chatRevision || 0) ? { ...session, ...draft } : session;
  });
}

export function withAssistantChatDrafts(view, drafts) {
  if (!view?.chats) return view;
  return { ...view, chats: view.chats.map(chat => {
    const patch = drafts?.[chat.id];
    if (!patch || patch.chatRevision <= (chat.chatRevision || 0)) return chat;
    const { currentInstruction: draft, ...state } = patch;
    return { ...chat, ...state, draft };
  }) };
}

export function assistantDraftUpdate(stored, { id, draft, chatRevision }, updatedAt) {
  const previous = stored.assistantChatViews?.chats?.find(chat => chat.id === id);
  if (!previous) return { response: { ok: false, code: 'chat_deleted', message: '对话已删除，请新建对话继续' } };
  if (previous.chatRevision !== chatRevision) return { response: { ok: false, code: 'chat_conflict', message: '对话已在其他页面更新，请重新读取后继续' } };
  if (typeof draft !== 'string') return { response: { ok: false, message: '无法保存创作草稿' } };
  if (draft === previous.draft) return { response: { ok: true, session: { id, chatRevision, updatedAt: previous.updatedAt, title: previous.title } } };
  const patch = { currentInstruction: draft, chatRevision: (chatRevision || 0) + 1, updatedAt };
  const session = { id, chatRevision: patch.chatRevision, updatedAt, title: previous.title };
  return { response: { ok: true, session }, update: {
    [COMPOSER_DRAFTS_KEY]: { ...stored[COMPOSER_DRAFTS_KEY], [id]: patch },
    composerSessionSummaries: (stored.composerSessionSummaries || []).map(item => item.id === id ? { ...item, updatedAt } : item)
  } };
}
