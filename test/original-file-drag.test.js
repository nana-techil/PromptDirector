import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createOriginalFileDragHost, ORIGINAL_FILE_DRAG_PORT, ORIGINAL_FILE_DRAG_SOURCE_PORT } from '../extension/original-file-drag.js';
import { AGENT_CHUNK_BYTES } from '../extension/agent-protocol.js';

const origin = 'chrome-extension://pd-test/';
const url = `blob:${origin}12345678-abcd-4321-abcd-123456789012`;
function environment(origins = ['<all_urls>']) {
  let scripts = [], granted = true;
  const api = {
    runtime: { getURL: (path = "") => origin + path },
    permissions: { getAll: async () => ({ origins }), contains: async () => granted },
    scripting: {
      getRegisteredContentScripts: async () => scripts,
      registerContentScripts: async values => { scripts = values; },
      updateContentScripts: async values => { scripts = values; },
      unregisterContentScripts: async () => { scripts = []; }
    }
  };
  return { api, scripts: () => scripts, revoke: () => { granted = false; } };
}
function port(sender = { url: 'https://canvas.test/' }) {
  let receive, disconnect;
  const waiting = [];
  const values = [];
  return { name: ORIGINAL_FILE_DRAG_PORT, sender,
    onMessage: { addListener: fn => { receive = fn; }, removeListener: () => {} },
    onDisconnect: { addListener: fn => { disconnect = fn; } },
    postMessage: value => { values.push(value); waiting.shift()?.(); },
    disconnect: () => disconnect?.(),
    send: value => receive(value),
    async request(value) {
      const next = new Promise(resolve => waiting.push(resolve));
      receive(value); await next; return values.at(-1);
    }
  };
}
function expose(host, assetId = 'original', dragUrl = url) {
  const source = port({ url: origin + 'library.html' }); source.name = ORIGINAL_FILE_DRAG_SOURCE_PORT;
  host.connect(source); source.send({ url: dragUrl, assetId }); return source;
}
test('receiver registration uses only already granted origins and follows revocation', async () => {
  const origins = ['https://canvas.test/*', 'file:///*'];
  const fixture = environment(origins), host = createOriginalFileDragHost(fixture.api);
  await host.sync();
  assert.deepEqual(fixture.scripts()[0].matches, ['https://canvas.test/*']);
  origins.splice(0); await host.sync();
  assert.deepEqual(fixture.scripts(), []);
});
test('existing all-sites Agent permission covers web receivers without requesting new access', async () => {
  const fixture = environment(), host = createOriginalFileDragHost(fixture.api);
  await Promise.all([host.sync(), host.sync()]);
  assert.deepEqual(fixture.scripts()[0].matches, ['http://*/*', 'https://*/*']);
  assert.equal(fixture.scripts().length, 1);
});
test('canvas receives every original byte across multiple transport chunks, including its MIME', async () => {
  const bytes = Uint8Array.from({ length: AGENT_CHUNK_BYTES * 2 + 19 }, (_, i) => i % 251);
  const fixture = environment(), host = createOriginalFileDragHost(fixture.api, async value => {
    assert.equal(value, 'original'); return new Blob([bytes], { type: 'video/mp4' });
  });
  expose(host);
  const connection = port(); host.connect(connection);
  assert.deepEqual(await connection.request({ url }), { type: 'file', size: bytes.length, mimeType: 'video/mp4' });
  const chunks = []; let offset = 0, done = false;
  while (!done) {
    const response = await connection.request({ offset });
    assert.equal(response.type, 'chunk');
    chunks.push(Buffer.from(response.data, 'base64')); offset = response.offset; done = response.done;
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  connection.disconnect();
});
test('empty original documents retain a valid zero-byte File', async () => {
  const host = createOriginalFileDragHost(environment().api, async () => new Blob([], { type: 'text/plain' }));
  expose(host);
  const connection = port(); host.connect(connection);
  assert.equal((await connection.request({ url })).size, 0);
  assert.deepEqual(await connection.request({ offset: 0 }), { type: 'chunk', data: '', offset: 0, done: true });
});
test('a webpage cannot turn the receiver into a network, local-file or another-extension reader', async () => {
  for (const value of ['https://private.test/secret', 'file:///private/secret', 'blob:https://canvas.test/id',
    'blob:chrome-extension://other/1234', `${url}/secret`, `${url}?secret=1`]) {
    let reads = 0;
    const host = createOriginalFileDragHost(environment().api, async () => { reads++; });
    expose(host);
  const connection = port(); host.connect(connection);
    assert.equal((await connection.request({ url: value })).type, 'error', value);
    assert.equal(reads, 0);
  }
});
test('revoked receiving-site permission prevents reading even a known original Blob URL', async () => {
  const fixture = environment(); fixture.revoke(); let reads = 0;
  const host = createOriginalFileDragHost(fixture.api, async () => { reads++; });
  expose(host);
  const connection = port(); host.connect(connection);
  assert.equal((await connection.request({ url })).type, 'error');
  assert.equal(reads, 0);
});
test('extension pages and unidentified senders cannot use the web drop file reader', async () => {
  for (const sender of [{}, { url: origin + 'library.html' }]) {
    let reads = 0;
    const host = createOriginalFileDragHost(environment().api, async () => { reads++; });
    const connection = port(sender); host.connect(connection);
    assert.equal((await connection.request({ url })).type, 'error');
    assert.equal(reads, 0);
  }
});
test('misordered chunk requests fail rather than silently return a truncated original', async () => {
  const host = createOriginalFileDragHost(environment().api, async () => new Blob(['original']));
  expose(host);
  const connection = port(); host.connect(connection);
  await connection.request({ url });
  assert.equal((await connection.request({ offset: 1 })).type, 'error');
});
test('page scripts cannot forge a trusted library drag to read private originals', () => {
  const listeners = new Map(); let connections = 0, prevented = 0;
  vm.runInNewContext(readFileSync(new URL('../extension/original-file-drop.js', import.meta.url), 'utf8'), {
    window: { addEventListener: (type, fn) => listeners.set(type, fn) },
    chrome: { runtime: { getURL: () => origin, connect: () => { connections++; } } }
  });
  const event = { isTrusted: false, dataTransfer: { types: ['application/x-promptdirector-file'],
    getData: () => JSON.stringify({ url, name: 'private.png' }) }, preventDefault: () => { prevented++; } };
  listeners.get('drop')(event); listeners.get('dragover')(event);
  assert.equal(connections, 0); assert.equal(prevented, 0);
  listeners.get('drop')({ ...event, isTrusted: true, dataTransfer: { types: ['text/plain'] } });
  assert.equal(connections, 0);
});

test('only the last asset explicitly dragged by a library page can be read', async () => {
  let reads = 0;
  const host = createOriginalFileDragHost(environment().api, async () => { reads++; return new Blob(['original']); });
  const unexposed = port(); host.connect(unexposed);
  assert.equal((await unexposed.request({url})).type, 'error');
  assert.equal(reads, 0);
  const source = expose(host);
  const other = url.replace('12345678', '87654321');
  source.send({url: other, assetId: 'next-original'});
  const old = port(); host.connect(old);
  assert.equal((await old.request({url})).type, 'error');
  source.disconnect();
  const closed = port(); host.connect(closed);
  assert.equal((await closed.request({url:other})).type, 'error');
  assert.equal(reads, 0);
});
test('webpages cannot register their own asset id as a drag capability', async () => {
  let disconnected = false, reads = 0;
  const host = createOriginalFileDragHost(environment().api, async () => { reads++; });
  const source = port(); source.name = ORIGINAL_FILE_DRAG_SOURCE_PORT;
  source.disconnect = () => { disconnected = true; };
  host.connect(source);
  assert(disconnected);
  const receiver = port(); host.connect(receiver);
  assert.equal((await receiver.request({url})).type, 'error');
  assert.equal(reads, 0);
});
