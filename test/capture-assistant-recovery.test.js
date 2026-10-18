import test from 'node:test';
import assert from 'node:assert/strict';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
import { runComposerToolLoop } from '../extension/composer-tool-loop.js';

const url = 'https://example.test/effects';
const runtime = { aiTaskAssignments: { creativePlanning: { providerId: 'deepseek', model: 'deepseek-flash' } }, aiSettings: { apiKey: 'fixture', consent: true } };

for (const oldTab of [1, 2]) test(`an unreadable inherited preview on tab ${oldTab} can recover and save without losing the old draft`, async () => {
  const old = { captureId: 'old', revision: 3, state: 'preview', tabId: oldTab, sourceUrl: url, candidates: [], selections: [] };
  const fresh = { ...old, captureId: 'fresh', tabId: 1, revision: 1,
    candidates: [{ id: 'effect', textSources: [{ selector: 'pre', totalCharacters: 15, completeness: 'complete' }] }],
    selections: [{ candidateId: 'effect', includeText: true }] };
  const calls = [];
  const result = await runCaptureAssistant({ captureId: 'old', tabId: 1, sourceUrl: url, instruction: 'Save each requested effect', userMessageId: 'human' }, {
    runtime, signal: new AbortController().signal,
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'read_capture' && !args.part) return args.captureId === 'old' ? old : fresh;
      if (name === 'read_capture' && args.part === 'source') {
        if (args.captureId === 'old') throw new Error(`No tab with id: ${oldTab}.`);
        return { captureId: 'fresh', selector: 'pre', revision: 1, content: 'complete source', totalCharacters: 15, nextOffset: null };
      }
      if (name === 'prepare_capture') { assert.equal(args.tabId, 1); assert.equal(args.initialBatch, undefined); return { state: 'completed', result: fresh }; }
      if (name === 'save_capture') { assert.equal(args.captureId, 'fresh'); return { state: 'completed', result: { results: [{ entryId: 'saved', status: 'saved' }] } }; }
      assert.fail(name);
    },
    execute: async (_r, _s, _i, { toolRuntime }) => {
      const steps = ['read_capture', 'save_capture'].map(operation => ({ operation, targetId: 'old', ...(operation === 'read_capture' ? { part: 'source' } : {}) }));
      assert.equal((await toolRuntime.execute('declare_task', { mode: 'act', goal: 'Save the requested effects', steps })).data.ok, true);
      assert.equal((await toolRuntime.execute('read_capture', { captureId: 'old', part: 'source', selector: 'pre' })).data.ok, false);
      const recovered = await toolRuntime.execute('prepare_capture', { requestId: 'recover', tabId: 1 });
      assert.equal(recovered.data.captureId, 'fresh', 'prepare must not return the known-broken preview again');
      assert.equal((await toolRuntime.execute('read_capture', { captureId: 'fresh', part: 'source', selector: 'pre' })).data.content, 'complete source');
      assert.equal((await toolRuntime.execute('save_capture', { captureId: 'fresh', expectedRevision: 1 })).data.results[0].entryId, 'saved');
      assert.equal(await toolRuntime.finishTurn({ content: 'Saved' }), undefined);
      return { text: 'Saved' };
    }
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(old.captureId, 'old'); assert.equal(old.revision, 3);
  assert.equal(calls.filter(c => c.name === 'prepare_capture').length, 1);
  assert.equal(calls.filter(c => c.name === 'save_capture').length, 1);
  assert(result.diagnostic.toolCalls.some(c => c.name === 'declare_task'), 'diagnostics must include plan validation, not hide the final failure');
});

test('different corrective plan inputs are not the same failed call', async () => {
  let requests = 0;
  const args = [{ goal: 'Save', invalid: true }, { goal: 'Save', steps: [] }, { goal: 'Save', steps: ['save'] }];
  const result = await runComposerToolLoop({ protocol: 'chat_completions', body: { model: 'fixture', messages: [{ role: 'user', content: 'Save' }] },
    runtime: { specs: [{ name: 'declare_task', parameters: { type: 'object' } }], execute: async (_name, input) => ({ data: input.steps?.length ? { ok: true } : { ok: false, code: 'task_invalid', message: input.invalid ? 'Unknown field' : 'Missing steps' } }) },
    request: async () => {
      const index = requests++;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...(index < args.length ? { tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'declare_task', arguments: JSON.stringify(args[index]) } }] } : { content: 'Done' }) } }] }));
    }
  });
  assert.equal(result.content, 'Done'); assert.equal(requests, 4);
});

test('an old preview does not prevent reading the explicitly selected current tab', async () => {
  let observed;
  const result = await runCaptureAssistant({ captureId: 'old', tabId: 1, sourceUrl: url, instruction: 'Read the page I am viewing' }, {
    runtime, signal: new AbortController().signal,
    call: async (name, args) => {
      assert.equal(name, 'read_capture');
      if (!args.part) return { captureId: 'old', tabId: 2, sourceUrl: url, state: 'preview', revision: 1 };
      observed = args; return { content: 'current page' };
    },
    execute: async (_r, _s, _i, { toolRuntime }) => {
      assert.equal((await toolRuntime.execute('read_capture', { part: 'context', tabId: 1 })).data.content, 'current page');
      return { text: 'current page' };
    }
  });
  assert.equal(result.ok, true, result.message); assert.equal(observed.tabId, 1); assert.equal(observed.captureId, undefined);
});

test('a healthy same-tab preview is reused and a revision typo does not force rescanning', async () => {
  const preview = { captureId: 'healthy', tabId: 1, sourceUrl: url, state: 'preview', revision: 3 };
  const result = await runCaptureAssistant({ captureId: 'healthy', tabId: 1, sourceUrl: url, instruction: 'Inspect the preview' }, {
    runtime, signal: new AbortController().signal,
    call: async (name, args) => {
      assert.equal(name, 'read_capture', 'unchanged healthy drafts should not run adapters again');
      if (args.part) throw Object.assign(new Error('Revision changed'), { code: 'capture_changed' });
      return preview;
    },
    execute: async (_r, _s, _i, { toolRuntime }) => {
      await toolRuntime.execute('read_capture', { captureId: 'healthy', part: 'source', selector: 'pre', expectedRevision: 1 });
      assert.equal((await toolRuntime.execute('prepare_capture', { tabId: 1 })).data.captureId, 'healthy');
      return { text: 'Preview retained' };
    }
  });
  assert.equal(result.ok, true, result.message);
});

test('native schema rejections are exported even though the rejected tool never executes', async () => {
  let requests = 0;
  const result = await runCaptureAssistant({ instruction: 'Explain the plugin' }, {
    runtime, signal: new AbortController().signal, call: () => assert.fail('No business operation needed'),
    execute: async (_r, _s, _i, { toolRuntime }) => {
      const response = await runComposerToolLoop({ protocol: 'chat_completions', runtime: toolRuntime,
        body: { model: 'fixture', messages: [{ role: 'user', content: 'Explain the plugin' }] },
        request: async () => new Response(JSON.stringify({ choices: [{ message: requests++ ? { role: 'assistant', content: 'Plugin help' }
          : { role: 'assistant', tool_calls: [{ id: 'invalid-plan', type: 'function', function: { name: 'declare_task', arguments: JSON.stringify({ mode: 'unknown' }) } }] } }] }))
      });
      return { text: response.content };
    }
  });
  assert.equal(result.ok, true, result.message);
  const recorded = result.diagnostic.toolCalls.find(event => event.callId === 'invalid-plan');
  assert.equal(recorded.result.data.code, 'invalid_tool_arguments');
  assert(recorded.result.data.message);
});
