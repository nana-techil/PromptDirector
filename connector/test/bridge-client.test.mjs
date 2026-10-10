import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { callExtension } from '../bridge-client.mjs';

for (const code of ['EPERM', 'EACCES', 'ENOENT', 'ECONNREFUSED']) {
  test(`local connection ${code} does not mislead users about pairing or browser state`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'pd-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const instanceId = randomUUID();
    await writeFile(join(root, 'selected.json'), JSON.stringify({ instanceId }));
    await writeFile(join(root, `${instanceId}.json`), JSON.stringify({ secret: 'fixture-secret' }));
    t.mock.method(net, 'connect', () => {
      const socket = new PassThrough();
      queueMicrotask(() => socket.emit('error', Object.assign(new Error('OS connection failure'), { code })));
      return socket;
    });
    const denied = ['EPERM', 'EACCES'].includes(code);
    await assert.rejects(callExtension('status', {}, { root }), error => {
      assert.equal(error.code, denied ? 'connector_access_denied' : 'connector_offline');
      assert.match(error.message, denied ? /权限/ : /Chrome/);
      assert(!error.message.includes('fixture-secret'));
      return true;
    });
  });
}

test('missing pairing record keeps ENOENT for discovery but gives pairing guidance without local paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(callExtension('status', {}, { root, instanceId: randomUUID() }), error => {
    assert.equal(error.code, 'ENOENT');
    assert.match(error.message, /配对/);
    assert(!error.message.includes(root));
    return true;
  });
});

test('a timed-out write sends once and reports unknown completion without silently retrying', async t => {
  const { encodeFrame, frameDecoder } = await import('../framing.mjs');
  const { instancePaths } = await import('../paths.mjs');
  const root = await mkdtemp(join(tmpdir(), 'pd-'));
  t.after(() => rm(root, { recursive:true,force:true }));
  const instanceId = randomUUID(), paths = instancePaths(root,instanceId);
  await writeFile(paths.record,JSON.stringify({secret:'fixture'}));
  let requests=0;
  const server=net.createServer(socket=>{
    const decode=frameDecoder(message=>{
      if(message.type==='authenticate')socket.write(encodeFrame({type:'ready',instanceId,protocolVersion:1,hostSessionId:'fixture'}));
      else if(message.type==='request')requests++;
    });
    socket.on('data',decode);
  });
  await new Promise(resolve=>server.listen(paths.socket,resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await assert.rejects(callExtension('edit_case',{requestId:'original-request'},{root,instanceId,timeoutMs:40}),error=>{
    assert.equal(error.code,'connector_timeout');assert.match(error.message,/原请求编号/);return true;
  });
  assert.equal(requests,1);
});
