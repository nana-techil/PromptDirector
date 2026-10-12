import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../mcp.mjs';
import { CAPTURE_OPERATION_SPECS } from '../../extension/capture-operation-specs.js';

test('external Agents receive the same source-backed candidates, batch goals and staged-original schema as the internal capture assistant', async () => {
  const calls = [];
  const server = createServer(async (operation, input) => {
    calls.push({ operation, input });
    if (operation === 'status') return { capabilities: CAPTURE_OPERATION_SPECS.map(spec => spec.name) };
    if (operation === 'get_task') return { state: 'completed', result: { captureId: 'preview', revision: 3 } };
    return operation === 'read_capture' ? { captureId: 'preview', revision: 2, content: 'actual source', nextOffset: null } : { state: 'queued', id: input.requestId };
  });
  try {
    const read = server._registeredTools.promptdirector_read_capture;
    await read.handler(read.inputSchema.parse({ captureId: 'preview', part: 'source', selector: '#actual-code', length: 7 }));
    const update = server._registeredTools.promptdirector_update_capture;
    const input = { requestId: 'batch', captureId: 'preview', expectedRevision: 2,
      candidates: [{ id: 'module', title: 'Actual code', canonicalUrl: 'https://example.test/', contentText: '',
        textSources: [{ selector: '#actual-code', target: 'prompt' }], media: [{ id: 'original', kind: 'image', localTransferId: 'prepared-original' }] }],
      selections: [{ candidateId: 'module', includeText: true, selectedMediaIds: ['original'] }],
      task: { objective: 'Save the requested module', outcome: 'save', candidateIds: ['module'], state: 'active' } };
    const response = await update.handler(update.inputSchema.parse(input)); assert(!response.isError);
    assert.deepEqual(calls.find(item => item.operation === 'update_capture').input, input);
    assert.equal(calls.find(item => item.operation === 'read_capture').input.part, 'source');
  } finally { await server.close(); }
});

test('MCP uses the same capture schemas, waits for receipts and exposes no arbitrary script or message execution', async () => {
  const calls = [];
  const server = createServer(async (operation, input, options) => {
    options.onHostSession?.('capture-session'); calls.push({ operation, input });
    if (operation === 'status') return { capabilities: CAPTURE_OPERATION_SPECS.map(spec => spec.name) };
    if (operation === 'get_task') return { state: 'completed', result: { captureId: 'preview', revision: 1 } };
    return operation === 'read_capture' ? { captureId: 'preview', revision: 1 } : { state: 'queued', id: input.requestId };
  });
  try {
    const inputs = { prepare_capture: { requestId: 'prepare', tabId: 5 }, read_capture: { captureId: 'preview', part: 'context', includeHidden: true },
      update_capture: { requestId: 'select', captureId: 'preview', expectedRevision: 1, selections: [], candidates: [{id:'code',title:'Code',canonicalUrl:'https://example.test/',contentText:'Original source',media:[],codePreview:{html:'<!doctype html><button>Demo</button>'}}] },
      save_capture: { requestId: 'save', captureId: 'preview', expectedRevision: 2, contentTypeId:'content:code-case', saveMode:'combined' } };
    for (const spec of CAPTURE_OPERATION_SPECS) {
      const tool = server._registeredTools[`promptdirector_${spec.name}`];
      assert.equal(tool.annotations.readOnlyHint, spec.name === 'read_capture');
      const response = await tool.handler(tool.inputSchema.parse(inputs[spec.name]));
      assert(!response.isError, response.content[0].text);
      const data = JSON.parse(response.content[0].text);
      assert.equal(spec.name === 'read_capture' ? data.captureId : data.state, spec.name === 'read_capture' ? 'preview' : 'completed');
      assert(!Object.hasOwn(spec.parameters.properties, 'script'));
    }
    assert.equal(calls.filter(item => item.operation === 'status').length, 1);
    assert.deepEqual(calls.filter(item => item.operation === 'get_task').map(item => item.input.requestId), ['prepare', 'select', 'save']);
    const read = server._registeredTools.promptdirector_read_capture;
    const supplement = read.inputSchema.parse({ captureId:'preview', part:'supplement', candidateId:'post', supplementId:'comment', expectedRevision:2 });
    assert(!(await read.handler(supplement)).isError);
    assert.deepEqual(calls.find(item=>item.input?.part === 'supplement').input, supplement);
    assert.equal(calls.find(item=>item.operation === 'save_capture').input.saveMode,'combined');
  } finally { await server.close(); }
});

test('unsupported backend and lost receipt cannot silently save or resubmit another capture', async () => {
  const calls = [];
  const server = createServer(async operation => { calls.push(operation); return { capabilities: [] }; });
  try {
    const response = await server._registeredTools.promptdirector_prepare_capture.handler({ requestId: 'one', tabId: 1 });
    assert(response.isError); assert.equal(JSON.parse(response.content[0].text).code, 'unsupported_capture_operation');
    assert.deepEqual(calls, ['status']);
  } finally { await server.close(); }
  const secondCalls = [];
  const second = createServer(async (operation, input) => {
    secondCalls.push({ operation, input });
    if (operation === 'status') return { capabilities: ['save_capture'] };
    if (operation === 'get_task') throw Object.assign(new Error('timeout'), { code: 'connector_timeout' });
    return { state: 'running', id: input.requestId };
  });
  try {
    const response = await second._registeredTools.promptdirector_save_capture.handler({ requestId: 'same', captureId: 'preview', expectedRevision: 1 });
    const data = JSON.parse(response.content[0].text);
    assert.equal(data.id, 'same'); assert.equal(data.waitError.code, 'connector_timeout');
    assert.equal(secondCalls.filter(item => item.operation === 'save_capture').length, 1);
  } finally { await second.close(); }
});

test('capture screenshot is exposed to external Agents as pixels with source metadata, without copying base64 into text', async () => {
  const server = createServer(async operation => operation === 'status' ? { capabilities: ['read_capture'] }
    : { captureId: 'visible', part: 'screenshot', sourceUrl: 'https://example.test/', dataUrl: 'data:image/png;base64,eA==' });
  try {
    const tool = server._registeredTools.promptdirector_read_capture;
    const response = await tool.handler(tool.inputSchema.parse({ captureId: 'visible', part: 'screenshot' }));
    assert.equal(response.isError, undefined); assert.equal(response.content[1].type, 'image');
    assert.equal(response.content[1].mimeType, 'image/png'); assert.equal(response.content[1].data, 'eA==');
    assert.equal(JSON.parse(response.content[0].text).dataUrl, undefined);
  } finally { await server.close(); }
});

test('external Agents can inspect the current dialog by tab and module title without creating a capture or calling a model', async () => {
  const calls=[];
  const server=createServer(async(operation,input)=>{calls.push({operation,input});return operation==='status'?{capabilities:['read_capture'],captureReadParts:['context']}:{part:'context',content:'current module selectors',nextOffset:null};});
  try {
    const tool=server._registeredTools.promptdirector_read_capture;
    const input=tool.inputSchema.parse({part:'context',tabId:7,query:'Expanding Search'});
    const result=await tool.handler(input);assert(!result.isError);assert.equal(JSON.parse(result.content[0].text).part,'context');
    assert.deepEqual(calls.map(call=>call.operation),['status','read_capture']);assert.deepEqual(calls[1].input,input);
  } finally {await server.close();}
});
