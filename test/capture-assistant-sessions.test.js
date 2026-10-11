import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreCaptureSessions, captureSessionForPage, newCaptureConversation } from '../extension/capture-assistant-sessions.js';
import { buildCaptureDiagnostic, captureDiagnosticValue } from '../extension/capture-assistant-diagnostics.js';

test('changing webpages preserves the unfinished originals and exact selections on each page', () => {
  const store = restoreCaptureSessions();
  const first = captureSessionForPage(store, { id: 1, url: 'https://example.com/a', title: 'A' });
  first.messages.push({ role: 'user', content: 'Capture this artwork' });
  first.pendingBatch = { sourceUrl: first.sourceUrl, candidates: [{ contentText: 'Exact original', media: [{ localAssetId: 'original' }] }], selections: [{ candidateId: 'chosen' }] };
  const second = captureSessionForPage(store, { id: 2, url: 'https://example.com/b', title: 'B' });
  assert.deepEqual(second.messages, []); assert.equal(second.pendingBatch, undefined);
  const reopened = captureSessionForPage(restoreCaptureSessions(structuredClone(store)), { id: 3, url: first.sourceUrl, title: 'A' });
  assert.deepEqual(reopened.pendingBatch, first.pendingBatch); assert.deepEqual(reopened.messages, first.messages);
  assert.equal(reopened.tabId, 3);
});

test('new chat clears visible history but retains preview and previous rounds for an explicit diagnostic export', () => {
  const store = restoreCaptureSessions(); const first = captureSessionForPage(store, { id: 1, url: 'https://example.com', title: 'Page' });
  first.messages = [{ role: 'user', content: 'How do I capture?' }]; first.captureId = 'pending';
  first.pendingBatch = { selections: ['original selection'] };
  const fresh = newCaptureConversation(store, first);
  assert.deepEqual(fresh.messages, []); assert.equal(fresh.captureId, 'pending'); assert.deepEqual(fresh.pendingBatch, first.pendingBatch);
  const diagnostic = buildCaptureDiagnostic(store, fresh);
  assert.equal(diagnostic.schema, 'promptdirector-composer-diagnostic'); assert.equal(diagnostic.version, 2);
  assert.equal(diagnostic.capture.sessions.length, 2);
  assert.equal(diagnostic.capture.sessions[0].messages[0].content, 'How do I capture?');
  assert.equal(diagnostic.capture.sessions[0].pendingBatch, null);
});

test('legacy single-page sessions migrate without losing messages, pending tasks or attachments', () => {
  const legacy = { messages: [{ role: 'user', content: 'Keep these' }], requestId: 'running', pendingBatch: { sourceUrl: 'https://example.com/a', media: ['attachment'] } };
  const store = restoreCaptureSessions(legacy);
  const session = captureSessionForPage(store, { id: 4, url: legacy.pendingBatch.sourceUrl });
  assert.deepEqual(session.messages, legacy.messages); assert.equal(session.requestId, 'running');
  assert.deepEqual(session.pendingBatch, legacy.pendingBatch);
});

test('diagnostics preserve full text, failed tool attempts and model usage while omitting credentials and binary payloads', () => {
  const value = captureDiagnosticValue({ apiKey: 'private', nested: { authorization: 'private', password: 'private', dataUrl: 'private', text: 'Exact original' },
    toolCalls: [{ name: 'read_capture', result: { content: 'data:image/png;base64,eA==', error: 'Missing media' } }], usage: { total_tokens: 120 } });
  assert.equal(JSON.stringify(value).includes('private'), false); assert.equal(value.nested.text, 'Exact original');
  assert.equal(value.toolCalls[0].result.error, 'Missing media'); assert.equal(value.usage.total_tokens, 120);
  assert.equal(JSON.stringify(value).includes('base64,'), false);
});

test('the reported old-preview/new-page mismatch migrates to separate pages instead of restoring stale content on the new page', () => {
  const pendingBatch = { sourceUrl: 'https://example.com/old', selections: ['selected original'] };
  const store = restoreCaptureSessions({ sourceUrl: 'https://example.com/new', messages: [{ role: 'user', content: 'Capture this page' }], pendingBatch });
  const current = captureSessionForPage(store, { id: 2, url: 'https://example.com/new' });
  assert.equal(current.pendingBatch, null); assert.equal(current.messages[0].content, 'Capture this page');
  assert.deepEqual(store.pages[pendingBatch.sourceUrl].pendingBatch, pendingBatch);
});
