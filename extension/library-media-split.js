import { entryMediaAssets, posterAssetForVideo } from './media.js';
import { detailPromptSources } from './prompt-sources.js';
import { showAppDialog } from './ui-dialogs.js';
import { t } from './i18n.js';

// Keep the first media and all shared text in the original case. The shared
// organize operation moves the other media, their notes and originals atomically.
export function splitContentAssets(entry) {
  const frames = new Set((entry.timeNotes || []).map(note => note.frameAssetId).filter(Boolean));
  return entryMediaAssets(entry).filter(asset => asset.usage !== 'poster' && !frames.has(asset.id));
}
export function mediaSplitGroups(entry) {
  return splitContentAssets(entry).slice(1).map((asset, index) => ({
    assetIds: [asset.id], title: asset.sourceTitle || `${entry.title}-${index + 2}`,
    text: detailPromptSources(entry, asset).original || '',
    sourceUrl: asset.originalWorkUrl || entry.url || '',
    ...(!asset.originalWorkUrl || asset.originalWorkUrl === entry.url ? { sourceFacts: entry.sourceFacts || {} } : {}),
    customLabels: [...(entry.customLabels || [])]
  }));
}

export async function splitMediaDialog(caseId, { invoke, thumbnailUrl }) {
  const parts = ['overview', 'source', 'media', 'document', 'annotations'];
  const first = await invoke('read_case_details', { caseId, parts, length: 49152 });
  let text = first.content, offset = first.nextOffset;
  while (offset !== null) {
    const page = await invoke('read_case_details', { caseId, parts, expectedRevision: first.revision, offset, length: 49152 });
    text += page.content; offset = page.nextOffset;
  }
  const data = JSON.parse(text);
  const entry = { ...data.overview, ...data.source, ...data.document, ...data.annotations, mediaAssets: data.media };
  const assets = splitContentAssets(entry);
  if (assets.length < 2) throw new Error(t('至少需要两项媒体才能拆分'));
  const groups = mediaSplitGroups(entry), inputs = [], requestId = crypto.randomUUID();
  return showAppDialog({
    title: '拆分案例', description: '首项留在原案例，公共正文保留；其余媒体各成一个案例。',
    dialogClass: 'media-split-dialog', confirmLabel: t('拆分为 {count} 个案例', { count: assets.length }),
    renderBody: ({ body }) => {
      const grid = document.createElement('div'); grid.className = 'media-split-grid'; body.append(grid);
      for (const [index, asset] of assets.entries()) {
        const card = document.createElement('label'); card.className = 'media-split-card';
        const caption = document.createElement('span'); caption.textContent = index === 0 ? t('保留原案例') : t('新案例');
        const title = document.createElement('input'); title.value = index === 0 ? entry.title : groups[index - 1].title;
        title.disabled = index === 0; title.required = true; title.setAttribute('aria-label', t('案例标题'));
        if (index) inputs.push(title);
        card.append(caption, title); grid.append(card);
        const visual = asset.kind === 'image' ? asset : posterAssetForVideo(entry, asset);
        if (visual) void thumbnailUrl(visual.id).then(url => {
          if (!url || !card.isConnected) return;
          const image = document.createElement('img'); image.src = url; image.alt = ''; card.prepend(image);
        }).catch(() => {});
      }
    },
    onSubmit: () => invoke('organize_case', { requestId, caseId, expectedRevision: first.revision,
      action: 'split_media', groups: groups.map((group, index) => ({ ...group, title: inputs[index].value.trim() })) })
  });
}
