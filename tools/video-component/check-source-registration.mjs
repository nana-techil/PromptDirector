import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMain } from '../../connector/is-main.mjs';

const exists = async path => {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

// Read back the OS registration, not just the installer's return value. This
// checker is also usable with an isolated native directory on macOS.
export async function checkSourceRegistration({ root, nativeDirectory, removed = false }) {
  root = resolve(root);
  const windows = process.platform === 'win32';
  const registration = join(nativeDirectory || (windows ? root : join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')), 'com.promptdirector.video.json');
  if (windows) {
    assert(process.env.SystemRoot, 'Windows system directory is required');
    const script = `$ErrorActionPreference='Stop'
$found=@()
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
 $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
 try {
  $key=$base.OpenSubKey('Software\\Google\\Chrome\\NativeMessagingHosts\\com.promptdirector.video')
  if ($null -eq $key) { $found += $null }
  else { try { $found += $key.GetValue('') } finally { $key.Dispose() } }
 } finally { $base.Dispose() }
}
ConvertTo-Json -InputObject @($found) -Compress`;
    const { stdout } = await promisify(execFile)(win32.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30_000 });
    const actual = JSON.parse(stdout);
    assert.deepEqual(actual, removed ? [null, null] : [registration, registration], 'Both HKCU views must reflect the actual source installation');
  }
  if (removed) {
    assert.equal(await exists(root), false, 'Uninstall left its runtime directory');
    assert.equal(await exists(registration), false, 'Uninstall left its Chrome manifest');
    return { distribution: 'source', removed: true };
  }
  const component = JSON.parse(await readFile(join(root, 'component.json'), 'utf8'));
  assert.equal(component.distribution, 'source');
  const manifest = JSON.parse(await readFile(registration, 'utf8'));
  assert.equal(manifest.name, 'com.promptdirector.video');
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, join(root, windows ? 'native-host.cmd' : 'native-host'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${component.extensionId}/`]);
  assert(await exists(manifest.path), 'Registered source launcher is missing');
  return { distribution: 'source', installed: true, version: component.version, registration };
}

if (isMain(import.meta.url)) {
  const [root, ...options] = process.argv.slice(2);
  assert(root, 'Usage: check-source-registration.mjs <installed-root> [--removed]');
  console.log(JSON.stringify(await checkSourceRegistration({ root, removed: options.includes('--removed') }), null, 2));
}
