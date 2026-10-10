"""Slow destructive work must stay visibly busy, including after closing/reopening."""
import os
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import base_entry, extension_session

with extension_session('pd-trash-feedback-') as run:
    page = run.open_page('collector.html')
    gone = base_entry('gone', 'Deleted case', 'Keep until confirmed', 'content:prompt:image')
    run.seed_storage(page, {'entries': [base_entry('live', 'Kept', 'Kept', 'content:prompt:image')], 'trashState': {'version': 1, 'items': [{
        'id': 'trash:entry:gone', 'kind': 'entry', 'targetId': 'gone',
        'deletedAt': '2026-10-09T00:00:00Z', 'snapshot': gone}]}})
    library = run.open_page('library.html')
    expect(library.locator("body[data-library-state='ready']")).to_be_visible()
    library.locator('#open-trash').click()
    worker = run.context.service_workers[0]
    worker.evaluate('''() => {
      const set=chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set=async function(values){
        if(values.pendingTrashCleanup) {
          self.commitBlocked=true;
          await new Promise(resolve=>self.releaseCleanupCommit=resolve);
        }
        return set(values);
      };
    }''')
    library.locator('#trash-empty').click()
    library.evaluate('''() => {
      document.addEventListener('click', event=>{if(event.target.closest('button')?.textContent==='永久清空') window.cleanupClickAt=performance.now();});
      new MutationObserver(()=>{if(!window.cleanupFeedbackMs&&document.querySelector('#trash-feedback').getAttribute('aria-busy')==='true') window.cleanupFeedbackMs=performance.now()-window.cleanupClickAt;})
        .observe(document.querySelector('#trash-feedback'),{attributes:true,childList:true});
    }''')
    library.get_by_role('button', name='永久清空', exact=True).click()
    expect(library.locator('#trash-feedback')).to_contain_text('正在')
    expect(library.locator('#trash-dialog')).to_have_attribute('aria-busy', 'true')
    expect(library.locator('#trash-progress')).to_be_visible()
    assert library.locator('#trash-feedback').evaluate('(el)=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}')
    expect(library.locator('#trash-empty')).to_be_disabled()
    expect(library.locator('#trash-restore-all')).to_be_disabled()
    library.locator('#trash-close').click()
    library.locator('#open-trash').click()
    expect(library.locator('#trash-feedback')).to_contain_text('正在')
    expect(library.locator('#trash-dialog')).to_have_attribute('aria-busy', 'true')
    for width in [1440, 420]:
        library.set_viewport_size({'width': width, 'height': 900})
        expect(library.locator('#trash-progress')).to_be_visible()
        assert library.locator('#trash-feedback').evaluate('(el)=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}')
        if os.environ.get('PROMPTDIRECTOR_E2E_ARTIFACT_DIR'):
            target = Path(os.environ['PROMPTDIRECTOR_E2E_ARTIFACT_DIR'])
            target.mkdir(parents=True, exist_ok=True)
            library.screenshot(path=str(target / f'trash-busy-{width}.png'))
    assert worker.evaluate('()=>self.commitBlocked')
    # A second library page can recover the running state without waiting in the write queue.
    observer = run.open_page('collector.html')
    status = observer.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_TRASH_CLEANUP_STATUS'})")
    assert status['progress']['phase'] == 'committing', status
    # Refreshing the view must not cancel the background work or lose its visible state.
    feedback_ms = library.evaluate('()=>window.cleanupFeedbackMs')
    assert feedback_ms is not None
    library.reload()
    expect(library.locator("body[data-library-state='ready']")).to_be_visible(timeout=10000)
    library.set_viewport_size({'width': 1440, 'height': 900})
    library.locator('#open-trash').click()
    expect(library.locator('#trash-feedback')).to_contain_text('正在')
    expect(library.locator('#trash-progress')).to_be_visible()
    worker.evaluate('()=>self.releaseCleanupCommit()')
    expect(library.locator('.trash-empty-title')).to_be_visible(timeout=30000)
    expect(library.locator('#trash-dialog')).not_to_have_attribute('aria-busy', 'true')
    assert observer.evaluate("async()=>(await chrome.storage.local.get('trashState')).trashState.items.length") == 0
    # A rejected metadata commit must release the controls and preserve recoverable content.
    observer.evaluate('''async entry=>chrome.storage.local.set({trashState:{version:1,items:[{
      id:'trash:entry:gone',kind:'entry',targetId:'gone',deletedAt:'2026-10-09T00:00:00Z',snapshot:entry}]}})''', gone)
    worker.evaluate('''()=>{const set=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=async values=>{
      if(values.pendingTrashCleanup) throw new Error('fixture commit rejected');return set(values);
    };}''')
    library.locator('#trash-close').click()
    library.locator('#open-trash').click()
    library.locator('#trash-empty').click()
    library.get_by_role('button', name='永久清空', exact=True).click()
    expect(library.locator('#trash-feedback')).to_contain_text('fixture commit rejected')
    expect(library.locator('#trash-progress')).not_to_be_visible()
    expect(library.locator('#trash-empty')).to_be_enabled()
    assert observer.evaluate("async()=>(await chrome.storage.local.get('trashState')).trashState.items.length") == 1
    print(f'PASS: pending feedback in {feedback_ms:.1f} ms; conflicting actions disabled; close/reopen/refresh; independent status; completion; rejected commit preserves content and unlocks UI')
