import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { collectDouyinVideoPayload } from '../extension/douyin-video-capture.js';
import { normalizeVideoPagePayload } from '../extension/video-page-capture.js';
import { normalizePageCaptureBatch } from '../extension/page-capture.js';
import { addDiscoveredVideos } from '../extension/video-discovery.js';
import { resolveCapturedVideoOriginal } from '../extension/captured-video-original.js';

const id = '7673852821996834082';
const work = `https://www.douyin.com/video/${id}`;
function collect(url, data, method = 'react') {
  const player = { parentElement: null, __reactProps$test: { children: { props: { data } } } };
  const script = { textContent: encodeURIComponent(JSON.stringify({ detail: data })) };
  return vm.runInNewContext(`(${collectDouyinVideoPayload.toString()})()`, {
    URL, location: { href: url }, window: {}, document: { title: '作品 - 抖音',
      querySelector: selector => selector === `.video_${id}` && method === 'react' ? player : null,
      querySelectorAll: selector => selector === 'video' ? [] : method === 'script' ? [script] : [] }
  });
}
const item = { awemeId: id, desc: '当前作品原文', authorInfo: { nickname: '作者' },
  video: { duration: 268911, width: 3840, height: 2160, play_addr: { url_list: ['https://v26-web.douyinvod.com/original/?signature=abc'], width: 3840, height: 2160 },
    bitRateList: [{ width: 1920, height: 1080, bitRate: 5000000, playAddr: [{ src: 'https://v26-web.douyinvod.com/1080/' }] },
      { width: 3840, height: 2160, isH265: 1, playAddr: [{ src: 'https://v26-web.douyinvod.com/separate/media-video-hvc1/' }] }] } };

test('Douyin profile modal selects exactly its video, preserves full source and never inherits recommendations', () => {
  const url = `https://www.douyin.com/user/author?modal_id=${id}&from_tab_name=main`;
  const payload = collect(url, { recommendation: { ...item, awemeId: '123', desc: '其他作品' }, selected: item });
  const site = normalizeVideoPagePayload(payload, url);
  const batch = normalizePageCaptureBatch({ adapter: 'douyin', candidates: site.candidates });
  assert.equal(batch.candidates.length, 1);
  const candidate = batch.candidates[0];
  assert.equal(candidate.canonicalUrl, work);
  assert.equal(candidate.sourceFacts.itemId, id);
  assert.equal(candidate.sourceFacts.author, '作者');
  assert.equal(candidate.contentText, '当前作品原文');
  assert.equal(candidate.media.length, 1);
  assert.equal(candidate.media[0].originalWorkUrl, work);
  assert.equal(candidate.media[0].url, item.video.play_addr.url_list[0]);
  assert.equal(candidate.media[0].width, 3840);
  assert.equal(candidate.media[0].sourceKind, 'site-original');
  assert.equal(addDiscoveredVideos(batch, [{ key: 'unrelated', url: 'https://v26-web.douyinvod.com/recommendation.mp4' }]).candidates[0].media.length, 1);
});

test('Douyin encoded server-rendered raw API data is read without rounding its long work ID', () => {
  const raw = { aweme_id: id, desc: '原文', video: { duration: 10000, play_addr: { url_list: ['https://cdn.douyinvod.com/asset'], width: 1080, height: 1920 } } };
  const payload = collect(work, raw, 'script');
  assert.equal(payload.itemId, id);
  assert.equal(payload.formats[0].urls[0], 'https://cdn.douyinvod.com/asset');
});

test('missing target media retains an unresolved target instead of collecting the author page', () => {
  const payload = collect(`https://www.douyin.com/user/author?modal_id=${id}`, { ...item, awemeId: 'other' });
  assert.equal(payload.formats.length, 0);
  assert.equal(normalizeVideoPagePayload(payload, work).candidates[0].media[0].url, work);
  assert.equal(collect('https://www.douyin.com/user/author', item), null);
});

test('master dimensions must not make a 1080p default URL outrank an explicitly available 4K format', () => {
  const payload = collect(work, { ...item, video: { width: 3840, height: 2160, playAddr: [{ src: 'https://cdn.douyinvod.com/default-1080' }],
    bitRateList: [{ width: 3840, height: 2160, isH265: 1, playAddr: [{ src: 'https://cdn.douyinvod.com/actual-4k' }] }] } });
  assert.equal(payload.formats[0].urls[0], 'https://cdn.douyinvod.com/actual-4k');
});

function feedSurface(data, { props = true, top = 56, active = true, infoId = data.awemeId, source = `https://cdn.douyinvod.com/${data.awemeId}/original/` } = {}) {
  const player = { currentSrc: source, src: '', videoWidth: 1920, videoHeight: 1080, duration: 38, poster: '' };
  return { active, player, parentElement: null,
    ...(props ? { __reactProps$test: { selected: data, preload: { ...item, awemeId: '7685996127329570075', desc: 'Next video' } } } : {}),
    closest: () => null,
    getBoundingClientRect: () => ({ top, bottom: top + 1040, left: 0, right: 1200, width: 1200, height: 1040 }),
    getAttribute: name => name === 'data-e2e-vid' ? data.awemeId : '',
    querySelector: selector => selector === 'video' ? player
      : selector === '[data-e2e="video-info"]' ? { getAttribute: () => infoId }
        : selector === '[data-e2e="feed-video-nickname"]' ? { textContent: '@作者' }
          : selector === '[data-e2e="video-desc"]' ? { cloneNode: () => {
            const clone = { textContent: data.desc + '展开' };
            clone.querySelectorAll = () => [{ remove: () => { clone.textContent = data.desc; } }];
            return clone;
          } } : null
  };
}

function collectFeed(surfaces, url = 'https://www.douyin.com/?recommend=1') {
  return vm.runInNewContext(`(${collectDouyinVideoPayload.toString()})()`, {
    URL, location: { href: url }, window: { innerHeight: 1100, innerWidth: 1400 }, document: { title: '抖音首页',
      querySelector: selector => selector === '#slidelist' ? {} : surfaces.find(surface => selector === `.video_${surface.getAttribute('data-e2e-vid')}`) || null,
      querySelectorAll: selector => selector === '[data-e2e="feed-active-video"][data-e2e-vid]' ? surfaces.filter(surface => surface.active)
        : selector === 'video' ? surfaces.map(surface => surface.player) : [] }
  });
}

test('Douyin recommendation flow binds the active marked player to its own work and excludes preloaded recommendations', () => {
  const current = feedSurface(item);
  const next = feedSurface({ ...item, awemeId: '7685996127329570075', desc: 'Next video' }, { active: false, top: 1156, source: 'blob:next' });
  const payload = collectFeed([current, next]);
  const site = normalizeVideoPagePayload(payload, 'https://www.douyin.com/?recommend=1');
  assert.equal(site.candidates[0].canonicalUrl, work);
  assert.equal(site.candidates[0].contentText, item.desc);
  assert.equal(site.candidates[0].media.length, 1);
  assert.equal(site.candidates[0].media[0].url, item.video.play_addr.url_list[0]);
  assert.equal(addDiscoveredVideos({ adapter: 'douyin', candidates: site.candidates }, [{ url: 'https://cdn.douyinvod.com/next/media-video-track' }]).candidates[0].media.length, 1);
});

test('an identified flow player can supply its complete currentSrc and local caption before React data arrives', () => {
  const current = feedSurface(item, { props: false });
  const payload = collectFeed([current]);
  assert.equal(payload.resolved, true);
  assert.equal(payload.title, item.desc, 'Expand controls must not become source text');
  assert.equal(payload.author, '作者');
  assert.equal(payload.formats[0].urls[0], current.player.currentSrc);
  assert.equal(payload.duration, 38);
});

test('the active player complete URL survives existing work formats and reaches page-session original saving', async () => {
  const publicUrl = 'https://cdn.douyinvod.com/current/original/?mime_type=video_mp4';
  const currentUrl = `${publicUrl}&fid=player-file&webid=page-session`;
  const current = feedSurface({ ...item, video: { play_addr: { url_list: [publicUrl], width: 1920, height: 1080 } } }, { source: currentUrl });
  const next = feedSurface({ ...item, awemeId: '123' }, { active: false, source: 'https://cdn.douyinvod.com/next/original/' });
  const payload = collectFeed([current, next]);
  const site = normalizeVideoPagePayload(payload, payload.sourceUrl);
  const candidate = normalizePageCaptureBatch({ candidates: site.candidates }).candidates[0];
  const media = candidate.media[0];
  assert(media.variants.some(variant => variant.url === currentUrl && variant.width === 1920 && variant.height === 1080));
  assert(!media.variants.some(variant => variant.url === next.player.currentSrc));
  const attempts = [], original = new Blob(['complete original'], { type: 'video/mp4' });
  const result = await resolveCapturedVideoOriginal(media, candidate, {
    download: async url => { attempts.push(['direct', url]); throw new Error('HTTP 403'); },
    downloadSession: async url => {
      attempts.push(['page', url]);
      if (url === currentUrl) return original;
      throw new Error('public URL lacks the player session parameters');
    },
    downloadNative: () => assert.fail('The authenticated player original must not require unrelated native cookie extraction')
  });
  assert.equal(result, original);
  assert.deepEqual(attempts, [['direct', publicUrl], ['page', publicUrl], ['direct', currentUrl], ['page', currentUrl]]);
});

test('a lower-resolution active player cannot silently replace an available higher-resolution original', async () => {
  const current = feedSurface(item);
  const payload = collectFeed([current]);
  const candidate = normalizeVideoPagePayload(payload, payload.sourceUrl).candidates[0];
  assert(candidate.media[0].variants.some(variant => variant.url === current.player.currentSrc));
  const attempts = [];
  await resolveCapturedVideoOriginal(candidate.media[0], candidate, {
    download: async url => { attempts.push(url); throw new Error('expired'); },
    downloadSession: async url => { attempts.push(url); throw new Error('expired'); },
    downloadNative: async (_url, options) => {
      assert.equal(options.minWidth, 3840); assert.equal(options.minHeight, 2160);
      return new Blob(['original']);
    }
  });
  assert(!attempts.includes(current.player.currentSrc));
});

test('a non-CORS Douyin player original uses the existing platform-bound native stream path before cookie-dependent extraction', async () => {
  const publicUrl = 'https://cdn.douyinvod.com/current/original/?mime_type=video_mp4';
  const currentUrl = `${publicUrl}&fid=player-file&webid=page-session`;
  const surface = feedSurface({ ...item, video: { play_addr: { url_list: [publicUrl], width: 1920, height: 1080 } } }, { source: currentUrl });
  const payload = collectFeed([surface]);
  const candidate = normalizePageCaptureBatch({ candidates: normalizeVideoPagePayload(payload, payload.sourceUrl).candidates }).candidates[0];
  let nativeCalls = 0;
  const result = await resolveCapturedVideoOriginal(candidate.media[0], candidate, {
    download: async () => { throw new Error('HTTP 403'); },
    downloadSession: async () => { throw new Error('Failed to fetch'); },
    downloadNative: async (url, options) => {
      nativeCalls++;
      assert.equal(url, work);
      assert.deepEqual(options.streams, { videoUrl: currentUrl });
      assert.equal(options.minWidth, 1920); assert.equal(options.minHeight, 1080);
      assert(!Object.hasOwn(options, 'cookies')); assert(!Object.hasOwn(options, 'headers'));
      return new Blob(['same original without re-encoding']);
    }
  });
  assert.equal(nativeCalls, 1); assert(result.size > 0);
});

test('switching the active flow marker on the same URL switches identity without carrying over the previous video', () => {
  const first = feedSurface(item, { props: false });
  const nextId = '7685996127329570075';
  const second = feedSurface({ ...item, awemeId: nextId, desc: 'Next video' }, { props: false, active: false });
  assert.equal(collectFeed([first, second]).itemId, id);
  first.active = false; second.active = true;
  const changed = collectFeed([first, second]);
  assert.equal(changed.itemId, nextId);
  assert.equal(changed.canonicalUrl, `https://www.douyin.com/video/${nextId}`);
  assert.equal(changed.formats[0].urls[0], second.player.currentSrc);
  assert.equal(changed.description, 'Next video');
});

test('ambiguous, offscreen or conflicting flow identities stay partial instead of falling through to page-shell capture', () => {
  for (const surfaces of [[feedSurface(item), feedSurface({ ...item, awemeId: '123' })],
    [feedSurface(item, { top: 1156 })], [feedSurface(item, { infoId: '123' })]]) {
    const payload = collectFeed(surfaces);
    const site = normalizeVideoPagePayload(payload, 'https://www.douyin.com/?recommend=1');
    assert.equal(payload.resolved, false);
    assert.equal(site.completeness, 'partial');
    assert.equal(site.candidates.length, 0);
  }
});

test('feed identity never overrides an explicit route ID or a different source page, and split tracks are not complete originals', () => {
  const payload = collectFeed([feedSurface(item)]);
  assert.equal(normalizeVideoPagePayload(payload, 'https://www.douyin.com/?recommend=2'), null);
  assert.equal(normalizeVideoPagePayload(payload, 'https://www.douyin.com/video/123'), null);
  assert.equal(normalizeVideoPagePayload({ ...payload, canonicalUrl: 'https://example.com/video' }, payload.sourceUrl), null);
  for (const source of ['blob:current', 'https://cdn.douyinvod.com/current/media-video-hvc1/', 'https://cdn.douyinvod.com/current/stream.m3u8']) {
    const unresolved = collectFeed([feedSurface(item, { props: false, source })]);
    assert.equal(unresolved.formats.length, 0);
    assert.equal(unresolved.resolved, false);
    const site = normalizeVideoPagePayload(unresolved, unresolved.sourceUrl);
    assert.equal(site.candidates[0].media[0].url, work, 'Native resolution must use only the identified work');
  }
});
