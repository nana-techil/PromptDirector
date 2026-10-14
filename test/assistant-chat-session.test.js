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

test('typing does not freeze the conversation title at its first character',()=>{
 let saved=assistantChatSession({id:'chat',draft:'c',messages:[]});
 saved=assistantChatSession({id:'chat',draft:'capture this code',messages:[]},saved);
 saved=assistantChatSession({id:'chat',draft:'',messages:[{role:'user',content:'capture this code'}]},saved);
 assert.equal(saved.title,'capture this code');
 const repaired=assistantChatSession({id:'chat',draft:'',messages:[{role:'user',content:'capture this code'}]}, {...saved,title:'c'});
 assert.equal(repaired.title,'capture this code');
});

test('automatic titles follow confirmed results while a studio title edited by the user stays intact',()=>{
 const messages=[{role:'user',content:'这个也存一下'}];
 const initial=assistantChatSession({id:'chat',messages});
 const completed=assistantChatSession({id:'chat',messages:[...messages,{role:'result',result:{results:[{status:'saved',title:'Magnetic Button'}]}}]},initial);
 assert.equal(completed.title,'Magnetic Button');
 const manual={...completed,title:'My named research chat'};
 assert.equal(assistantChatSession({id:'chat',messages},manual).title,manual.title);
});

test('ordinary sidebar views exclude heavy diagnostics while saving a draft preserves every old turn',()=>{
 const turns=[{requestId:'old',diagnostic:{source:'original'.repeat(100000)}}];
 const previous=assistantChatSession({id:'chat',messages:[{role:'user',content:'capture'}],turns});
 const view=assistantChatView(previous);
 assert.equal(view.turns,undefined,'opening the sidebar must not transfer diagnostic source bodies');
 const next=assistantChatSession({...view,draft:'new input',turns:[{requestId:'new',diagnostic:{ok:true}}]},previous);
 assert.deepEqual(next.assistantState.turns,[...turns,{requestId:'new',diagnostic:{ok:true}}]);
 const again=assistantChatSession({...view,turns:[{requestId:'new',diagnostic:{ok:true}}]},next);
 assert.equal(again.assistantState.turns.length,2);
 assert.deepEqual(assistantChatView(again,{includeDiagnostics:true}).turns,next.assistantState.turns);
});
