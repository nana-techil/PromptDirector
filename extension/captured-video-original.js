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
  const pixels = Number(media.width) * Number(media.height);
  const variants = (media.variants || []).filter(variant => !pixels || Number(variant.width) * Number(variant.height) >= pixels);
  let failure;
  const withDownloadFailure = error => {
    if (!failure || error.name === 'AbortError' || ['video_cancelled', 'video_component_required'].includes(error.code)) return error;
    const combined = new Error(`原件读取失败：${failure.message}；本地解析失败：${error.message}`, { cause: error });
    combined.name = error.name;
    if (error.code) combined.code = error.code;
    if (error.details) combined.details = error.details;
    return combined;
  };
  if (!media.videoStreams) {
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
          catch (error) { signal?.throwIfAborted(); failure = new Error(`${failure.message}；${error.message}`); }
        }
      }
    }
  }
  if (workUrl && downloadNative) {
    let streams = media.videoStreams;
    // A complete Douyin player file may deny extension requests and lack CORS
    // while accepting the native downloader's work Referer. Reuse the existing
    // platform-bound stream contract; never export browser cookies or a foreign CDN.
    if (!streams && /(^|\.)douyin\.com$/u.test(new URL(workUrl).hostname)) {
      const source = [...variants.filter(variant => variant.sourceKind === 'video-element'), media].find(value => {
        if (!['site-original', 'video-element'].includes(value.sourceKind)) return false;
        try {
          const url = new URL(value.url);
          return url.protocol === 'https:' && !url.username && !url.password
            && /(^|\.)douyinvod\.com$/u.test(url.hostname)
            && !/\/media-(?:video|audio)-|\.(?:m3u8|mpd)(?:[?#]|$)/iu.test(url.href);
        } catch { return false; }
      });
      if (source) streams = { videoUrl: source.url };
    }
    // Pending captures can predate the CDN mirror adapter. Keep the work and
    // let the extractor refresh a PCDN hint the installed host cannot accept.
    if (streams && /(^|\.)bilibili\.com$/u.test(new URL(workUrl).hostname)
      && [streams.videoUrl, streams.audioUrl].filter(Boolean).some(value => {
        try { const url = new URL(value); return url.protocol !== 'https:' || url.username || url.password || !/(^|\.)(bilivideo\.com|bilivideo\.cn)$/u.test(url.hostname); }
        catch { return true; }
      })) streams = undefined;
    const options = { signal, onProgress, minWidth: media.width, minHeight: media.height };
    try { return await downloadNative(workUrl, { ...options, streams }); }
    catch (error) {
      signal?.throwIfAborted();
      // Signed page URLs can be valid in Chrome but denied from the native
      // process. Refresh the same work once; setup, cancellation and disk errors
      // must keep their original outcome instead of starting another download.
      if (!streams || ['video_cancelled', 'video_staging_exceeded'].includes(error.code) || error.name === 'AbortError' || error.code === 'video_component_required'
        || error.code !== 'video_timeout' && !/(?:HTTP|Server returned)\s*(?:401|403|404|410|429|5\d\d)\b|timed?\s*out|Connection (?:refused|reset)/iu.test(error.message)) throw withDownloadFailure(error);
      try { return await downloadNative(workUrl, options); }
      catch (refreshError) {
        signal?.throwIfAborted();
        if (refreshError.name === 'AbortError' || refreshError.code === 'video_component_required') throw refreshError;
        const refreshFailure = new Error(`页面视频地址不可用；从作品重新解析失败：${refreshError.message}`, { cause: refreshError });
        if (refreshError.code) refreshFailure.code = refreshError.code;
        throw withDownloadFailure(refreshFailure);
      }
    }
  }
  throw failure || new Error('尚未取得完整视频文件，请重新读取来源页面后重试');
}
