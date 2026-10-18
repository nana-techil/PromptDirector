"""One reading scrollbar, a coherent footer and editable notes keep their original media identity."""
import os
import re
import tempfile
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def main():
    out = Path(os.environ.get('PD_E2E_ARTIFACT_DIR') or tempfile.mkdtemp(prefix='pd-detail-workspace-'))
    out.mkdir(parents=True, exist_ok=True)
    video = (Path(__file__).parent / 'fixtures/review-workspace-smoke.mp4').read_bytes()
    text = '\n\n'.join(['镜头缓慢推进，保持人物、服装与光线一致。\nA continuous camera movement through the scene.'] * 40)
    entry = base_entry('workspace', '视觉特效 / Motion study — a continuous shot and a long original prompt ' * 8, text, 'content:prompt:video')
    entry.update(mediaAssets=[{'id': key, 'kind': 'video', 'storageMode': 'managed', 'mimeType': 'video/mp4', 'width': 320, 'height': 180} for key in ['video-one', 'video-two']] +
                 [{'id': 'frame', 'kind': 'image', 'storageMode': 'managed', 'mimeType': 'image/png', 'width': 180, 'height': 320}], primaryMediaId='video-one',
                 timeNotes=[{'id': 'original-note', 'assetId': 'video-one', 'frameAssetId': 'frame', 'text': '原有备注', 'startMs': 200, 'endMs': 700, 'createdAt': '2026-10-01T00:00:00.000Z'}])
    entry['videoAnalyses'] = [{'id':'saved-analysis','assetId':'video-two','mode':'visual-reconstruction','requestId':'completed','contractVersion':'visual-v3-1','analysisScope':'visual','includeTags':False,'tags':[],'uncertainties':[],'finishReason':'stop','reconstructionPrompt':text,'createdAt':'2026-10-01T00:00:00.000Z'}]
    with extension_session('pd-workspace-controls-', show_scrollbars=True) as run:
        setup = run.open_page('collector.html')
        run.seed_storage(setup, {'entries': [entry], 'dataSafetyOnboardingSeen': True,
                                'uiPreferences': {'locale': 'zh-CN', 'theme': 'dark', 'motion': 'reduced'}})
        setup.evaluate('''async raw => {
          const {saveMediaBlob} = await import('./media-store.js');
          for (const id of ['video-one', 'video-two']) await saveMediaBlob(id,new Blob([new Uint8Array(raw)],{type:'video/mp4'}));
          const c=document.createElement('canvas');c.width=180;c.height=320;
          const x=c.getContext('2d');x.fillStyle='#52736d';x.fillRect(0,0,180,320);
          await saveMediaBlob('frame',await new Promise(r=>c.toBlob(r)));
        }''', list(video))
        p = run.open_page('library.html', wait_until='networkidle')
        p.locator('.case-card').click()
        expect(p.locator('.detail-workspace')).to_be_visible()
        expect(p.locator('#detail-navigation')).to_have_text('')
        assert p.locator('.detail-content').evaluate('e=>getComputedStyle(e).scrollbarWidth') == 'none'
        assert p.locator('.detail-visual-gallery').bounding_box()['x'] == 0
        reading = p.locator('.detail-reading')
        expect(p.locator('.prompt-expand')).to_be_visible()
        expect(p.locator('.prompt-expand')).to_have_attribute('aria-expanded', 'false')
        assert p.locator('.prompt-read-body').evaluate('e=>e.clientHeight<e.scrollHeight')
        assert p.locator('.detail-title').evaluate('e=>e.clientHeight<30&&getComputedStyle(e).textOverflow==="ellipsis"')
        assert p.locator('.detail-title').get_attribute('title')==entry['title']
        assert p.locator('.detail-create-action').bounding_box()['y']+36<900
        p.screenshot(path=str(out/'long-prompt-collapsed.png'))
        p.locator('.prompt-expand').click()
        assert reading.evaluate('e=>e.scrollHeight>e.clientHeight')
        heading_y=p.locator('.prompt-section-heading:visible').bounding_box()['y']
        reading.hover(); p.mouse.wheel(0, 700)
        p.wait_for_function('()=>document.querySelector(".detail-reading").scrollTop>100')
        assert abs(p.locator('.prompt-section-heading:visible').bounding_box()['y']-heading_y)<2, (heading_y,p.locator('.prompt-section-heading:visible').bounding_box(),reading.bounding_box())
        assert p.locator('#detail-content').evaluate('e=>e.scrollTop') == 0
        assert p.locator('.detail-create-action').bounding_box()['y']+36<900
        p.screenshot(path=str(out/'long-prompt-scrolled.png'))
        reading.evaluate('e=>e.scrollTop=0')
        p.set_viewport_size({'width':1280,'height':600})
        p.wait_for_function('()=>document.querySelector(".detail-create-action").getBoundingClientRect().bottom<=600')
        p.screenshot(path=str(out/'short-viewport-expanded.png'))
        p.set_viewport_size({'width':1280,'height':900})
        p.locator('.detail-video-play').click()
        p.wait_for_function('()=>document.querySelector(".detail-video").readyState>=2')
        p.locator('.detail-video').evaluate('v=>{v.pause();v.currentTime=.6;v.dataset.identity="keep"}')
        p.locator('.review-volume button').hover()
        volume = p.get_by_role('slider', name='音量', exact=True)
        expect(volume).to_be_visible()
        volume.focus(); volume.press('Home')
        for _ in range(25): volume.press('ArrowRight')
        assert p.locator('.detail-video').evaluate('v=>v.volume===.25&&!v.muted')
        p.locator('.review-volume button').click()
        assert p.locator('.detail-video').evaluate('v=>v.muted')
        p.locator('.review-volume button').click()
        assert p.locator('.detail-video').evaluate('v=>!v.muted&&v.volume===.25')
        volume.focus(); volume.press('Home')
        assert p.locator('.detail-video').evaluate('v=>v.volume===0&&v.muted')
        p.locator('.review-volume button').click()
        assert p.locator('.detail-video').evaluate('v=>v.volume===.25&&!v.muted')
        p.locator('.review-volume button').hover()
        box = volume.bounding_box()
        assert box['width'] >= 100, box
        mute=p.locator('.review-volume button').bounding_box()
        assert abs(box['y']-mute['y'])<2 and box['x']+box['width']<=mute['x']+1, (box,mute)
        p.mouse.click(box['x'] + box['width'] * .7, box['y'] + box['height'] / 2)
        assert p.locator('.detail-video').evaluate('v=>v.volume>.6&&v.volume<.9&&Math.abs(v.currentTime-.6)<.02')
        volume.focus(); volume.press('Home')
        for _ in range(25): volume.press('ArrowRight')
        p.screenshot(path=str(out/'volume-control.png'))
        before_editor = p.locator('.detail-video').bounding_box()
        p.locator('.entry-editor-inline > summary').click()
        entry_editor = p.locator('.entry-editor-body')
        expect(entry_editor).to_be_visible()
        assert p.locator('.detail-video').bounding_box() == before_editor
        assert entry_editor.bounding_box()['y'] + entry_editor.bounding_box()['height'] <= 900
        p.screenshot(path=str(out/'case-editor.png'))
        p.locator('.entry-editor-inline > summary').click()
        p.locator('[data-review-feedback]').click()
        panel = p.locator('.review-feedback-panel')
        expect(panel).to_be_visible()
        panel.get_by_role('button', name='编辑备注', exact=True).click()
        expect(panel.locator('textarea')).to_have_value('原有备注')
        panel.locator('textarea').fill('取消这次修改')
        panel.get_by_role('button', name='取消', exact=True).click()
        expect(panel.locator('.review-feedback-row p')).to_have_text('原有备注')
        panel.get_by_role('button', name='编辑备注', exact=True).click()
        panel.locator('textarea').fill('保留这个转场，缩短停顿')
        panel.locator('input[type=number]').first.fill('0.3')
        # Force only this disposable browser's note write to fail once.
        p.evaluate('''()=>{window.realSend=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(message,...args)=>message.type==='ADD_TIME_NOTE'?Promise.resolve({ok:false,message:'测试保存失败'}):window.realSend(message,...args)}''')
        panel.get_by_role('button', name='保存修改', exact=True).click()
        expect(panel.get_by_role('status')).to_contain_text('测试保存失败')
        expect(panel.locator('textarea')).to_have_value('保留这个转场，缩短停顿')
        p.screenshot(path=str(out/'note-save-failure.png'))
        p.evaluate('()=>{chrome.runtime.sendMessage=window.realSend}')
        panel.get_by_role('button', name='保存修改', exact=True).click()
        expect(panel.locator('form')).to_have_attribute('data-dirty', 'false')
        stored = p.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries[0]")
        note = stored['timeNotes'][0]
        assert len(stored['timeNotes']) == 1 and note['id'] == 'original-note'
        assert note['assetId'] == 'video-one' and note['frameAssetId'] == 'frame'
        assert note['createdAt'] == '2026-10-01T00:00:00.000Z' and note['startMs'] == 300 and note['endMs'] == 700
        assert note['text'] == '保留这个转场，缩短停顿'
        assert p.locator('.detail-video').evaluate('v=>v.dataset.identity==="keep"&&Math.abs(v.currentTime-.6)<.02')
        # Drag across the split in both directions, then keep a draft while folding.
        def drag_to(x, y):
            box=panel.locator('.panel-drag-handle').bounding_box(); current=panel.bounding_box()
            sx=box['x']+box['width']/2; sy=box['y']+box['height']/2
            p.mouse.move(sx,sy);p.mouse.down();p.mouse.move(sx+x-current['x'],sy+y-current['y'],steps=8);p.mouse.up()
        drag_to(80, 130)
        assert panel.bounding_box()['x'] < 100
        drag_to(890, 190)
        assert panel.bounding_box()['x'] > p.locator('.detail-body').bounding_box()['x']
        panel.locator('textarea').fill('尚未保存的草稿')
        p.locator('#detail-close').click()
        expect(p.get_by_role('dialog', name='放弃未保存的文字修改？', exact=True)).to_be_visible()
        p.get_by_role('button', name='取消', exact=True).click()
        expect(panel.locator('textarea')).to_have_value('尚未保存的草稿')
        panel.get_by_role('button', name='收起备注', exact=True).click()
        p.locator('[data-review-feedback]').click()
        expect(panel.locator('textarea')).to_have_value('尚未保存的草稿')
        p.screenshot(path=str(out/'note-over-information-pane.png'))
        panel.locator('textarea').fill('')
        panel.get_by_role('button', name='收起备注', exact=True).click()
        # One reading scrollbar while editing; cancel leaves the source exact.
        p.get_by_role('button', name='编辑原始提示词', exact=True).click()
        editor = p.locator('.prompt-editor:visible')
        assert reading.evaluate('e=>getComputedStyle(e).overflowY') == 'hidden'
        assert editor.evaluate('e=>e.scrollHeight>e.clientHeight')
        editor.fill('不应保存的草稿')
        editor.press('ArrowLeft')
        caret = editor.evaluate('e=>e.selectionStart')
        response = setup.evaluate("async()=>chrome.runtime.sendMessage({type:'UPDATE_ENTRY_TITLE',entryId:'workspace',title:'Updated title — the prompt draft must keep its focus'})")
        assert response['ok']
        # External changes wait while a draft is dirty; the active editor keeps its caret.
        expect(editor).to_have_value('不应保存的草稿')
        assert editor.evaluate('e=>document.activeElement===e')
        assert editor.evaluate('e=>e.selectionStart') == caret
        p.screenshot(path=str(out/'prompt-editing.png'))
        p.locator('.prompt-edit-actions:visible').get_by_role('button', name='取消', exact=True).click()
        expect(p.locator('.prompt-read-body')).to_have_text(text)
        p.get_by_role('button', name='下一项媒体', exact=True).click()
        p.locator('.detail-video-play').click()
        p.wait_for_function('()=>document.querySelector(".detail-video").readyState>=2')
        p.locator('.detail-video').evaluate('v=>v.pause()')
        assert p.locator('.detail-video').evaluate('v=>v.volume===.25&&!v.muted')
        p.locator('[data-prompt-tab=ai]').click()
        p.get_by_role('button', name='编辑 AI 逆推提示词', exact=True).click()
        ai_editor = p.locator('.prompt-editor:visible')
        assert ai_editor.evaluate('e=>e.scrollHeight>e.clientHeight')
        assert p.locator('.prompt-edit-actions:visible').bounding_box()['y'] + p.locator('.prompt-edit-actions:visible').bounding_box()['height'] <= p.locator('.detail-workspace-footer').bounding_box()['y']
        p.screenshot(path=str(out/'ai-prompt-editing.png'))
        p.locator('.prompt-edit-actions:visible').get_by_role('button', name='取消', exact=True).click()
        p.locator('[data-prompt-tab=shared]').click()
        # Dark/light, long prompt, multi-media footer and narrow layout screenshots.
        wide_panel_width = None
        for locale, theme in [('zh-CN','dark'), ('en','light')]:
            p.evaluate("async prefs=>(await import('./i18n.js')).initializeUi(prefs)", {'locale':locale,'theme':theme,'motion':'reduced'})
            p.locator('#detail-close').click(); p.locator('.case-card').click()
            p.locator('.detail-video-play').click()
            p.wait_for_function('()=>document.querySelector(".detail-video").readyState>=2')
            p.locator('.detail-video').evaluate('v=>v.pause()')
            for width in [1440, 390]:
                p.set_viewport_size({'width':width,'height':900})
                p.mouse.move(2,2)
                assert p.locator('#detail-content').evaluate('e=>e.scrollWidth<=e.clientWidth')
                if width>640:
                    p.wait_for_function('()=>document.querySelector(".detail-body").getBoundingClientRect().width>500')
                    panel_width = p.locator('.detail-body').bounding_box()['width']
                    if wide_panel_width is not None: assert abs(wide_panel_width-panel_width)<1
                    wide_panel_width = panel_width
                    p.screenshot(path=str(out/f'alignment-{theme}.png'))
                    assert p.locator('.detail-visual-caption').bounding_box()['height'] < 65
                p.screenshot(path=str(out/f'workspace-{theme}-{width}.png'))
                if width==390:
                    p.locator('.review-volume button').hover()
                    transport=p.locator('.review-transport-row')
                    assert transport.evaluate('e=>e.scrollWidth<=e.clientWidth'), transport.bounding_box()
                    slider=p.locator('.review-volume input')
                    assert slider.bounding_box()['width']>=60
                    p.screenshot(path=str(out/f'volume-{theme}-390.png'))
        p.locator('[data-review-media=previous]').click()
        p.locator('[data-review-feedback]').click()
        p.get_by_role('button', name='Edit note', exact=True).click()
        p.screenshot(path=str(out/'note-edit-light-390.png'))
        assert p.locator('.review-feedback-panel').evaluate('e=>e.scrollWidth<=e.clientWidth')
        p.get_by_role('button', name='Cancel', exact=True).click()
        p.set_viewport_size({'width':1280,'height':900})
        p.reload(wait_until='networkidle');p.locator('.case-card').click()
        p.get_by_role('button', name='上一项媒体', exact=True).click() if p.get_by_role('button', name='上一项媒体', exact=True).is_enabled() else None
        p.locator('[data-review-feedback]').click()
        expect(p.locator('.review-feedback-row p')).to_have_text('保留这个转场，缩短停顿')
        current = p.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries[0]")
        assert current['text']==text and current['timeNotes']==stored['timeNotes']
        assert p.evaluate("async()=>Array.from(new Uint8Array(await(await(await import('./media-store.js')).getMediaBlob('video-one')).arrayBuffer()))") == list(video)
        print(f'PASS: collapsed/expanded reading, pinned heading, visible actions, inline volume, same-id note editing/cancel/failure/reload, cross-pane drag, drafts and original bytes. Screenshots: {out}')


if __name__ == '__main__':
    main()
