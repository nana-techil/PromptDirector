// Display projection is dependency-free so storage readers do not load the agent runtime.
export function assistantChatView(session, { includeDiagnostics = false } = {}) {
  const { turns, ...state } = session.assistantState || {};
  return { ...state, ...(includeDiagnostics && turns ? { turns } : {}), id: session.id, aiProfile: session.aiProfile,
    chatRevision: session.chatRevision, draft: session.currentInstruction, title: session.title, updatedAt: session.updatedAt,
    messages: (session.messages || []).map(message => message.captureReceipt
      ? { ...message, role: 'result', result: message.captureReceipt }
      : message), requestId: session.assistantState?.requestId || '', captureId: session.assistantState?.captureId || '' };
}

// Derived UI data; full conversation and tool facts remain canonical.
export function assistantChatViews(sessions) {
  return { version: 1, chats: (Array.isArray(sessions) ? sessions : []).map(session => assistantChatView(session)) };
}
