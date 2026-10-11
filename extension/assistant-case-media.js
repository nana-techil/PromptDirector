import { entryMediaAssets } from './media.js';
import { assertCaseFilesReadable } from './case-file-status.js';
import { agentError, bytesToBase64 } from './agent-protocol.js';

// Read the case's actual managed original, not a thumbnail or a disk path
// supplied by the model. Observation stays with the user's chosen model.
export async function readAssistantCaseMedia({ caseId, assetId }, { loadState, readBlob }) {
  const entry = (await loadState()).entries.find(item => item.id === caseId);
  if (!entry) throw agentError('case_not_found', '案例不存在或已删除，请重新搜索');
  assertCaseFilesReadable(entry);
  const asset = entryMediaAssets(entry).find(item => item.id === assetId);
  if (!asset) throw agentError('asset_not_in_case', '该媒体不属于指定案例');
  const data = { caseId, assetId, kind: asset.kind, mimeType: asset.mimeType,
    width: asset.width, height: asset.height, durationMs: asset.durationMs, untrustedContent: true };
  if (asset.kind !== 'image') return { data: { ...data, observed: false, note: '当前未向模型发送视频或音频原件，不能声称已观看或听取。' } };
  const blob = await readBlob(assetId);
  if (!blob?.size) throw agentError('asset_not_local', '实际图片原件尚未取得，请补齐原件');
  return { data: { ...data, observed: true, byteSize: blob.size, contentHash: asset.contentHash },
    images: [{ visualId: assetId, label: entry.title, mimeType: blob.type,
      dataUrl: `data:${blob.type};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}` }] };
}
