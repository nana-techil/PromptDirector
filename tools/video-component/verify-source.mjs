import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readZipBlob } from '../../extension/zip.js';
import { VIDEO_COMPONENT } from '../../extension/video-component-config.js';
import { isMain } from '../../connector/is-main.mjs';
import { VIDEO_SOURCE_ASSET, sourcePackageFiles, sourceArchiveModes } from './package-source.mjs';

export async function verifyVideoSource(directory) {
  const report = JSON.parse(await readFile(join(directory, 'source-build.json'), 'utf8'));
  assert.equal(report.distribution, 'source'); assert.equal(report.version, VIDEO_COMPONENT.version);
  assert.equal(report.asset, VIDEO_SOURCE_ASSET);
  const bytes = await readFile(join(directory, VIDEO_SOURCE_ASSET));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), report.sha256, 'Source archive differs from its build report');
  const files = await readZipBlob(new Blob([bytes]));
  const expected = await sourcePackageFiles();
  assert.deepEqual([...files.keys()].sort(), expected.map(file => file.name).sort(), 'Source package must contain only its public allowlist');
  assert.equal(files.size, report.files);
  const { modes } = sourceArchiveModes(bytes);
  for (const file of expected) {
    assert.deepEqual(Buffer.from(await files.get(file.name).arrayBuffer()), Buffer.from(file.data), `${file.name} differs from current source`);
    assert.equal(modes.get(file.name).mode, file.name.endsWith('.command') ? 0o100755 : 0o100644, `${file.name}: unsafe or missing file mode`);
  }
  return { verified: true, distribution: 'source', version: report.version, files: files.size, sha256: report.sha256 };
}
if (isMain(import.meta.url)) console.log(JSON.stringify(await verifyVideoSource(resolve(process.argv[2] || 'dist/video-component')), null, 2));
