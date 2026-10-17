import { downloadPageCaptureVideo } from './page-capture-video.js';

export function platformVideoWorkUrl(media, candidate) {
  for (const value of [media.originalWorkUrl, candidate.canonicalUrl, media.url]) {
    try {
      const url = new URL(value);
      if (/(^|\.)(douyin\.com|youtube\.com|youtu\.be|bilibili\.com)$/u.test(url.hostname)) return url.href;
    } catch { /* Not a platform work URL. */ }
  }
  return '';
}

// The sidebar, internal assistant and MCP all consume this same original-file
// contract. A page/player/manifest is never a successful local download.
export async function resolveCapturedVideoOriginal(media, candidate, {
  download = downloadPageCaptureVideo, downloadNative, downloadSession, signal, onProgress
} = {}) {
  const workUrl = platformVideoWorkUrl(media, candidate);
  let failure;
  if (!media.videoStreams) {
    const pixels = Number(media.width) * Number(media.height);
    const variants = (media.variants || []).filter(variant => !pixels || Number(variant.width) * Number(variant.height) >= pixels);
    const urls = [...new Set([media.url, ...variants.map(variant => variant.url)].filter(Boolean))];
    for (const url of urls) {
      signal?.throwIfAborted();
      try {
        const blob = await download(url, { signal, onProgress, mimeType: media.mimeType,
          declaredVideo: ['site-original', 'video-element'].includes(media.sourceKind) });
        if (blob) return blob;
      } catch (error) {
        signal?.throwIfAborted(); failure = error;
        if (downloadSession) {
          try { return await downloadSession(url); }
          catch (error) { signal?.throwIfAborted(); failure = error; }
        }
      }
    }
  }
  if (workUrl && downloadNative) return downloadNative(workUrl, { streams: media.videoStreams, signal, onProgress });
  throw failure || new Error('尚未取得完整视频文件，请重新读取来源页面后重试');
}
