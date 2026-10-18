import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "cheerio";

test("analysis methods are a first-level settings destination, not nested in connection settings", () => {
  const $ = load(readFileSync(new URL("../extension/library.html", import.meta.url), "utf8"));
  assert.equal($("[data-settings-tab=rules]").length, 1);
  for (const kind of ["text", "vision", "video", "composer"]) {
    assert.equal($(`[data-settings-panel=rules] [data-analysis-kind-panel=${kind}]`).length, 1);
  }
  assert.equal($("#settings-ai-panel .ai-advanced-settings").length, 0);
  assert.equal($("#open-text-batch").length, 0);
  assert.equal($("#settings-tasks-panel #text-batch-card #preview-analysis-batch").length, 1);
  assert.equal($("#settings-tasks-panel #copy-analysis-diagnostics").length, 1);
  assert.equal($("#settings-tasks-panel [data-batch-kind], #settings-tasks-panel #batch-scope-fields").length, 0);
  assert.equal($("#show-analysis-diagnostics, #analysis-diagnostics, #undo-analysis-batch, #undo-facet, #import-undo").length, 0);
  assert.equal($("#settings-rules-panel .analysis-protocol:not(details)").length, 0);
});
