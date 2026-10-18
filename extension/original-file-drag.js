import { AGENT_CHUNK_BYTES, bytesToBase64 } from './agent-protocol.js';

const SCRIPT_ID = 'pd-original-file-drop';
export const ORIGINAL_FILE_DRAG_SOURCE_PORT = 'pd-original-file-drag-source';
export const ORIGINAL_FILE_DRAG_PORT = 'pd-original-file-drag';

// Reuse granted web access; this never requests a permission or opens a file.
// Only a library page can expose its currently dragged asset. The opaque URL is
// a drag capability, not a fetch location; cache eviction cannot invalidate bytes.
export function createOriginalFileDragSource(api) {
  let port;
  return {
    expose(url, assetId) {
      if (!port) {
        port = api.runtime.connect({ name: ORIGINAL_FILE_DRAG_SOURCE_PORT });
        port.onDisconnect.addListener(() => { port = undefined; });
      }
      port.postMessage({ url, assetId });
    }
  };
}

export function createOriginalFileDragHost(api, readBlob) {
  const sources = new Map();
  let registration = Promise.resolve();
  const synchronize = async () => {
    const { origins = [] } = await api.permissions.getAll();
    const matches = origins.includes('<all_urls>') ? ['http://*/*', 'https://*/*']
      : origins.filter(origin => /^https?:\/\//u.test(origin));
    const registered = (await api.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }))[0];
    if (!matches.length) {
      if (registered) await api.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      return;
    }
    const script = { id: SCRIPT_ID, js: ['original-file-drop.js'], matches,
      runAt: 'document_start', allFrames: true, persistAcrossSessions: true };
    if (registered) await api.scripting.updateContentScripts([script]);
    else await api.scripting.registerContentScripts([script]);
  };
  return {
    sync() {
      registration = registration.catch(() => {}).then(synchronize);
      return registration;
    },
    connect(port) {
      if (port.name === ORIGINAL_FILE_DRAG_SOURCE_PORT) {
        const sourcePage = String(port.sender?.url || '').split(/[?#]/u)[0];
        if (sourcePage !== api.runtime.getURL('library.html')) { port.disconnect(); return true; }
        const receive = message => {
          const prefix = `blob:${api.runtime.getURL('')}`;
          if (typeof message?.assetId !== 'string' || !message.assetId ||
              !String(message.url).startsWith(prefix) || !/^[a-f0-9-]+$/iu.test(message.url.slice(prefix.length))) return;
          sources.set(port, { url: message.url, assetId: message.assetId });
        };
        port.onMessage.addListener(receive);
        port.onDisconnect.addListener(() => { sources.delete(port); port.onMessage.removeListener(receive); });
        return true;
      }
      if (port.name !== ORIGINAL_FILE_DRAG_PORT) return false;
      let blob, offset = 0, closed = false;
      let queue = Promise.resolve();
      const read = async message => {
        if (closed) return;
        if (!blob) {
          const source = new URL(message?.url);
          const origin = api.runtime.getURL('');
          if (!/^https?:\/\//u.test(port.sender?.url || '') || source.protocol !== 'blob:' ||
              !source.href.startsWith(`blob:${origin}`) || !/^[a-f0-9-]+$/iu.test(source.href.slice(`blob:${origin}`.length))) {
            throw new Error('只能接收本插件主动拖出的原件');
          }
          if (!await api.permissions.contains({ origins: [`${new URL(port.sender.url).origin}/*`] })) {
            throw new Error('接收网页未获授权，未读取原件');
          }
          const exposed = [...sources.values()].find(value => value.url === source.href);
          if (!exposed) throw new Error('原件拖动已结束，请回到资料库重新拖动');
          blob = await readBlob(exposed.assetId);
          if (!blob) throw new Error('原件已不可读，请回到资料库重新拖动');
          if (!closed) port.postMessage({ type: 'file', size: blob.size, mimeType: blob.type });
          return;
        }
        if (message?.offset !== offset) throw new Error('原件读取位置不一致，请重新拖动');
        const bytes = new Uint8Array(await blob.slice(offset, offset + AGENT_CHUNK_BYTES).arrayBuffer());
        offset += bytes.length;
        if (!closed) port.postMessage({ type: 'chunk', data: bytesToBase64(bytes), offset, done: offset === blob.size });
      };
      const receive = message => {
        queue = queue.then(() => read(message)).catch(error => {
          if (!closed) port.postMessage({ type: 'error', message: error.message });
          blob = undefined;
          port.disconnect();
        });
      };
      port.onMessage.addListener(receive);
      port.onDisconnect.addListener(() => { closed = true; blob = undefined; port.onMessage.removeListener(receive); });
      return true;
    }
  };
}
