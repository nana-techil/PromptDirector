import test from 'node:test';
import assert from 'node:assert/strict';
import { withAssistantTaskRuntime } from '../extension/assistant-task.js';
import { createAgentContextRuntime, projectAgentToolContext, readAgentToolResult } from '../extension/agent-runtime-context.js';
import { captureScopeProgress } from '../extension/agent-capture-inventory.js';
import { runComposerToolLoop } from '../extension/composer-tool-loop.js';

const inventory = { callId: 'directory', turnId: 'old', name: 'read_capture', args: { captureId: 'inventory', part: 'modules' }, data: {
  captureId: 'inventory', sourceUrl: 'https://source.test/', part: 'modules', revision: 1, total: 2, offset: 0,
  modules: ['a', 'b'].map(id => ({ selector: `#${id}`, title: id, sources: [{ selector: `#${id} pre`, characters: 20 }] }))
} };
const scope = { captureId: 'inventory', selectors: ['#a', '#b'], project: 'project', saveMode: 'multiple' };
const prior = { callId: 'old-task', turnId: 'old', name: 'assistant_task_state', args: {}, data: {
  mode: 'act', goal: 'Save the selected effects', currentUserId: 'old', state: 'active', steps: [{ operation: 'save_capture' }]
} };
function save(id, { project = 'project', sourceUrl = 'https://source.test/', partial = false } = {}) {
  return [
    { callId: `prepare-${id}`, name: 'prepare_capture', args: {}, data: { captureId: id, sourceUrl, ok: true } },
    { callId: `save-${id}`, name: 'save_capture', args: { captureId: id, project }, data: { ok: true, state: 'completed', captureId: id, collectionId: project,
      results: [{ candidateId: id, entryId: `entry-${id}`, status: 'saved', originalVerification: { status: partial ? 'partial' : 'verified',
        sources: [{ selector: `#${id} pre`, totalCharacters: 20, completeness: 'complete' }] } }] } }
  ];
}
function fixture(records = [inventory, prior], instruction = 'Continue the work') {
  const state = { toolContext: structuredClone(records) };
  const durable = createAgentContextRuntime({ turnId: 'now', load: async () => state, update: async transform => Object.assign(state, transform(state)) });
  const runtime = withAssistantTaskRuntime({ ...durable, specs: ['prepare_capture', 'read_capture', 'save_capture'].map(name => ({ name,
    parameters: { type: 'object', properties: name === 'save_capture' ? { requestId: { type: 'string' } } : {} } })),
    execute: async (name, args) => ({ data: save(args.captureId, { sourceUrl: args.sourceUrl }).find(record => record.name === name)?.data }) }, { instruction, userMessageId: 'now' });
  return { runtime, state };
}
const declare = (runtime, extra = {}) => runtime.execute('declare_task', JSON.parse(JSON.stringify({
  mode: 'act', goal: 'Save the selected effects', steps: [{ operation: 'save_capture' }], captureScope: scope, ...extra
})));

test('an unfinished prior goal cannot silently become an old success report on a new turn', async () => {
  const { runtime } = fixture(); await runtime.loadContext();
  const check = await runtime.finishTurn({ content: 'Everything is already finished.' });
  assert.equal(check?.action, 'continue');
  assert.match(check.message, /declare_task/);
  assert.equal(runtime.task, undefined, 'the host must not infer fresh authorization from a continuation phrase');
});

test('status questions, cancellation, and unrelated requests can be answered without resuming old writes', async () => {
  for (const instruction of ['Why did it stop?', 'Stop. Explain the plugin instead.', 'What is on the other page?']) {
    const { runtime } = fixture(undefined, instruction); await runtime.loadContext();
    const result = await declare(runtime, { mode: 'respond', goal: instruction, captureScope: undefined, steps: [], reply: 'Here is the requested explanation.' });
    assert.equal(result.data.ok, true); assert.equal(result.terminate, true);
    assert.equal(await runtime.finishTurn({}), undefined);
    assert.equal(runtime.observations.length, 0);
  }
});

test('one saved batch cannot complete a larger selected scope; later batches keep earlier verified results', async () => {
  const { runtime } = fixture(); await runtime.loadContext();
  assert.equal((await declare(runtime)).data.ok, true);
  for (const record of save('a')) await runtime.execute(record.name, { captureId: 'a' }, { callId: record.callId });
  const partial = await runtime.finishTurn({ content: 'Saved a, all done.' });
  assert.equal(partial?.action, 'continue');
  assert.deepEqual(runtime.task.captureProgress.pending.map(item => item.selector), ['#b']);
  for (const record of save('b')) await runtime.execute(record.name, { captureId: 'b' }, { callId: record.callId });
  assert.equal(await runtime.finishTurn({}), undefined);
  assert.equal(runtime.task.state, 'completed');
});

test('a generic checklist cannot replace a declared batch scope or silently drop an unfinished target', async () => {
  const { runtime } = fixture(); await runtime.loadContext(); await declare(runtime);
  assert.equal((await declare(runtime, { captureScope: undefined })).data.code, 'task_goal_changed');
  assert.equal((await declare(runtime, { captureScope: { ...scope, selectors: ['#a'] } })).data.code, 'task_goal_changed');
});

test('completion evidence is bound to source, destination, complete originals, and user-selected subset', () => {
  for (const options of [{ project: 'elsewhere' }, { sourceUrl: 'https://different.test/' }, { partial: true }]) {
    assert.equal(captureScopeProgress([inventory, ...save('a', options)], { ...scope, selectors: ['#a'] }).complete, false);
  }
  assert.equal(captureScopeProgress([inventory, ...save('a')], { ...scope, selectors: ['#a'] }).complete, true);
  assert.equal(captureScopeProgress([inventory, ...save('a')], scope).complete, false);
  assert.equal(captureScopeProgress([inventory], { ...scope, selectors: ['#invented'] }).valid, false);
});

test('equivalent source selectors use the observed DOM identity, not string similarity or a guessed alias', () => {
  const records = [inventory, ...save('a')];
  const source = records.at(-1).data.results[0].originalVerification.sources[0];
  source.selector = 'main article:first-child pre';
  assert.equal(captureScopeProgress(records, { ...scope, selectors: ['#a'] }).complete, false);
  source.resolvedSelector = '#a pre';
  assert.equal(captureScopeProgress(records, { ...scope, selectors: ['#a'] }).complete, true);
});

test('one merged case cannot satisfy independent cases, and separate cases do not prove a requested merge', () => {
  const separate = [inventory, ...save('a'), ...save('b')];
  assert.equal(captureScopeProgress(separate, { ...scope, saveMode: 'combined' }).complete, false);
  const merged = [inventory, ...save('a')];
  merged.at(-1).data.results[0].originalVerification.sources.push(save('b').at(-1).data.results[0].originalVerification.sources[0]);
  assert.equal(captureScopeProgress(merged, scope).complete, false);
  assert.equal(captureScopeProgress(merged, { ...scope, saveMode: 'combined' }).complete, true);
});

test('new user scope correction may select fewer targets; old verified saves need no repeat write', async () => {
  const { runtime } = fixture([inventory, prior, ...save('a')], 'Only keep the first one; do not save the second'); await runtime.loadContext();
  assert.equal((await declare(runtime, { captureScope: { ...scope, selectors: ['#a'] } })).data.ok, true);
  assert.equal(await runtime.finishTurn({}), undefined);
  assert.equal(runtime.task.state, 'completed');
  assert.equal(runtime.observations.length, 0);
});

test('a batch with a known directory and no target list gets a completion check without blocking its writes', async () => {
  const { runtime } = fixture([inventory]); await runtime.loadContext();
  for (const id of ['a', 'b']) for (const record of save(id)) await runtime.execute(record.name, { captureId: id }, { callId: record.callId });
  assert.equal(runtime.observations.filter(record => record.name === 'save_capture').length, 2);
  assert.equal((await runtime.finishTurn({ content: 'All done' })).state.captureScopeMissing, true);
  await declare(runtime);
  assert.equal(await runtime.finishTurn({}), undefined);
});

test('a module inventory from another page cannot impose code-module completion on a new capture', async () => {
  const { runtime } = fixture([inventory]); await runtime.loadContext();
  for (const id of ['a', 'b']) for (const record of save(id)) await runtime.execute(record.name, { captureId: id, sourceUrl: 'https://another.test/' }, { callId: record.callId });
  assert.equal(await runtime.finishTurn({ content: 'Saved the two selected posts.' }), undefined);
});

test('resume carries the frozen scope and actual progress across a human turn, not old completion prose', async () => {
  const previous = { ...prior, data: { ...prior.data, captureScope: scope } };
  const { runtime } = fixture([inventory, previous, ...save('a')]); await runtime.loadContext();
  const context = await runtime.context();
  assert.deepEqual(context.continuingTask.captureProgress.pending.map(item => item.selector), ['#b']);
  assert.equal(context.continuingTask.captureProgress.saved[0].entryId, 'entry-a');
  assert.equal(runtime.task, undefined, 'latest human intent must still determine whether to resume');
});

test('large failed historical arguments are references, never corrupted executable schemas', () => {
  const args = { captureId: 'old', candidates: [{ id: 'draft', codePreview: { html: '<p>Original</p>'.repeat(1000) } }] };
  const records = [{ callId: 'failed-update', turnId: 'old-user', name: 'update_capture', args, data: { ok: false, code: 'capture_changed' } }];
  const fact = projectAgentToolContext(records).untrustedToolEvidence[0];
  assert.equal(fact.args, undefined); assert.equal(fact.argumentScope.captureId, 'old');
  assert.equal(fact.data.code, 'capture_changed');
  assert.deepEqual(JSON.parse(readAgentToolResult(records, fact.argsReference).content), args);
  assert.equal(records[0].args, args);
});

test('completed historical work leaves the prompt but remains fully retrievable; pending work stays', () => {
  const html = '<h1>Original effect</h1>'.repeat(2000);
  const records = [inventory, save('a')[0], { callId: 'html', turnId: 'old', name: 'update_capture', args: {
    captureId: 'a', candidates: [{ id: 'a', title: 'A', codePreview: { html }, textSources: [{ selector: '#a pre' }] }]
  }, data: { ok: true, captureId: 'a' } }, save('a')[1],
  { callId: 'new-source', name: 'read_capture', args: { captureId: 'a', selector: '#b pre' }, data: { content: 'new uncommitted source' } }];
  const projected = projectAgentToolContext(records);
  assert(!JSON.stringify(projected).includes(html));
  assert(projected.untrustedToolEvidence.some(item => item.callId === 'new-source'));
  assert.equal(projected.completedCaptureWork[0].candidateId, 'a');
  assert.equal(readAgentToolResult(records, { callId: 'html', turnId: 'old', path: ['args', 'candidates', '0', 'codePreview', 'html'], length: html.length }).content, html);
});

for (const protocol of ['chat_completions', 'responses']) test(`${protocol}: a false final answer is followed by goal resolution and real execution in the same run`, async () => {
  const { runtime } = fixture(); let requests = 0;
  const response = (content, calls = []) => new Response(JSON.stringify(protocol === 'responses' ? {
    status: 'completed', output_text: content, output: calls.map((call, index) => ({ type: 'function_call', call_id: `${requests}-${index}`, name: call.name, arguments: JSON.stringify(call.args) }))
  } : { choices: [{ message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls.map((call, index) => ({ id: `${requests}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
  await runComposerToolLoop({ protocol, body: { model: 'fixture', [protocol === 'responses' ? 'input' : 'messages']: [{ role: 'user', content: 'Continue the work' }] }, runtime,
    request: async () => {
      requests++;
      if (requests === 1) return response('Everything is already finished.');
      if (requests === 2) return response('', [{ name: 'declare_task', args: { mode: 'act', goal: 'Save selected effects', steps: [{ operation: 'save_capture' }], captureScope: scope } }]);
      if (requests === 3 || requests === 5) {
        const id = requests === 3 ? 'a' : 'b';
        return response('', save(id).map(record => ({ name: record.name, args: { captureId: id, requestId: id } })));
      }
      return response('Saved.');
    } });
  assert.equal(requests, 6); assert.equal(runtime.task.state, 'completed');
  assert.deepEqual(runtime.task.captureProgress.saved.map(item => item.entryId), ['entry-a', 'entry-b']);
});
