import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantChatSession,assistantChatView,assistantChatContent} from '../extension/assistant-chat-session.js';
import {createComposerSession,isMeaningfulComposerSession} from '../extension/composer.js';
import {collectRetainedLocalAssetIds} from '../extension/import-staging.js';

test('sidebar messages, receipts, draft and original attachments belong to the canonical studio conversation',()=>{
 const chat={id:'shared',draft:'unsent goal',messages:[{id:'human',role:'user',content:'保存这一份',attachments:[{transferId:'transfer',assetId:'original',name:'reference.png',kind:'image',mimeType:'image/png',byteSize:10}]},{id:'receipt',role:'result',result:{results:[{status:'saved',entryId:'case'}]}}]};
 const session=assistantChatSession(chat);const restored=createComposerSession(session),view=assistantChatView(restored);
 assert.equal(view.id,chat.id);assert.equal(view.draft,chat.draft);assert.deepEqual(view.messages[1].result,chat.messages[1].result);
 assert.equal(view.messages[0].attachments[0].assetId,'original');
 assert(collectRetainedLocalAssetIds({composerSessions:[session]}).has('original'),'history must protect the real attached file, not just a UI thumbnail');
 assert(isMeaningfulComposerSession(assistantChatSession({id:'draft',messages:[],draft:'a real unsent goal'})));
 assert(!isMeaningfulComposerSession(assistantChatSession({id:'empty',messages:[]})));
});

test('page bookkeeping does not alter canonical message identity or invalidate the shared dialogue',()=>{
 const chat={id:'shared',messages:[{id:'human',role:'user',content:'open library'}],sourceUrl:'https://example.com/a'};
 const saved=assistantChatSession(chat);
 saved.toolContext=[{name:'open_workspace',callId:'real'}];
 const refreshed=assistantChatSession({...chat,sourceUrl:'https://example.com/b'},saved);
 assert.equal(assistantChatContent(saved),assistantChatContent(refreshed));
 assert.deepEqual(refreshed.toolContext,saved.toolContext);assert.equal(refreshed.messages[0].createdAt,saved.messages[0].createdAt);
});
