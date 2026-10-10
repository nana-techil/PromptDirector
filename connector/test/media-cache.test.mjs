import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { receiveMedia, stageFiles } from '../transfers.mjs';

test('Skill upload checks all declared package limits before sending any file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pd-skill-limits-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const small = join(root, 'small.md'), large = join(root, 'large.md');
  await writeFile(small, '123'); await writeFile(large, '12345');
  let calls = 0;
  const call = async () => { calls++; throw Error('Unexpected upload'); };
  const files = [small, large].map(path => ({path}));
  for (const [limits, message] of [
    [{maxFileCount:1,maxFileBytes:10,maxArchiveBytes:10}, /文件数量/],
    [{maxFileCount:2,maxFileBytes:4,maxArchiveBytes:10}, /单文件/],
    [{maxFileCount:2,maxFileBytes:5,maxArchiveBytes:7}, /总大小/]
  ]) await assert.rejects(stageFiles(files,undefined,'limits',call,{purpose:'skill-file',limits}), message);
  assert.equal(calls,0,'a later invalid file must not leave earlier files uploaded');
});

test('reusing an original checks current library ownership and local bytes without retransferring all chunks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pd-media-cache-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  let bytes = Buffer.from('original-video-content'.repeat(20));
  let calls = 0, deleted = false;
  const call = async (_, {offset}) => {
    calls++;
    if (deleted) throw Object.assign(new Error('案例不存在'), {code:'case_not_found'});
    return {offset,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length,
      name:'original.mp4',mimeType:'video/mp4',data:bytes.subarray(offset,offset+29).toString('base64'),nextOffset:offset+29 < bytes.length ? offset+29 : null};
  };
  const input = {caseId:'case',assetId:'asset'};
  const first = await receiveMedia(input,call,root);
  assert(calls > 1);
  calls = 0;
  const reused = await receiveMedia(input,call,root);
  assert.equal(reused.path,first.path);
  assert.equal(calls,1,'the unchanged original needs one current-library check, not another complete transfer');
  await writeFile(first.path,Buffer.alloc(bytes.length));
  calls = 0;
  assert.deepEqual(await readFile((await receiveMedia(input,call,root)).path),bytes);
  assert.deepEqual(await readFile(first.path), Buffer.alloc(bytes.length), 'edited download is preserved');
  assert(calls > 1,'same-size corrupted local files must be downloaded and verified again');
  bytes = Buffer.from('changed-content'.repeat(20));
  const changed = await receiveMedia(input,call,root);
  assert.notEqual(changed.sha256,first.sha256);
  assert.deepEqual(await readFile(changed.path),bytes);
  deleted = true;
  await assert.rejects(receiveMedia(input,call,root),{code:'case_not_found'});
});

test('an in-flight upload protects an expired connector copy from concurrent cleanup', async t => {
  const { mkdir } = await import('node:fs/promises');
  const { recordCacheFile, sweepTransferCache, CACHE_IDLE_MS } = await import('../transfer-cache.mjs');
  const root = await mkdtemp(join(tmpdir(), 'pd-cache-upload-'));
  const previous = process.env.PROMPTDIRECTOR_CONNECTOR_HOME;
  process.env.PROMPTDIRECTOR_CONNECTOR_HOME = root;
  t.after(async () => { if (previous === undefined) delete process.env.PROMPTDIRECTOR_CONNECTOR_HOME; else process.env.PROMPTDIRECTOR_CONNECTOR_HOME = previous; await rm(root,{recursive:true,force:true}); });
  const directory = join(root,'files'); await mkdir(directory);
  const path = join(directory,'original.png'); await writeFile(path,'original');
  await recordCacheFile(path,{owned:true,now:Date.now()-CACHE_IDLE_MS*2});
  const calls=[];
  await stageFiles([{path}],undefined,'upload',async operation=>{
    calls.push(operation);
    assert.equal((await sweepTransferCache(directory,{now:Date.now()+CACHE_IDLE_MS*2})).removed,0);
    assert.equal(await readFile(path,'utf8'),'original');
    return operation==='begin_transfer'?{state:'complete'}:{};
  });
  assert.deepEqual(calls,['begin_transfer','finish_transfer']);
  assert.equal((await sweepTransferCache(directory)).removed,0,'successful reuse refreshes idle age');
});
