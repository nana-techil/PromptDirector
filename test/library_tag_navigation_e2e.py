"""Tag navigation filters a large library and restores its full result sequence."""
import json, os
from pathlib import Path
from e2e_support import extension_session,base_entry
from playwright.sync_api import expect
def main():
    with extension_session('pd-tag-filter-') as run:
        setup=run.open_page('collector.html',wait_until='networkidle')
        entries=[base_entry(f'tag-{i}',f'Tagged case {i}',f'Source {i}','content:prompt:image') for i in range(6363)]
        run.seed_storage(setup,{'entries':entries,'dataSafetyOnboardingSeen':True,'uiPreferences':{'locale':'zh-CN','theme':'light','motion':'reduced'}})
        setup.evaluate('''async()=>{const {createFixedFacetCatalog,applyFixedAnalysisTags}=await import('./tag-taxonomy.js');const storage=(await import('./library-storage.js')).getLibraryStorage();let {entries}=await storage.get('entries');let state={entries:[entries[0]],facetCatalog:createFixedFacetCatalog()};for(let i=0;i<100;i++)state=applyFixedAnalysisTags(state,entries[0].id,[{g:'style.render',t:'Render '+i},{g:'camera.shot',t:'Shot '+i},{g:'light.source',t:'Light '+i}],{source:'deepseek_text'}).state;const nodes=state.facetCatalog.nodes.filter(n=>n.parentId);entries.forEach((e,i)=>{e.facetAssignments=i%3===0?[]:[0,1,2,3,4,5].map(k=>{const n=nodes[(i*6+k)%nodes.length];return {facetId:n.facetId,nodeId:n.id,status:'confirmed',source:'manual'}})});await storage.set({entries,facetCatalog:state.facetCatalog});}''')
        p=run.open_page('library.html',wait_until='networkidle');expect(p.locator('#result-count')).to_contain_text('6363',timeout=60000)
        p.evaluate("""()=>{window.clicks=[];document.addEventListener('click',e=>{if(!e.target.closest('.facet-filter,.sidebar-module-toggle'))return;const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>clicks.push(performance.now()-start)));},true)}""")

        p.locator('[data-sidebar-module=tags] .sidebar-module-toggle').click()
        facet=p.locator('.facet-filter[data-facet-id=style]');facet.locator('summary').click()
        node_id=facet.locator('.facet-group-title button').evaluate_all("buttons=>buttons.find(b=>Number(b.querySelector('.facet-option-count').textContent)>0).dataset.facetNodeId")
        b=facet.locator(f'[data-facet-node-id="{node_id}"]')
        expected=setup.evaluate("""async id=>{const storage=(await import('./library-storage.js')).getLibraryStorage();const {entries,facetCatalog}=await storage.get(['entries','facetCatalog']);const accepted=new Set([id,...facetCatalog.nodes.filter(n=>n.parentId===id).map(n=>n.id)]);return entries.filter(e=>e.facetAssignments.some(a=>accepted.has(a.nodeId))).length;}""",node_id)
        assert 0<expected<6363, expected
        for i in range(4):
            b.click()
            expect(p.locator('#result-count')).to_have_text(f'{expected if i%2==0 else 6363} 个案例')
            expect(b).to_have_attribute('aria-pressed','true' if i%2==0 else 'false')
            p.wait_for_timeout(100)
        out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-tag-navigation'));out.mkdir(parents=True,exist_ok=True)
        p.screenshot(path=str(out/'tags-light.png'))
        (out/'results.json').write_text(json.dumps({'cases':6363,'matched':expected,'clickToTwoFramesMs':p.evaluate('clicks'),'pageErrors':run.page_errors}))
        assert not run.page_errors
        print('tag navigation click to two frames ms',p.evaluate('clicks'), 'errors',run.page_errors,flush=True)


if __name__ == "__main__":
    main()
