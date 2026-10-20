import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { packageVideoSource, VIDEO_SOURCE_ASSET, sourceArchiveModes } from '../../tools/video-component/package-source.mjs';
import { verifyVideoSource } from '../../tools/video-component/verify-source.mjs';
import { checkSourceRegistration } from '../../tools/video-component/check-source-registration.mjs';
import { readZipBlob, createZipBlob } from '../../extension/zip.js';
import { videoSourcePlan, installVideoSource, uninstallVideoSource, videoSourceLauncher } from '../register-video.mjs';
import { discoverVideoTools } from '../video-tools.mjs';
import { frameDecoder, encodeFrame } from '../framing.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'pd-video-source-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await packageVideoSource(base);
  const directory = join(base, '视频 source with space');
  const files = await readZipBlob(new Blob([await readFile(join(base, VIDEO_SOURCE_ASSET))]));
  for (const [name, data] of files) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), Buffer.from(await data.arrayBuffer()));
  }
  const plan = await videoSourcePlan({ directory, root: join(base, '视频 installed with space'), nativeDirectory: join(base, 'chrome'), platform: process.platform === 'win32' ? 'win32' : 'darwin' });
  return { base, directory, files, plan };
}
async function fixtureTools(directory) {
  if (process.platform === 'win32') return discoverVideoTools();
  await mkdir(directory, { recursive: true });
  const tools = {};
  for (const [key, name] of [['ytDlp', 'yt-dlp'], ['ffmpeg', 'ffmpeg'], ['ffprobe', 'ffprobe']]) {
    const path = join(directory, name);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${name} source-install-test'\n`, { mode: 0o700 });
    tools[key] = path;
  }
  return tools;
}
const toolEnv = tools => ({ ...process.env, PROMPTDIRECTOR_YTDLP: tools.ytDlp, PROMPTDIRECTOR_FFMPEG: tools.ffmpeg, PROMPTDIRECTOR_FFPROBE: tools.ffprobe });
const unavailable = { ...process.env, PROMPTDIRECTOR_YTDLP: join(tmpdir(), 'missing-pd-ytdlp'), PROMPTDIRECTOR_FFMPEG: join(tmpdir(), 'missing-pd-ffmpeg'), PROMPTDIRECTOR_FFPROBE: join(tmpdir(), 'missing-pd-ffprobe') };
async function nativeStatus(plan) {
  const messages = [];
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `""${plan.launcher}" "chrome-extension://${plan.config.extensionId}/""`]
    : [`chrome-extension://${plan.config.extensionId}/`];
  const child = spawn(process.platform === 'win32' ? process.env.ComSpec : plan.launcher, args,
    { env: { ...process.env, PATH: '', PROMPTDIRECTOR_YTDLP: 'ignored-untrusted-override' }, windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Native status timed out: ${stderr}`)); }, 20_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', frameDecoder(message => {
      messages.push(message);
      if (message.type === 'video_response') child.stdin.end();
    }));
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(messages) : reject(new Error(stderr || `Host exit ${code}`)); });
    child.stdin.write(encodeFrame({ type: 'video_hello', extensionId: plan.config.extensionId, protocolVersion: 1 }));
    child.stdin.write(encodeFrame({ type: 'video_request', id: 'status', operation: 'status' }));
  });
}

test('the public source ZIP contains runnable Mac scripts and no installed paths or configuration; verifier rejects added runtime state', async t => {
  const { base, files } = await fixture(t);
  const result = await verifyVideoSource(base);
  assert(result.verified);
  assert(!files.has('video-tools.json')); assert(!files.has('node_modules'));
  const config = JSON.parse(await files.get('component.json').text());
  assert.equal(config.distribution, 'source'); assert.match(config.extensionId, /^[a-p]{32}$/u);
  const modes = sourceArchiveModes(await readFile(join(base, VIDEO_SOURCE_ASSET))).modes;
  assert.equal(modes.get('Install-macOS.command').mode, 0o100755);
  const windows = await files.get('Install-Windows.cmd').text();
  assert(windows.includes('%ProgramFiles%\\nodejs\\node.exe'));
  assert(windows.includes('connector\\register-video.mjs install')); assert(windows.includes('pause'));
  for (const [name, blob] of files) {
    const text = await blob.text();
    assert(!text.includes(base), name);
    if (name.endsWith('.md')) for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
      const link = match[1]; if (/^[a-z]+:/iu.test(link)) continue;
      assert(files.has(join(dirname(name), link).replaceAll('\\', '/')), `${name}: missing local link ${link}`);
    }
  }
  const entries = await Promise.all([...files].map(async ([name, data]) => ({ name, data: new Uint8Array(await data.arrayBuffer()) })));
  entries.push({ name: 'video-tools.json', data: new TextEncoder().encode('{"ffmpeg":"private"}') });
  const altered = Buffer.from(await (await createZipBlob(entries)).arrayBuffer());
  await writeFile(join(base, VIDEO_SOURCE_ASSET), altered);
  const report = JSON.parse(await readFile(join(base, 'source-build.json')));
  report.sha256 = createHash('sha256').update(altered).digest('hex');
  await writeFile(join(base, 'source-build.json'), JSON.stringify(report));
  await assert.rejects(verifyVideoSource(base), /allowlist/u);
});

test('source installation survives moving its download, launches with empty PATH, rejects failed upgrades and only uninstalls its own registration', async t => {
  const { directory, base, plan } = await fixture(t);
  const tools = await fixtureTools(join(base, 'external tools'));
  if (!tools.ytDlp || !tools.ffmpeg || !tools.ffprobe) {
    assert.notEqual(process.env.PROMPTDIRECTOR_VIDEO_REQUIRE_TOOLS, '1'); return t.skip('Install real video dependencies for Windows integration');
  }
  let registrations = 0;
  const register = async () => { registrations++; };
  await installVideoSource(plan, { env: toolEnv(tools), register });
  const config = JSON.parse(await readFile(join(plan.root, 'video-tools.json')));
  assert.equal(config.ytDlp, tools.ytDlp);
  const manifest = JSON.parse(await readFile(plan.registration));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${plan.config.extensionId}/`]);
  assert.equal(manifest.path, plan.launcher);
  if (plan.platform !== 'win32') assert.equal((await checkSourceRegistration(plan)).installed, true);
  await assert.rejects(installVideoSource(plan, { env: unavailable, register }), /missing or blocked/u);
  await rm(directory, { recursive: true });
  const messages = await nativeStatus(plan);
  assert.equal(messages[0].type, 'video_ready');
  assert.equal(messages[1].result.available, true);
  assert.equal(messages[1].result.componentVersion, plan.config.version);
  if (plan.platform !== 'win32') {
    await writeFile(plan.registration, JSON.stringify({ name: 'com.promptdirector.video', path: join(base, 'another installation') }));
    await assert.rejects(checkSourceRegistration(plan));
    await uninstallVideoSource(plan);
    assert.equal(JSON.parse(await readFile(plan.registration)).path, join(base, 'another installation'));
  } else {
    await uninstallVideoSource(plan, { register }); assert.equal(registrations, 2);
  }
  await assert.rejects(stat(plan.root), { code: 'ENOENT' });
  assert.deepEqual(await uninstallVideoSource(plan, { register }), { removed: false });
});

test('missing dependencies never register a broken host or overwrite an unrelated directory', async t => {
  const { plan } = await fixture(t);
  await assert.rejects(installVideoSource(plan, { env: unavailable }), /https:\/\/ffmpeg.org/u);
  await assert.rejects(stat(plan.registration), { code: 'ENOENT' });
  await assert.rejects(stat(plan.root), { code: 'ENOENT' });
  await mkdir(plan.root); await writeFile(join(plan.root, 'important.txt'), 'keep');
  await assert.rejects(installVideoSource(plan, { env: unavailable }));
  await assert.rejects(uninstallVideoSource(plan));
  assert.equal(await readFile(join(plan.root, 'important.txt'), 'utf8'), 'keep');
});

test('manual standalone downloads are copied, remain available after source removal and survive a source-only update', { skip: process.platform === 'win32' }, async t => {
  const { plan, directory, base } = await fixture(t);
  const manual = await fixtureTools(join(directory, 'tools'));
  await cp(manual.ytDlp, join(directory, 'tools/yt-dlp_macos'));
  await rm(manual.ytDlp); await chmod(join(directory, 'tools/yt-dlp_macos'), 0o600);
  if (process.platform === 'darwin') await exec('/usr/bin/xattr', ['-w', 'com.promptdirector.source-test', 'keep-download-attributes', join(directory, 'tools/yt-dlp_macos')]);
  await installVideoSource(plan, { env: unavailable });
  const config = JSON.parse(await readFile(join(plan.root, 'video-tools.json')));
  assert.equal(config.ytDlp, join(plan.root, 'bin/yt-dlp'));
  if (process.platform === 'darwin') assert.equal((await exec('/usr/bin/xattr', ['-p', 'com.promptdirector.source-test', config.ytDlp])).stdout.trim(), 'keep-download-attributes');
  await rm(join(directory, 'tools'), { recursive: true });
  await installVideoSource(plan, { env: { ...process.env, PATH: '' } });
  await rm(directory, { recursive: true });
  assert.equal((await nativeStatus(plan))[1].result.available, true);
  await uninstallVideoSource(plan);
  await assert.rejects(stat(plan.registration), { code: 'ENOENT' });
  assert.equal((await checkSourceRegistration({ ...plan, removed: true })).removed, true);
  assert.deepEqual((await readdir(base)).filter(name => name.includes('.install-') || name.includes('.previous-')), []);
});

test('Windows launchers preserve percent, spaces and shell characters without delayed expansion', () => {
  const text = videoSourceLauncher({ platform: 'win32', root: 'C:\\Users\\A & B%20!', node: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.match(text, /DisableDelayedExpansion/u); assert(text.includes('A & B%%20!'));
  assert(text.includes('"%SystemRoot%\\System32\\chcp.com"'));
  assert.throws(() => videoSourceLauncher({ platform: 'win32', root: 'bad"path', node: 'node' }), /Invalid/u);
});

test('reinstallation rediscovers moved dependencies but an installed host never silently changes executables', { skip: process.platform === 'win32' }, async t => {
  const { plan, base } = await fixture(t);
  const first = await fixtureTools(join(base, 'old tools'));
  await installVideoSource(plan, { env: toolEnv(first) });
  const current = await fixtureTools(join(base, 'new tools'));
  await rm(dirname(first.ytDlp), { recursive: true });
  const env = { PATH: dirname(current.ytDlp) };
  assert.equal((await discoverVideoTools({ root: plan.root, env, configuredOnly: true })).ytDlp, '');
  await installVideoSource(plan, { env });
  assert.equal(JSON.parse(await readFile(join(plan.root, 'video-tools.json'))).ytDlp, current.ytDlp);
  assert.equal((await nativeStatus(plan))[1].result.available, true);
  await uninstallVideoSource(plan);
});

test('macOS ZIP extraction preserves executable launch scripts', { skip: process.platform !== 'darwin' }, async t => {
  const { base } = await fixture(t);
  const extracted = join(base, 'system-unzip');
  await exec('/usr/bin/ditto', ['-x', '-k', join(base, VIDEO_SOURCE_ASSET), extracted]);
  assert.equal((await stat(join(extracted, 'Install-macOS.command'))).mode & 0o777, 0o755);
  await exec('/bin/sh', ['-n', join(extracted, 'Install-macOS.command')]);
});

test('the installed source host can invoke actual local dependencies without a browser PATH', async t => {
  const tools = await discoverVideoTools();
  if (!tools.ytDlp || !tools.ffmpeg || !tools.ffprobe) {
    assert.notEqual(process.env.PROMPTDIRECTOR_VIDEO_REQUIRE_TOOLS, '1'); return t.skip('Real native dependencies are optional outside component acceptance');
  }
  const { plan } = await fixture(t);
  await installVideoSource(plan, { env: toolEnv(tools), register: async () => {} });
  try {
    const messages = await nativeStatus(plan);
    assert.equal(messages[1].result.available, true);
    assert(messages[1].result.versions.ytDlp);
    assert.match(messages[1].result.versions.ffmpeg, /^ffmpeg version/u);
    assert.match(messages[1].result.versions.ffprobe, /^ffprobe version/u);
    assert.equal(await readFile(join(plan.root, 'LICENSE'), 'utf8'), await readFile(new URL('../../LICENSE', import.meta.url), 'utf8'));
  } finally { await uninstallVideoSource(plan, { register: async () => {} }); }
});

test('a registry failure during Windows reinstallation restores the previous runtime and leaves external tools untouched', async t => {
  const { plan, base } = await fixture(t);
  const tools = await fixtureTools(join(base, 'external tools'));
  if (!tools.ytDlp || !tools.ffmpeg || !tools.ffprobe) {
    assert.notEqual(process.env.PROMPTDIRECTOR_VIDEO_REQUIRE_TOOLS, '1'); return t.skip('Windows integration requires video tools');
  }
  // On macOS this exercises file replacement only, never the real registry.
  plan.platform = 'win32';
  await installVideoSource(plan, { env: toolEnv(tools), register: async () => {} });
  const marker = join(plan.root, 'previous-runtime.txt');
  await writeFile(marker, 'previous installation');
  const previousManifest = await readFile(plan.registration, 'utf8');
  await assert.rejects(installVideoSource(plan, { env: toolEnv(tools), register: async () => { throw new Error('Registry write denied'); } }), /Registry write denied/u);
  assert.equal(await readFile(marker, 'utf8'), 'previous installation');
  assert.equal(await readFile(plan.registration, 'utf8'), previousManifest);
  assert.equal((await stat(tools.ffmpeg)).isFile(), true);
  assert.deepEqual((await readdir(base)).filter(name => name.includes('.install-') || name.includes('.previous-')), []);
  await uninstallVideoSource(plan, { register: async () => {} });
});
