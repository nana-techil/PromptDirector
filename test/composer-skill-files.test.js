import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareComposerSkillWrite } from '../extension/composer-skill-files.js';
import { createAgentTransfers } from '../extension/agent-transfers.js';
import { AGENT_CHUNK_BYTES, bytesToBase64 } from '../extension/agent-protocol.js';

function fixture() {
  const data = {}, blobs = new Map(), calls = [];
  const transfers = createAgentTransfers({ storage: {
    get: async keys => Object.fromEntries((keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])),
    set: async update => Object.assign(data, structuredClone(update)),
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  }, readBlob: async id => blobs.get(id), writeBlob: async (id, blob) => blobs.set(id, blob),
  deleteBlob: async id => blobs.delete(id), prepare: () => { throw Error('Skill files must not run media preparation'); } });
  return { data, blobs, transfers, calls, invoke: async (name, args) => {
    calls.push(name); return transfers[{begin_transfer:'begin',append_transfer:'append',finish_transfer:'finish'}[name]](args);
  } };
}

test('complete workspace packages preserve Unicode scripts, empty files and binary bytes across protocol chunks', async () => {
  const f = fixture();
  const bytes = Uint8Array.from({length:AGENT_CHUNK_BYTES+7}, (_,i)=>i%256);
  const input = { requestId:'whole-package', files:[
    {path:'SKILL.md',content:'---\nname: package\ndescription: Workflow\n---\n完整方法'},
    {path:'scripts/工具.py',content:'print("原样保留")\n'},
    {path:'scripts/__init__.py',content:''},
    {path:'assets/data.bin',encoding:'base64',content:bytesToBase64(bytes)}
  ] };
  const prepared = await prepareComposerSkillWrite('save_skill',input,f.invoke);
  for (let i=0;i<prepared.files.length;i++) {
    const record = await f.transfers.get(prepared.files[i].transferId);
    const blob = f.blobs.get(record.assetId);
    if (i===3) assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
    else assert.equal(await blob.text(),input.files[i].content);
  }
  const appends = f.calls.filter(name=>name==='append_transfer').length;
  const retry = await prepareComposerSkillWrite('save_skill',input,f.invoke);
  assert.deepEqual(retry,prepared);
  assert.equal(f.calls.filter(name=>name==='append_transfer').length,appends);
  await assert.rejects(prepareComposerSkillWrite('save_skill', {...input,files:[{path:'SKILL.md',content:'changed'}]},f.invoke),{code:'transfer_conflict'});
});

test('invalid package paths, conflicting bodies and cancelled work never begin a transfer', async () => {
  const f=fixture();
  for(const files of [[{path:'../SKILL.md',content:'x'}],[{path:'SKILL.md',content:'x'},{path:'SKILL.md',content:'y'}]]) {
    await assert.rejects(prepareComposerSkillWrite('save_skill',{requestId:'bad',files},f.invoke));
  }
  await assert.rejects(prepareComposerSkillWrite('save_skill',{requestId:'bad',skillMarkdown:'other',files:[{path:'SKILL.md',content:'x'}]},f.invoke));
  const controller=new AbortController();controller.abort();
  await assert.rejects(prepareComposerSkillWrite('save_skill',{requestId:'cancel',files:[{path:'SKILL.md',content:'x'}]},f.invoke,controller.signal));
  assert.equal(f.calls.length,0);
});
