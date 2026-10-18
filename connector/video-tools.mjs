import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function discoverVideoTools({ env = process.env, executable = process.execPath, root, configuredOnly = false } = {}) {
  let configured = {};
  try { if (root) configured = JSON.parse(await readFile(join(root, 'video-tools.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // GUI-launched Chrome need not inherit the user's terminal PATH. Installation
  // records the resolved paths; a running source host uses only that record.
  const common = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin']
    : process.platform === 'win32' && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Microsoft/WinGet/Links')] : [];
  const directories = configuredOnly ? [] : [...new Set([dirname(executable), ...(env.PATH || '').split(delimiter), ...common].filter(isAbsolute))];
  const find = async (name, override, rediscover = false) => {
    const suffixes = process.platform === 'win32' ? ['.exe'] : [''];
    const candidates = [...(override ? [override] : []),
      ...(!override || rediscover ? directories.flatMap(directory => suffixes.map(suffix => join(directory, name + suffix))) : [])];
    for (const candidate of candidates) {
      if (!isAbsolute(candidate)) continue;
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed executable. */ }
    }
    return '';
  };
  const settings = configuredOnly ? configured : { ...configured,
    ...(env.PROMPTDIRECTOR_YTDLP ? { ytDlp: env.PROMPTDIRECTOR_YTDLP } : {}),
    ...(env.PROMPTDIRECTOR_FFMPEG ? { ffmpeg: env.PROMPTDIRECTOR_FFMPEG } : {}),
    ...(env.PROMPTDIRECTOR_FFPROBE ? { ffprobe: env.PROMPTDIRECTOR_FFPROBE } : {}),
    ...(env.PROMPTDIRECTOR_DENO ? { deno: env.PROMPTDIRECTOR_DENO } : {}) };
  const ytDlp = await find('yt-dlp', settings.ytDlp, !configuredOnly && !env.PROMPTDIRECTOR_YTDLP);
  const ffmpeg = await find('ffmpeg', settings.ffmpeg, !configuredOnly && !env.PROMPTDIRECTOR_FFMPEG);
  const ffprobe = await find('ffprobe', settings.ffprobe || (ffmpeg ? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : ''), !configuredOnly && !env.PROMPTDIRECTOR_FFPROBE);
  const deno = await find('deno', settings.deno, !configuredOnly && !env.PROMPTDIRECTOR_DENO);
  return { ytDlp, ffmpeg, ffprobe, deno };
}

export async function videoToolsStatus(tools) {
  const versions = {};
  for (const [name, path] of Object.entries(tools)) {
    if (!path) continue;
    try { versions[name] = (await exec(path, name === 'ytDlp' ? ['--ignore-config', '--version'] : [name === 'deno' ? '--version' : '-version'], { timeout: 10_000, windowsHide: true })).stdout.split('\n')[0]; }
    catch (error) {
      if (process.env.PROMPTDIRECTOR_DEBUG) console.error(`[video-tools] ${name}: ${error.stderr || error.message}`);
    }
  }
  return { available: Boolean(versions.ytDlp && versions.ffmpeg && versions.ffprobe), versions,
    missing: ['ytDlp', 'ffmpeg', 'ffprobe'].filter(name => !versions[name]) };
}
