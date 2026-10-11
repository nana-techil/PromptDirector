import test from 'node:test';
import assert from 'node:assert/strict';
import { codePreviewHtml, codePreviewText } from '../extension/code-case.js';
import { compactCaptureReply, CAPTURE_REPLY_CHARACTERS } from '../extension/capture-reply.js';
import { classifyContent } from '../extension/classifier.js';
import { CONTENT_IDS, createDefaultTaxonomy, normalizeTaxonomy } from '../extension/taxonomy.js';

test('runnable preview roundtrips exact code including markdown fences without replacing original sources', () => {
  const html = '<!doctype html><html><body><script>let a="```";</script></body></html>';
  const original = 'CSS original\nReact original\nPrompt original';
  const text = original + '\n' + codePreviewText(html);
  assert.equal(codePreviewHtml(text), html); assert(text.startsWith(original));
  assert.deepEqual(classifyContent({ text, sourceFacts: { codePreviewAvailable: true } }).pathIds, [CONTENT_IDS.codeCase]);
  assert.notDeepEqual(classifyContent({ text }).pathIds, [CONTENT_IDS.codeCase], 'webpage text alone does not authorize a runnable code case');
  assert.equal(codePreviewHtml('```html\n<p>ordinary article</p>\n```'), '', 'ordinary article snippets do not become executable previews');
});
test('existing libraries gain a code type while custom names and original classifications remain intact', () => {
  const taxonomy = createDefaultTaxonomy(); taxonomy.nodes = taxonomy.nodes.filter(node => node.id !== CONTENT_IDS.codeCase);
  taxonomy.nodes[0].name = 'My tutorial';
  const updated = normalizeTaxonomy(taxonomy);
  assert(updated.nodes.some(node => node.id === CONTENT_IDS.codeCase));
  assert.equal(updated.nodes[0].name, 'My tutorial');
});
test('long sidebar replies stay compact while the original and saved code remain untouched', () => {
  const original = '暂未保存。'.repeat(100) + '```html\nsource\n```';
  const result = compactCaptureReply(original);
  assert(result.overflow); assert(Array.from(result.brief).length <= CAPTURE_REPLY_CHARACTERS);
  assert(original.endsWith('```html\nsource\n```'));
  assert.deepEqual(compactCaptureReply('已保存。'), { brief: '已保存。', overflow: false });
});
