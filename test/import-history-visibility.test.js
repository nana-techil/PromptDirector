import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
const source = await readFile(new URL('../extension/library.js', import.meta.url), 'utf8');
const declarations = parse(source, {ecmaVersion:'latest',sourceType:'module'}).body.filter(node => node.type === 'FunctionDeclaration');
function fixture(job) {
  const elements = Object.fromEntries(['importDialogTitle','importSource','importPreparing','importConfirmation','importJobPanel','importActions','importLastJob'].map(key=>[key,{}]));
  const scope=vm.createContext({elements,latestImportJob:job,t:value=>value});
  const node=declarations.find(node=>node.id.name==='renderImportSource');
  vm.runInContext(source.slice(node.start,node.end),scope);
  return {scope,elements};
}
test('completed or canceled successful imports do not leave a history action on the new import surface',()=>{
  for(const job of [null,{status:'completed',items:[{status:'imported'},{status:'skipped'}]}, {status:'canceled',items:[{status:'skipped',skipReason:'canceled'}]}]){
    const {scope,elements}=fixture(job);scope.renderImportSource();
    assert.equal(elements.importLastJob.hidden,true);assert.equal(elements.importSource.hidden,false);
    assert.equal(scope.latestImportJob,job);
  }
});
test('failed items remain reachable for retry, including a canceled batch with failures, while undone jobs stay hidden',()=>{
  for(const status of ['failed','canceled']){
    const job={id:'import-to-retry',status,items:[{status:'imported'},{status:'failed',error:'Cannot read original'}]};
    const {scope,elements}=fixture(job);scope.renderImportSource();assert.equal(elements.importLastJob.hidden,false);
    assert.equal(scope.latestImportJob,job);
    job.undoneAt='2026-10-18T00:00:00.000Z';scope.renderImportSource();assert.equal(elements.importLastJob.hidden,true);
  }
});
test('opening import during an active batch returns to real progress instead of hiding the task',async()=>{
  const job={status:'running',items:[{status:'queued'}]};
  let rendered=0,opened=0;
  const scope=vm.createContext({activeImportJob:job,renderImportJob:()=>rendered++,elements:{importDialog:{open:false,showModal:()=>opened++}}});
  const node=declarations.find(node=>node.id.name==='openLocalImportSource');vm.runInContext(source.slice(node.start,node.end),scope);
  await scope.openLocalImportSource();assert.equal(rendered,1);assert.equal(opened,1);assert.equal(scope.activeImportJob,job);
});
