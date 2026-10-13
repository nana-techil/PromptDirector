import test from 'node:test';
import assert from 'node:assert/strict';
import { withAssistantTaskRuntime } from '../extension/assistant-task.js';
import { runComposerToolLoop } from '../extension/composer-tool-loop.js';

const spec = { name: 'read_capture', parameters: { type: 'object' } };
const directory = (offset, count, revision = 1, captureId = 'page-a') => ({ ok: true, part: 'modules', captureId, revision,
  offset, total: 3, nextOffset: offset + count < 3 ? offset + count : null,
  modules: Array.from({ length: count }, (_, i) => ({ title: `Effect ${offset+i}`, selector: `#effect-${offset+i}` })) });
const record = data => ({ name: 'read_capture', args: { captureId: data.captureId, part: 'modules', offset: data.offset }, data });

test('directory progress is explicit without a model plan and survives another human turn without mixing pages or versions', async () => {
  const old = [record(directory(0, 1)), record(directory(1, 1, 2)), record(directory(1, 1, 1, 'page-b'))];
  const runtime = withAssistantTaskRuntime({ specs: [spec], loadContext: async () => old,
    execute: async (_name, args) => ({ data: directory(args.offset, args.offset === 1 ? 2 : 1) }) }, { instruction: 'Save each requested module' });
  await runtime.loadContext();
  const gap = await runtime.execute('read_capture', { captureId: 'page-a', part: 'modules', offset: 2 });
  assert.deepEqual(gap.data.inventoryProgress, { read: 2, total: 3, complete: false, nextUnreadOffset: 1 },
    'another page or directory revision cannot fill a missing range');
  const result = await runtime.execute('read_capture', { captureId: 'page-a', part: 'modules', offset: 1 });
  assert.deepEqual(result.data.inventoryProgress, { read: 3, total: 3, complete: true, nextUnreadOffset: null });
  assert.equal(runtime.task, undefined, 'a registration must not be necessary for useful progress facts');
  assert.equal(result.data.modules.length, 2, 'do not truncate original directory data');
  const overlap = await runtime.execute('read_capture', { captureId: 'page-a', part: 'modules', offset: 0, length: 9000 });
  assert.equal(overlap.progressed, false, 'changing page length or offset cannot make an already-read range new progress');
});

test('reading the final page alone never claims the whole directory was read', async () => {
  const runtime = withAssistantTaskRuntime({ specs: [spec], execute: async () => ({ data: directory(2, 1) }) }, { instruction: 'Collect these modules' });
  const result = await runtime.execute('read_capture', { captureId: 'page-a', part: 'modules', offset: 2 });
  assert.deepEqual(result.data.inventoryProgress, { read: 1, total: 3, complete: false, nextUnreadOffset: 0 });
});

for (const protocol of ['chat_completions', 'responses']) test(`${protocol}: unchanged reads receive corrective facts before stopping and can proceed to a save`, async () => {
  let requests = 0, writes = 0;
  const call = (id, name, args) => protocol === 'responses'
    ? { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }
    : { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  const result = await runComposerToolLoop({ protocol,
    body: { model: 'fixture', ...(protocol === 'responses' ? { input: [{ role: 'user', content: 'Save the requested case' }] } : { messages: [{ role: 'user', content: 'Save the requested case' }] }) },
    runtime: { specs: [spec, { name: 'save_case', parameters: { type: 'object' } }], execute: async name => {
      if (name === 'save_case') { writes++; return { data: { ok: true, entryId: 'saved-case' } }; }
      return { data: directory(0, 3) };
    } },
    request: async payload => {
      requests++;
      const sequence = payload.messages || payload.input;
      if (requests === 3) {
        const feedback = JSON.parse(sequence.at(-1).content);
        assert.equal(feedback.runtimeFeedback.status, 'unchanged_tool_results');
        assert.equal(feedback.runtimeFeedback.calls[0].name, 'read_capture');
        assert.equal(feedback.runtimeFeedback.calls[0].previousCallId, 'read-1');
      }
      const calls = requests < 3 ? [call(`read-${requests}`, 'read_capture', { part: 'modules' })]
        : requests === 3 ? [call('save', 'save_case', {})] : [];
      return new Response(JSON.stringify(protocol === 'responses' ? { status: 'completed', output: calls, output_text: calls.length ? '' : 'Saved' }
        : { choices: [{ message: { role: 'assistant', ...(calls.length ? { tool_calls: calls } : { content: 'Saved' }) } }] }));
    } });
  assert.equal(result.content, 'Saved'); assert.equal(writes, 1); assert.equal(requests, 4);
});
