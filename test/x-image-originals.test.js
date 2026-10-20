import test from "node:test";
import assert from "node:assert/strict";
import { normalizePageCaptureCandidate, pageCaptureMediaFetchCandidates, resolvePageCaptureImage } from "../extension/page-capture.js";

const small = "https://pbs.twimg.com/media/example?format=jpg&name=small";
const original = small.replace("name=small", "name=orig");
const photo = (url = small) => ({ id: "photo", kind: "image", url, width: 680, height: 380, sourceKind: "current" });
const candidate = (media) => normalizePageCaptureCandidate({
  title: "Character sheet", canonicalUrl: "https://x.com/artist/status/123", media
});
const bytes = new Blob(["original bytes"], { type: "image/jpeg" });

test("X previews and restored small-image drafts prefer original bytes without labelling them with thumbnail dimensions", () => {
  for (const name of ["small", "900x900", "large"]) {
    const raw = photo(small.replace("small", name));
    const result = candidate([raw]);
    assert.equal(result.media[0].id, raw.id);
    assert.equal(result.media[0].url, original);
    assert.equal(result.media[0].sourceKind, "site-original");
    assert.equal(result.media[0].width, 0);
    assert.equal(result.media[0].height, 0);
    assert.deepEqual(pageCaptureMediaFetchCandidates(raw), [original, raw.url]);
    assert.deepEqual(candidate(result.media).media, result.media, "restored preview remains stable");
  }
});

test("original X photos retain their known dimensions, format and unrelated URL parameters", () => {
  const raw = photo("https://pbs.twimg.com/media/example?format=png&name=orig&tag=one");
  raw.width = 4096; raw.height = 2286;
  const result = candidate([raw]).media[0];
  assert.equal(result.width, 4096);
  assert.equal(result.height, 2286);
  assert.deepEqual(pageCaptureMediaFetchCandidates(result), [raw.url]);
  assert.deepEqual(pageCaptureMediaFetchCandidates(photo("https://pbs.twimg.com/media/example.jpg:small")), [
    "https://pbs.twimg.com/media/example.jpg:orig", "https://pbs.twimg.com/media/example.jpg:small"
  ]);
});
test("a site attribute incorrectly calling a resized X URL original cannot outrank name=orig", () => {
  assert.deepEqual(pageCaptureMediaFetchCandidates({...photo(), sourceKind:"site-original"}), [original,small]);
});

test("X original selection leaves avatars, video posters, other hosts and explicit local assets alone", () => {
  for (const url of [
    "https://pbs.twimg.com/profile_images/person/small.jpg",
    "https://pbs.twimg.com/amplify_video_thumb/123/img/cover?format=jpg&name=small",
    "https://pbs.twimg.com.evil.example/media/example?name=small",
    "https://example.com/media/example?name=small",
    "https://pbs.twimg.com@evil.example/media/example?name=small"
  ]) assert.deepEqual(pageCaptureMediaFetchCandidates(photo(url)), [url]);
  for (const extra of [{ kind: "video" }, { localAssetId: "selected-original" }, { localTransferId: "upload" }]) {
    assert.deepEqual(pageCaptureMediaFetchCandidates({ ...photo(), ...extra }), [small]);
  }
  const local = { ...photo(), localAssetId: "selected-original" };
  assert.deepEqual(pageCaptureMediaFetchCandidates(candidate([local, local]).media[0]), [small]);
});

test("two renditions of the same X photo collapse to one original without dropping either fallback", () => {
  const large = small.replace("small", "large");
  const result = candidate([photo(), { ...photo(large), id: "other-dom-node" }]);
  assert.equal(result.media.length, 1);
  assert.deepEqual(new Set(pageCaptureMediaFetchCandidates(result.media[0])), new Set([original, small, large]));
});

test("original download is used without fetching thumbnails and exposes actual file dimensions", async () => {
  const calls = [];
  const result = await resolvePageCaptureImage(photo(), {
    fetchMedia: async url => { calls.push(url); return { blob: bytes, metadata: { width: 4096, height: 2286 } }; },
    decodeDataUrl: () => assert.fail("no pixel fallback")
  });
  assert.deepEqual(calls, [original]);
  assert.equal(result.blob, bytes);
  assert.deepEqual(result.metadata, { width: 4096, height: 2286 });
  assert.equal(result.usedReducedImage, false);
});

test("an allowed page-session original wins over a publicly downloadable thumbnail", async () => {
  const calls = [];
  const result = await resolvePageCaptureImage(photo(), {
    fetchMedia: async url => { calls.push(`public:${url}`); if (url === original) throw Error("403"); return bytes; },
    fetchSessionMedia: async url => { calls.push(`session:${url}`); return bytes; },
    decodeDataUrl: () => assert.fail("no pixel fallback")
  });
  assert.deepEqual(calls, [`public:${original}`, `session:${original}`]);
  assert.equal(result.usedReducedImage, false);
  assert.equal(result.sourceUrl, original);
});

test("failed originals preserve a usable smaller photo and report the quality downgrade", async () => {
  const calls = [];
  const result = await resolvePageCaptureImage(photo(), {
    fetchMedia: async url => { calls.push(url); if (url === original) throw Error("404"); return bytes; },
    fetchSessionMedia: async () => { throw Error("unavailable"); },
    decodeDataUrl: () => assert.fail("no pixel fallback")
  });
  assert.deepEqual(calls, [original, small]);
  assert.equal(result.sourceUrl, small);
  assert.equal(result.usedReducedImage, true);
  assert.equal(result.failures.length, 2);
});

test("original retries respect denied session access and cancellation", async () => {
  const result = await resolvePageCaptureImage(photo(), {
    sessionMediaAllowed: false,
    fetchMedia: async url => { if (url === original) throw Error("403"); return bytes; },
    fetchSessionMedia: () => assert.fail("session permission denied"),
    decodeDataUrl: () => assert.fail("no pixels")
  });
  assert.equal(result.usedReducedImage, true);
  const controller = new AbortController();
  await assert.rejects(resolvePageCaptureImage(photo(), {
    signal: controller.signal,
    fetchMedia: async () => { controller.abort(); throw Error("cancelled"); },
    fetchSessionMedia: () => assert.fail("cancelled"),
    decodeDataUrl: () => assert.fail("cancelled")
  }), { name: "AbortError" });
});
