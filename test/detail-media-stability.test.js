import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(process.env.PD_MEDIA_SOURCE || new URL('../extension/library.js',import.meta.url),'utf8');
const start=source.indexOf('  function syncMediaStageSize(');
const size=source.slice(start,source.indexOf('\n  function captureDetailScrollAnchor',start));
function stageFixture({mobile=false,assets=[{kind:'video',width:1920,height:1080},{kind:'image',width:800,height:1200}],review=false}={}) {
 const heights=[];
 const context=vm.createContext({contentAssets:assets,activeIndex:0,immersive:true,
  stage:{querySelector:selector=>selector.includes('caption')?{offsetHeight:52}:null},
  gallery:{clientWidth:600,style:{setProperty:(_,value)=>heights.push(Number.parseFloat(value))},parentElement:{querySelector:()=>({getBoundingClientRect:()=>({height:60})})}},
  elements:{detailDrawer:{classList:{contains:()=>review}}},mobileLayout:{matches:mobile},innerHeight:800,
  getComputedStyle:()=>({maxHeight:'464px'}),rail:{isConnected:false,offsetHeight:0}});
 vm.runInContext(size,context);return {run:asset=>context.syncMediaStageSize(asset),heights};
}
test('mixed image/video cases keep one stage through loading metadata and landscape/portrait switches',()=>{
 for(const mobile of [false,true]) {
  const f=stageFixture({mobile});
  for(const asset of [{kind:'video'}, {kind:'video',width:1920,height:1080},{kind:'image',width:800,height:1200},{kind:'image',width:1600,height:900}])f.run(asset);
  assert.equal(f.heights.length,4);assert.equal(new Set(f.heights).size,1);assert.equal(f.heights[0],mobile?464:740);
 }
});
test('single media retain fitted height and review layout remains managed by its existing player',()=>{
 const asset={kind:'image',width:1600,height:900};const f=stageFixture({assets:[asset]});f.run(asset);assert.equal(f.heights[0],389.5);
 const review=stageFixture({review:true});review.run(asset);assert.deepEqual(review.heights,[]);
});
test('document stages do not adopt the mixed image/video height rule',()=>{
 const f=stageFixture();f.run({kind:'document',width:1600,height:900});assert.equal(f.heights[0],389.5);
});
