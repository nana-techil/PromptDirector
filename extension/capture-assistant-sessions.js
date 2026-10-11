// Conversations belong to the user; page work belongs to its source.
// The sidebar shows recent conversations; history is never automatically deleted.
const fresh = () => ({ id: crypto.randomUUID(), updatedAt: new Date().toISOString(), messages: [], requestId: '', captureId: '', draft: '' });
export function restoreCaptureSessions(value = {}) {
  const pages = value.pages || {};
  const sourceUrl = value.sourceUrl || value.pendingBatch?.sourceUrl;
  if (!value.pages && sourceUrl) {
    pages[sourceUrl] = { ...value, sourceUrl };
    if (value.pendingBatch?.sourceUrl && value.pendingBatch.sourceUrl !== sourceUrl) {
      pages[value.pendingBatch.sourceUrl] = pageWork({ sourceUrl: value.pendingBatch.sourceUrl, tabId: value.pendingBatch.tabId, pendingBatch: value.pendingBatch });
      pages[sourceUrl].pendingBatch = null; pages[sourceUrl].captureId = ''; pages[sourceUrl].pendingRevision = null;
    }
  }
  const history = value.history || [];
  let conversations = value.conversations;
  if (!conversations) {
    const previous = Object.values(pages);
    const active = previous.find(session => session.requestId) || pages[value.activeUrl || sourceUrl] || previous.at(-1);
    conversations = [active || (value.messages ? value : fresh())];
    // Previous page-bound chats stay available in exported diagnostics.
    history.push(...previous.filter(session => session !== active));
    for (const [url, session] of Object.entries(pages)) pages[url] = pageWork(session);
  }
  conversations = conversations.length ? conversations : [fresh()];
  for (const session of conversations) { session.id ||= crypto.randomUUID(); session.messages ||= []; }
  return { pages, history, conversations, activeId: value.activeId || conversations[0].id, activeUrl: value.activeUrl || sourceUrl || '' };
}
export function pageWork(session) {
  return { sourceUrl: session.sourceUrl, tabId: session.tabId, pendingBatch: session.pendingBatch || null,
    captureId: session.captureId || '', pendingRevision: session.pendingRevision || null, projectDraft: session.projectDraft };
}
export function captureSessionForPage(store, tab = {}) {
  store.activeUrl = tab.url || '';
  const session = store.conversations.find(item => item.id === store.activeId) || store.conversations[0];
  store.activeId = session.id;
  // A running task remains pinned; browsing changes only the displayed context.
  if (!session.requestId) {
    if (session.sourceUrl !== (tab.url || '') || session.tabId !== tab.id) {
      if (session.sourceUrl) store.pages[session.sourceUrl] = pageWork(session);
      const pending = store.pages[tab.url] || {};
      Object.assign(session, { captureId: pending.captureId || '', pendingRevision: pending.pendingRevision || null,
        pendingBatch: pending.pendingBatch || null, projectDraft: pending.projectDraft || session.projectDraft });
    }
    session.sourceUrl = tab.url || ''; session.pageTitle = tab.title || ''; session.tabId = tab.id;
  }
  return session;
}
export function newCaptureConversation(store, current) {
  if (current.sourceUrl) store.pages[current.sourceUrl] = pageWork(current);
  const session = { ...fresh(), userCreated: true, aiProfile: current.aiProfile, projectDraft: current.projectDraft,
    sourceUrl: current.sourceUrl, pageTitle: current.pageTitle, tabId: current.tabId,
    pendingBatch: current.pendingBatch || null, captureId: current.captureId || '', pendingRevision: current.pendingRevision || null };
  store.conversations.push(session);
  store.activeId = session.id;
  return session;
}
export function recentCaptureConversations(store) {
  const recent = [...store.conversations].sort((a,b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0,5);
  const active = store.conversations.find(session => session.id === store.activeId);
  if (active && !recent.includes(active)) recent.splice(4,1,active);
  return recent;
}
