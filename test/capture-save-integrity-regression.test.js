import test from 'node:test';
import assert from 'node:assert/strict';
import { combinePageCaptureCandidates, normalizePageCaptureCandidate } from '../extension/page-capture.js';
import { articleDocumentText } from '../extension/article-document.js';
import { projectAgentToolContext, readAgentToolResult } from '../extension/agent-runtime-context.js';

test('combining one selected code case must preserve its full source, preview and identity instead of a title-only article', () => {
 const candidate=normalizePageCaptureCandidate({id:'one',title:'Resize',canonicalUrl:'https://example.test',contentRole:'code_case',contentText:'```css\n.card {\n  height: 64px;\n}\n```\n\n```promptdirector-preview-html\n<button>Run</button>\n```',media:[]});
 const combined=combinePageCaptureCandidates([candidate]);
 assert.equal(combined.id,candidate.id);
 assert.equal(combined.contentText,candidate.contentText);
 assert(!combined.articleDocument || articleDocumentText(combined.articleDocument).includes(candidate.contentText));
});

test('combining text-only captures with structured articles retains both full bodies in the document saved downstream', () => {
 const values=[{id:'code',title:'Code',canonicalUrl:'https://example.test/code',contentText:'```js\nfunction x() {\n  return 1;\n}\n```',media:[]},
 {id:'article',title:'Article',canonicalUrl:'https://example.test/article',contentText:'Article body',articleDocument:{blocks:[{id:'paragraph',kind:'paragraph',text:'Article body'}]},media:[]}];
 const combined=combinePageCaptureCandidates(values);
 const saved=articleDocumentText(combined.articleDocument);
 assert(saved.includes(values[0].contentText));assert(saved.includes('Article body'));
});

test('historical directories keep module identities but do not resend every source selector; originals remain exactly retrievable', () => {
 const sources=Array.from({length:3},(_,i)=>({selector:'#root > '+ 'div:nth-of-type(4) > '.repeat(8)+`pre:nth-of-type(${i+1})`,language:['css','react','prompt'][i],characters:500}));
 const record={name:'read_capture',callId:'read-1',turnId:'turn-1',args:{captureId:'capture',part:'modules'},data:{captureId:'capture',part:'modules',revision:1,modules:[{title:'One effect',selector:'#effect',sources}],offset:0,total:1,nextOffset:null}};
 const data=projectAgentToolContext([record]).untrustedToolEvidence[0].data.modules[0];
 assert.equal(data.title,'One effect');assert.equal(data.selector,'#effect');
 assert(data.sourcesReference,'history needs an exact source pointer, not repeated long selectors');
 assert.deepEqual(JSON.parse(readAgentToolResult([record],data.sourcesReference).content),sources);
 assert.deepEqual(record.data.modules[0].sources,sources);
});

test('reopened-page history uses references for older inventories without deleting frozen work or hiding the current modules', () => {
 const old={name:'read_capture',callId:'old',turnId:'t',args:{captureId:'old',part:'modules'},data:{sourceUrl:'https://example.test',captureId:'old',part:'modules',modules:[{selector:'#old',title:'Earlier module'}],revision:1}};
 const prep={name:'prepare_capture',callId:'new',data:{ok:true,sourceUrl:'https://example.test',captureId:'new'}};
 const current={...old,callId:'current',args:{captureId:'new',part:'modules'},data:{...old.data,captureId:'new',modules:[{selector:'#new',title:'Current module'}]}};
 const records=[old,prep,current];const evidence=projectAgentToolContext(records).untrustedToolEvidence;
 assert.equal(evidence[0].data.modules,undefined);assert.equal(evidence[0].data.newerCaptureId,'new');
 assert.deepEqual(JSON.parse(readAgentToolResult(records,evidence[0].data.modulesReference).content),old.data.modules);
 assert.equal(evidence[2].data.modules[0].selector,'#new');
});
