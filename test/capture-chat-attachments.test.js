import test from 'node:test';
import assert from 'node:assert/strict';
import { captureChatAssetIds, readCaptureChatAttachment, resolveCaptureLocalMedia } from '../extension/capture-chat-attachments.js';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
import { executeComposerTurnWithService } from '../extension/composer-service.js';
const file = { transferId: 'user-file', name: 'target.png', assetId: 'original', kind: 'image' };
const record = { id: file.transferId, name: file.name, state: 'ready', assetId: file.assetId,
  prepared: { asset: { id: file.assetId, kind: 'image', mimeType: 'image/png' }, contentText: '' } };
const dependencies = { transfers: { get: async id => { assert.equal(id, file.transferId); return record; } }, readBlob: async () => new Blob(['actual original'], { type: 'image/png' }) };
const runtime = { aiTaskAssignments: { creativePlanning: { providerId: 'deepseek', model: 'deepseek-flash' } },
  aiSettings: { apiKey: 'fixture', consent: true }, visionSettings: { consent: true, openai: { apiKey: 'fixture', model: 'gpt-4.1' } } };
const input = { instruction: '截图中这块才是我要保存的网页内容，先告诉我是否看见', sourceUrl: 'https://example.test/', tabId: 1, attachments: [file] };

test('a screenshot reaches the actual shared provider request as image bytes, while no library write occurs', async () => {
  let requests = 0;
  const result = await runCaptureAssistant({ ...input, aiProfile: { serviceId: 'openai', model: 'gpt-4.1' } }, {
    runtime, signal: new AbortController().signal, readAttachment: id => readCaptureChatAttachment(id, dependencies),
    call: () => assert.fail('attaching an image does not select or save it'),
    execute: (request, settings, images, options) => executeComposerTurnWithService(request, settings, images, { ...options, stream: false,
      fetchImpl: async (_url, init) => {
        requests++; const body = JSON.parse(init.body);
        assert.equal(body.model, 'gpt-4.1');
        assert(JSON.stringify(body).includes('input_image'));
        assert(JSON.stringify(body).includes(Buffer.from('actual original').toString('base64')));
        return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到真实截图' }] }] }));
      } })
  });
  assert.equal(result.ok, true); assert.equal(requests, 1);
});

test('a text-only model rejects image input before any paid request and preserves its explicit attachment identity', async () => {
  const textRuntime = { ...runtime, visionSettings: { providerProfiles: { 'custom-text': { id: 'custom-text', apiKey: 'fixture', consent: true,
    endpoint: 'https://example.test/chat/completions', protocol: 'chat_completions', capabilities: ['creativePlanning'], models: { creativePlanning: 'text-only' },
    discoveredModels: [{ id: 'text-only', tasks: ['creativePlanning'], inputModalities: ['text'], supportedParameters: ['tools'] }] } } } };
  const result = await runCaptureAssistant({ ...input, aiProfile: { serviceId: 'custom-text', model: 'text-only' } }, { runtime: textRuntime, signal: new AbortController().signal,
    readAttachment: id => readCaptureChatAttachment(id, dependencies), call: () => assert.fail('no capture'), execute: () => assert.fail('no paid request') });
  assert.equal(result.ok, false); assert.match(result.message, /不能接收图片/); assert.equal(file.transferId, 'user-file');
});

test('historical attachments remain scoped to the human conversation and are re-read only when requested', async () => {
  const result = await runCaptureAssistant({ ...input, attachments: [], messages: [{ role: 'user', content: '看这张截图', attachments: [file] }], aiProfile: { serviceId: 'openai', model: 'gpt-4.1' } }, {
    runtime, signal: new AbortController().signal, readAttachment: id => readCaptureChatAttachment(id, dependencies), call: () => assert.fail('no capture'),
    execute: async (_request, _settings, images, { toolRuntime }) => {
      assert.equal(images.length, 0);
      assert.equal((await toolRuntime.execute('read_chat_attachment', { transferId: 'other-session-file' })).data.code, 'attachment_unavailable');
      assert.equal((await toolRuntime.execute('update_capture', { captureId: 'preview', candidates: [{ media: [{ localTransferId: 'other-session-file' }] }] })).data.code, 'capture_scope_changed');
      assert.equal((await toolRuntime.execute('read_chat_attachment', { transferId: file.transferId })).images.length, 1);
      return { text: '按需重读' };
    } });
  assert.equal(result.ok, true);
});

test('saving an attachment uses its staged original identity and protects attachments across draft, history and page changes', async () => {
  const media = await resolveCaptureLocalMedia({ id: 'picked', kind: 'image', localTransferId: file.transferId }, dependencies.transfers);
  assert.equal(media.localAssetId, file.assetId); assert.equal(media.filename, file.name); assert.equal(media.url, '');
  await assert.rejects(resolveCaptureLocalMedia({ kind: 'video', localTransferId: file.transferId }, dependencies.transfers), { code: 'invalid_input' });
  assert.deepEqual(captureChatAssetIds({ history: [{ messages: [{ attachments: [file] }] }], pages: { current: { attachments: [file] } } }), [file.assetId]);
});
