import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePageCaptureCandidate, pageCaptureMediaFetchCandidates, resolvePageCaptureImage } from '../extension/page-capture.js';
import { normalizePageCaptureSitePayload } from '../extension/page-capture-site-adapters.js';

const original = 'https://example.com/original.jpg';
const preview = 'https://example.com/preview.jpg';
const media = {kind:'image', url:preview, width:640, height:360, sourceKind:'current', variants:[
  {url:preview, sourceKind:'picture-srcset', declaredWidth:8000},
  {url:original, sourceKind:'site-original'}
]};

test('generic and adapter images share original priority through normalization and actual download', async () => {
  for (const adapter of ['generic','x','pinterest','jimeng','krea','liblibai','higgsfield','midjourney']) {
    const candidate = normalizePageCaptureCandidate({id:adapter,adapter,title:'Original priority',canonicalUrl:'https://example.com/art',media:[media]});
    assert.deepEqual(pageCaptureMediaFetchCandidates(candidate.media[0]), [original,preview]);
    assert.equal(candidate.media[0].width, 0);
    const calls = [];
    const result = await resolvePageCaptureImage(candidate.media[0], {
      fetchMedia:async url=>{calls.push(`public:${url}`); if(url===original) throw Error('403'); return new Blob(['preview']);},
      fetchSessionMedia:async url=>{calls.push(`session:${url}`); return new Blob(['original']);},
      decodeDataUrl:()=>assert.fail('no pixels')
    });
    assert.equal(result.sourceUrl, original);
    assert.equal(result.usedReducedImage, false);
    assert.deepEqual(calls, [`public:${original}`,`session:${original}`]);
  }
});
test('generic original failure is disclosed when a preview is saved', async () => {
  const result = await resolvePageCaptureImage(media, {
    fetchMedia:async url=>{if(url===original)throw Error('404');return new Blob(['preview']);},
    sessionMediaAllowed:false, decodeDataUrl:()=>assert.fail('no pixels')
  });
  assert.equal(result.sourceUrl,preview);
  assert.equal(result.usedReducedImage,true);
});
test('rediscovering an existing URL as original upgrades its priority without duplicate requests', () => {
  assert.deepEqual(pageCaptureMediaFetchCandidates({...media,variants:[
    {url:original,sourceKind:'current'},{url:preview,sourceKind:'picture-srcset',declaredWidth:8000},
    {url:original,sourceKind:'site-original'}
  ]}),[original,preview]);
});
test('Liblib, Krea and Higgsfield thumbnail-only payloads are not labelled as originals', () => {
  const cases = [
    [{adapter:'liblibai',data:{uuid:'art',images:[{previewUrl:'https://liblibai-online.liblib.cloud/preview.jpg'}]}},'https://www.liblib.art/imageinfo/art'],
    [{adapter:'krea',jsonLd:[{'@type':'ImageObject',thumbnailUrl:'https://gen.krea.ai/preview.jpg'}]},'https://www.krea.ai/image/12345678-1234-4234-8234-123456789012'],
    [{adapter:'higgsfield',jsonLd:[{'@type':'ImageObject',thumbnailUrl:'https://images.higgs.ai/preview.jpg'}]},'https://higgsfield.ai/@artist/projects/art']
  ];
  for (const [payload,url] of cases) {
    const normalized = normalizePageCaptureSitePayload(payload,url);
    assert.ok(normalized?.media.length, JSON.stringify(payload));
    assert.equal(normalized.media[0].sourceKind,'current', JSON.stringify(payload));
  }
});
