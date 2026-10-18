import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const library = await readFile(new URL("../extension/library.js", import.meta.url), "utf8");
const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../extension/library.css", import.meta.url), "utf8");

test("current libraries bypass whole-library migration and normalization on every read", () => {
  const readState = background.slice(background.indexOf("async function readState()"), background.indexOf("async function readComposerSessions"));
  assert.match(readState, /shouldMigrate \? migrateLibraryState\(stored\) : null/);
});

test("project batch analysis inherits the clicked project without forcing image-only selection", () => {
  const menu = library.slice(library.indexOf("function createProjectMenu"), library.indexOf("function bindCaseDrop"));
  assert.match(menu, /openBatchAnalysis\(\{ scope: \{ collectionId: collection\.id, includeSubprojects: uiPreferences\.includeSubprojects \}/);
  assert.doesNotMatch(library, /function enterVisionSelection/);
});

test("visible thumbnails use a bounded queue and a rebuildable persistent cache", () => {
  assert.match(library, /thumbnailConcurrency = Math\.max\(1, Math\.min\(2,/);
  assert.match(library, /thumbnailLoader\.request\(visualId, image\)/);
  assert.match(library, /getDerivedMedia\(visualId\)/);
  assert.match(library, /saveDerivedMedia\(visualId, \{ \.\.\.derived, thumbnail, animated: false \}\)/);
});

test("narrow-screen add menu starts below the complete two-row header", () => {
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.package-menu-panel,[\s\S]*top: 126px/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.add-menu \.package-menu-panel \{[^}]*position:\s*fixed[^}]*top:\s*118px/);
});
