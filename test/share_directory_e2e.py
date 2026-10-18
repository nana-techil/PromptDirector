"""Real persistent directory handles and ZIP writes in a disposable origin.

The OS picker is replaced; ZIP generation, handle storage, writes and readback are real.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import base_entry, extension_session

with extension_session('pd-share-directory-') as run:
    setup = run.open_page('collector.html')
    entry = base_entry('shared', 'Share originals', 'Complete original prompt', 'content:prompt:image')
    entry['mediaAssets'] = [{'id': 'picture', 'kind': 'image', 'storageMode': 'managed', 'mimeType': 'image/png', 'width': 1, 'height': 1}]
    entry['primaryMediaId'] = 'picture'
    run.seed_storage(setup, {'entries': [entry], 'organizerState': {'collections': [{'id': 'project', 'name': 'Project', 'entryIds': ['shared']}]}, 'uiPreferences': {'locale': 'en', 'motion': 'reduced'}})
    setup.evaluate('''async()=>{const {saveMediaBlob}=await import('./media-store.js');
      await saveMediaBlob('picture',await(await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')).blob());}''')
    page = run.open_page('library.html')
    expect(page.locator('.case-card')).to_have_count(1)
    page.locator('#open-settings').click()
    expect(page.locator('#export-path-setting')).to_have_value('Choose location each time')
    page.evaluate('''()=>{window.showDirectoryPicker=async options=>{window.pickerMode=options.mode;
      return (await navigator.storage.getDirectory()).getDirectoryHandle('Chosen share folder',{create:true});};}''')
    page.locator('#choose-share-directory').click()
    expect(page.locator('#export-path-setting')).to_have_value('Chosen share folder')
    assert page.evaluate('pickerMode') == 'readwrite'
    # Canceling a new choice must leave the prior location and permission untouched.
    page.evaluate("()=>{window.showDirectoryPicker=async()=>{throw new DOMException('Canceled','AbortError')};}")
    page.locator('#choose-share-directory').click()
    expect(page.locator('#export-path-setting')).to_have_value('Chosen share folder')
    artifact = os.environ.get('PD_E2E_ARTIFACT_DIR')
    if artifact:
        for width in [390, 1280]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.screenshot(path=str(Path(artifact) / f'share-location-en-{width}.png'))
    page.locator('#settings-close').click()
    page.reload()
    expect(page.locator('.case-card')).to_have_count(1)
    page.locator('#open-settings').click()
    expect(page.locator('#export-path-setting')).to_have_value('Chosen share folder')
    page.locator('#settings-close').click()
    for _ in range(2):
        page.locator('#select-cases').click()
        page.locator('.case-card').click()
        page.locator('#selection-more-menu > summary').click()
        page.locator('#share-export').click()
        page.locator('#share-dialog-export').click()
        expect(page.locator('#share-dialog')).not_to_be_visible(timeout=30000)
    result = page.evaluate("async()=>chrome.runtime.sendMessage({type:'EXPORT_PROJECT',collectionId:'project',directory:true})")
    assert result['ok'], result
    packages = page.evaluate('''async()=>{
      const {shareDirectory}=await import('./share-directory.js');
      const {readZipResources}=await import('./zip-reader.js');const directory=await shareDirectory();const result=[];
      for await (const [name,handle] of directory.entries()) {
        const file=await handle.getFile();const resources=await readZipResources(file);
        const metadata=JSON.parse(await resources.get('library.json').text());
        if(metadata.entries[0].text!=='Complete original prompt')throw Error('Original prompt lost');
        const original=await import('./media-store.js').then(module=>module.getMediaBlob('picture'));
        const bytes=await resources.get('images/shared/picture.png').arrayBuffer();
        if(JSON.stringify([...new Uint8Array(bytes)])!==JSON.stringify([...new Uint8Array(await original.arrayBuffer())]))throw Error('Original image changed');
        result.push({name,bytes:file.size,paths:[...resources.keys()],originalPromptAndBytes:true});
      }return result;
    }''')
    assert len(packages) == 3 and len({p['name'] for p in packages}) == 3, packages
    assert any('(1)' in p['name'] for p in packages), packages
    assert all(p['bytes'] > 100 and any('picture' in path for path in p['paths']) for p in packages), packages
    failure_checks = page.evaluate('''async()=>{
      const {shareDirectory,writeShareArchive}=await import('./share-directory.js');
      const directory=await shareDirectory();const before=[];
      for await(const name of directory.keys())before.push(name);
      try {await writeShareArchive({queryPermission:async()=> 'denied'},new Blob(['new']),'denied.zip');throw Error('Permission failure was reported as success');}
      catch(error){if(!error.message.includes('尚未授权'))throw error;}
      for(const failure of ['open','write']) {
        const wrapped={queryPermission:async()=> 'granted',removeEntry:name=>directory.removeEntry(name),
          getFileHandle:async(name,options)=>{
            const handle=await directory.getFileHandle(name,options);
            if(!options?.create)return handle;
            return {createWritable:async()=>{if(failure==='open')throw Error('Disk open failed');
              return new WritableStream({write(){throw Error('Disk write failed');}});}};
          }};
        try{await writeShareArchive(wrapped,new Blob(['new']),failure+'.zip');throw Error('Disk failure was reported as success');}
        catch(error){if(!error.message.startsWith('Disk'))throw error;}
      }
      const after=[];for await(const name of directory.keys())after.push(name);
      if(JSON.stringify(before.sort())!==JSON.stringify(after.sort()))throw Error('Failure changed existing packages or left a partial file');
      return {permissionDenied:true,diskFailurePreservesPackages:true};
    }''')
    page.locator('#open-settings').click()
    page.locator('#reset-share-directory').click()
    expect(page.locator('#export-path-setting')).to_have_value('Choose location each time')
    assert setup.evaluate('''async()=>{const directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('Chosen share folder');let count=0;for await(const _ of directory.keys())count++;return count;}''') == 3
    assert not run.page_errors, run.page_errors
    print(json.dumps({'realHandlePersistence': True, 'pickerCanceledPreviousKept': True, 'completePackages': packages, 'failureChecks': failure_checks, 'resetPreservesFiles': True}))
