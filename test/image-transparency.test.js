import test from 'node:test';
import assert from 'node:assert/strict';
import * as transparency from '../extension/image-transparency.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 15));
function canvasHarness() {
  let reads = 0;
  globalThis.document = { createElement() {
    let image;
    return { getContext: () => ({ clearRect() {}, drawImage(value) { image = value; },
      getImageData() {
        reads++;
        if (image.unreadable) throw new Error('tainted');
        return {data: new Uint8Array([0, 0, 0, image.alpha ? 0 : 255])};
      }
    }) };
  } };
  return () => reads;
}
function image(src, alpha = false) {
  const target = new EventTarget();
  return Object.assign(target, {src, currentSrc: '', alpha, complete: true,
    naturalWidth: 1, naturalHeight: 1, isConnected: true});
}

test('reopened immutable images reuse both opaque and transparent results within the preview budget', async () => {
  const reads = canvasHarness();
  const observe = transparency.createImageTransparencyObserver({maxEntries: 2});
  const results = [];
  for (const [src, alpha] of [['blob:a',false],['blob:b',true],['blob:a',false],['blob:b',true]]) {
    observe(image(src,alpha), value => results.push(value)); await settle();
  }
  assert.deepEqual(results,[false,true,false,true]); assert.equal(reads(),2);
  observe(image('blob:c'),()=>{}); await settle();
  observe(image('blob:a'),()=>{}); await settle();
  assert.equal(reads(),4,'evicted images are inspected again');
});

test('changed sources, detached viewers and unreadable images never publish or cache a stale result', async () => {
  const reads=canvasHarness(); const observe=transparency.createImageTransparencyObserver({maxEntries:2});
  const results=[];const changed=image('blob:old');changed.naturalHeight=512;
  observe(changed,v=>results.push(v)); changed.src='blob:new'; await settle();
  assert.deepEqual(results,[]);
  changed.alpha=true;changed.dispatchEvent(new Event('load'));await settle();
  assert.deepEqual(results,[true]);
  const detached=image('blob:detached');observe(detached,v=>results.push(v));detached.isConnected=false;await settle();
  assert.deepEqual(results,[true]);
  const bad=image('blob:bad');bad.unreadable=true;observe(bad,v=>results.push(v));await settle();
  const before=reads();observe(image('blob:bad'),v=>results.push(v));await settle();
  assert.equal(reads(),before+1);assert.deepEqual(results,[true,false]);
});

test('mutable remote URLs are rechecked and transparency beyond the first tile remains detected', async () => {
  const reads=canvasHarness();const observe=transparency.createImageTransparencyObserver({maxEntries:2});
  const results=[];
  observe(image('https://example.test/image',false),v=>results.push(v));await settle();
  observe(image('https://example.test/image',true),v=>results.push(v));await settle();
  const large=image('blob:large');large.naturalHeight=512;
  observe(large,v=>results.push(v));large.alpha=true;await settle();
  assert.deepEqual(results,[false,true,true]);assert.equal(reads(),4);
});
