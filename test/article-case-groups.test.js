import test from 'node:test';
import assert from 'node:assert/strict';
import { splitArticleCases } from '../extension/article-case-groups.js';
import { normalizePageCaptureBatch, applyPageCaptureSelections } from '../extension/page-capture.js';
const heading = (id,text,level=2) => ({id,kind:'heading',text,level});
const paragraph = (id,text) => ({id,kind:'paragraph',text});
const image = id => ({id,kind:'image',assetId:id});
function candidate(blocks) { return {id:'article',title:'Article',canonicalUrl:'https://example.com/article',sourceFacts:{},media:blocks.filter(b=>b.kind==='image').map(b=>({id:b.id,kind:'image',url:`https://example.com/${b.id}.png`})),articleDocument:{blocks:blocks.map((b,sourceOrder)=>({...b,sourceOrder}))}}; }
test('case boundaries keep multiple images with the correct prompt and leave intro separate',()=>{
 const groups=splitArticleCases(candidate([paragraph('intro','Introduction'),image('cover'),heading('a','No. 1: Portrait'),heading('ap','提示词',3),paragraph('at','Portrait prompt'),image('a1'),image('a2'),heading('b','No. 2: Landscape'),heading('bp','提示词',3),paragraph('bt','Landscape prompt'),image('b1'),paragraph('bonus','彩蛋：Extra case'),image('c1'),{id:'ct',kind:'quote',text:'Extra prompt'}]));
 assert.equal(groups.length,4);
 assert.deepEqual(groups.map(g=>g.media.map(m=>m.id)),[['a1','a2'],['b1'],['c1'],['cover']]);
 assert.ok(groups[0].contentText.includes('Portrait prompt'));
 assert.ok(!groups[0].contentText.includes('Landscape prompt'));
 assert.equal(groups[3].batchStructureStatus,'review');
});
test('ordinary article headings and images alone do not invent independent prompt cases',()=>{
 assert.deepEqual(splitArticleCases(candidate([heading('a','Chapter 1'),paragraph('x','Some prose'),image('a1'),heading('b','Chapter 2'),paragraph('y','More prose'),image('b1')])),[]);
});
test('numbered paragraph headings can delimit styled articles; numbers inside prompt code cannot',()=>{
 const groups=splitArticleCases(candidate([paragraph('a','1、人物案例'),paragraph('ap','提示词：portrait'),{id:'code',kind:'code',text:'1. lighting\n2. composition'},image('a1'),paragraph('b','2、建筑案例'),paragraph('bp','Prompt: architecture'),image('b1')]));
 assert.equal(groups.length,2);
 assert.deepEqual(groups[0].media.map(m=>m.id),['a1']);
 assert.ok(groups[0].contentText.includes('2. composition'));
});

test('automatic cases stop before the next parent chapter so its introduction is not attributed to the previous prompt', () => {
 const input = candidate([heading('parent1','Chapter one',1), heading('a','Case A'), paragraph('ap','Prompt: first'), image('a1'),
  heading('b','Case B'), paragraph('bp','Prompt: second'), image('b1'), heading('parent2','Chapter two',1), paragraph('intro2','Next chapter introduction')]);
 const groups = splitArticleCases(input);
 assert.equal(groups[1].contentText,'Case B\n\nPrompt: second');
 assert.equal(groups.at(-1).contentText,'Chapter one\n\nChapter two\n\nNext chapter introduction');
});

test('same-level prompt labels remain inside their case rather than becoming new boundaries', () => {
 const input = candidate([heading('a','Case A'), heading('ap','提示词'), paragraph('at','First source prompt'), image('a1'),
  heading('b','Case B'), heading('bp','提示词'), paragraph('bt','Second source prompt'), image('b1')]);
 const groups = splitArticleCases(input);
 assert.equal(groups.length,2);
 assert.deepEqual(groups.map(group=>group.media.map(item=>item.id)),[['a1'],['b1']]);
 assert.ok(groups[0].contentText.includes('First source prompt'));
 assert.ok(!groups[0].contentText.includes('Second source prompt'));
});

test('automatic grouping preserves unplaced originals and unread sources through preview normalization and explicit save selection', () => {
 const input = candidate([heading('a','Case A'), paragraph('ap','Prompt: first'), image('a1'), image('a2'),
  heading('b','Case B'), paragraph('bp','Prompt: second'), image('b1')]);
 input.media.push({id:'unplaced',kind:'image',url:'https://example.com/unplaced.png'},
  {id:'attachment',kind:'document',url:'https://example.com/source.pdf'});
 input.possibleOmissions = [{id:'warning',text:'More media may exist'}];
 input.supplements = [{id:'source',text:'Unconfirmed source text',sourceUrl:'https://example.com/source'}];
 const original = structuredClone(input);
 const groups = splitArticleCases(input);
 assert.deepEqual(input,original,'grouping must not mutate the original candidate');
 assert.deepEqual(groups.map(g=>g.media.map(m=>m.id)),[['a1','a2'],['b1'],['unplaced','attachment']]);
 assert.equal(groups.at(-1).batchStructureStatus,'review');
 assert.deepEqual(groups.at(-1).possibleOmissions,input.possibleOmissions);
 assert.deepEqual(groups.at(-1).supplements,input.supplements);
 const batch = normalizePageCaptureBatch({candidates:groups,selections:groups.map(g=>({candidateId:g.id,includeText:true,
  selectedMediaIds:g.media.map(m=>m.id),mediaDecision:'confirmed'}))});
 const selected = applyPageCaptureSelections(batch);
 assert.deepEqual(batch.candidates.at(-1).possibleOmissions.map(item=>item.text),input.possibleOmissions.map(item=>item.text));
 assert.deepEqual(batch.candidates.at(-1).supplements.map(item=>item.text),input.supplements.map(item=>item.text));
 assert.deepEqual(selected.flatMap(g=>g.media.map(m=>m.id)),input.media.map(m=>m.id));
 assert.equal(selected[0].contentText,'Case A\n\nPrompt: first');
});

test('warnings and unread supplements retain a review candidate even when all article blocks and media are grouped', () => {
 const input = candidate([heading('a','Case A'), paragraph('ap','Prompt: first'), image('a1'),
  heading('b','Case B'), paragraph('bp','Prompt: second'), image('b1')]);
 input.possibleOmissions = [{id:'warning',text:'More media may exist'}];
 input.supplements = [{id:'source',text:'Unread source text',sourceUrl:'https://example.com/source'}];
 const groups = splitArticleCases(input);
 assert.equal(groups.length,3);
 assert.equal(groups.at(-1).batchStructureStatus,'review');
 assert.deepEqual(groups.at(-1).possibleOmissions,input.possibleOmissions);
 assert.deepEqual(groups.at(-1).supplements,input.supplements);
 assert.ok(groups.slice(0,-1).every(g=>!g.possibleOmissions.length&&!g.supplements.length));
 assert.equal(normalizePageCaptureBatch({candidates:groups}).candidates.length,3,'the review candidate must survive the actual preview boundary');
});

test('a shared original in the introduction remains there even when another occurrence belongs to a prompt case', () => {
 const input = candidate([{id:'intro-image',kind:'image',assetId:'shared'}, heading('a','Case A'), paragraph('ap','Prompt: first'),
  {id:'case-image',kind:'image',assetId:'shared'}, heading('b','Case B'), paragraph('bp','Prompt: second'), image('b1')]);
 input.media = [{id:'shared',kind:'image',url:'https://example.com/shared.png'}, {id:'b1',kind:'image',url:'https://example.com/b1.png'}];
 const groups = normalizePageCaptureBatch({candidates:splitArticleCases(input)}).candidates;
 assert.equal(groups.at(-1).articleDocument.blocks[0].id,'intro-image');
 assert.deepEqual(groups.at(-1).media.map(item=>item.id),['shared']);
 assert.equal(groups[0].articleDocument.blocks.find(block=>block.assetId==='shared').id,'case-image');
});
