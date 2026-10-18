import { videoComponentDownload } from './video-component-config.js';
import { operationBudget } from './resource-policy.js';

export const VIDEO_SETUP_KEY = 'videoComponentSetup';
export const VIDEO_SETUP_ALARM = 'video-component-setup';
// Checks exist only during an explicitly requested installation. A one-shot
// alarm survives worker suspension; the memory timer keeps an open view responsive.
export function createVideoComponentSetup({ storage, inspect, platform, homepage, downloads, resume,
  alarms, fetchImpl = fetch, notify = () => {}, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  let timer, starting, checking = false;
  const publish = async state => { await storage.set({ [VIDEO_SETUP_KEY]: state }); await notify(state); return state; };
  const get = async () => (await storage.get(VIDEO_SETUP_KEY))[VIDEO_SETUP_KEY] || { phase: 'idle' };
  const stop = async () => { if (timer) cancel(timer); timer = null; await alarms.clear(VIDEO_SETUP_ALARM); };
  const arm = async () => {
    await stop();
    const state = await get();
    if (!['downloading', 'review', 'installing'].includes(state.phase)) return;
    // Keep the existing 2s-to-60s backoff across worker restarts. Neither a wakeup
    // nor opening a view renews the explicitly requested operation's deadline.
    const attempts = state.checkAttempts || 0;
    const delay = Math.max(0, Math.min(60_000, 2000 * 2 ** Math.min(attempts, 5),
      operationBudget().maxDurationMs - (now() - state.startedAt)));
    await storage.set({ [VIDEO_SETUP_KEY]: { ...state, checkAttempts: attempts + 1 } });
    await alarms.create(VIDEO_SETUP_ALARM, { when: now() + delay });
    timer = schedule(() => void check(), delay);
  };
  async function check() {
    if (checking) return get();
    checking = true;
    try {
      const state = await get();
      if (!['downloading', 'review', 'installing'].includes(state.phase)) { await stop(); return state; }
      if (now() - state.startedAt >= operationBudget().maxDurationMs) {
        await stop(); return publish({ ...state, phase: 'paused', message: '安装尚未完成，完成后点继续即可' });
      }
      try {
        const result = await inspect();
        if (result.available) {
          await stop(); await publish({ phase: 'ready', versions: result.versions });
          await resume(); return get();
        }
      } catch { /* A host is unavailable until the system installer finishes. */ }
      if (['downloading', 'review'].includes(state.phase)) {
        const [download] = await downloads.search({ id: state.downloadId });
        if (!download || download.state === 'interrupted') {
          await stop(); return publish({ ...state, phase: 'failed', message: '安装包下载中断，请重试' });
        }
        if (download.state === 'complete') await publish({ ...state, phase: 'installing' });
        else if (download.danger && !['safe', 'accepted', 'allowlistedByPolicy', 'deepScannedSafe', 'asyncScanning', 'asyncLocalPasswordScanning'].includes(download.danger)) {
          if (state.phase !== 'review') await publish({ ...state, phase: 'review' });
        } else if (download.bytesReceived !== state.bytesReceived || state.phase === 'review') await publish({ ...state, phase: 'downloading', bytesReceived: download.bytesReceived, totalBytes: download.totalBytes });
      }
      await arm(); return get();
    } catch (error) {
      await stop(); return publish({ ...(await get()), phase: 'failed', message: error.message });
    } finally { checking = false; }
  }
  return {
    get, check, restore: check,
    async start({ restart = false } = {}) {
      if (starting) return starting;
      starting = (async () => {
        await stop();
        try {
          const current = await get();
          try {
            if ((await inspect()).available) { await publish({ phase: 'ready' }); await resume(); return get(); }
          } catch { /* Offer the complete installer. */ }
          if (!restart && ['downloading', 'review', 'installing'].includes(current.phase)) { await arm(); return get(); }
          const url = videoComponentDownload((await platform()).os, homepage);
          const response = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(response.status === 404 ? '视频组件安装包尚未发布，待保存内容已保留' : '暂时无法下载安装包，请稍后重试');
          const downloadId = await downloads.download({ url, saveAs: false });
          await publish({ phase: 'downloading', downloadId, startedAt: now() });
          await arm(); return get();
        } catch (error) { return publish({ phase: 'failed', message: ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name) ? '暂时无法下载安装包，请稍后重试' : error.message }); }
      })();
      try { return await starting; } finally { starting = null; }
    },
    async continue() {
      await stop();
      const state = await get();
      await publish({ ...state, phase: state.downloadId ? 'installing' : 'paused', startedAt: now(), checkAttempts: 0 });
      if (!state.downloadId) {
        if ((await inspect()).available) { await publish({ phase: 'ready' }); await resume(); }
        return get();
      }
      return check();
    },
    stop
  };
}
