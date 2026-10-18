"""Materials share the centered article reader without changing original text or files."""
import os
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import base_entry, extension_session


def main():
    out = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', '/tmp/pd-article-reader'))
    out.mkdir(parents=True, exist_ok=True)
    long_text = '\n\n'.join(f'第{i}段，完整资料正文与原始内容保持。' for i in range(1, 90)) + '\n\n全文结束标记'
    md = '# 完整 Markdown 资料\n\n**粗体原文**\n\n|镜头|说明|\n|---|---|\n|1|保留表格|\n\n```css\nbutton { color: red; }\n```\n\n' + long_text
    article = base_entry('article', '网页文章', long_text, 'content:reference')
    article['articleDocument'] = {'version': 1, 'blocks': [{'id': f'p{i}', 'kind': 'paragraph', 'text': text} for i, text in enumerate(long_text.split('\n\n'))]}
    markdown = base_entry('md', '本机 Markdown 资料', md, 'content:reference')
    markdown.update(mediaAssets=[{'id': 'md-file', 'kind': 'document', 'storageMode': 'managed', 'mimeType': 'text/markdown', 'sourceFormat': 'md', 'sourceTitle': 'original.md', 'extractedTextFormat': 'markdown'}], primaryMediaId='md-file')
    plain = base_entry('plain', '纯文字资料', long_text, 'content:reference')
    post = base_entry('post', '社交正文资料', long_text, 'content:reference')
    post['sourceFacts'] = {'pageType': 'post', 'author': '原作者'}
    tutorial = base_entry('tutorial', '教程资料', long_text, 'content:tutorial')
    empty = base_entry('empty', '空正文资料', '', 'content:reference')
    entries = [article, markdown, plain, post, tutorial, empty]
    with extension_session('pd-article-reader-', show_scrollbars=True) as run:
        setup = run.open_page('collector.html', wait_until='networkidle')
        run.seed_storage(setup, {'entries': entries, 'dataSafetyOnboardingSeen': True, 'uiPreferences': {'theme': 'dark', 'locale': 'zh-CN', 'motion': 'reduced'}})
        setup.evaluate('''async text=>(await import('./media-store.js')).saveMediaBlob('md-file',new Blob([text],{type:'text/markdown'}))''', md)
        p = run.open_page('library.html', wait_until='networkidle')
        for entry in entries:
            p.locator(f'.case-card[data-entry-id="{entry["id"]}"]').click()
            expect(p.locator('.article-document-reader')).to_be_visible()
            assert p.locator('.detail-visual-gallery').count() == 0, 'materials must not split into a document gallery and duplicate text panel'
            assert p.locator('.original-prompt-panel,.document-text-reader').count() == 0
            expect(p.locator('.article-document-reader').get_by_role('button', name='编辑正文', exact=True)).to_be_visible()
            if entry['text']:
                for name in ['复制文字', '分析文字标签', '编辑分析规则']:
                    button = p.locator('.article-document-reader').get_by_role('button', name=name, exact=True)
                    expect(button).to_be_visible()
                    expect(button.locator('svg')).to_have_count(1)
                expect(p.locator('#detail-content').get_by_role('button', name='分析文字标签', exact=True)).to_have_count(1)
            else:
                expect(p.locator('.article-document-reader').get_by_role('button', name='分析文字标签', exact=True)).to_have_count(0)
            for theme,locale,width in [('dark','zh-CN',1280),('light','en',390)]:
                p.set_viewport_size({'width':width,'height':900})
                p.evaluate('async prefs=>(await import("./i18n.js")).initializeUi(prefs)', {'theme':theme,'locale':locale,'motion':'reduced'})
                p.locator('#detail-close').click()
                p.locator(f'.case-card[data-entry-id="{entry["id"]}"]').click()
                expect(p.locator('.article-document-reader').get_by_role('button', name='Edit article' if locale == 'en' else '编辑正文', exact=True)).to_be_visible()
                p.wait_for_timeout(200)
                bounds = p.locator('.detail-body').bounding_box()
                available = p.locator('#detail-content').evaluate('e=>({x:e.getBoundingClientRect().x,width:e.clientWidth})')
                assert abs((bounds['x']-available['x']) * 2 + bounds['width'] - available['width']) < 2, (bounds,available)
                assert p.locator('#detail-content').evaluate('e=>getComputedStyle(e).scrollbarWidth') == 'thin'
                assert p.locator('#detail-content').evaluate('e=>e.scrollWidth<=e.clientWidth')
                p.screenshot(path=str(out/f'{entry["id"]}-{theme}-{width}.png'))
            p.locator('#detail-close').click()
            p.set_viewport_size({'width':1280,'height':900})
            p.evaluate('async()=>(await import("./i18n.js")).initializeUi({theme:"dark",locale:"zh-CN",motion:"reduced"})')
        p.locator('.case-card[data-entry-id=md]').click()
        reader = p.locator('.article-document-reader')
        expect(reader.locator('h1')).to_have_text('完整 Markdown 资料')
        expect(reader.locator('strong')).to_contain_text('粗体原文')
        expect(reader.locator('table')).to_contain_text('保留表格')
        p.locator('#detail-mode-toggle').click()
        expect(p.locator('#detail-drawer')).to_have_class(__import__('re').compile('.*detail-sidebar-mode.*'))
        expect(reader).to_be_visible()
        p.wait_for_timeout(200)
        p.screenshot(path=str(out/'md-sidebar.png'))
        p.locator('#detail-mode-toggle').click()
        reader.get_by_role('button', name='编辑分析规则', exact=True).click()
        expect(p.locator('#settings-rules-panel')).to_be_visible()
        p.locator('#settings-close').click()
        p.evaluate('''()=>{const send=chrome.runtime.sendMessage.bind(chrome.runtime);window.restoreArticleAnalysis=()=>chrome.runtime.sendMessage=send;chrome.runtime.sendMessage=(m,...a)=>m.type==='GET_AI_TASK_RUNTIME'?Promise.resolve({ok:false,message:'测试分析服务不可用'}):send(m,...a)}''')
        reader.get_by_role('button', name='分析文字标签', exact=True).click()
        expect(p.get_by_text('测试分析服务不可用', exact=True)).to_be_visible()
        expect(reader.get_by_role('button', name='分析文字标签', exact=True)).to_be_enabled()
        p.evaluate('()=>window.restoreArticleAnalysis()')
        # Actual wheel and drag must reach the tail; locator auto-scroll cannot prove this.
        p.mouse.move(650,500)
        for _ in range(18): p.mouse.wheel(0,900)
        p.wait_for_function('()=>{const e=document.querySelector("#detail-content");return e.scrollTop>2000}')
        assert p.locator('#detail-content').evaluate('e=>e.scrollTop') > 2000
        p.locator('#detail-content').evaluate('e=>e.scrollTop=0')
        p.mouse.move(1274,40)
        p.mouse.down()
        p.mouse.move(1274,860,steps=16)
        p.mouse.up()
        p.wait_for_function('()=>document.querySelector("#detail-content").scrollTop>2000')
        tail = reader.get_by_text('全文结束标记', exact=True).bounding_box()
        assert tail and tail['y'] >= 0 and tail['y']+tail['height'] <= 900, tail
        p.screenshot(path=str(out/'md-scrollbar-end.png'))
        p.locator('#detail-content').evaluate('e=>e.scrollTop=0')
        reader.get_by_role('button', name='复制文字', exact=True).click()
        assert p.evaluate('()=>navigator.clipboard.readText()') == md
        edit = reader.get_by_role('button', name='编辑正文', exact=True)
        edit.click()
        editor = reader.get_by_role('textbox', name='编辑正文段落', exact=True)
        expect(editor).to_have_value(md)
        editor.fill('# 取消的草稿')
        reader.get_by_role('button', name='取消', exact=True).click()
        expect(reader.locator('h1')).to_have_text('完整 Markdown 资料')
        edit.click()
        updated = md.replace('粗体原文','更新后的原文')
        editor.fill(updated)
        p.evaluate('''()=>{const send=chrome.runtime.sendMessage.bind(chrome.runtime);window.restoreArticleSend=()=>chrome.runtime.sendMessage=send;chrome.runtime.sendMessage=(m,...a)=>m.type==='UPDATE_ENTRY_TEXT'?Promise.resolve({ok:false,message:'测试保存失败'}):send(m,...a)}''')
        reader.get_by_role('button', name='保存', exact=True).click()
        expect(editor).to_have_value(updated)
        expect(editor).to_be_editable()
        p.screenshot(path=str(out/'md-save-failed.png'))
        p.evaluate('()=>window.restoreArticleSend()')
        reader.get_by_role('button', name='保存', exact=True).click()
        expect(reader.locator('strong')).to_contain_text('更新后的原文')
        p.locator('#detail-close').click()
        p.reload(wait_until='networkidle')
        p.locator('.case-card[data-entry-id=md]').click()
        expect(p.locator('.article-document-reader strong')).to_contain_text('更新后的原文')
        saved = setup.evaluate('async()=>(await chrome.runtime.sendMessage({type:"GET_STATE"})).entries')
        for original in entries:
            actual = next(e for e in saved if e['id']==original['id'])
            assert actual['text'] == (updated if original['id']=='md' else original['text'])
            assert actual['customLabels'] == original['customLabels']
            assert [a['id'] for a in actual['mediaAssets']] == [a['id'] for a in original['mediaAssets']]
            assert bool(actual.get('articleDocument')) == bool(original.get('articleDocument')), 'opening flat materials must not migrate their stored structure'
        assert setup.evaluate('async()=>await(await(await import("./media-store.js")).getMediaBlob("md-file")).text()') == md
        p.screenshot(path=str(out/'md-reopened.png'))
        print('PASS: centered article/MD/plain/post/tutorial/empty, shared icon actions, scrolling, Markdown copy/edit/cancel/failure/save/reopen and original file preservation')


if __name__ == '__main__': main()
