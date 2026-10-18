"""Isolated large-library discovery and physical trash cleanup timing; never uses daily data."""
import json,time
from e2e_support import extension_session,base_entry
with extension_session('pd-maintenance-perf-') as run:
 p=run.open_page('collector.html')
 r=p.evaluate('''async()=>{const {scanDuplicateCases,bulkDuplicateGroups}=await import('./library-duplicates.js');const entries=Array.from({length:11242},(_,i)=>({id:'e'+i,title:'Case '+i,text:'original prompt '.repeat(150),mediaAssets:[{id:'m'+(i%5621),kind:'image',storageMode:'managed',byteSize:100,contentHash:(i%5621).toString(16).padStart(64,'0')}]}));const start=performance.now();let s;const it=scanDuplicateCases({entries});do{s=await it.next()}while(!s.done);bulkDuplicateGroups(s.value,entries);return {scanMs:performance.now()-start,cases:entries.length,groups:s.value.mediaGroups.length}}''')
 entries=[base_entry('live'+str(i),'Live','text '*400,'content:prompt:image',0) for i in range(1200)]
 trash=[{'id':'trash:entry:gone'+str(i),'kind':'entry','targetId':'gone'+str(i),'deletedAt':'2026-10-09T00:00:00Z','snapshot':base_entry('gone'+str(i),'Gone','text '*400,'content:prompt:image',0)} for i in range(1000)]
 run.seed_storage(p,{'entries':entries,'trashState':{'version':1,'items':trash}})
 p.evaluate('''async()=>{const {getLibraryStorage}=await import('./library-storage.js');const s=getLibraryStorage();const {entries}=await s.get('entries');await s.set({upgradeBackup:{state:{entries}},migrationBackup:{entries}})}''')
 t=time.monotonic();response=p.evaluate("async()=>chrome.runtime.sendMessage({type:'EMPTY_TRASH'})");r.update(trashMs=(time.monotonic()-t)*1000,trashItems=1000,ok=response['ok'])
 assert response['ok'],response
 assert len(response['permanentlyDeletedItemIds'])==1000
 saved=p.evaluate("async()=> (await import('./library-storage.js')).getLibraryStorage().get(['entries','trashState','upgradeBackup'])")
 assert len(saved['entries'])==1200 and len(saved['upgradeBackup']['state']['entries'])==1200
 assert saved['trashState']['items']==[]
 # Real Blob bytes, multiple shared owners, and a batch larger than the UI rendering page.
 result=p.evaluate('''async()=>{
  const {getLibraryStorage}=await import('./library-storage.js');const storage=getLibraryStorage();
  const {saveMediaBlob,getMediaBlob}=await import('./media-store.js');const {sha256Blob}=await import('./blob-digest.js');
  const {moveEntriesToTrash}=await import('./trash.js');
  const entries=[],assets=[];
  for(let i=0;i<60;i++){
   const id='original-'+i,blob=new Blob(['actual bytes '+i],{type:'image/png'});await saveMediaBlob(id,blob,{checkCapacity:false});
   const entryIds=[];for(let j=0;j<4;j++){const caseId='verified-'+i+'-'+j;entryIds.push(caseId);entries.push({id:caseId,text:'Original '+caseId,mediaAssets:[{id,kind:'image',storageMode:'managed'}]});}
   assets.push({assetId:id,entryIds});
  }
  await storage.set({entries});const start=performance.now();
  for(let offset=0;offset<assets.length;offset+=24){const response=await chrome.runtime.sendMessage({type:'VERIFY_DEDUPE_MEDIA',assets:assets.slice(offset,offset+24)});if(!response.ok)throw new Error(response.message);if(response.results.some(r=>r.failedIds.length))throw new Error('Verification failed');}
  const verifyMs=performance.now()-start;const saved=(await storage.get('entries')).entries;
  for(const entry of saved){const a=entry.mediaAssets[0],blob=await getMediaBlob(a.id);if(a.contentHash!==await sha256Blob(blob)||a.byteSize!==blob.size||entry.text!=='Original '+entry.id)throw new Error('Readback mismatch');}
  // Keep one owner of original-0; permanently remove every other case and its exclusive bytes.
  const keptId=entries[0].id;const moved=moveEntriesToTrash({entries:saved,organizerState:{collections:[]},trashState:{items:[]}},entries.slice(1).map(e=>e.id));
  await storage.set({entries:moved.entries,trashState:moved.trashState});
  const cleanup=await chrome.runtime.sendMessage({type:'EMPTY_TRASH'});if(!cleanup.ok)throw new Error(cleanup.message);
  for(let i=0;i<60;i++)if(Boolean(await getMediaBlob('original-'+i))!==(i===0))throw new Error('Shared/exclusive original cleanup mismatch');
  if((await storage.get('entries')).entries[0].id!==keptId)throw new Error('Lost kept case');
  return {verifyMs,originals:60,updatedCases:saved.length,sharedOriginalPreserved:true,exclusiveOriginalsDeleted:59};
 }''')
 r.update(result)
 assert not run.page_errors,run.page_errors
 print(json.dumps(r))
