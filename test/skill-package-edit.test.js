import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareSkillFileEdit, resolveSkillFileLink } from '../extension/skill-package-edit.js';
import { createCreativeSkill, saveCreativeSkillVersion, restoreCreativeSkillVersion } from '../extension/creative-skills.js';
import { parseSkillFiles, parseSkillArchive, storedSkillFiles, storedSkillPaths, exportStoredSkillPackage } from '../extension/creative-skill-package.js';
import { createZipBlob, readZipBlob } from '../extension/zip.js';
import { validateCuratedSkillPackage } from '../extension/curated-skill-catalog.js';
import { installCuratedSkillTransaction } from '../extension/curated-skill-install.js';
import { buildCuratedSkillSnapshot, buildCuratedSkillSubmissionArchive } from '../extension/curated-skill-package.js';

async function fixture(prefix = '') {
  const files = new Map(Object.entries({
    'SKILL.md': new Blob(['---\nname: full-package\ndescription: Complete files.\nlicense: MIT\n---\n\nRun scripts/helper.py when supported.\n']),
    'RIGHTS.md': new Blob(['Rights retained.']),
    'LICENSE': new Blob(['MIT']),
    'scripts/helper.py': new Blob(['raise RuntimeError("Do not execute this fixture")\n']),
    'scripts/config.json': new Blob(['{"enabled":true}']),
    'references/完整原词.txt': new Blob(['original\nfull prompt\n']),
    'references/guide.md': new Blob(['# guide\n\nOriginal text.\n']),
    'references/provenance.md': new Blob(['Public source.\n']),
    'assets/empty.bin': new Blob([]),
    'assets/data.bin': new Blob([new Uint8Array([0, 255, 128, 13])]),
    'assets/cover.gif': new Blob([readFileSync(new URL('./fixtures/transfer-media/original.gif', import.meta.url))], { type: 'image/gif' })
  }).map(([path, blob]) => [prefix + path, blob]));
  const parsed = await parseSkillFiles(files), blobs = new Map();
  const saveFile = async (path, blob) => { const assetId = crypto.randomUUID(); blobs.set(assetId, blob); return { path, assetId, byteSize: blob.size, mimeType: blob.type }; };
  const packageFiles = await Promise.all([...files].map(([path, blob]) => saveFile(path, blob)));
  const { skill, state } = createCreativeSkill({}, { callName: 'Full package', portableId: parsed.name, description: parsed.description, skillMarkdown: parsed.body, references: parsed.references, packageFiles });
  return { files, parsed, skill, state, blobs, saveFile, readFile: async id => blobs.get(id) };
}

test('selecting a script reads only that file; full export preserves every byte and frontmatter', async () => {
  const f = await fixture('bundle/'); const reads = [];
  const files = await storedSkillFiles(f.skill, { paths: ['bundle/scripts/helper.py'], readFile: async id => { reads.push(id); return f.blobs.get(id); } });
  assert.equal(reads.length, 1); assert.deepEqual([...files.keys()], ['bundle/scripts/helper.py']);
  const exported = await parseSkillArchive(await exportStoredSkillPackage(f.skill, { readFile: f.readFile }));
  assert.deepEqual(new Set(storedSkillPaths(f.skill)), new Set(f.files.keys()));
  for (const [path, blob] of f.files) assert.deepEqual(await exported.files.get(path).arrayBuffer(), await blob.arrayBuffer());
});

test('editing Python and a reference preserves unrelated binary, empty and original files, and complete history restores them', async () => {
  const f = await fixture('bundle/');
  // A main-document edit already exists above the imported bytes.
  const edited = saveCreativeSkillVersion(f.state, f.skill.id, { skillMarkdown: 'Changed method.', description: 'Edited description.' });
  const input = { skillMarkdown: 'Changed method again.', description: 'Edited description.', provenanceMarkdown: 'Public source.' };
  const changes = new Map([['bundle/scripts/helper.py', new Blob(['# edited, never executed\n'])], ['bundle/references/guide.md', new Blob([])], ['bundle/assets/new.dat', new Blob([new Uint8Array([0,1,2])])]]);
  const patch = await prepareSkillFileEdit({ ...f, skill: edited.skill, input, changes });
  const saved = saveCreativeSkillVersion(edited.state, f.skill.id, { ...input, ...patch });
  const exported = await storedSkillFiles(saved.skill, { readFile: f.readFile });
  assert.equal(await exported.get('bundle/scripts/helper.py').text(), '# edited, never executed\n');
  assert.equal(exported.get('bundle/references/guide.md').size, 0);
  for (const name of ['assets/empty.bin','assets/data.bin','references/完整原词.txt','LICENSE']) assert.deepEqual(await exported.get('bundle/'+name).arrayBuffer(), await f.files.get('bundle/'+name).arrayBuffer());
  assert.match(await exported.get('bundle/SKILL.md').text(), /license: MIT/);
  const restored = restoreCreativeSkillVersion(saved.state, saved.skill.id, f.skill.currentVersionId);
  const original = await storedSkillFiles(restored.skill, { readFile: f.readFile });
  for (const [path, blob] of f.files) assert.deepEqual(await original.get(path).arrayBuffer(), await blob.arrayBuffer());
});

test('complete package passes submission payload, curated installation and re-export with provenance and dependency facts', async () => {
  const f = await fixture();
  const snapshot = await buildCuratedSkillSnapshot(f.skill, { author: 'Author', summary: 'Full method', rightsConfirmed: true }, { readFile: f.readFile });
  const outer = await readZipBlob(await buildCuratedSkillSubmissionArchive(snapshot));
  const archive = outer.get('payload.zip');
  const item = { id:'full-package@1.0.0',skillId:'full-package',version:'1.0.0',title:'Full package',callName:'Full package',authorId:'author',author:'Author',license:'MIT',reviewStatus:'approved',reviewedAt:'2026-10-22T00:00:00Z',summary:'Full method',downloadUrl:'https://github.com/example/repo/releases/download/v1/full.zip',sha256:'a'.repeat(64),archiveBytes:archive.size,order:1 };
  const parsed = await validateCuratedSkillPackage(item, archive);
  let installed;
  await installCuratedSkillTransaction({ state:{},item,parsed, saveBlob: async (id,blob) => f.blobs.set(id,blob),deleteBlobs:async()=>{},createSkill:async input=>{installed=createCreativeSkill({},input).skill;return {skill:installed};} });
  assert.ok(installed.runtimeDependencies.includes('scripts'));
  const exported = await parseSkillArchive(await exportStoredSkillPackage(installed,{readFile:f.readFile}));
  for (const [path, blob] of f.files) assert.deepEqual(await exported.files.get(path).arrayBuffer(), await blob.arrayBuffer());
});

test('internal references stay inside the known package and external sources are not mistaken for files', () => {
  const paths=['references/原词.txt','assets/photo.png'];
  assert.equal(resolveSkillFileLink('references/index.md','%E5%8E%9F%E8%AF%8D.txt',paths).path,'references/原词.txt');
  assert.equal(resolveSkillFileLink('references/index.md','../assets/photo.png',paths).path,'assets/photo.png');
  assert.equal(resolveSkillFileLink('SKILL.md','https://example.com/a',paths),null);
  assert.equal(resolveSkillFileLink('SKILL.md','javascript:alert(1)',paths),null);
  assert.equal(resolveSkillFileLink('SKILL.md','missing.txt',paths),null);
});
