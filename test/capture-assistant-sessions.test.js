import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreCaptureSessions, captureSessionForPage, newCaptureConversation, recentCaptureConversations } from '../extension/capture-assistant-sessions.js';
import { buildCaptureDiagnostic, captureDiagnosticValue } from '../extension/capture-assistant-diagnostics.js';

test('reopening shared chat restores newer page work without rewriting retained conversation history', () => {
  const sourceUrl = 'https://example.test/motion';
  const current = { sourceUrl, tabId: 7, captureId: '', pendingRevision: null,
    pendingBatch: { id: 'automatic-scan', sourceUrl, selections: ['selected'] } };
  const messages = [{role:'user',content:'Capture the remaining effects'}];
  const store = restoreCaptureSessions({schema:'shared-chat',activeId:'chat',pages:{[sourceUrl]:current},
    conversations:[{id:'chat',sourceUrl,tabId:7,captureId:'stale-preview',messages,draft:'Unsent draft'},
      {id:'running',sourceUrl,tabId:7,captureId:'in-flight',requestId:'task',messages:[]}]});
  const reopened = captureSessionForPage(store,{id:7,url:sourceUrl});
  assert.equal(reopened.captureId,'');
  assert.deepEqual(reopened.pendingBatch,current.pendingBatch);
  assert.equal(reopened.messages,messages);
  assert.equal(reopened.draft,'Unsent draft');
  assert.equal(store.conversations[1].captureId,'in-flight');
});

test('browsing keeps the user conversation while preserving unfinished originals by page', () => {
  const store = restoreCaptureSessions();
  const first = captureSessionForPage(store, { id: 1, url: 'https://example.com/a', title: 'A' });
  first.messages.push({ role: 'user', content: 'Capture this artwork' });
  first.pendingBatch = { sourceUrl: first.sourceUrl, candidates: [{ contentText: 'Exact original', media: [{ localAssetId: 'original' }] }], selections: [{ candidateId: 'chosen' }] };
  const originalBatch = structuredClone(first.pendingBatch), originalUrl = first.sourceUrl;
  const second = captureSessionForPage(store, { id: 2, url: 'https://example.com/b', title: 'B' });
  assert.equal(second.id, first.id); assert.equal(second.messages[0].content, 'Capture this artwork'); assert.equal(second.pendingBatch, null);
  const reopened = captureSessionForPage(restoreCaptureSessions(structuredClone(store)), { id: 3, url: originalUrl, title: 'A' });
  assert.deepEqual(reopened.pendingBatch, originalBatch); assert.deepEqual(reopened.messages, first.messages);
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
  assert.deepEqual(diagnostic.capture.sessions[0].pendingBatch, first.pendingBatch);
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


test('sidebar shows five recent chats while the sixth preserves all conversations and pending originals for studio management', () => {
  const store = restoreCaptureSessions(); const first = captureSessionForPage(store, {id:1,url:'https://example.com/a'});
  first.messages.push({role:'user',content:'first'}); first.pendingBatch={sourceUrl:first.sourceUrl,selections:['original']};
  const id=first.id, sourceUrl=first.sourceUrl;
  let current=first;
  for(let i=0;i<5;i++){current=newCaptureConversation(store,current); current.messages.push({role:'user',content:String(i)});}
  assert.equal(store.conversations.length,6); assert.equal(store.conversations.some(s=>s.id===id),true); assert.equal(recentCaptureConversations(store).length,5);
  assert.deepEqual(store.pages[sourceUrl].pendingBatch.selections,['original']);
  const restored=restoreCaptureSessions(structuredClone(store));
  assert.equal(captureSessionForPage(restored,{}).id,current.id);
  restored.activeId=restored.conversations[0].id;
  assert.equal(captureSessionForPage(restored,{id:2,url:'chrome://newtab/'}).messages[0].content,'first');
  assert.equal(restored.conversations.length,6);
});

test('no webpage is needed to persist chat and navigation cannot retarget an executing task', () => {
  const store=restoreCaptureSessions(); const current=captureSessionForPage(store,{});
  current.messages.push({role:'user',content:'Open my library'});
  assert.deepEqual(captureSessionForPage(restoreCaptureSessions(structuredClone(store)),{}).messages,current.messages);
  current.requestId='running'; current.tabId=4; current.sourceUrl='https://example.com/target';
  captureSessionForPage(store,{id:9,url:'https://example.com/new'});
  assert.equal(current.tabId,4); assert.equal(current.sourceUrl,'https://example.com/target');
});

test('a new webpage keeps the project and chat but does not inherit the previous page manual video type', () => {
  const store=restoreCaptureSessions();const session=captureSessionForPage(store,{id:1,url:'https://example.test/video'});
  session.projectDraft={collectionId:'chosen-project',contentTypeId:'content:prompt:video',contentTypeExplicit:true};
  session.messages=[{role:'user',content:'Keep my conversation'}];
  captureSessionForPage(store,{id:1,url:'https://example.test/code'});
  assert.equal(session.projectDraft.collectionId,'chosen-project');
  assert.equal(session.projectDraft.contentTypeId,'');assert.equal(session.projectDraft.contentTypeExplicit,false);
  assert.equal(session.messages[0].content,'Keep my conversation');
  session.projectDraft={...session.projectDraft,contentTypeId:'content:code-case',contentTypeExplicit:true};
  captureSessionForPage(store,{id:1,url:'https://example.test/video'});
  assert.equal(session.projectDraft.contentTypeId,'content:prompt:video');
  captureSessionForPage(store,{id:1,url:'https://example.test/code'});
  assert.equal(session.projectDraft.contentTypeId,'content:code-case');
});
