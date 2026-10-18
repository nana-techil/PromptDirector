import test from "node:test";
import assert from "node:assert/strict";
import { selectAnalysisScope, sameAnalysisTargets } from "../extension/analysis-scope.js";
import { previewAnalysisBatch, createAnalysisBatchJob } from "../extension/analysis-batch.js";

const done = { facetAssignments: [{ source: "deepseek_text", nodeId: "old" }], analysisMeta: { textRevision: 1 } };
const entries = [
  { id: "new", text: "待打标提示词", classification: { pathIds: ["prompt"] }, labels: ["人工标签"] },
  { id: "done", text: "已完成的提示词", classification: { pathIds: ["prompt"] }, ...done },
  { id: "changed", text: "后来改过的提示词", textRevision: 2, classification: { pathIds: ["prompt"] }, ...done },
  { id: "empty", text: "", classification: { pathIds: ["prompt"] } },
  { id: "video", text: "视频案例的文字", classification: { pathIds: ["video"] } },
  { id: "child", text: "子项目文字", classification: { pathIds: ["prompt"] } },
  { id: "outside", text: "其他项目文字", classification: { pathIds: ["prompt"] } }
];
const organizer = { collections: [
  { id: "project", name: "目标项目", entryIds: ["new", "done", "changed", "empty", "video"] },
  { id: "sub", name: "子项目", parentId: "project", entryIds: ["child"] },
  { id: "other", name: "其他项目", entryIds: ["outside", "video"] }
] };

test("only unanalysed project prompts enter both preview and the paid queue; manual tags are not analysis", async () => {
  const scope = { collectionId: "project", contentTypeIds: ["prompt"] };
  const scoped = selectAnalysisScope(entries, organizer, scope);
  const options = { includeChanged: false };
  const preview = await previewAnalysisBatch(scoped, options);
  const job = await createAnalysisBatchJob(scoped, options);
  assert.deepEqual(preview.entries.map(item => item.entryId), ["new"]);
  assert.deepEqual(job.items.map(item => item.entryId), ["new"]);
  assert.deepEqual(preview.skipCounts, { analyzed: 1, changed: 1, empty: 1 });
});

test("explicit entryIds restrict incremental tagging, including an empty selection", async () => {
  assert.deepEqual((await previewAnalysisBatch(entries, { entryIds: ["new", "done"], includeChanged: false })).entries.map(item => item.entryId), ["new"]);
  assert.equal((await previewAnalysisBatch(entries, { entryIds: [] })).caseCount, 0);
});

test("subprojects, type selection, selection intersection and project exclusions compose without changing membership", () => {
  const before = structuredClone(organizer);
  const scope = { collectionId: "project", includeSubprojects: true, excludedCollectionIds: ["other"], entryIds: ["new", "video", "child", "outside"] };
  assert.deepEqual(selectAnalysisScope(entries, organizer, scope).map(item => item.id), ["new", "child"]);
  assert.deepEqual(organizer, before);
  assert.deepEqual(selectAnalysisScope(entries, organizer, { collectionId: "project", excludedCollectionIds: ["project"] }), []);
  assert.deepEqual(selectAnalysisScope(entries, organizer, { contentTypeIds: [] }), [], "deselecting every type must never become all types");
  assert.throws(() => selectAnalysisScope(entries, organizer, { collectionId: "deleted" }), /项目已不存在/);
});

test("changed prompts and paid reanalysis are explicit choices within the same scope", async () => {
  const scoped = selectAnalysisScope(entries, organizer, { collectionId: "project", contentTypeIds: ["prompt"] });
  assert.deepEqual((await previewAnalysisBatch(scoped)).entries.map(item => item.entryId), ["new", "changed"]);
  assert.deepEqual((await previewAnalysisBatch(scoped, { mode: "selected", entryIds: scoped.map(item => item.id) })).entries.map(item => item.entryId), ["new", "done", "changed"]);
});

test("a paid queue must still match the preview's cases, media and text versions", () => {
  const expected = [{ entryId: "a", assetId: "image", textRevision: 1 }, { entryId: "b", textRevision: 2 }];
  assert.equal(sameAnalysisTargets(expected, [...expected].reverse()), true);
  assert.equal(sameAnalysisTargets(expected, [expected[0], { ...expected[1], textRevision: 3 }]), false);
  assert.equal(sameAnalysisTargets(expected, [expected[0], { ...expected[1], assetId: "another" }]), false);
  assert.equal(sameAnalysisTargets(expected, [...expected, { entryId: "outside" }]), false);
});

test("catalog rebuilding is separate from selection retagging and still covers the full catalog", async () => {
  const preview = await previewAnalysisBatch(entries, { mode: "rebuild", entryIds: ["new"] });
  assert.equal(preview.caseCount, entries.filter(item => item.text).length);
});
