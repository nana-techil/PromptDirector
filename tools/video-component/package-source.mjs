import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createZipBlob } from '../../extension/zip.js';
import { VIDEO_COMPONENT } from '../../extension/video-component-config.js';
import { VIDEO_SOURCE_FILES } from '../../connector/register-video.mjs';
import { isMain } from '../../connector/is-main.mjs';
import { extensionIdFromPublicKey } from '../release-identity.mjs';

export const VIDEO_SOURCE_ASSET = VIDEO_COMPONENT.sourceAsset;
const repository = fileURLToPath(new URL('../../', import.meta.url));
const encoder = new TextEncoder();
const macLauncher = command => `#!/bin/sh
cd "$(dirname "$0")" || exit 1
PD_VIDEO_NODE=$(command -v node 2>/dev/null || true)
if [ -z "$PD_VIDEO_NODE" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then PD_VIDEO_NODE="$candidate"; break; fi
  done
fi
if [ -z "$PD_VIDEO_NODE" ]; then
  echo 'Install free Node.js LTS first: https://nodejs.org/en/download/'
  echo '请先安装免费的 Node.js LTS，再重新运行此脚本。'
  PD_VIDEO_RESULT=1
else
  "$PD_VIDEO_NODE" connector/register-video.mjs ${command}
  PD_VIDEO_RESULT=$?
fi
printf '\nPress Enter to close / 按回车关闭：'
read -r PD_VIDEO_REPLY
exit "$PD_VIDEO_RESULT"
`;
const windowsLauncher = command => String.raw`@echo off
setlocal DisableDelayedExpansion
"%SystemRoot%\System32\chcp.com" 65001 >nul
cd /d "%~dp0"
set "PD_VIDEO_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined PD_VIDEO_NODE set "PD_VIDEO_NODE=%%N"
if not defined PD_VIDEO_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "PD_VIDEO_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined PD_VIDEO_NODE (
  echo Install free Node.js LTS first: https://nodejs.org/en/download/
  echo 请先安装免费的 Node.js LTS，再重新运行此脚本。
  pause
  exit /b 1
)
"%PD_VIDEO_NODE%" connector\register-video.mjs ${command}
set "PD_VIDEO_RESULT=%errorlevel%"
pause
exit /b %PD_VIDEO_RESULT%
`.replaceAll('\n', '\r\n');

export async function sourcePackageFiles(repo = repository) {
  const manifest = JSON.parse(await readFile(join(repo, 'extension/manifest.json'), 'utf8'));
  const component = { distribution: 'source', version: VIDEO_COMPONENT.version, extensionId: extensionIdFromPublicKey(manifest) };
  const files = await Promise.all([...VIDEO_SOURCE_FILES, 'docs/VIDEO_COMPONENT.md'].map(async name => ({ name, data: await readFile(join(repo, name)) })));
  const guide = files.find(file => file.name === 'docs/VIDEO_COMPONENT.md');
  guide.data = encoder.encode(guide.data.toString('utf8').replaceAll('../tools/video-component/', '../'));
  for (const language of ['zh', 'en']) files.push({ name: `INSTALL.${language}.md`, data: await readFile(new URL(`./INSTALL.${language}.md`, import.meta.url)) });
  files.push({ name: 'INSTALL-AGENT.md', data: await readFile(new URL('./INSTALL-AGENT.md', import.meta.url)) });
  files.push({ name: 'component.json', data: encoder.encode(JSON.stringify(component, null, 2)) },
    { name: 'package.json', data: encoder.encode(JSON.stringify({ private: true, type: 'module', engines: { node: '>=22.13' } }, null, 2)) });
  for (const [verb, command] of [['Install', 'install'], ['Uninstall', 'uninstall']]) {
    files.push({ name: `${verb}-macOS.command`, data: encoder.encode(macLauncher(command)) },
      { name: `${verb}-Windows.cmd`, data: encoder.encode(windowsLauncher(command)) });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

// ZIP's central-directory Unix mode is required for a downloaded .command to
// remain double-clickable after macOS Archive Utility extracts the source ZIP.
export function sourceArchiveModes(bytes) {
  const buffer = Buffer.from(bytes);
  const end = buffer.length - 22;
  if (buffer.readUInt32LE(end) !== 0x06054b50) throw new Error('Unexpected source ZIP trailer.');
  let offset = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10), modes = new Map();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Unexpected source ZIP entry.');
    const length = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 46, offset + 46 + length).toString('utf8');
    modes.set(name, { offset, mode: buffer.readUInt32LE(offset + 38) >>> 16 });
    offset += 46 + length + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return { buffer, modes };
}

export async function packageVideoSource(directory = join(repository, 'dist/video-component')) {
  const files = await sourcePackageFiles();
  const archive = await createZipBlob(files);
  const { buffer, modes } = sourceArchiveModes(await archive.arrayBuffer());
  for (const [name, { offset }] of modes) {
    buffer.writeUInt16LE(0x0314, offset + 4);
    buffer.writeUInt32LE(((name.endsWith('.command') ? 0o100755 : 0o100644) << 16) >>> 0, offset + 38);
  }
  await mkdir(directory, { recursive: true });
  const path = join(directory, VIDEO_SOURCE_ASSET);
  await writeFile(path, buffer);
  const report = { distribution: 'source', version: VIDEO_COMPONENT.version, asset: VIDEO_SOURCE_ASSET,
    sha256: createHash('sha256').update(buffer).digest('hex'), files: files.length };
  await writeFile(join(directory, 'source-build.json'), JSON.stringify(report, null, 2));
  return { path, ...report };
}

if (isMain(import.meta.url)) console.log(JSON.stringify(await packageVideoSource(resolve(process.argv[2] || 'dist/video-component')), null, 2));
