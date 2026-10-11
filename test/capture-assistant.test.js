import test from 'node:test';
import assert from 'node:assert/strict';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
import { CAPTURE_OPERATION_SPECS } from '../extension/capture-operation-specs.js';
const runtime = { aiTaskAssignments: { creativePlanning: { providerId: 'deepseek', model: 'deepseek-flash' } },
  aiSettings: { apiKey: 'isolated-fixture', consent: true } };
const input = { tabId: 1, sourceUrl: 'https://example.test/', instruction: 'Collect the original prompt', locale: 'en' };
const preview = { captureId: 'preview', revision: 1, state: 'preview', tabId: 1, sourceUrl: input.sourceUrl };

test('new project creation uses the shared synchronous durable project receipt instead of incorrectly polling it as an Agent task', async () => {
  const project = { id: 'actually-created', name: '用户指定的新项目' }; const calls = [];
  const result = await runCaptureAssistant({ ...input, instruction: '新建项目并保存' }, { runtime, signal: new AbortController().signal,
    call: async (name, args) => { calls.push(name); assert.equal(args.name, project.name); return { ok: true, requestId: args.requestId, project }; },
    execute: async (_request, _settings, _images, { toolRuntime }) => {
      const receipt = await toolRuntime.execute('create_project', { requestId: 'project-request', name: project.name });
      assert.equal(receipt.data.project.id, project.id); assert.equal(receipt.data.ok, true); return { text: '取得真实项目编号' };
    } });
  assert.equal(result.ok, true); assert.deepEqual(calls, ['read_capture', 'create_project']);
});

test('a newer preview-only request is not forced to save by an inherited task goal', async () => {
  let current = { ...preview, selections: [{ candidateId: 'original' }], task: { outcome: 'save', candidateIds: ['original'], state: 'active' } };
  const result = await runCaptureAssistant({ ...input, captureId: preview.captureId, instruction: '改一下选择，先不要保存' }, {
    runtime, signal: new AbortController().signal,
    call: async name => { assert(['read_capture', 'update_capture'].includes(name)); return name === 'read_capture' ? current : { state: 'completed', result: { ...current, revision: 2 } }; },
    execute: async (_request, _settings, _images, { toolRuntime }) => {
      await toolRuntime.execute('update_capture', { captureId: preview.captureId, expectedRevision: 1, selections: [{ candidateId: 'original', includeText: true, selectedMediaIds: [] }] });
      assert.equal(await toolRuntime.finishTurn({}), undefined); return { text: '仅修改预览' };
    } });
  assert.equal(result.ok, true); assert.equal(result.outcome, 'preview'); assert(!result.saveResult);
});
function fixture(execute, extras = {}) {
  const calls = [];
  return { calls, run: () => runCaptureAssistant({ ...input, ...extras }, { runtime, signal: new AbortController().signal,
    call: async (operation, args) => { calls.push({ operation, args }); return operation === 'read_capture' ? preview : { state: 'completed', result: preview }; }, execute }) };
}

test('the plugin assistant can inspect any actual library case, not only this chat save receipts', async () => {
  const calls = [];
  const result = await runCaptureAssistant({ ...input, instruction: '提示词没存全',
    messages: [{ role: 'result', result: { results: [{ status: 'saved', entryId: 'real-saved-case' }] } }] }, {
    runtime, signal: new AbortController().signal,
    call: async (name,args) => { calls.push(name); return name === 'read_case_details' ? { content: 'Full actual prompt', nextOffset: null } : { content: 'Current reply' }; },
    execute: async (_request,_settings,_images,{toolRuntime}) => {
      assert(toolRuntime.specs.some(spec => spec.name === 'read_case_details'));
      assert.equal((await toolRuntime.execute('read_case_details',{caseId:'unrelated',parts:['source','media']})).data.content,'Full actual prompt');
      const read=await toolRuntime.execute('read_case_details',{caseId:'real-saved-case',parts:['source','media','document']});
      assert.equal(read.data.content,'Full actual prompt');return {text:'已核对实际保存的原文。'};
    }
  });
  assert(result.ok);assert.deepEqual(calls,['read_capture','read_case_details','read_case_details']);
});

test('asking how to capture or save can answer normally without scanning, selecting or saving the webpage', async () => {
  for (const instruction of ['这个怎么采集？', '怎么保存到项目？', 'How do I save this?']) {
    const f = fixture(async () => ({ text: 'Use the capture or save action.' }), { instruction });
    assert.equal((await f.run()).ok, true); assert.deepEqual(f.calls, [{ operation: 'read_capture', args: { part: 'context', tabId: 1 } }]);
  }
});

test('collector assistant uses shared MCP tools lazily, preserves the configured model and rejects another page or preview', async () => {
  const f = fixture(async (request, _settings, _images, { toolRuntime }) => {
    assert.equal(request.session.aiProfile.model, 'deepseek-flash'); assert.equal(request.route, 'chat');
    assert.deepEqual(toolRuntime.specs.slice(0, 4), CAPTURE_OPERATION_SPECS);
    assert(!toolRuntime.specs.some(spec => /delete|trash|generat/u.test(spec.name)));
    assert.equal((await toolRuntime.execute('prepare_capture', { tabId: 2 })).data.code, 'capture_scope_changed');
    await toolRuntime.execute('prepare_capture', { tabId: 1 });
    assert.equal((await toolRuntime.execute('update_capture', { captureId: 'other', expectedRevision: 1 })).data.code, 'capture_scope_changed');
    await toolRuntime.execute('update_capture', { captureId: 'preview', expectedRevision: 1, selections: [] });
    return { text: 'Preview prepared', model: 'observed-model' };
  });
  const result = await f.run(); assert.equal(result.ok, true); assert.equal(result.model, 'observed-model');
  assert.deepEqual(f.calls.map(item => item.operation), ['read_capture', 'prepare_capture', 'update_capture']);
});

test('unconfigured model makes no page reads or paid requests', async () => {
  await assert.rejects(runCaptureAssistant(input, { runtime: {}, signal: new AbortController().signal,
    call: () => assert.fail('No read'), execute: () => assert.fail('No model request') }), { code: 'capture_model_required' });
});

test('stopping after a successful tool call retains capture identity and preview revision', async () => {
  const controller = new AbortController();
  const result = await runCaptureAssistant(input, { runtime, signal: controller.signal,
    call: async () => ({ state: 'completed', result: preview }), execute: async (_request, _settings, _images, options) => {
      await options.toolRuntime.execute('prepare_capture', {}); controller.abort(new Error('User stopped')); throw new Error('aborted');
    } });
  assert.equal(result.ok, false); assert.equal(result.captureId, 'preview'); assert.equal(result.revision, 1); assert.equal(result.message, 'User stopped');
});

test('tool failures are visible to the model so it can explain or recover without losing the conversation', async () => {
  const result = await runCaptureAssistant(input, { runtime, signal: new AbortController().signal,
    call: async () => ({ state: 'failed', error: { code: 'site_permission_required', message: 'Permission is missing' } }),
    execute: async (_request, _settings, _images, { toolRuntime }) => {
      const response = await toolRuntime.execute('prepare_capture', {});
      assert.equal(response.data.code, 'site_permission_required');
      return { text: 'Grant webpage access in settings first.' };
    } });
  assert.equal(result.ok, true); assert.equal(result.captureId, undefined);
});

test('explicit save uses the same durable save receipt, project and current preview as MCP', async () => {
  const calls = []; let current = preview;
  const saved = { ok: true, results: [{ entryId: 'saved', status: 'partial', warnings: ['Video missing'] }] };
  const result = await runCaptureAssistant({ ...input, captureId: 'preview', instruction: 'Save the selected content', project: 'chosen-project' }, {
    runtime, signal: new AbortController().signal,
    call: async (operation, args) => { calls.push({ operation, args });
      if (operation === 'read_capture') return current;
      if (operation === 'save_capture') { current = { ...preview, revision: 2 }; return { state: 'completed', result: saved }; }
      throw new Error('unexpected operation'); },
    execute: async (_request, _settings, _images, { toolRuntime }) => {
      assert.equal((await toolRuntime.execute('save_capture', { captureId: 'preview', expectedRevision: 1 })).data.results[0].status, 'partial');
      return { text: 'Text saved. Video is still missing.' };
    } });
  assert.deepEqual(result.saveResult, saved); assert.equal(result.revision, 2);
  assert.equal(calls.find(item => item.operation === 'save_capture').args.project, 'chosen-project');
});

test('the visible reply streams through the existing provider loop rather than waiting for a completed paragraph', async () => {
  const deltas = [];
  const result = await runCaptureAssistant(input, { runtime, signal: new AbortController().signal, onDelta: (...args) => deltas.push(args),
    call: () => assert.fail('No web read needed'), execute: async (_request, _settings, _images, options) => {
      options.onDelta('Hello', 'Hello'); options.onDelta(' there', 'Hello there'); return { text: 'Hello there' };
    } });
  assert.equal(result.ok, true); assert.deepEqual(deltas, [['Hello', 'Hello'], [' there', 'Hello there']]);
});

test('a real screenshot is passed as model image input with its source metadata, never as a claimed original', async () => {
  const result = await runCaptureAssistant({ ...input, captureId: 'preview' }, { runtime, signal: new AbortController().signal,
    call: async (_name, args) => args.part === 'screenshot' ? { dataUrl: 'data:image/png;base64,eA==', part: 'screenshot', sourceUrl: input.sourceUrl } : preview,
    execute: async (_request, _settings, _images, { toolRuntime }) => {
      const result = await toolRuntime.execute('read_capture', { captureId: 'preview', part: 'screenshot' });
      assert.equal(result.data.screenshotObserved, true); assert.equal(result.data.dataUrl, undefined);
      assert.equal(result.images[0].dataUrl, 'data:image/png;base64,eA=='); return { text: 'I can see the screenshot.' };
    } });
  assert.equal(result.ok, true);
});

test('the plugin assistant opens, searches and edits the library without a capture webpage', async () => {
  const calls = [];
  const result = await runCaptureAssistant({ instruction: '打开案例库，查找案例并改标题', sessionId: 'general', locale: 'zh-CN' }, {
    runtime, signal: new AbortController().signal,
    call: async (name,args) => { calls.push({name,args}); return {ok:true,state:'ready',revision:'case-version',content:'actual case'}; },
    execute: async (_request,_settings,_images,{toolRuntime}) => {
      for (const name of ['open_workspace','search_cases','read_case_details','edit_case','organize_case','control_workspace','read_projects','update_project','submit_analysis_result']) assert(toolRuntime.specs.some(spec=>spec.name===name),name+' must use the same plugin capability');
      assert((await toolRuntime.execute('open_workspace',{surface:'library'})).data.ok);
      assert((await toolRuntime.execute('search_cases',{query:'gym'})).data.ok);
      assert((await toolRuntime.execute('read_case_details',{caseId:'existing',parts:['overview']})).data.ok);
      assert((await toolRuntime.execute('edit_case',{requestId:'edit',caseId:'existing',expectedRevision:'case-version',patch:{title:'New title'}})).data.ok);
      assert.equal((await toolRuntime.execute('prepare_capture',{tabId:9})).data.code,'capture_page_required');
      assert.equal((await toolRuntime.execute('trash_case',{caseId:'existing'})).data.code,'unknown_operation');
      return {text:'已打开并更新标题。'};
    }
  });
  assert(result.ok);assert.deepEqual(calls.map(x=>x.name),['open_workspace','search','read_case_details','edit_case']);
});

test('duplicate capture does not falsely report a requested supplement as saved', async () => {
  const result=await runCaptureAssistant({...input,instruction:'给旧案例追加效果'}, {runtime,signal:new AbortController().signal,
    call:async name=>name==='save_capture'?{state:'completed',result:{results:[{entryId:'old',status:'duplicate'}]}}:name==='prepare_capture'?{state:'completed',result:preview}:preview,
    execute:async (_request,_settings,_images,{toolRuntime})=>{await toolRuntime.execute('prepare_capture',{tabId:1});await toolRuntime.execute('save_capture',{requestId:'supplement',captureId:'preview',expectedRevision:1});return {text:'原案例未更新，补充失败。'};}
  });
  assert.equal(result.saveResult.results[0].status,'duplicate');assert.equal(result.text,'原案例未更新，补充失败。');
});

test('a user-provided link can be captured from library chat through the same URL service as MCP', async () => {
  const calls=[];
  const remote={...preview,tabId:88,sourceUrl:'https://example.com/linked'};
  const result=await runCaptureAssistant({instruction:'采集这个链接 https://example.com/linked',sessionId:'library-link'}, {
    runtime,signal:new AbortController().signal,
    call:async(name,args)=>{calls.push({name,args});return name==='prepare_capture'?{state:'completed',result:remote}:{content:'actual linked page',revision:1};},
    execute:async(_request,_settings,_images,{toolRuntime})=>{
      assert.equal((await toolRuntime.execute('prepare_capture',{url:remote.sourceUrl})).data.tabId,88);
      assert.equal((await toolRuntime.execute('read_capture',{captureId:remote.captureId,part:'context',tabId:88})).data.content,'actual linked page');
      return {text:'已取得预览。'};
    }
  });
  assert(result.ok);assert.equal(calls[0].args.url,remote.sourceUrl);assert.equal(calls[0].args.tabId,undefined);assert.equal(calls[1].args.tabId,88);
});
