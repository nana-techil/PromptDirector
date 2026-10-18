import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from 'node:fs';
import { boundedMediaBlobFromResponse, mediaDownloadFailure } from '../extension/bounded-media.js';

import {
  discardPageSessionMedia,
  preparePageSessionMedia,
  readPageSessionMediaChunk
} from "../extension/page-session-media.js";

test("page-session media reads only the exact selected HTTPS URL with browser credentials", async () => {
  const injected = (0, eval)(`(${preparePageSessionMedia.toString()})`);
  const original = { location: globalThis.location, fetch: globalThis.fetch };
  const calls = [];
  globalThis.location = { href: "https://example.com/work/1", origin: "https://example.com" };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });
  };
  try {
    const denied = await injected({
      token: "token-a", url: "https://evil.example/image.png", allowedUrls: ["https://media.example/image.png"], maxBytes: 32, chunkBytes: 4, timeoutMs: 1000
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.stage, 'permission');
    assert.match(denied.error.message, /不在本次选择范围/);
    assert.equal(calls.length, 0, 'denied URLs must never reach the network');
    const prepared = await injected({
      token: "token-b", url: "https://media.example/image.png", allowedUrls: ["https://media.example/image.png"], maxBytes: 32, chunkBytes: 4, timeoutMs: 1000
    });
    assert.equal(prepared.chunkCount, 1);
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(calls[0].options.redirect, "error");
    assert.equal(calls[0].options.referrerPolicy, "strict-origin-when-cross-origin");
  } finally {
    discardPageSessionMedia({ token: 'token-b' });
    delete globalThis.__PROMPTDIRECTOR_PAGE_SESSION_MEDIA__;
    Object.assign(globalThis, original);
  }
});

test("page-session chunks are one-time bounded state and can be explicitly discarded", async () => {
  const read = (0, eval)(`(${readPageSessionMediaChunk.toString()})`);
  const discard = (0, eval)(`(${discardPageSessionMedia.toString()})`);
  globalThis.__PROMPTDIRECTOR_PAGE_SESSION_MEDIA__ = new Map([["token", { blob: new Blob([Uint8Array.from([0, 0, 0, 4, 16, 65])]), chunkBytes: 3 }]]);
  try {
    assert.equal(await read({ token: "token", index: 0 }), "AAAA");
    assert.equal(await read({ token: "token", index: 1 }), "BBBB");
    assert.equal(await read({ token: "token", index: 2 }), "");
    assert.equal(discard({ token: "token" }), true);
    assert.equal(await read({ token: "token", index: 0 }), "");
  } finally {
    delete globalThis.__PROMPTDIRECTOR_PAGE_SESSION_MEDIA__;
  }
});

test('a stalled page-session download is cancelled without leaving temporary media or buffered copies', async t => {
  // Keep the mock transport alive until AbortSignal.timeout fires on Node 22.
  const transport = setInterval(() => {}, 1000);
  t.after(() => clearInterval(transport));
  const injected = (0, eval)(`(${preparePageSessionMedia.toString()})`);
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  try {
    const failed = await injected({ token: 'stalled', url: 'https://media.example/video.mp4',
      allowedUrls: ['https://media.example/video.mp4'], maxBytes: 1024, chunkBytes: 4, timeoutMs: 40 });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.name, 'TimeoutError');
    assert.equal(cancelled, true);
    assert.equal(globalThis.__PROMPTDIRECTOR_PAGE_SESSION_MEDIA__?.has('stalled') ?? false, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('page-session streaming enforces temporary storage budget and preserves exact bytes chunk by chunk', async () => {
  const originalFetch = globalThis.fetch;
  const original = Uint8Array.from({ length: 1031 }, (_, index) => index % 256);
  globalThis.fetch = async () => new Response(original);
  try {
    const failed = await preparePageSessionMedia({ token: 'oversized', url: 'https://media.example/video.mp4',
      allowedUrls: ['https://media.example/video.mp4'], maxBytes: 1030, chunkBytes: 4, timeoutMs: 1000 });
    assert.equal(failed.ok, false);
    assert.match(failed.error.message, /暂存预算/);
    const prepared = await preparePageSessionMedia({ token: 'exact', url: 'https://media.example/video.mp4',
      allowedUrls: ['https://media.example/video.mp4'], maxBytes: 1031, chunkBytes: 256, timeoutMs: 1000 });
    const chunks = [];
    for (let index = 0; index < prepared.chunkCount; index++) chunks.push(Buffer.from(await readPageSessionMediaChunk({ token: 'exact', index }), 'base64'));
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(original));
    const record = globalThis.__PROMPTDIRECTOR_PAGE_SESSION_MEDIA__.get('exact');
    assert(record.blob instanceof Blob);
    assert.equal(Object.hasOwn(record, 'chunks'), false);
  } finally { discardPageSessionMedia({ token: 'exact' }); globalThis.fetch = originalFetch; }
});

test('explicit discard aborts an in-flight page download instead of only removing an already-loaded blob', async () => {
  const original = globalThis.fetch;
  let entered, signal;
  const began = new Promise(resolve => { entered = resolve; });
  globalThis.fetch = async (_url, options) => {
    signal = options.signal; entered();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  try {
    const pending = preparePageSessionMedia({ token: 'cancel-running', url: 'https://media.example/video.mp4',
      allowedUrls: ['https://media.example/video.mp4'], maxBytes: 64, chunkBytes: 16, timeoutMs: 1000 });
    await began;
    assert.equal(discardPageSessionMedia({ token: 'cancel-running' }), true);
    const failed = await pending;
    assert.equal(failed.ok, false);
    assert.equal(failed.error.name, 'AbortError');
    assert.match(failed.error.message, /取消/);
    assert.equal(signal.aborted, true);
    assert.equal(globalThis.__PROMPTDIRECTOR_PAGE_SESSION_DOWNLOADS__.has('cancel-running'), false);
  } finally { globalThis.fetch = original; }
});

// Run the real background restoration function with a Chrome script boundary.
// A successful pure page call alone would miss the formerly discarded exception.
const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const selectedSource = background.slice(background.indexOf('async function fetchSelectedPageSessionMedia('),
  background.indexOf('\nfunction pageCaptureMediaFetchCandidatesForSession('));
function backgroundSession(chromeApi) {
  return new Function('chrome', 'stagingByteBudget', 'operationBudget', 'pageCaptureMediaFetchCandidatesForSession',
    'discardPageSessionMedia', 'preparePageSessionMedia', 'readPageSessionMediaChunk', 'PAGE_SESSION_MEDIA_CHUNK_BYTES',
    'boundedMediaBlobFromResponse', 'LIBRARY_TRANSFER_LIMITS', 'mediaDownloadFailure', `return (${selectedSource});`)(
    chromeApi, async () => 1024, () => ({ maxDurationMs: 1000 }), (_candidate, url) => [url],
    discardPageSessionMedia, (0, eval)(`(${preparePageSessionMedia.toString()})`), readPageSessionMediaChunk, 256,
    boundedMediaBlobFromResponse, { maxImagePixels: 1024 }, mediaDownloadFailure);
}

test('page network interruption survives the script boundary with exact received bytes and no signed URL', async () => {
  const original = globalThis.fetch;
  const cause = new TypeError('Failed to fetch https://media.example/file?signature=private-signature Bearer private-key');
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(13)); },
    pull(controller) { controller.error(cause); }
  }));
  const fetchSession = backgroundSession({
    tabs: { get: async () => ({ url: 'https://example.com/work' }) },
    scripting: { executeScript: async ({ func, args }) => [{ result: await func(...args) }] }
  });
  try {
    await assert.rejects(fetchSession({ tabId: 1, sourceUrl: 'https://example.com/work' }, {}, 'https://media.example/file'), error => {
      assert.equal(error.name, 'TypeError');
      assert.deepEqual(error.mediaDownload, { stage: 'read', receivedBytes: 13 });
      assert.match(error.message, /Failed to fetch/);
      assert.doesNotMatch(error.message, /private-signature|private-key|https:/);
      return true;
    });
    assert.equal(globalThis.__PROMPTDIRECTOR_PAGE_SESSION_DOWNLOADS__.size, 0);
  } finally { globalThis.fetch = original; }
});

test('page permission rejection and cancellation retain their names through the background boundary', async () => {
  const original = globalThis.fetch;
  const fetchSession = backgroundSession({
    tabs: { get: async () => ({ url: 'https://example.com/work' }) },
    scripting: { executeScript: async ({ func, args }) => [{ result: await func(...args) }] }
  });
  try {
    for (const name of ['NotAllowedError', 'AbortError']) {
      globalThis.fetch = async () => { throw new DOMException('Permission or cancellation source reason', name); };
      await assert.rejects(fetchSession({ tabId: 1, sourceUrl: 'https://example.com/work' }, {}, 'https://media.example/file'), error => {
        assert.equal(error.name, name);
        assert.match(error.message, /Permission or cancellation source reason/);
        assert.deepEqual(error.mediaDownload, { stage: 'request', receivedBytes: 0 });
        return true;
      });
    }
  } finally { globalThis.fetch = original; }
});

test('a page Blob sink failure is not reported as a network failure or a successful prepared original', async () => {
  const original = { fetch: globalThis.fetch, Response: globalThis.Response };
  const response = new Response(new Uint8Array(17));
  globalThis.fetch = async () => response;
  globalThis.Response = class extends original.Response {
    async blob() { await this.arrayBuffer(); throw new DOMException('Temporary disk write denied', 'NotReadableError'); }
  };
  try {
    const failed = await preparePageSessionMedia({ token: 'blob-failure', url: 'https://media.example/file',
      allowedUrls: ['https://media.example/file'], maxBytes: 1024, chunkBytes: 256, timeoutMs: 1000 });
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.error, { stage: 'blob', receivedBytes: 17, name: 'NotReadableError', message: 'Temporary disk write denied' });
    assert.equal(globalThis.__PROMPTDIRECTOR_PAGE_SESSION_MEDIA__?.has('blob-failure') ?? false, false);
  } finally { Object.assign(globalThis, original); }
});
