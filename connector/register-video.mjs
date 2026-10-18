import { readFile, writeFile, mkdir, cp, rm, lstat, rename, chmod, access, realpath } from 'node:fs/promises';
import { join, dirname, resolve, win32 } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMain } from './is-main.mjs';

export async function registerPackagedVideo(directory = dirname(dirname(fileURLToPath(import.meta.url)))) {
  const config = JSON.parse(await readFile(join(directory, 'component.json'), 'utf8'));
  if (!/^[a-p]{32}$/u.test(config.extensionId)) throw new Error('Invalid extension identity.');
  const exec = promisify(execFile);
  for (const [name, args] of [['yt-dlp', ['--ignore-config', '--version']], ['ffmpeg', ['-version']], ['ffprobe', ['-version']]]) {
    await exec(join(directory, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), args, { windowsHide: true, timeout: 30_000 });
  }
  const manifest = { name: 'com.promptdirector.video', description: 'PromptDirector video component',
    path: join(directory, process.platform === 'win32' ? 'native-host.cmd' : 'native-host'), type: 'stdio',
    allowed_origins: [`chrome-extension://${config.extensionId}/`] };
  await writeFile(join(directory, 'native-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

// Explicit source-only allowlist. No Agent, npm dependencies, credentials or
// downloaded binaries enter the standalone source package or its installed copy.
export const VIDEO_SOURCE_FILES = [
  'connector/video-host.mjs', 'connector/video-service.mjs', 'connector/video-tools.mjs',
  'connector/register-video.mjs', 'connector/node-command.mjs', 'connector/framing.mjs', 'connector/is-main.mjs',
  'extension/agent-protocol.js', 'extension/resource-policy.js', 'extension/video-component-config.js',
  'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'
];
export const VIDEO_DEPENDENCY_HELP = {
  node: 'Node.js 22.13+ (LTS): https://nodejs.org/en/download/',
  ytDlp: 'yt-dlp (official standalone includes EJS): https://github.com/yt-dlp/yt-dlp#installation',
  ffmpeg: 'FFmpeg / FFprobe (use both programs): https://ffmpeg.org/download.html'
};
const sourceDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function copyUserTool(from, to) {
  // Preserve macOS download provenance: copying a user-provided executable must
  // not silently remove quarantine or other extended attributes.
  if (process.platform === 'darwin') await promisify(execFile)('/usr/bin/ditto', ['--rsrc', '--extattr', '--qtn', await realpath(from), to]);
  else await cp(from, to, { dereference: true });
}

export async function videoSourcePlan({ directory = sourceDirectory, root, nativeDirectory,
  platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('The source video component supports macOS and Windows.');
  const config = await readJson(join(directory, 'component.json'));
  if (config.distribution !== 'source' || !/^[a-p]{32}$/u.test(config.extensionId) || !/^\d+\.\d+\.\d+$/u.test(config.version)) throw new Error('Invalid source component identity. Download a new source package.');
  if (!root && platform === 'win32' && !env.LOCALAPPDATA) throw new Error('Windows LOCALAPPDATA is unavailable.');
  root = resolve(root || (platform === 'darwin' ? join(home, 'Library/Application Support/PromptDirector/VideoComponent-Source') : join(env.LOCALAPPDATA, 'PromptDirector/VideoComponent-Source')));
  nativeDirectory = resolve(nativeDirectory || (platform === 'darwin' ? join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts') : root));
  const { nodeCommand } = await import('./node-command.mjs');
  return { directory: resolve(directory), root, nativeDirectory, platform, config,
    launcher: join(root, platform === 'win32' ? 'native-host.cmd' : 'native-host'),
    registration: join(nativeDirectory, 'com.promptdirector.video.json'), node: nodeCommand() };
}

export function videoSourceLauncher(plan) {
  const entry = join(plan.root, 'connector/video-host.mjs');
  if (plan.platform !== 'win32') return `#!/bin/sh\nexec ${shellQuote(plan.node)} ${shellQuote(entry)} "$@"\n`;
  const quote = value => {
    if (/["\r\n]/u.test(value)) throw new Error('Invalid Windows installation path.');
    return value.replaceAll('%', '%%');
  };
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%SystemRoot%\\System32\\chcp.com" 65001 >nul\r\n"${quote(plan.node)}" "${quote(entry)}" %*\r\n`;
}

// Snapshot both views before changing either one. A write can succeed even when
// its readback fails, so rollback also checks the attempted view's current value.
export async function registerVideoViews(registration, registry) {
  const views = ['Registry32', 'Registry64'];
  const previous = await registry.snapshot();
  const attempted = [];
  try {
    for (const [index, view] of views.entries()) {
      attempted.push(index);
      await registry.write(view, registration);
    }
  } catch (error) {
    for (const index of attempted.reverse()) {
      try { await registry.restoreIfCurrent(views[index], registration, previous[index]); }
      catch (rollbackError) { (error.rollbackErrors ??= []).push(rollbackError.message); }
    }
    throw error;
  }
}

// Values are data, never interpolated as PowerShell. Conditional restoration is
// performed in the same native operation as the read, preserving later writers.
export function windowsVideoRegistry(plan, { keyName = 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.promptdirector.video' } = {}) {
  if (!process.env.SystemRoot) throw new Error('Windows system directory is unavailable.');
  const script = `$ErrorActionPreference='Stop'
$name=$env:PROMPTDIRECTOR_VIDEO_REGISTRY_KEY
if ($env:PROMPTDIRECTOR_VIDEO_REGISTRY_OPERATION -eq 'snapshot') {
 $snapshots=@()
 foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
  try {
   $key=$base.OpenSubKey($name)
   if ($null -eq $key) { $snapshots += @{exists=$false} }
   else {
    try {
     $hasValue=$key.GetValueNames() -contains ''
     $value=$null; $kind=$null
     if ($hasValue) {
      $value=$key.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind=$key.GetValueKind('').ToString()
     }
     $snapshots += @{exists=$true; hasValue=$hasValue; value=$value; kind=$kind}
    } finally { $key.Dispose() }
   }
  } finally { $base.Dispose() }
 }
 ConvertTo-Json -InputObject @($snapshots) -Compress -Depth 5
} else {
 $view=[Enum]::Parse([Microsoft.Win32.RegistryView],$env:PROMPTDIRECTOR_VIDEO_REGISTRY_VIEW)
 $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
 try {
  if ($env:PROMPTDIRECTOR_VIDEO_REGISTRY_OPERATION -eq 'write') {
   $key=$base.CreateSubKey($name)
   try {
    $key.SetValue('',$env:PROMPTDIRECTOR_VIDEO_MANIFEST,[Microsoft.Win32.RegistryValueKind]::String)
    if ($key.GetValue('') -cne $env:PROMPTDIRECTOR_VIDEO_MANIFEST) { throw 'Video registration readback mismatch' }
   } finally { $key.Dispose() }
  } elseif ($env:PROMPTDIRECTOR_VIDEO_REGISTRY_OPERATION -eq 'restore') {
   $key=$base.OpenSubKey($name,$true)
   if ($null -ne $key) {
    $deleteEmpty=$false
    try {
     if ($key.GetValue('') -ceq $env:PROMPTDIRECTOR_VIDEO_MANIFEST) {
      $previous=ConvertFrom-Json $env:PROMPTDIRECTOR_VIDEO_PREVIOUS
      if ($previous.exists -and $previous.hasValue) {
       $kind=[Enum]::Parse([Microsoft.Win32.RegistryValueKind],$previous.kind)
       $key.SetValue('',$previous.value,$kind)
      } else {
       $key.DeleteValue('',$false)
       $deleteEmpty=(!$previous.exists -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0)
      }
     }
    } finally { $key.Dispose() }
    if ($deleteEmpty) { $base.DeleteSubKey($name) }
   }
  } else { throw 'Invalid video registry operation' }
 } finally { $base.Dispose() }
}`;
  const run = async (operation, view, previous) => {
    const { stdout } = await promisify(execFile)(win32.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30_000, env: { ...process.env, PROMPTDIRECTOR_VIDEO_MANIFEST: plan.registration,
        PROMPTDIRECTOR_VIDEO_REGISTRY_KEY: keyName,
        PROMPTDIRECTOR_VIDEO_REGISTRY_OPERATION: operation, PROMPTDIRECTOR_VIDEO_REGISTRY_VIEW: view || '',
        PROMPTDIRECTOR_VIDEO_PREVIOUS: JSON.stringify(previous || {}) } });
    return stdout;
  };
  return {
    snapshot: async () => JSON.parse(await run('snapshot')),
    write: view => run('write', view),
    restoreIfCurrent: (view, _registration, previous) => run('restore', view, previous)
  };
}
async function windowsRegistration(plan, remove = false) {
  const registry = windowsVideoRegistry(plan);
  if (!remove) return registerVideoViews(plan.registration, registry);
  for (const view of ['Registry32', 'Registry64']) await registry.restoreIfCurrent(view, plan.registration, { exists: false });
}

async function assertOwnedRoot(plan) {
  let info;
  try { info = await lstat(plan.root); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && info.uid !== process.getuid())) throw new Error('Video installation directory is not owned by this user.');
  const installed = await readJson(join(plan.root, 'component.json'));
  if (installed.distribution !== 'source' || installed.extensionId !== plan.config.extensionId) throw new Error('Refusing to replace an unrelated installation directory.');
  return true;
}

export async function installVideoSource(plan, { env = process.env, register = windowsRegistration } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(VIDEO_DEPENDENCY_HELP.node);
  const { discoverVideoTools, videoToolsStatus } = await import('./video-tools.mjs');
  const installed = await assertOwnedRoot(plan);
  const stage = `${plan.root}.install-${randomUUID()}`, backup = `${plan.root}.previous-${randomUUID()}`;
  await mkdir(stage, { recursive: true, mode: 0o700 });
  let swapped = false, registered = false;
  try {
    const tools = await discoverVideoTools({ env, root: installed ? plan.root : undefined });
    const manualNames = { ytDlp: plan.platform === 'win32' ? ['yt-dlp.exe'] : ['yt-dlp', 'yt-dlp_macos'],
      ffmpeg: [plan.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'], ffprobe: [plan.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'] };
    const ownedTools = new Map();
    for (const [key, names] of Object.entries(manualNames)) {
      for (const name of names) {
        const from = join(plan.directory, 'tools', name);
        try { await access(from); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const target = join(stage, 'bin', names[0]);
        await mkdir(dirname(target), { recursive: true });
        await copyUserTool(from, target);
        await chmod(target, 0o700);
        tools[key] = target; ownedTools.set(key, names[0]); break;
      }
      // Retain manually installed binaries when updating from a fresh source ZIP.
      if (!ownedTools.has(key) && tools[key]?.startsWith(join(plan.root, 'bin') + (plan.platform === 'win32' ? '\\' : '/'))) {
        const target = join(stage, 'bin', names[0]);
        await mkdir(dirname(target), { recursive: true }); await copyUserTool(tools[key], target);
        tools[key] = target; ownedTools.set(key, names[0]);
      }
    }
    const status = await videoToolsStatus(tools);
    if (!status.available) throw new Error(`Required programs are missing or blocked: ${status.missing.join(', ')}.\n${[...new Set(status.missing.map(name => VIDEO_DEPENDENCY_HELP[name === 'ffprobe' ? 'ffmpeg' : name]))].join('\n')}\nInstall the dependencies, then run this installer again. Do not disable system protection.`);
    for (const [key, name] of ownedTools) tools[key] = join(plan.root, 'bin', name);
    for (const name of VIDEO_SOURCE_FILES) {
      await mkdir(dirname(join(stage, name)), { recursive: true });
      await cp(join(plan.directory, name), join(stage, name));
    }
    await writeFile(join(stage, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(stage, 'component.json'), JSON.stringify(plan.config));
    await writeFile(join(stage, 'video-tools.json'), JSON.stringify(tools, null, 2), { mode: 0o600 });
    await writeFile(join(stage, plan.platform === 'win32' ? 'native-host.cmd' : 'native-host'), videoSourceLauncher(plan), { mode: 0o700 });
    if (installed) await rename(plan.root, backup);
    try { await rename(stage, plan.root); swapped = true; }
    catch (error) { if (installed) await rename(backup, plan.root); throw error; }
    await mkdir(plan.nativeDirectory, { recursive: true });
    const manifest = { name: 'com.promptdirector.video', description: 'PromptDirector source video component',
      path: plan.launcher, type: 'stdio', allowed_origins: [`chrome-extension://${plan.config.extensionId}/`] };
    const temporary = `${plan.registration}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(temporary, plan.registration);
    if (plan.platform === 'win32') await register(plan);
    registered = true;
    await rm(backup, { recursive: true, force: true }).catch(error => console.warn(`Previous component cleanup: ${error.message}`));
    return { installed: true, version: plan.config.version, root: plan.root, versions: status.versions };
  } catch (error) {
    // Once registered, an installation must keep its launcher path usable.
    // Restore the previous runtime when a replacement fails.
    if (swapped && installed && !registered) { await rm(plan.root, { recursive: true, force: true }); await rename(backup, plan.root); }
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function uninstallVideoSource(plan, { register = windowsRegistration } = {}) {
  if (!await assertOwnedRoot(plan)) return { removed: false };
  if (plan.platform === 'win32') await register(plan, true);
  else {
    try {
      const manifest = await readJson(plan.registration);
      if (manifest.name === 'com.promptdirector.video' && manifest.path === plan.launcher) await rm(plan.registration);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await rm(plan.root, { recursive: true });
  return { removed: true };
}

if (isMain(import.meta.url)) {
  (async () => {
    const command = process.argv[2];
    if (!command) return registerPackagedVideo();
    const plan = await videoSourcePlan();
    if (command === 'install') {
      const result = await installVideoSource(plan);
      console.log(`Video component installed (${result.version}). Return to PromptDirector to continue saving.\n视频组件已安装，请返回 PromptDirector 继续保存。`);
    } else if (command === 'uninstall') {
      await uninstallVideoSource(plan); console.log('Video component removed. Browser library and external dependencies were kept.\n视频组件已卸载，浏览器资料库和外部依赖保持不变。');
    } else throw new Error('Usage: node connector/register-video.mjs install | uninstall');
  })().catch(error => {
    console.error(error.message);
    if (error.rollbackErrors?.length) console.error(`Registration rollback incomplete: ${error.rollbackErrors.join('; ')}`);
    process.exitCode = 1;
  });
}
