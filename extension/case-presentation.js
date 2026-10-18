import { assetFormatForExtension, assetFormatForFile } from "./asset-formats.js";
import { CONTENT_ROLES, contentRoleForEntry } from "./taxonomy.js";
import { entryMediaAssets, primaryMediaAsset } from "./media.js";

export function defaultPreviewMediaAsset(entry = {}) {
  const primary = primaryMediaAsset(entry);
  if ([CONTENT_ROLES.promptVideo, CONTENT_ROLES.videoCase].includes(contentRoleForEntry(entry))) {
    return (primary?.kind === 'video' ? primary : entryMediaAssets(entry).find(asset => asset.kind === 'video' && asset.usage !== 'poster')) || primary;
  }
  return primary;
}

function usesCreativeCase(entry) {
  return [CONTENT_ROLES.promptImage, CONTENT_ROLES.promptVideo, CONTENT_ROLES.imageCase, CONTENT_ROLES.videoCase]
    .includes(contentRoleForEntry(entry));
}

export function usesArticleReader(entry = {}) {
  if (entry.articleDocument?.blocks?.some(block => block.kind === "table" && block.rows?.length)) return true;
  if (usesCreativeCase(entry)) return false;
  const role = contentRoleForEntry(entry);
  if ([CONTENT_ROLES.tutorial, CONTENT_ROLES.reference].includes(role)) return true;
  return Boolean(entry.articleDocument?.blocks?.length) && !["video", "artwork"].includes(entry.sourceFacts?.pageType);
}

export function usesPostReader(entry = {}) {
  return entry.sourceFacts?.pageType === "post" && !usesCreativeCase(entry) && !usesArticleReader(entry);
}

export function mediaFormatLabel(asset = {}) {
  const format = assetFormatForExtension(asset.sourceFormat)
    || assetFormatForFile({ name: asset.sourceTitle, type: asset.mimeType });
  return (format?.extensions?.[0] || "FILE").toUpperCase();
}
