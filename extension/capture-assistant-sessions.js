// Unfinished page work is kept independently from the visible conversation.
export function restoreCaptureSessions(value = {}) {
  const pages = value.pages || {};
  const sourceUrl = value.sourceUrl || value.pendingBatch?.sourceUrl;
  if (!value.pages && sourceUrl) {
    pages[sourceUrl] = { ...value, sourceUrl };
    const batch = value.pendingBatch;
    if (batch?.sourceUrl && batch.sourceUrl !== sourceUrl) {
      pages[sourceUrl] = { ...pages[sourceUrl], pendingBatch: null, captureId: '', pendingRevision: null };
      pages[batch.sourceUrl] = { id: crypto.randomUUID(), sourceUrl: batch.sourceUrl, tabId: batch.tabId,
        messages: [], requestId: '', captureId: '', pendingBatch: batch };
    }
  }
  return { pages, history: value.history || [], activeUrl: value.activeUrl || value.sourceUrl || '' };
}

export function captureSessionForPage(store, tab) {
  store.activeUrl = tab.url;
  const session = store.pages[tab.url] || { id: crypto.randomUUID(), messages: [], requestId: '', captureId: '', draft: '' };
  session.id ||= crypto.randomUUID();
  session.sourceUrl = tab.url;
  session.pageTitle = tab.title || '';
  // A running task stays pinned to the tab where it started.
  if (!session.requestId) {
    if (session.tabId !== undefined && session.tabId !== tab.id) { session.captureId = ''; session.pendingRevision = null; }
    session.tabId = tab.id;
  }
  store.pages[tab.url] = session;
  return session;
}

export function newCaptureConversation(store, current) {
  if (current.messages.length || current.turns?.length) store.history.push({ ...current, pendingBatch: null, captureId: '', pendingRevision: null });
  const session = { id: crypto.randomUUID(), messages: [], requestId: '', captureId: current.captureId || '',
    projectDraft: current.projectDraft, sourceUrl: current.sourceUrl, pageTitle: current.pageTitle, tabId: current.tabId, draft: '', pendingBatch: current.pendingBatch || null };
  store.pages[current.sourceUrl] = session;
  return session;
}
