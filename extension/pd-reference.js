// Stable, non-secret identity. This URI is resolved through the paired MCP,
// never fetched as a webpage and never interpreted as permission to mutate data.
export function pdReference({ libraryId, caseId, assetId = "" }) {
  if (!libraryId || !caseId) throw new Error("PD引用缺少资料库或案例身份");
  const url = new URL("promptdirector://reference");
  url.searchParams.set("v", "1");
  url.searchParams.set("library", libraryId);
  url.searchParams.set("case", caseId);
  if (assetId) url.searchParams.set("asset", assetId);
  return url.href;
}

export function parsePdReference(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("不是有效的PD引用"); }
  if (['http:', 'https:'].includes(url.protocol)) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (url.username || url.password || fragment.size !== 1 || !fragment.has('pd-reference')) throw new Error("PD名称链接格式无效");
    try { url = new URL(fragment.get('pd-reference')); } catch { throw new Error("PD名称链接缺少有效引用"); }
  }
  const keys = [...url.searchParams.keys()];
  if (url.protocol !== "promptdirector:" || url.hostname !== "reference" || url.pathname || url.hash || url.username || url.password || url.port ||
    url.searchParams.get("v") !== "1" || !url.searchParams.get("library") || !url.searchParams.get("case") ||
    keys.some(key => !["v", "library", "case", "asset"].includes(key)) || new Set(keys).size !== keys.length) throw new Error("PD引用格式或版本无效");
  return { libraryId: url.searchParams.get("library"), caseId: url.searchParams.get("case"), assetId: url.searchParams.get("asset") || "" };
}

// Some rich-text hosts keep only HTTP links. The identity remains in the
// fragment (excluded from the HTTP request); MCP resolves without fetching it.
export function pdReferenceLink(reference, linkBase) {
  const url = new URL(linkBase);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('PD名称链接需要有效的网页来源');
  parsePdReference(reference);
  url.hash = new URLSearchParams({ 'pd-reference': reference }).toString();
  return url.href.replaceAll('(', '%28').replaceAll(')', '%29');
}

// File-bearing drags prioritize the original; text-only cases retain their reference.
export function setPdReferenceDragData(dataTransfer, { libraryId, caseId, assetId = '', name, file, linkBase }) {
  const reference = pdReference({ libraryId, caseId, assetId });
  const link = linkBase ? pdReferenceLink(reference, linkBase) : reference;
  const label = String(name || caseId).replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  const escapeHtml = value => String(value).replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const markdownLabel = label.replace(/[\\\[\]]/gu, '\\$&');
  dataTransfer.clearData();
  dataTransfer.effectAllowed = 'copyMove';
  dataTransfer.setData('application/x-promptdirector-case', caseId);
  dataTransfer.setData('application/x-promptdirector-reference', reference);
  if (file?.url) dataTransfer.setData('application/x-promptdirector-file', JSON.stringify({ url: file.url, name: file.name, mimeType: file.mimeType }));
  if (file?.url) {
    dataTransfer.setData('text/plain', file.url);
    dataTransfer.setData('text/uri-list', file.url);
    dataTransfer.setData('text/html', file.kind === 'image'
      ? `<img src="${escapeHtml(file.url)}" alt="${escapeHtml(file.name)}">`
      : `<a href="${escapeHtml(file.url)}" download="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>`);
    dataTransfer.setData('DownloadURL', `${file.mimeType || 'application/octet-stream'}:${file.name}:${file.url}`);
  } else {
    dataTransfer.setData('text/plain', `[${markdownLabel}](${link})`);
    dataTransfer.setData('text/html', `<a href="${escapeHtml(link)}">${escapeHtml(label)}</a>`);
    dataTransfer.setData('text/uri-list', link);
  }
  return reference;
}
