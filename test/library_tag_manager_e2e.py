"""The tag manager stays responsive with thousands of tags and refreshes real usage counts."""
import json
import os
from pathlib import Path

from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def main():
    out = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', '/tmp/pd-tag-manager'))
    out.mkdir(parents=True, exist_ok=True)
    with extension_session('pd-tag-manager-') as run:
        setup = run.open_page('collector.html', wait_until='networkidle')
        entries = [base_entry(f'case-{i}', f'案例 {i}', f'完整原始提示词 {i}', 'content:prompt:image') for i in range(6000)]
        run.seed_storage(setup, {'entries': entries, 'dataSafetyOnboardingSeen': True,
                                 'uiPreferences': {'theme': 'dark', 'locale': 'zh-CN', 'motion': 'reduced'}})
        groups = setup.evaluate('''async () => {
          const {createFixedFacetCatalog} = await import('./tag-taxonomy.js');
          const catalog = createFixedFacetCatalog();
          const groups = catalog.nodes.filter(n => n.facetId === 'subject' && !n.parentId);
          for (let i = 0; i < 3000; i++) catalog.nodes.push({id: 'perf-' + i, name: '标签 ' + i,
            facetId: 'subject', parentId: groups[i % groups.length].id, order: i,
            aliases: [], patterns: [], status: 'active', kind: 'tag', origin: 'manual', fixed: false, protected: false});
          const storage = (await import('./library-storage.js')).getLibraryStorage();
          const {entries} = await storage.get('entries');
          entries.forEach((entry, i) => entry.facetAssignments = Array.from({length: 6}, (_, k) => ({
            facetId: 'subject', nodeId: 'perf-' + ((i * 6 + k) % 3000), status: 'confirmed', source: 'manual'})));
          await storage.set({entries, facetCatalog: catalog});
          return groups.map(g => g.id);
        }''')
        p = run.open_page('library.html', wait_until='networkidle')
        expect(p.locator('body')).to_have_attribute('data-library-state', 'ready', timeout=60000)
        p.evaluate('''() => {
          window.managerClicks = []; window.managerLongTasks = [];
          new PerformanceObserver(list => managerLongTasks.push(...list.getEntries().map(e => e.duration)))
            .observe({type: 'longtask'});
          document.addEventListener('click', e => {
            const target = e.target.closest('[data-manager-tab]');
            if (!target) return;
            const start = performance.now();
            requestAnimationFrame(() => requestAnimationFrame(() => managerClicks.push({
              tab: target.dataset.managerTab, ms: performance.now() - start})));
          }, true);
        }''')
        p.locator('#manage-facets').click()
        expect(p.locator('#manager-content-types')).to_be_visible()
        p.evaluate('() => { managerClicks = []; managerLongTasks = []; }')
        p.locator('[data-manager-tab="vocabulary"]').click()
        p.wait_for_function('() => managerClicks.length === 1')
        initial = p.evaluate('() => ({clicks: managerClicks, longTasks: managerLongTasks})')
        (out / 'performance.json').write_text(json.dumps(initial, indent=2))
        # Browser-defined long tasks catch the original multi-second main-thread stall.
        assert not initial['longTasks'], initial
        assert p.locator('.vocabulary-children > .vocabulary-node').count() == 3000

        def tag(name):
            return p.locator('.vocabulary-children > .vocabulary-node').filter(
                has=p.locator('.vocabulary-node-name', has_text=name))

        first = tag('标签 0')
        expect(first.locator('.vocabulary-node-count')).to_have_text('12')
        p.screenshot(path=str(out / 'wide-dark.png'), animations='disabled')
        # An unchanged revisit retains the actual rows and any open editor draft.
        first.locator('summary').click()
        first.get_by_role('textbox').first.fill('未保存草稿')
        p.evaluate('() => { window.firstTagRow = document.querySelector(".vocabulary-children > .vocabulary-node"); }')
        p.locator('[data-manager-tab="content-types"]').click()
        p.locator('[data-manager-tab="vocabulary"]').click()
        assert p.evaluate('firstTagRow === document.querySelector(".vocabulary-children > .vocabulary-node")')
        expect(first.get_by_role('textbox').first).to_have_value('未保存草稿')
        first.get_by_role('textbox').first.fill('标签 0')
        first.locator('summary').click()

        # Both dimension switching and reaching the last off-screen tag remain usable.
        p.locator('#vocabulary-facet').select_option('style')
        expect(p.locator('.vocabulary-children > .vocabulary-node')).to_have_count(0)
        p.screenshot(path=str(out / 'empty-dimension.png'), animations='disabled')
        p.locator('#vocabulary-facet').select_option('subject')
        expect(p.locator('.vocabulary-children > .vocabulary-node')).to_have_count(3000)
        last = tag('标签 2999')
        last.locator('summary').click()
        expect(last.get_by_role('textbox').first).to_have_value('标签 2999')
        p.screenshot(path=str(out / 'last-tag-expanded.png'), animations='disabled')

        # A real per-case edit from another extension page must invalidate cached counts.
        result = setup.evaluate('''async () => chrome.runtime.sendMessage({type: 'SET_ENTRY_FACET',
          entryId: 'case-0', facetId: 'subject', nodeId: 'perf-0', selected: false})''')
        assert result['ok'], result
        expect(first.locator('.vocabulary-node-count')).to_have_text('11', timeout=30000)
        first.locator('summary').click()
        first.get_by_role('textbox').first.fill('改名后标签')
        first.get_by_role('button', name='保存名称', exact=True).click()
        renamed = tag('改名后标签')
        expect(renamed.locator('.vocabulary-node-count')).to_have_text('11', timeout=30000)
        renamed.locator('summary').click()
        renamed.locator('.node-actions select').select_option(groups[1])
        renamed.get_by_role('button', name='移动', exact=True).click()
        expect(p.locator('.vocabulary-group').filter(has=renamed).locator(':scope > .vocabulary-group-node .vocabulary-node-name')).to_have_text(
            setup.evaluate('''async id => (await chrome.runtime.sendMessage({type: 'GET_STATE'}))
              .facetCatalog.nodes.find(n => n.id === id).name''', groups[1]), timeout=30000)

        # Compare rendered group badges to the original distinct-case union definition.
        expected_groups = setup.evaluate('''async () => {
          const {entries, facetCatalog} = await chrome.runtime.sendMessage({type: 'GET_STATE'});
          return facetCatalog.nodes.filter(n => n.facetId === 'subject' && !n.parentId && n.status === 'active')
            .map(group => {
              const ids = new Set([group.id, ...facetCatalog.nodes.filter(n => n.facetId === 'subject'
                && n.parentId === group.id && n.status === 'active').map(n => n.id)]);
              return {name: group.name, count: entries.filter(e => e.facetAssignments.some(a => ids.has(a.nodeId))).length};
            });
        }''')
        for group in expected_groups:
            row = p.locator('.vocabulary-group-node').filter(has=p.locator('.vocabulary-node-name', has_text=group['name']))
            expect(row.locator('.vocabulary-node-count')).to_have_text(str(group['count']))

        p.set_viewport_size({'width': 560, 'height': 900})
        renamed.locator('summary').click()
        expect(renamed.get_by_role('textbox').first).to_have_value('改名后标签')
        p.locator('#manager-vocabulary').evaluate('e => e.scrollLeft = 0')
        assert p.locator('#manager-vocabulary').evaluate('e => e.scrollWidth <= e.clientWidth'), 'resizing must not retain the wide off-screen row width'
        p.screenshot(path=str(out / 'narrow-expanded-dark.png'), animations='disabled')
        p.evaluate("document.documentElement.dataset.theme = 'light'")
        p.screenshot(path=str(out / 'narrow-expanded-light.png'), animations='disabled')
        p.set_viewport_size({'width': 1280, 'height': 900})
        p.screenshot(path=str(out / 'wide-expanded-light.png'), animations='disabled')
        renamed.get_by_role('button', name='归档标签…', exact=True).click()
        p.locator('#promptdirector-app-dialog').get_by_role('button', name='确认归档', exact=True).click()
        expect(renamed).to_have_count(0, timeout=30000)
        expect(p.locator('.vocabulary-children > .vocabulary-node')).to_have_count(2999)
        recovery = p.locator('#vocabulary-tree details').filter(has=p.locator('summary', has_text='已归档内容'))
        recovery.locator('summary').click()
        recovery.get_by_role('button', name='恢复标签：改名后标签', exact=True).click()
        expect(renamed.locator('.vocabulary-node-count')).to_have_text('11', timeout=30000)
        expect(p.locator('.vocabulary-children > .vocabulary-node')).to_have_count(3000)
        p.locator('#manager-vocabulary').evaluate('e => new Promise(resolve => { e.scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(resolve)); })')
        p.screenshot(path=str(out / 'wide-light.png'), animations='disabled')
        assert setup.evaluate('''async () => {
          const {entries} = await chrome.runtime.sendMessage({type: 'GET_STATE'});
          return entries.length === 6000 && entries.every((e, i) => e.text === '完整原始提示词 ' + i
            && e.url === 'https://fixture.invalid/case-' + i && e.customLabels.length === 0);
        }'''), 'counting, renaming and moving tags must preserve all cases and original text'
        assert not run.page_errors, run.page_errors
        (out / 'results.json').write_text(json.dumps({'performance': initial, 'clicks': p.evaluate('managerClicks'), 'groupCounts': expected_groups,
            'pageErrors': run.page_errors, 'allTagsRetained': True, 'caseReadback': 6000}, ensure_ascii=False, indent=2))
        print(json.dumps({'performance': initial, 'tags': 3000, 'cases': 6000, 'errors': run.page_errors}), flush=True)


if __name__ == '__main__':
    main()
