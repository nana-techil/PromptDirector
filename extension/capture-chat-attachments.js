import { agentError, bytesToBase64 } from './agent-protocol.js';

export function captureChatAssetIds(dialog = {}) {
  return [...new Set([...(dialog.history || []), ...(dialog.conversations || []), ...Object.values(dialog.pages || {})].flatMap(session =>
    [...(session.attachments || []), ...(session.messages || []).flatMap(message => message.attachments || [])].map(item => item.assetId).filter(Boolean)))];
}

// Chat and capture use the existing staged originals. Merely attaching a file
// never selects it for library ingestion.
export async function readCaptureChatAttachment(transferId, { transfers, readBlob }) {
  const record = await transfers.get(transferId);
  const asset = record.prepared?.asset;
  if (!asset || record.purpose || !['ready', 'committed'].includes(record.state)) throw agentError('attachment_unavailable', '附件尚未准备好，已有对话保留');
  const blob = await readBlob(asset.id);
  if (!blob?.size) throw agentError('attachment_unavailable', '附件原件未取得，请重新附加');
  const data = { transferId, name: record.name, kind: asset.kind, mimeType: asset.mimeType, byteSize: blob.size,
    localAssetId: asset.id, text: record.prepared.contentText || '', untrustedContent: true };
  return { data, ...(asset.kind === 'image' ? {
    images: [{ visualId: asset.id, label: record.name, mimeType: blob.type,
      dataUrl: `data:${blob.type};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}` }]
  } : {}) };
}

export async function resolveCaptureLocalMedia(media, transfers) {
  const record = await transfers.get(media.localTransferId);
  const asset = record.prepared?.asset;
  if (!asset || record.purpose || !['ready', 'committed'].includes(record.state)) throw agentError('attachment_unavailable', '本机原件未准备好');
  if (media.kind !== asset.kind) throw agentError('invalid_input', '附件类型与实际原件不符');
  return { ...media, url: '', localAssetId: asset.id, filename: record.name, mimeType: asset.mimeType,
    contentHash: asset.contentHash, width: asset.width, height: asset.height };
}
