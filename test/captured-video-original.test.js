import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveCapturedVideoOriginal } from '../extension/captured-video-original.js';
import { videoResource, addDiscoveredVideos } from '../extension/video-discovery.js';
import { normalizePageCaptureBatch } from '../extension/page-capture.js';
const bytes = await readFile(new URL('./fixtures/zhipu-local-video-smoke.mp4', import.meta.url));

test('a network-observed extensionless MP4 reaches actual byte download through candidate normalization', async () => {
  const url = 'https://v26-web.douyinvod.com/video/asset/?mime_type=video_mp4&signature=keep';
  const resource = videoResource({ tabId: 1, url, statusCode: 206, responseHeaders: [{ name: 'content-type', value: 'video/mp4' }] });
  const batch = normalizePageCaptureBatch(addDiscoveredVideos({ candidates: [{ id: 'selected', canonicalUrl: 'https://example.com/work', title: 'Work', media: [] }] }, [resource]));
  const candidate = batch.candidates[0];
  const { downloadPageCaptureVideo } = await import('../extension/page-capture-video.js');
  let calls = 0;
  const blob = await resolveCapturedVideoOriginal(candidate.media[0], candidate, { download: (value, options) => downloadPageCaptureVideo(value, {
    ...options, fetchImpl: async value => { calls++; assert.equal(value, url); return new Response(bytes, { headers: { 'content-type': 'video/mp4' } }); }
  }) });
  assert.equal(calls, 1);
  assert.equal(blob.size, bytes.length);
});

test('a platform player is resolved by the native engine instead of succeeding as a local video', async () => {
  const work = 'https://www.youtube.com/watch?v=current';
  let calls = 0;
  const blob = await resolveCapturedVideoOriginal({ url: work }, { canonicalUrl: work }, {
    download: async () => null,
    downloadNative: async value => { calls++; assert.equal(value, work); return new Blob([bytes]); }
  });
  assert.equal(calls, 1); assert.equal(blob.size, bytes.length);
  await assert.rejects(resolveCapturedVideoOriginal({ url: work }, { canonicalUrl: work }, { download: async () => null }), /完整视频/);
});

test('selected DASH video and audio stay together and cancellation does not start a second download', async () => {
  const streams = { videoUrl: 'https://a.bilivideo.com/video', audioUrl: 'https://a.bilivideo.com/audio' };
  const candidate = normalizePageCaptureBatch({ candidates: [{ id: 'b', title: 'B', canonicalUrl: 'https://www.bilibili.com/video/BVtest/?p=2', media: [{ id: 'v', kind: 'video', url: 'https://www.bilibili.com/video/BVtest/?p=2', videoStreams: streams }] }] }).candidates[0];
  await resolveCapturedVideoOriginal(candidate.media[0], candidate, { download: () => assert.fail('DASH tracks need merging'), downloadNative: async (url, options) => {
    assert.match(url, /p=2/u); assert.deepEqual(options.streams, streams); return new Blob([bytes]);
  } });
  const controller = new AbortController();
  await assert.rejects(resolveCapturedVideoOriginal({ url: 'https://example.com/video.mp4' }, {}, {
    signal: controller.signal, download: async () => { controller.abort(); controller.signal.throwIfAborted(); },
    downloadNative: () => assert.fail('cancel cannot become another request')
  }), { name: 'AbortError' });
});

test('an expired high-resolution file tries its same-quality mirrors, then re-resolves the work instead of silently saving a lower-quality variant', async () => {
  const urls = [];
  const result = await resolveCapturedVideoOriginal({ url: 'https://cdn.douyinvod.com/4k', width: 3840, height: 2160,
    variants: [{ url: 'https://cdn.douyinvod.com/4k-mirror', width: 3840, height: 2160 }, { url: 'https://cdn.douyinvod.com/720', width: 1280, height: 720 }] },
  { canonicalUrl: 'https://www.douyin.com/video/123' }, {
    download: async url => { urls.push(url); throw new Error('HTTP 403'); },
    downloadNative: async url => { urls.push(url); return new Blob([bytes]); }
  });
  assert.equal(result.size, bytes.length);
  assert.deepEqual(urls, ['https://cdn.douyinvod.com/4k', 'https://cdn.douyinvod.com/4k-mirror', 'https://www.douyin.com/video/123']);
});
