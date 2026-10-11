import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../mcp.mjs';
import { CAPTURE_OPERATION_SPECS } from '../../extension/capture-operation-specs.js';

test('MCP uses the same capture schemas, waits for receipts and exposes no arbitrary script or message execution', async () => {
  const calls = [];
  const server = createServer(async (operation, input, options) => {
    options.onHostSession?.('capture-session'); calls.push({ operation, input });
    if (operation === 'status') return { capabilities: CAPTURE_OPERATION_SPECS.map(spec => spec.name) };
    if (operation === 'get_task') return { state: 'completed', result: { captureId: 'preview', revision: 1 } };
    return operation === 'read_capture' ? { captureId: 'preview', revision: 1 } : { state: 'queued', id: input.requestId };
  });
  try {
    const inputs = { prepare_capture: { requestId: 'prepare', tabId: 5 }, read_capture: { captureId: 'preview' },
      update_capture: { requestId: 'select', captureId: 'preview', expectedRevision: 1, selections: [] },
      save_capture: { requestId: 'save', captureId: 'preview', expectedRevision: 2 } };
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
