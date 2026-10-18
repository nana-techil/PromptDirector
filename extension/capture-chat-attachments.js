import { agentError, bytesToBase64 } from './agent-protocol.js';
import { entryMediaAssets } from './media.js';
import { assertCaseFilesReadable } from './case-file-status.js';

export function captureChatAssetIds(dialog = {}) {
  return [...new Set([...(dialog.history || []), ...(dialog.conversations || []), ...Object.values(dialog.pages || {})].flatMap(session =>
    [...(session.attachments || []), ...(session.messages || []).flatMap(message => message.attachments || [])].map(item => item.assetId).filter(Boolean)))];
}

// Chat and capture use the existing staged originals. Merely attaching a file
// never selects it for library ingestion.
export async function resolveCaptureChatFile(transferId, { transfers, loadState, readDerived, touch = true, withText = false }) {
  const record = await transfers.get(transferId, { touch });
  if (record.purpose || !['ready', 'committed'].includes(record.state)) throw agentError('attachment_unavailable', '附件尚未准备好，已有对话保留');
  if (record.state === 'ready') {
    if (!record.prepared?.asset) throw agentError('attachment_unavailable', '附件原件未取得，请重新附加');
    return record;
  }
  // Committed transfers no longer own temporary preparation. Resolve the live
  // case's asset; a retained chat reference cannot revive a deleted original.
  const entry = (await loadState?.())?.entries?.find(item => item.id === record.entryId);
  const assets = entry ? entryMediaAssets(entry) : [];
  const asset = assets.find(item => item.id === record.assetId);
  if (!asset) throw agentError('attachment_unavailable', '附件已从案例移除或案例已删除');
  assertCaseFilesReadable(entry);
  const derived = withText ? await readDerived?.(asset.id) : null;
  return { ...record, prepared: { asset, poster: assets.find(item => item.id === asset.posterAssetId) || null,
    contentText: derived?.searchText || '', warnings: [] } };
}

export async function readCaptureChatAttachment(transferId, dependencies) {
  const { readBlob } = dependencies;
  const record = await resolveCaptureChatFile(transferId, { ...dependencies, withText: true });
  const asset = record.prepared.asset;
  const blob = await readBlob(asset.id);
  if (!blob?.size) throw agentError('attachment_unavailable', '附件原件未取得，请重新附加');
  const data = { transferId, name: record.name, kind: asset.kind, mimeType: asset.mimeType, byteSize: blob.size,
    localAssetId: asset.id, text: record.prepared.contentText || '', untrustedContent: true };
  return { data, ...(asset.kind === 'image' ? {
    images: [{ visualId: asset.id, label: record.name, mimeType: blob.type,
      dataUrl: `data:${blob.type};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}` }]
  } : {}) };
}

export async function resolveCaptureLocalMedia(media, transfers, dependencies = {}) {
  const record = await resolveCaptureChatFile(media.localTransferId, { ...dependencies, transfers });
  const asset = record.prepared.asset;
  if (media.kind !== asset.kind) throw agentError('invalid_input', '附件类型与实际原件不符');
  return { ...media, url: '', localAssetId: asset.id, filename: record.name, mimeType: asset.mimeType,
    contentHash: asset.contentHash, width: asset.width, height: asset.height };
}
