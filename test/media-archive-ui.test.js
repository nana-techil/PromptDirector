import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { ASSET_IMPORT_FAILURE_CODES } from "../extension/resource-limits.js";

const js = await readFile(new URL("../extension/library.js", import.meta.url), "utf8");
const css = await readFile(new URL("../extension/library.css", import.meta.url), "utf8");

test("modern file and folder pickers preserve handles and relative paths before falling back", () => {
  assert.match(js, /showOpenFilePicker\(\{ multiple: true \}\)/);
  assert.match(js, /showDirectoryPicker\(\{ mode: "read" \}\)/);
  assert.match(js, /readImportDirectoryHandle\(root, root\.name\)/);
  assert.match(js, /\{\s*handle,\s*file:\s*await handle\.getFile\(\),\s*relativePath/);
  assert.match(js, /elements\.mediaFile\.click\(\)/);
  assert.match(js, /elements\.mediaFolder\.click\(\)/);
  assert.match(js, /getAsFileSystemHandle/);
});

test("unsupported failures can become inert persistent local references", () => {
  assert.match(js, /ASSET_IMPORT_FAILURE_CODES\.UNSUPPORTED_FORMAT/);
  assert.match(js, /"保留本机链接"/);
  assert.match(js, /createUnsupportedLocalAssetReference\(file, assetId/);
  assert.match(js, /saveLocalAssetHandle\(assetId, handle, file\)/);
  assert.match(js, /recordType:\s*reference\.recordType/);
  assert.match(js, /sourceLastModified:\s*file\.lastModified/);
  assert.match(js, /mediaStage\.write\(\[assetId\], \(\) => saveLocalAssetHandle\(assetId, handle, file\), \[assetId\]\)/);
  assert.match(js, /draft\?\.mediaStage\.release\(\)/);
});

test("audio and creative source files have useful card and detail surfaces", () => {
  const card = js.slice(js.indexOf("function createCaseCard"), js.indexOf("async function reorderProjectCase"));
  const viewer = js.slice(js.indexOf("async function createMediaViewer"), js.indexOf("async function loadRemoteMarkdownImage"));
  assert.match(card, /createAudioCaseCover/);
  assert.match(card, /createSourceFileCaseCover/);
  assert.match(js, /case-audio-player/);
  assert.match(viewer, /asset\.kind === "audio"/);
  assert.match(viewer, /audio\.controls = true/);
  assert.match(viewer, /asset\.kind === "attachment"/);
  assert.match(viewer, /不会执行或内嵌打开/);
  assert.match(viewer, /下载本机副本/);
  assert.match(js, /formatMediaTime\(asset\.durationMs\)/);
  assert.match(js, /formatBytes\(asset\.byteSize\)/);
  assert.match(css, /\.detail-audio-wrap/);
  assert.match(css, /\.detail-source-file/);
});

test("local reference details report state and require explicit user actions", () => {
  const viewer = js.slice(js.indexOf("async function createLocalAssetReferenceViewer"), js.indexOf("async function createReferencedMediaViewer"));
  assert.match(viewer, /inspectLocalAssetHandle/);
  assert.match(viewer, /重新授权读取/);
  assert.match(viewer, /重新链接源文件/);
  assert.match(viewer, /UPDATE_LOCAL_ASSET_REFERENCE/);
  assert.match(viewer, /只保存文件信息与本机授权/);
  assert.doesNotMatch(viewer, /createElement\("iframe"\)|createElement\("script"\)|innerHTML/);
});

test("share export checks every linked source and stops when permission is canceled", () => {
  const exportFlow = js.slice(js.indexOf("async function prepareShareLocalAssetRecords"), js.indexOf("async function submitFromShareDialog"));
  assert.match(exportFlow, /getLocalAssetHandleRecord/);
  assert.match(exportFlow, /requestPermission\(\{ mode: "read" \}\)/);
  assert.match(exportFlow, /if \(!await authorizeShareLocalAssets\(\)\)/);
  assert.match(exportFlow, /分享包未导出/);
  assert.match(exportFlow, /源文件自上次链接后发生变化/);
  assert.match(exportFlow, /UPDATE_LOCAL_ASSET_REFERENCE/);
});

test("project share preflight uses the same compound-complete member selection as packaging", () => {
  assert.match(js, /projectPackageEntryIds\(\{ entries, compoundCases, organizerState \}, context\.collectionId\)/u);
});

test("share package import keeps archive and expanded-entry limits independent", () => {
  const imported = js.slice(js.indexOf("async function openLibraryPackageBatch"), js.indexOf("function backupMediaPaths"));
  assert.match(imported, /const limits = \{ \.\.\.LIBRARY_TRANSFER_LIMITS \}/);
  assert.doesNotMatch(imported, /max(?:Archive|File|Image|Video)Bytes:\s*file\.size/);
  assert.match(imported, /openZipBlob\(file, limits\)/);
  assert.match(imported, /sourceType:\s*LIBRARY_TRANSFER_SOURCES\.SHARE_PACKAGE/);
  assert.match(imported, /limits/);
  assert.match(imported, /validateImage:\s*validateImportedImage/);
});

test("folder restore derives its media budget before strict or rescue inspection", () => {
  const restore = js.slice(js.indexOf("async function restoreCompleteFolderBackup"), js.indexOf("async function openLibraryPackageBatch"));
  assert.match(restore, /largestMediaBytes = backupMediaSizes\.reduce/);
  assert.match(restore, /maxFileBytes: largestMediaBytes/);
  assert.match(restore, /maxImageBytes: largestMediaBytes/);
  assert.match(restore, /maxVideoBytes: largestMediaBytes/);
  assert.match(restore, /inspectFolderBackupEnvelope\(files,\s*\{\s*digest,\s*onProgress:/);
  assert.match(restore, /sourceType:\s*envelope\.mode === "complete"[\s\S]*LIBRARY_TRANSFER_SOURCES\.COMPLETE_BACKUP[\s\S]*LIBRARY_TRANSFER_SOURCES\.RESCUE_BACKUP/);
  assert.match(restore, /limits:\s*restoreLimits/);
  assert.match(restore, /validateImage:\s*validateImportedImage/);
  assert.doesNotMatch(restore, /maxFileBytes: Number\.MAX_SAFE_INTEGER/);
});

test("an unsupported file offers an explicit local-link action with its preservation boundary", () => {
  const source = js.slice(js.indexOf("function createSkippedImportRow("), js.indexOf("async function preserveUnsupportedImportReference("));
  const calls = [];
  const element = (tag, className = '', textContent = '') => ({
    tag, className, textContent, children: [], listeners: {},
    append(...children) { this.children.push(...children); },
    addEventListener(name, callback) { this.listeners[name] = callback; }
  });
  const createRow = vm.runInNewContext(`${source}; createSkippedImportRow`, {
    Blob, ASSET_IMPORT_FAILURE_CODES, document: { createElement: element },
    el: element, textEl: element, rawTextEl: element, t: value => value,
    preserveUnsupportedImportReference: (...args) => calls.push(args)
  });
  const item = { name: 'source.unknown', reason: 'Unsupported format',
    code: ASSET_IMPORT_FAILURE_CODES.UNSUPPORTED_FORMAT, file: new Blob(['original source']) };
  const row = createRow(item);
  const button = row.children.find(child => child.tag === 'button');
  assert.equal(button.textContent, '保留本机链接');
  assert.match(button.title, /不复制或执行源文件/);
  assert.equal(calls.length, 0, 'displaying an unsupported file must not preserve it without a user action');
  button.listeners.click();
  assert.deepEqual(calls, [[item, button]]);
  assert(!createRow({ ...item, file: undefined }).children.some(child => child.tag === 'button'),
    'missing source files must not offer a link that cannot be retained');
});
