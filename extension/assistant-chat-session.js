import { createComposerSession } from './composer.js';

// Sidebar and studio share canonical messages and tool progress. Only sidebar
// view/task metadata is additional; page previews remain in the capture store.
export function assistantChatSession(chat, previous) {
  const { messages = [], pendingBatch, aiProfile, draft, id, chatRevision, ...view } = chat;
  return createComposerSession({ ...previous, id, aiProfile: aiProfile || previous?.aiProfile,
    chatRevision: chatRevision ?? previous?.chatRevision ?? 0, routeMode: 'chat',
    title: previous?.title && previous.title !== '新对话' ? previous.title : messages.find(message => message.role === 'user')?.content || draft || '新对话',
    currentInstruction: draft || '', assistantState: view,
    referenceSnapshots: [ ...(previous?.referenceSnapshots || []),
      ...[...(chat.attachments || []), ...messages.flatMap(message => message.attachments || [])]
        .filter((asset, index, list) => asset.assetId && list.findIndex(item => item.assetId === asset.assetId) === index
          && !previous?.referenceSnapshots?.some(reference => reference.assetRefs?.some(item => item.assetId === asset.assetId)))
        .map(asset => ({entryId:asset.transferId,referenceId:asset.transferId,alias:asset.name,title:asset.name,
          sourceType:'temporary',referenceKind:asset.kind === 'image' ? 'reference' : 'prompt',
          assetRefs:[{assetId:asset.assetId,kind:asset.kind,mimeType:asset.mimeType,name:asset.name,byteSize:asset.byteSize || 0}],
          imageRefs:asset.kind === 'image' ? [{visualId:asset.assetId,mimeType:asset.mimeType}] : []})) ],
    messages: messages.map(message => message.role === 'result'
      ? { ...previous?.messages?.find(item => item.id === message.id), ...message, role: 'assistant', type: 'status', content: captureReceiptText(message.result), captureReceipt: message.result }
      : { ...previous?.messages?.find(item => item.id === message.id), ...message, type: message.role === 'assistant' ? 'chat' : 'request' }),
    updatedAt: new Date().toISOString() });
}
export function assistantChatView(session) {
  return { ...session.assistantState, id: session.id, aiProfile: session.aiProfile,
    chatRevision: session.chatRevision, draft: session.currentInstruction, title: session.title, updatedAt: session.updatedAt,
    messages: session.messages.map(message => message.captureReceipt
      ? { ...message, role: 'result', result: message.captureReceipt }
      : message), requestId: session.assistantState?.requestId || '', captureId: session.assistantState?.captureId || '' };
}

export function assistantChatContent(session) {
  return JSON.stringify([session.messages,session.currentInstruction,session.title,session.aiProfile,
    session.referenceSnapshots,session.promptVersions,session.appliedSkills]);
}

export function captureReceiptText(result) {
  const receipts = result?.results || [];
  if (receipts.length && receipts.every(item => item.status === 'saved' && item.entryId)) return '已保存。';
  if (receipts.length && receipts.every(item => item.status === 'duplicate' && item.entryId)) return '已有案例，未新增采集内容。';
  if (receipts.some(item => item.entryId)) return '已部分保存，请查看缺失原因。';
  return '未保存，已有内容保留';
}
