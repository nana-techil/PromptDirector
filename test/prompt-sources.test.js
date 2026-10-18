import test from "node:test";
import assert from "node:assert/strict";
import { detailPromptSources, sharedOriginalPrompt, caseOriginalPromptText, detailCaseOriginalPromptText } from "../extension/prompt-sources.js";
import { setEntryMediaPrompt } from "../extension/media.js";

test('an explicitly captured full case prompt remains readable when a screenshot carries only its prefix', () => {
  const complete = 'Create a cinematic scene, standing barefoot inside an apartment. No watermark.';
  const entry = { text: complete, sourceFacts: { originalPromptAvailable: true },
    mediaAssets: [{ id: 'video', kind: 'video' }, { id: 'screenshot', kind: 'image' }],
    mediaPrompts: [{ assetId: 'screenshot', source: 'webpage', text: 'Create a cinematic scene, standing' }] };
  const before = structuredClone(entry);
  assert.equal(detailCaseOriginalPromptText(entry), complete);
  assert.equal(sharedOriginalPrompt(entry), '', 'legacy display inference does not pollute shared prompt search');
  assert(caseOriginalPromptText({ ...entry, sourceFacts: { ...entry.sourceFacts, caseOriginalPromptAvailable: true } }).includes(complete));
  assert.deepEqual(entry, before, 'reading must preserve the screenshot original and existing library');
});

test("article body never becomes an image prompt; actual per-media prompts remain available", () => {
  const asset = { id: "image", kind: "image" };
  const entry = { text: "正文只显示一次", sourceFacts: { pageType: "article" }, articleDocument: { blocks: [{ kind: "paragraph", text: "正文只显示一次" }] } };
  assert.equal(detailPromptSources(entry, asset).original, "");
  entry.mediaPrompts = [{ assetId: "image", source: "manual", text: "配图实际提示词" }];
  assert.equal(detailPromptSources(entry, asset).original, "配图实际提示词");
});

test("adding and editing an original beside adopted AI preserves both sources", () => {
  const asset = { id: "image", kind: "image", usage: "content" };
  const entry = { text: "共享", mediaAssets: [asset], mediaPrompts: [{ assetId: asset.id, source: "ai-suggestion", text: "AI 人工修订" }] };
  const added = setEntryMediaPrompt(entry, asset.id, "独立原始", "manual", { preserveOtherSource: true });
  assert.equal(detailPromptSources(added, asset).ai, "AI 人工修订");
  assert.equal(detailPromptSources(added, asset).original, "独立原始");
  const edited = setEntryMediaPrompt(added, asset.id, "再次修订 AI", "ai-suggestion", { preserveOtherSource: true });
  assert.equal(detailPromptSources(edited, asset).ai, "再次修订 AI");
  assert.equal(detailPromptSources(edited, asset).original, "独立原始");
  const cleared = setEntryMediaPrompt(edited, asset.id, "", "manual", { preserveOtherSource: true });
  assert.equal(detailPromptSources(cleared, asset).original, "共享");
  assert.equal(detailPromptSources(cleared, asset).ai, "再次修订 AI");
});

test("video-specific original editing preserves shared text and the other media", () => {
  const asset = { id: "video", kind: "video", usage: "content" };
  const entry = { text: "案例原始", mediaAssets: [asset, { id: "other", kind: "image", usage: "content" }],
    mediaPrompts: [{ assetId: "video", source: "manual", text: "视频原始" }, { assetId: "other", source: "manual", text: "其他图片" }] };
  assert.equal(detailPromptSources(entry, asset).originalAssetId, asset.id);
  const edited = setEntryMediaPrompt(entry, asset.id, "修订视频原始");
  assert.equal(detailPromptSources(edited, asset).original, "修订视频原始");
  assert.equal(edited.text, "案例原始");
  assert.equal(edited.mediaPrompts.find(item => item.assetId === "other").text, "其他图片");
  assert.equal(entry.mediaPrompts[0].text, "视频原始");
});

for (const kind of ["image", "video"]) for (const original of ["", "原始内容"]) for (const ai of ["", "AI 内容"]) {
  test(`${kind}: original=${Boolean(original)}, AI=${Boolean(ai)} remain independent`, () => {
    const asset = { id: "asset", kind, usage: "content", contentHash: "hash", visionAnalysis: { version: 2, imageFingerprint: "hash", reconstructionPrompt: ai } };
    const entry = { text: original, mediaAssets: [asset], videoAnalyses: [{ id: "record", assetId: "asset", mode: "visual-reconstruction",
      reconstructionPrompt: ai, requestId: "fixture", contractVersion: "fixture", analysisScope: "visual", includeTags: false, tags: [], uncertainties: [], finishReason: "stop" }] };
    const before = structuredClone(entry);
    const result = detailPromptSources(entry, asset);
    assert.equal(result.original, original);
    assert.equal(result.ai, ai);
    assert.deepEqual(entry, before);
  });
}

test("per-image manual text outranks shared text but adopted AI is never relabeled as original", () => {
  const asset = { id: "image", kind: "image", usage: "content" };
  const entry = { text: "共享", mediaAssets: [asset], mediaPrompts: [{ assetId: "image", source: "manual", text: "逐图" }] };
  assert.equal(detailPromptSources(entry, asset).original, "逐图");
  entry.mediaPrompts[0].source = "ai-suggestion";
  assert.equal(detailPromptSources(entry, asset).original, "共享");
  assert.equal(detailPromptSources(entry, asset).ai, "逐图");
  assert.equal(detailPromptSources(entry, asset).aiSource, "media-prompt");
});

test("clearing adopted AI also clears its underlying text without removing analysis evidence or original media", () => {
  const asset = { id: "image", kind: "image", usage: "content", visionAnalysis: { version: 2, quality: "complete", reconstructionPrompt: "底层AI", tags: [{ g: "style.render", t: "电影感" }], imageFingerprint: "fixture" } };
  const original = { text: "原文", mediaAssets: [asset], mediaPrompts: [{ assetId: asset.id, source: "ai-suggestion", text: "采用AI" }] };
  const cleared = setEntryMediaPrompt(original, asset.id, "", "ai-suggestion", { preserveOtherSource: true });
  const reopened = setEntryMediaPrompt(cleared, asset.id, "保留独立原文", "manual", { preserveOtherSource: true });
  assert.equal(detailPromptSources(reopened, reopened.mediaAssets[0]).ai, "");
  assert.equal(reopened.text, "原文");
  assert.equal(reopened.mediaAssets[0].visionAnalysis.userEdited, true);
  assert.deepEqual(reopened.mediaAssets[0].visionAnalysis.tags, asset.visionAnalysis.tags);
  assert.equal(reopened.mediaAssets[0].visionAnalysis.imageFingerprint, "fixture");
  assert.equal(original.mediaAssets[0].visionAnalysis.reconstructionPrompt, "底层AI");
});

test('explicit video AI prompt edits and clears survive normalization without reviving old reconstruction text', () => {
  const asset={id:'v',kind:'video',usage:'content'};
  const entry={text:'原始词',mediaAssets:[asset],videoAnalyses:[{id:'complete',assetId:'v',mode:'visual-reconstruction',reconstructionPrompt:'旧逆推',requestId:'fixture',contractVersion:'fixture',analysisScope:'visual',includeTags:false,tags:[],uncertainties:[],finishReason:'stop'}]};
  const edited=setEntryMediaPrompt(entry,'v','自己的修订词','ai-suggestion',{preserveOtherSource:true});
  assert.equal(detailPromptSources(edited,asset).ai,'自己的修订词');
  const cleared=setEntryMediaPrompt(edited,'v','','ai-suggestion',{preserveOtherSource:true});
  const reopened=setEntryMediaPrompt(cleared,'v','原始词','manual',{preserveOtherSource:true});
  assert.equal(detailPromptSources(reopened,asset).ai,'');assert.equal(detailPromptSources(reopened,asset).original,'原始词');
  assert.deepEqual(entry.videoAnalyses[0].reconstructionPrompt,'旧逆推');
});

for (const type of ['image-case', 'video-case']) test(`original text stays visible in ${type} without a source flag`, () => {
  const asset = { id: 'original', kind: type === 'image-case' ? 'image' : 'video' };
  const entry = { text: '已有原始提示词', classification: { pathIds: [`content:${type}`], status: 'confirmed' }, mediaAssets: [asset] };
  assert.equal(detailPromptSources(entry, asset).original, entry.text);
  assert.equal(entry.sourceFacts, undefined);
  assert.equal(detailPromptSources({ ...entry, sourceFacts: { originalPromptAvailable: false } }, asset).original, '');
});

test('media tabs require distinct original prompts, not extra images, repeated excerpts or AI results', async () => {
  const { hasDistinctMediaPrompts } = await import('../extension/prompt-sources.js');
  const entry = { text: 'A forest with glowing fireflies', sourceFacts: { originalPromptAvailable: true },
    mediaAssets: [{ id: 'image', kind: 'image' }, { id: 'video', kind: 'video' }] };
  assert.equal(hasDistinctMediaPrompts(entry), false);
  for (const text of [entry.text, 'A forest', '  A forest\n with glowing fireflies  ']) {
    assert.equal(hasDistinctMediaPrompts({ ...entry, mediaPrompts: [{ assetId: 'image', source: 'webpage', text }] }), false);
  }
  assert.equal(hasDistinctMediaPrompts({ ...entry, mediaPrompts: [{ assetId: 'image', source: 'ai-suggestion', text: 'AI result' }] }), false);
  assert.equal(hasDistinctMediaPrompts({ ...entry, mediaPrompts: [{ assetId: 'deleted', source: 'manual', text: 'Orphan prompt' }] }), false);
  assert.equal(hasDistinctMediaPrompts({ ...entry, mediaPrompts: [{ assetId: 'image', source: 'manual', text: 'A city' }] }), true);
  const originals = [{ assetId: 'image', source: 'webpage', text: 'A city' }, { assetId: 'video', source: 'webpage', text: 'An ocean' }];
  assert.equal(hasDistinctMediaPrompts({ ...entry, text: '', mediaPrompts: originals }), true);
  assert.equal(hasDistinctMediaPrompts({ ...entry, text: '', mediaPrompts: originals.slice(0, 1) }), false);
});
