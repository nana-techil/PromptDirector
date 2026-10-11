import test from 'node:test';
import assert from 'node:assert/strict';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
import { CAPTURE_OPERATION_SPECS } from '../extension/capture-operation-specs.js';
const runtime = { aiTaskAssignments: { creativePlanning: { providerId: 'deepseek', model: 'deepseek-flash' } },
  aiSettings: { apiKey: 'isolated-fixture', consent: true } };
const input = { tabId: 1, sourceUrl: 'https://example.test/', instruction: 'Collect the original prompt', locale: 'en' };

test('collector assistant shares MCP preview tools and configured model, with no save, deletion or generation tools', async () => {
  const calls = []; const preview = { captureId: 'preview', revision: 1, tabId: 1, sourceUrl: input.sourceUrl };
  const result = await runCaptureAssistant(input, { runtime, signal: new AbortController().signal,
    call: async (operation, args) => { calls.push({ operation, args }); return { state: 'completed', result: preview }; },
    execute: async (request, _settings, _images, options) => {
      assert.equal(request.session.aiProfile.model, 'deepseek-flash'); assert.equal(request.route, 'chat');
      assert.deepEqual(options.toolRuntime.specs, CAPTURE_OPERATION_SPECS.filter(spec => ['read_capture', 'update_capture'].includes(spec.name)));
      await assert.rejects(options.toolRuntime.execute('update_capture', { captureId: 'other', expectedRevision: 1 }), { code: 'capture_scope_changed' });
      await options.toolRuntime.execute('update_capture', { captureId: 'preview', expectedRevision: 1, selections: [] });
      return { text: 'Preview prepared', model: 'observed-model' };
    } });
  assert.equal(result.ok, true); assert.equal(result.model, 'observed-model');
  assert.deepEqual(calls.map(item => item.operation), ['prepare_capture', 'update_capture']);
});

test('an unconfigured model makes no page reads or paid requests', async () => {
  await assert.rejects(runCaptureAssistant(input, { runtime: {}, signal: new AbortController().signal,
    call: () => assert.fail('No read'), execute: () => assert.fail('No model request') }), { code: 'capture_model_required' });
});

test('a stopped or failed model keeps the capture identity for continuation and does not pretend to save', async () => {
  const controller = new AbortController();
  const result = await runCaptureAssistant(input, { runtime, signal: controller.signal,
    call: async () => ({ state: 'completed', result: { captureId: 'preview', revision: 1 } }),
    execute: async () => { controller.abort(new Error('User stopped')); throw new Error('aborted'); } });
  assert.equal(result.ok, false); assert.equal(result.captureId, 'preview'); assert.equal(result.message, 'User stopped');
});
