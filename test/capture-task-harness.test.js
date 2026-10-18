import test from 'node:test';
import assert from 'node:assert/strict';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
import { createAgentCapturePreview } from '../extension/agent-capture-preview.js';
import { createAgentContextRuntime } from '../extension/agent-runtime-context.js';
import { executeComposerTurnWithService } from '../extension/composer-service.js';
import { applyPageCaptureSelections } from '../extension/page-capture.js';

test('an undeclared first save task must resolve its semantic goal before an early reply can claim completion', async () => {
  const url = 'https://example.test/code'; const originals = { '#first': '  function first() { return 1; }\n', '#second': '  function second() { return 2; }\n' };
  const stored = {}; let journal = {}, saved = [], requests = 0, forcedContinuation = false;
  const scope = { libraryId: 'isolated', assertCurrent: async () => {} };
  const api = createAgentCapturePreview({ storage: { get: async key => ({ [key]: structuredClone(stored[key]) }), set: async update => Object.assign(stored, structuredClone(update)) },
    getLibraryId: async () => scope.libraryId, loadState: async () => ({ collections: [] }),
    chromeApi: { permissions: { contains: async () => true }, tabs: { get: async () => ({ id: 1, url }) }, scripting: {
      executeScript: async ({ func, args }) => [{ result: { ok: true, url, selector: args?.[0], completeness: 'complete', text: func.name === 'readCaptureSource' ? originals[args[0]] : 'Two actual modules', format: 'code', links: [], media: [] } }]
    } }, collect: async () => ({ candidates: [{ id: 'detected', title: 'Page', canonicalUrl: url, contentText: 'Page facts', media: [] }] }),
    readSavedText: async id => saved.find(item => `saved-${item.id}` === id)?.contentText || '',
    commit: async batch => { saved = applyPageCaptureSelections(batch); return { ok: true, results: saved.map(item => ({ candidateId: item.id, status: 'saved', entryId: `saved-${item.id}` })) }; } });
  const result = await runCaptureAssistant({ tabId: 1, sourceUrl: url, instruction: '把这两个代码模块分别保存成案例' }, {
    runtime: { aiTaskAssignments: { creativePlanning: { providerId: 'deepseek', model: 'deepseek-flash' } }, aiSettings: { apiKey: 'fixture', consent: true } },
    signal: new AbortController().signal, sessionRuntime: createAgentContextRuntime({ turnId: 'human', load: async () => journal, update: async transform => { journal = structuredClone(transform(journal)); } }),
    call: async (name, args) => name === 'read_capture' ? api.read(args) : { state: 'completed', result: await api.execute(name, args, args.requestId, scope) },
    execute: (input, settings, images, options) => executeComposerTurnWithService(input, settings, images, { ...options, stream: false,
      fetchImpl: async (_url, init) => {
        requests++; const body = JSON.parse(init.body);
        const values = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
        const first = values[0]; const latest = values.findLast(value => value.revision);
        const call = (name, args) => ({ role: 'assistant', tool_calls: [{ id: `tool-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        let message;
        if (requests === 1) message = call('prepare_capture', { requestId: 'prepare', tabId: 1 });
        else if (requests <= 3) message = call('read_capture', { captureId: first.captureId, part: 'source', selector: requests === 2 ? '#first' : '#second', length: 1000, expectedRevision: latest.revision });
        else if (requests === 4) message = call('update_capture', { requestId: 'select', captureId: first.captureId, expectedRevision: latest.revision, saveMode: 'multiple',
          candidates: Object.keys(originals).map((selector, index) => ({ id: `case-${index}`, title: selector, canonicalUrl: url, contentText: 'fake', media: [], codePreview:{html:'<!doctype html><button>source demo</button>'}, textSources: [{ selector, target: 'prompt' }] })),
          selections: [0, 1].map(index => ({ candidateId: `case-${index}`, includeText: true, selectedMediaIds: [] })),
           });
        else if (requests === 5) message = { role: 'assistant', content: '已全部保存，这是一个虚构的完成声明' };
        else if (requests === 6) {
          forcedContinuation = body.messages.at(-1).content.includes('declare_task');
          message = call('declare_task', { mode: 'act', goal: 'Save both actual code modules separately', steps: [{ operation: 'save_capture', resultIds: ['case-0', 'case-1'] }] });
        } else if (requests === 7) {
          message = call('save_capture', { requestId: 'save', captureId: first.captureId, expectedRevision: latest.revision });
        } else message = { role: 'assistant', content: '真实回执中有两个已保存案例' };
        return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
      } })
  });
  assert.equal(result.ok, true, result.message); assert.equal(forcedContinuation, true); assert.equal(saved.length, 2);
  assert(saved[0].contentText.includes(originals['#first'])); assert(saved[1].contentText.includes(originals['#second']));
  assert(saved.every(item => !item.contentText.includes('fake'))); assert.equal(result.saveResult.results.length, 2);
  assert.equal(journal.toolContext.filter(item => item.name === 'save_capture').length, 1);
});
