import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizePageCaptureBatch } from '../extension/page-capture.js';
import { appendCaptureCandidate } from '../extension/capture-additions.js';

test('adding partially captured content retains previous materials, new originals, and the visible failure', async () => {
  const source = await readFile(new URL('../extension/collector.js', import.meta.url), 'utf8');
  const choose = source.slice(source.indexOf('async function extractPageSelection('), source.indexOf('async function extractClipboard('));
  const append = source.slice(source.indexOf('function appendToPageCapture('), source.indexOf('function syncDraftIntoPageCapture('));
  const pageCaptureBatch = normalizePageCaptureBatch({ id: 'draft', sourceUrl: 'https://example.com/work', candidates: [
    { id: 'original', title: 'Original', contentText: 'Preserve existing original text.', media: [{id:'old-image',kind:'image',url:'https://example.com/old.png'}] }
  ], selections: [{ candidateId: 'original', selectedMediaIds: ['old-image'], includeText: true }] });
  const context = vm.createContext({
    structuredClone, normalizePageCaptureBatch, appendCaptureCandidate,
    pageCaptureBatch, saving: false, pageCaptureEditing: null, pageCaptureRequestId: '', manuallyPickedBatchId: 'draft',
    capturePreviewEditVersion: 0, pageCaptureEditHistory: [], genericGroupingBase: null,
    render() {}, withButton: async (_button, action) => action(), resolveActivePage: async () => ({id:1}),
    showFeedback(message) { throw Error(message); }, previewPageCaptureRegion() {},
    chrome: { tabs: {}, scripting: {}, runtime: { sendMessage: async () => ({ok:true,batch:{
      id:'new-selection',sourceUrl:'https://example.com/work',error:'One embedded frame could not be captured.',candidates:[
        {id:'addition',title:'Additional content',contentText:'Preserve newly selected text.',media:[{id:'new-image',kind:'image',url:'https://example.com/new.png'}]}
      ]
    }}) }}
  });
  await vm.runInContext(`${append}\n${choose}\nextractPageSelection({})`, context);
  const result = context.pageCaptureBatch;
  assert.equal(result.id, 'draft');
  assert.match(result.candidates[0].contentText, /Preserve existing original text\./);
  assert.match(result.candidates[0].contentText, /Preserve newly selected text\./);
  assert.deepEqual(result.candidates[0].media.map(media => media.url), ['https://example.com/old.png','https://example.com/new.png']);
  assert.equal(result.error, 'One embedded frame could not be captured.');
  assert.equal(context.pageCaptureEditing, null);
});
