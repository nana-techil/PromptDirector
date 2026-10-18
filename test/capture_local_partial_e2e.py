"""One expired local attachment must not roll back other selected capture candidates."""
import json
from e2e_support import extension_session


def main():
    with extension_session('pd-local-partial-') as run:
        page = run.open_page('collector.html')
        run.seed_storage(page, {'entries': []})
        result = page.evaluate('''async()=>{
          const {normalizePageCaptureBatch}=await import('./page-capture.js');
          const candidates=[{id:'expired',title:'Expired attachment',canonicalUrl:'https://example.test/expired',contentText:'Keep this exact original body',
            media:[{id:'missing',kind:'image',url:'https://example.test/image.png',localTransferId:'expired-transfer',localAssetId:'expired-asset'}]},
            {id:'valid',title:'Valid original',canonicalUrl:'https://example.test/valid',contentText:'Second exact original body',media:[]}];
          const batch=normalizePageCaptureBatch({sourceUrl:'https://example.test/',candidates,saveMode:'multiple',
            selections:candidates.map(c=>({candidateId:c.id,includeText:true,selectedMediaIds:c.media.map(m=>m.id),mediaDecision:'confirmed'}))});
          const saved=await chrome.runtime.sendMessage({type:'COMMIT_PAGE_CAPTURE',batch});
          const state=await chrome.runtime.sendMessage({type:'GET_STATE'});
          return {saved,entries:state.entries};
        }''')
        assert result['saved']['ok'], result
        receipts = {r['candidateId']: r for r in result['saved']['results']}
        assert receipts['expired']['status'] == 'partial' and receipts['expired']['warnings'], result
        assert receipts['valid']['status'] == 'saved', result
        assert len(result['entries']) == 2, result
        page.reload()
        readback = page.evaluate("()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
        assert {e['text'] for e in readback['entries']} == {'Keep this exact original body', 'Second exact original body'}, readback
        print(json.dumps({'localFailureIsolated': True, 'savedOriginalsReopened': True}))


if __name__ == '__main__':
    main()
