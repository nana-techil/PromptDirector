import test from 'node:test';
import assert from 'node:assert/strict';
import { textDifferenceParts } from '../extension/case-dedupe-diff.js';
test('diff preserves both full originals and separates independent edits',()=>{
 for(const [a,b] of [['Slow camera passes the red house.','Fast camera passes the blue house.'],['雨中慢推镜，聚焦角色。','雨中快推镜，聚焦车辆。'],['','new'],['same','same'],['a'.repeat(20000)+'b','a'.repeat(20000)+'c']]){
 const parts=textDifferenceParts(a,b);for(const side of ['left','right'])assert.equal(parts.map(p=>p.same??p[side]??'').join(''),side==='left'?a:b);
 }
 const parts=textDifferenceParts('Slow camera passes the red house.','Fast camera passes the blue house.');assert.ok(parts.some(p=>p.same?.includes('camera')));
});
