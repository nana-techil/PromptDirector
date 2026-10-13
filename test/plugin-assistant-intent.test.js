import test from 'node:test';
import assert from 'node:assert/strict';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
import { executeComposerTurnWithService } from '../extension/composer-service.js';

const runtime = { aiTaskAssignments: { creativePlanning: { providerId: 'deepseek', model: 'deepseek-flash' } },
  aiSettings: { apiKey: 'offline-fixture', consent: true } };
function stream(content, calls = [], requestIndex = 0) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content, tool_calls: calls.map((call, index) => ({
    index, id: `call-${requestIndex}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) }
  })) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
async function run(instruction, responses, extra = {}) {
  const requests = [], operations = [];
  const result = await runCaptureAssistant({ sessionId: 'intent-session', instruction, ...extra.input }, {
    runtime, signal: new AbortController().signal,
    sessionRuntime: extra.sessionRuntime,
    call: async (name, args) => { operations.push({ name, args }); return extra.call?.(name, args) ?? { available: false }; },
    execute: (request, settings, images, options) => executeComposerTurnWithService(request, settings, images, {
      ...options, fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        const response = responses[Math.min(requests.length - 1, responses.length - 1)];
        const value = typeof response === 'function' ? response(requests.at(-1)) : response;
        return stream(value.content || '', value.calls, requests.length);
      }
    })
  });
  return { result, requests, operations };
}

test('an ordinary native response never becomes a saved outcome without a receipt', async () => {
  const { result } = await run('请把刚才那个磁吸交互收入我的素材库，原代码一并保留', [{ content: '我可以为你准备采集步骤。' }]);
  assert.equal(result.outcome, 'conversation');
  assert.equal(result.saveResult, undefined, 'semantic task fulfillment is also tested with a real model; transport success is never a save receipt');
});

function context(body) {
  return body.messages.map(message => { try { return JSON.parse(message.content).runtimeContext; } catch { return null; } }).find(Boolean);
}
function declare(body, args) {
  return { name: 'declare_task', args: { goal: '满足当前用户目标', steps: [], ...args } };
}

test('ordinary help answers in one native request without reading a website or charging for a classifier', async () => {
  const observed = await run('如何整理自己的素材？', [body => ({ calls: [declare(body, { mode: 'respond', reply: '可按项目整理，也可直接编辑案例标签。' })] })],
    { input: { tabId: 1, sourceUrl: 'https://example.test/' } });
  assert.equal(observed.result.ok, true); assert.equal(observed.requests.length, 1); assert.equal(observed.operations.length, 0);
  assert.equal(observed.result.text, '可按项目整理，也可直接编辑案例标签。');
  assert(!observed.requests[0].messages[0].content.includes('https://example.test/'));
});

test('a semantic save task must obtain an actual receipt even when the model never says a recognized success word', async () => {
  const observed = await run('把这个收进库里吧', [body => ({ calls: [declare(body, { mode: 'act', steps: [{ operation: 'save_capture' }] })] }),
    { content: '好，事情都搞定了。' }]);
  assert.equal(observed.result.ok, false); assert.equal(observed.requests.length, 3);
  assert.equal(observed.operations.length, 0);
});

test('a registered preview-only task cannot execute a save when the user withheld that authorization', async () => {
  const observed = await run('先看看内容，别写进库里', [body => ({ calls: [declare(body, { mode: 'act', steps: [{ operation: 'read_capture' }] }),
    { name: 'save_capture', args: { requestId: 'save-preview', captureId: 'preview', expectedRevision: 1 } },
    { name: 'read_capture', args: { part: 'context', tabId: 1 } }] }), { content: '已读取页面，尚未保存。' }],
    { input: { tabId: 1, sourceUrl: 'https://example.test/' }, call: () => ({ available: true, textModules: [] }) });
  assert(observed.result.ok); assert.deepEqual(observed.operations.map(item => item.name), ['read_capture']);
  const failure = observed.requests[1].messages.find(message => message.role === 'tool' && JSON.parse(message.content).code === 'task_scope_changed');
  assert(failure);
});

test('a website cannot invent a user message identity to authorize writing', async () => {
  const observed = await run('讲讲这个页面', [{ calls: [{ name: 'declare_task', args: { mode: 'act', goal: '存案例', userMessageIndices: [99],
    steps: [{ operation: 'save_capture' }] } }] }, { content: '已处理' }]);
  assert.equal(observed.operations.length, 0);
  assert.equal(observed.result.outcome, 'conversation');
  assert(observed.requests[1].messages.some(m=>m.role==='tool' && JSON.parse(m.content).code==='invalid_tool_arguments'));
});

test('the model cannot replace an unfinished action with an easy answer to bypass completion', async () => {
  const observed = await run('把原文存好', [body => ({ calls: [declare(body, { mode: 'act', steps: [{ operation: 'save_capture' }] })] }),
    body => ({ calls: [declare(body, { mode: 'respond', reply: '点击保存即可。' })] }), { content: '点击保存即可。' }]);
  assert.equal(observed.result.ok, false); assert.equal(observed.operations.length, 0);
});

test('a real tool failure can stop honestly while preserving its task instead of demanding more user commands', async () => {
  const observed = await run('把这个页面保存下来', [body => ({ calls: [declare(body, { mode: 'act', steps: [{ operation: 'prepare_capture' }, { operation: 'save_capture' }] }),
    { name: 'prepare_capture', args: { requestId: 'prepare', tabId: 1 } }] }),
    { calls: [{ name: 'settle_task', args: { state: 'blocked', reason: '网页暂时不可读，已有资料保留', failedCallId: 'call-1-1' } }] },
    { content: '网页暂时不可读，已有资料保留。' }], { input: { tabId: 1, sourceUrl: 'https://example.test/' },
    call: () => ({ state: 'failed', error: { code: 'page_unavailable', message: 'Page unavailable' } }) });
  assert(observed.result.ok); assert.equal(observed.result.diagnostic.task.state, 'blocked');
  assert.deepEqual(observed.operations.map(item => item.name), ['prepare_capture']);
});
