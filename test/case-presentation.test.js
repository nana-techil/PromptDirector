import test from "node:test";
import assert from "node:assert/strict";
import { usesArticleReader, usesPostReader, mediaFormatLabel } from "../extension/case-presentation.js";

test("creative classifications open existing case details regardless of webpage origin", () => {
  const articleDocument = { blocks: [{ kind: "paragraph", text: "Original prompt" }] };
  for (const id of ["content:prompt:image", "content:prompt:video", "content:image-case", "content:video-case"]) {
    for (const pageType of ["article", "post", "video", "artwork"]) {
      const entry = { classification: { pathIds: [id] }, articleDocument, sourceFacts: { pageType } };
      assert.equal(usesArticleReader(entry), false);
      assert.equal(usesPostReader(entry), false);
      assert.equal(usesPostReader({ ...entry, articleDocument: null }), false);
    }
  }
});

test("article roles retain structured reading including X quotes and media", () => {
  const articleDocument = { blocks: [{ kind: "quote", text: "Quoted context" }] };
  for (const id of ["content:tutorial", "content:reference"]) {
    for (const pageType of ["article", "post", "video", "artwork"]) {
      const entry = { classification: { pathIds: [id] }, articleDocument, sourceFacts: { pageType } };
      assert.equal(usesArticleReader(entry), true);
      assert.equal(usesPostReader(entry), false);
    }
  }
  assert.equal(usesArticleReader({ articleDocument }), true);
  assert.equal(usesPostReader({ sourceFacts: { pageType: "post" } }), true);
  assert.equal(usesArticleReader({ text: "Ordinary text case" }), false);
});

test("renamed and custom categories use their resolved purpose, not their display label", () => {
  const base = { articleDocument: { blocks: [{ kind: "paragraph", text: "text" }] }, sourceFacts: { pageType: "post" } };
  assert.equal(usesArticleReader({ ...base, contentRole: "prompt_video" }), false);
  assert.equal(usesPostReader({ ...base, contentRole: "prompt_video" }), false);
  assert.equal(usesArticleReader({ ...base, contentRole: "reference" }), true);
});

test('reference and tutorial content use the centered article reader with or without structured blocks or files', () => {
  for (const contentRole of ['reference', 'tutorial']) {
    for (const sourceFacts of [{}, { pageType: 'post' }]) {
      for (const mediaAssets of [[], [{ id: 'md', kind: 'document', mimeType: 'text/markdown' }]]) {
        const entry = { contentRole, text: '# Original document', sourceFacts, mediaAssets, primaryMediaId: 'md' };
        const original = structuredClone(entry);
        assert.equal(usesArticleReader(entry), true);
        assert.equal(usesPostReader(entry), false);
        assert.deepEqual(entry, original, 'choosing a reader must not rewrite the saved material');
      }
    }
  }
});

test("media format comes from recognized file metadata, never a creator's title", () => {
  assert.equal(mediaFormatLabel({ sourceTitle: "Community post by @creator", mimeType: "video/mp4" }), "MP4");
  assert.equal(mediaFormatLabel({ sourceTitle: "Test film" }), "FILE");
  assert.equal(mediaFormatLabel({ sourceTitle: "Test animation.mov" }), "MOV");
});

test("a short document with a structured table keeps the article reader despite image classification", () => {
  assert.equal(usesArticleReader({
    contentRole: "image_case", sourceFacts: { pageType: "article" },
    articleDocument: { blocks: [{ id: "table", kind: "table", rows: [[{ blockIds: [] }]] }] }
  }), true);
});

test('video classifications preview a video even when capture stored an image first, without changing originals', async () => {
  const { defaultPreviewMediaAsset } = await import('../extension/case-presentation.js');
  const image = { id: 'image', kind: 'image' }, video = { id: 'video', kind: 'video' };
  for (const contentRole of ['prompt_video', 'video_case']) {
    const entry = { contentRole, mediaAssets: [image, video], primaryMediaId: image.id };
    const before = structuredClone(entry);
    assert.equal(defaultPreviewMediaAsset(entry).id, video.id);
    assert.deepEqual(entry, before);
    assert.equal(defaultPreviewMediaAsset({ ...entry, mediaAssets: [image] }).id, image.id);
    const preferred = { id: 'preferred-video', kind: 'video' };
    assert.equal(defaultPreviewMediaAsset({ ...entry, mediaAssets: [image, video, preferred], primaryMediaId: preferred.id }).id, preferred.id);
  }
  assert.equal(defaultPreviewMediaAsset({ contentRole: 'prompt_image', mediaAssets: [image, video], primaryMediaId: image.id }).id, image.id);
});
