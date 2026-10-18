"""Disposable library and deterministic model; no real cases, keys or paid requests."""
from __future__ import annotations

import os
from pathlib import Path
from tempfile import mkdtemp

from playwright.sync_api import expect
from e2e_support import ai_configuration_fixture, base_entry, extension_session, wait_for_async_condition


def capture(page, path: Path) -> None:
    page.evaluate("""async () => {
      const finite = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity);
      await Promise.all(finite.map(animation => animation.finished.catch(() => {})));
    }""")
    page.screenshot(path=str(path))


def main() -> None:
    artifacts = Path(os.environ.get("PROMPTDIRECTOR_TEST_ARTIFACTS", mkdtemp(prefix="pd-batch-scope-")))
    artifacts.mkdir(parents=True, exist_ok=True)
    entries = [base_entry(key, title, text, category, i) for i, (key, title, text, category) in enumerate([
        ("new", "尚未分析", "庭院雾气与柔和逆光", "content:prompt:image"),
        ("done", "已经分析", "已完成的提示词", "content:prompt:image"),
        ("changed", "原文变化", "后来改过的提示词", "content:prompt:image"),
        ("video", "视频案例文字", "不应被类型筛选带入的文字", "content:video-case"),
        ("empty", "没有提示词", "", "content:image-case"),
        ("child", "子项目提示词", "子项目的提示词", "content:prompt:image"),
        ("outside", "其他项目", "其他项目的提示词", "content:prompt:image"),
    ])]
    entries[0]["customLabels"] = ["保留人工标签"]
    for entry in entries[1:3]:
        entry["facetAssignments"] = [{"nodeId": "style.render", "source": "deepseek_text", "confidence": 1}]
        entry["analysisMeta"] = {"textRevision": 1}
    entries[2]["textRevision"] = 2
    # Keep the empty case valid without supplying any media to a model.
    entries[4]["mediaAssets"] = [{"id": "empty-image", "kind": "image", "usage": "content", "storageMode": "managed", "mimeType": "image/png"}]
    entries[4]["primaryMediaId"] = "empty-image"
    with extension_session("pd-project-text-batch-", viewport={"width": 1280, "height": 900}) as session:
        setup = session.open_page("collector.html")
        session.seed_storage(setup, {
            "schemaVersion": 29, "entries": entries,
            "uiPreferences": {"locale": "zh-CN", "theme": "dark", "includeSubprojects": False},
            "organizerState": {"version": 7, "collections": [
                {"id": "target", "name": "x精选", "entryIds": ["new", "done", "changed", "video", "empty"]},
                {"id": "sub", "name": "子项目", "parentId": "target", "entryIds": ["child"]},
                {"id": "other", "name": "其他项目", "entryIds": ["outside"]},
            ]},
            **ai_configuration_fixture(
                providers={"deepseek": {"apiKey": "fixture-key", "consent": True, "models": {"textTags": "deepseek-v4-flash"}}},
                assignments={"textTags": {"providerId": "deepseek", "model": "deepseek-v4-flash"}},
            ),
        })
        setup.evaluate("""async () => {
          const state = await chrome.runtime.sendMessage({type:'GET_STATE'});
          const group = state.facetCatalog.nodes.find(node => !node.parentId && node.status !== 'archived');
          for (const entry of state.entries.filter(item => ['done','changed'].includes(item.id))) {
            entry.facetAssignments = [{nodeId:group.id,source:'deepseek_text'}];
            entry.analysisMeta = {textRevision:1};
          }
          const {getLibraryStorage} = await import(chrome.runtime.getURL('library-storage.js'));
          await getLibraryStorage().set({entries:state.entries});
        }""")
        worker = session.context.service_workers[0]
        worker.evaluate("""() => {
          globalThis.batchCalls = 0;
          globalThis.batchWait = new Promise(resolve => globalThis.finishBatchFixture = resolve);
          const realFetch = globalThis.fetch;
          globalThis.fetch = async (...args) => {
            if (!String(args[0]?.url || args[0]).includes('chat/completions')) return realFetch(...args);
            batchCalls++;
            await batchWait;
            const {facetCatalog} = await chrome.storage.local.get('facetCatalog');
            const tags = facetCatalog.nodes.filter(node => !node.parentId && node.status !== 'archived').slice(0,6).map(node => ({g:node.id,t:''}));
            return new Response(JSON.stringify({model:'deepseek-v4-flash',
              choices:[{finish_reason:'stop',message:{content:JSON.stringify({tags})}}],
              usage:{prompt_tokens:20,completion_tokens:4,total_tokens:24}}),
              {status:200,headers:{'Content-Type':'application/json'}});
          };
        }""")
        page = session.open_page("library.html", wait_until="networkidle")
        expect(page.locator("body")).to_have_attribute("data-library-state", "ready")
        menu = page.locator('.project-row[data-collection-id="target"] .project-menu')
        menu.locator("summary").click()
        menu.get_by_role("button", name="批量分析", exact=True).click()
        dialog = page.locator("#text-batch-dialog")
        expect(dialog).to_be_visible()
        expect(page.locator("#batch-scope-project")).to_have_value("target")
        expect(page.locator("#batch-text-status")).to_have_value("missing")
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 2")
        expect(page.locator("#analysis-batch-summary")).to_contain_text("已分析跳过 1")
        page.locator("#batch-scope-types-title").click()
        page.locator("#batch-scope-all-types").uncheck()
        page.locator('#batch-scope-types input[value="content:prompt:image"]').check()
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 1")
        page.locator("#batch-scope-types-title").click()
        expect(page.locator("#start-analysis-batch")).to_be_enabled()
        capture(page, artifacts / "project-dark-wide.png")
        page.locator("#batch-scope-subprojects").check()
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 2")
        page.locator("#batch-scope-exclusions-title").click()
        page.locator('#batch-scope-exclusions input[value="sub"]').check()
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 1")
        page.locator("#batch-scope-exclusions-title").click()
        page.locator("#batch-text-status").select_option("incremental")
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 2")
        page.locator("#batch-text-status").select_option("selected")
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 3")
        page.locator("#batch-text-status").select_option("missing")
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 1")
        assert worker.evaluate("batchCalls") == 0

        blocked_rebuild = page.evaluate("() => chrome.runtime.sendMessage({type:'PREVIEW_ANALYSIS_BATCH',mode:'rebuild',scope:{collectionId:'target'}})")
        assert not blocked_rebuild['ok'] and '完整资料库' in blocked_rebuild['message']
        changed_preview = page.evaluate("""() => chrome.runtime.sendMessage({
          type:'CREATE_ANALYSIS_BATCH',mode:'incremental',includeChanged:false,
          scope:{collectionId:'target',contentTypeIds:['content:prompt:image']},
          expectedEntryIds:['new'],expectedItems:[{entryId:'new',textRevision:999}]
        })""")
        assert not changed_preview['ok'] and changed_preview['previewChanged']
        assert worker.evaluate("batchCalls") == 0
        before = page.evaluate("() => chrome.runtime.sendMessage({type:'GET_STATE'})")
        page.locator("#start-analysis-batch").click()
        confirmation = page.locator("#promptdirector-app-dialog")
        expect(confirmation).to_contain_text("1 个案例")
        assert worker.evaluate("batchCalls") == 0
        confirmation.get_by_role("button", name="确认付费", exact=True).click()
        running = wait_for_async_condition(page, """async () => {
          const s = await chrome.runtime.sendMessage({type:'GET_STATE'});
          return s.analysisBatchJob?.status === 'running' ? s.analysisBatchJob : null;
        }""")
        assert [item["entryId"] for item in running["items"]] == ["new"], running
        page.locator("#text-batch-close").click()
        menu.locator("summary").click()
        menu.get_by_role("button", name="批量分析", exact=True).click()
        expect(page.locator("#batch-scope-project")).to_have_value("target")
        expect(page.locator("#batch-scope-project")).to_be_disabled()
        expect(page.locator("#analysis-batch-summary")).to_contain_text("完成 0/1")
        capture(page, artifacts / "running.png")
        worker.evaluate("finishBatchFixture()")
        result = wait_for_async_condition(page, """async () => {
          const s = await chrome.runtime.sendMessage({type:'GET_STATE'});
          return s.analysisBatchJob?.status === 'completed' ? s : null;
        }""")
        assert worker.evaluate("batchCalls") == 1
        original_by_id = {entry["id"]: entry for entry in before["entries"]}
        for entry in result["entries"]:
            if entry["id"] == "new":
                assert entry["text"] == original_by_id["new"]["text"]
                assert entry["customLabels"] == ["保留人工标签"]
                assert any(item["source"] == "deepseek_text" for item in entry["facetAssignments"])
            else:
                assert entry == original_by_id[entry["id"]], entry["id"]
        assert result["organizerState"] == before["organizerState"]
        page.locator("#text-batch-close").click()
        page.reload(wait_until="networkidle")
        # Settings stay inline. Scope options remain in the project workflow.
        page.locator("#open-settings").click()
        page.locator('[data-settings-tab="tasks"]').click()
        expect(page.locator("#settings-tasks-panel #preview-analysis-batch")).to_be_visible()
        expect(page.locator("#text-batch-dialog")).to_be_hidden()
        expect(page.locator("#settings-tasks-panel [data-batch-kind], #settings-tasks-panel #batch-scope-fields")).to_have_count(0)
        page.locator("#settings-close").click()
        menu.locator("summary").click()
        menu.get_by_role("button", name="批量分析", exact=True).click()
        page.locator("#batch-scope-project").select_option("target")
        page.locator("#batch-scope-types-title").click()
        page.locator("#batch-scope-all-types").uncheck()
        page.locator('#batch-scope-types input[value="content:prompt:image"]').check()
        page.locator("#batch-scope-types-title").click()
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 0")
        expect(page.locator("#start-analysis-batch")).to_be_disabled()
        capture(page, artifacts / "empty.png")
        page.locator("#batch-scope-project").select_option("")
        page.locator("#batch-scope-exclusions-title").click()
        page.locator('#batch-scope-exclusions input[value="other"]').check()
        page.locator('#batch-scope-exclusions input[value="sub"]').check()
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 0")
        page.locator("#batch-scope-exclusions-title").click()
        page.set_viewport_size({"width": 390, "height": 844})
        capture(page, artifacts / "narrow-dark.png")
        assert page.locator("#text-batch-dialog").evaluate("el => el.scrollWidth <= el.clientWidth")
        page.locator("#text-batch-close").click()
        # Management retains the explicit selection and defaults to skipping completed cases.
        page.locator("#select-cases").click()
        page.locator('#case-list > .case-card[data-entry-id="outside"]').click()
        page.locator("#selection-more-menu > summary").click()
        page.locator("#selection-text-analyze").click()
        expect(page.locator("#batch-scope-project")).to_have_value(":selection")
        expect(page.locator("#batch-text-status")).to_have_value("missing")
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 1")
        page.locator('[data-batch-kind="image"]').click()
        expect(page.locator("#vision-batch-summary")).to_contain_text("0 次图片请求")
        expect(page.locator("#vision-batch-start")).to_be_disabled()
        capture(page, artifacts / "image-empty.png")
        page.locator('[data-batch-kind="video"]').click()
        expect(page.locator("#vision-batch-summary")).to_contain_text("检查失败")
        expect(page.locator("#vision-batch-start")).to_have_text("重新检查")
        page.locator("#vision-batch-start").click()
        expect(page.locator("#vision-batch-feedback")).not_to_be_empty()
        capture(page, artifacts / "video-preview-failure.png")
        page.locator('[data-batch-kind="text"]').click()
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 1")
        # A failed check must be visible in the modal and must never enable a paid start.
        page.evaluate("""() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          let fail = true;
          chrome.runtime.sendMessage = (message, ...args) => {
            if (fail && message.type === 'PREVIEW_ANALYSIS_BATCH') {
              fail = false;
              return Promise.resolve({ok:false,message:'测试：预览服务不可用'});
            }
            return send(message, ...args);
          };
        }""")
        page.locator("#batch-text-status").select_option("incremental")
        expect(page.locator("#batch-dialog-feedback")).to_contain_text("预览服务不可用")
        expect(page.locator("#start-analysis-batch")).to_be_disabled()
        capture(page, artifacts / "failure.png")
        page.locator("#batch-text-status").select_option("missing")
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 1")
        # Delay one actual backend reply, then change the scope: the old result must not win.
        page.evaluate("""() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          let hold = true;
          chrome.runtime.sendMessage = async (message, ...args) => {
            const response = await send(message, ...args);
            if (hold && message.type === 'PREVIEW_ANALYSIS_BATCH') {
              hold = false;
              await new Promise(resolve => globalThis.releaseBatchPreview = resolve);
            }
            return response;
          };
        }""")
        page.locator("#batch-scope-project").select_option("target")
        page.wait_for_function("() => typeof releaseBatchPreview === 'function'")
        expect(page.locator("#start-analysis-batch")).to_be_disabled()
        capture(page, artifacts / "checking.png")
        page.locator("#batch-scope-project").select_option(":selection")
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 1")
        page.evaluate("releaseBatchPreview()")
        expect(page.locator("#analysis-batch-summary")).to_contain_text("待处理 1")
        page.locator("#text-batch-close").click()
        setup.evaluate("""async () => {
          const {getLibraryStorage} = await import(chrome.runtime.getURL('library-storage.js'));
          const storage = getLibraryStorage();
          const {organizerState} = await storage.get('organizerState');
          organizerState.collections.find(item => item.id === 'target').name = 'x精选 / A very long project name for creative references and original prompts';
          await storage.set({organizerState});
        }""")
        for width, locale, theme in [(1440, "en", "light"), (390, "en", "light"), (1440, "zh-CN", "light")]:
            page.close()
            worker.evaluate("""async prefs => {
              const {uiPreferences} = await chrome.storage.local.get('uiPreferences');
              await chrome.storage.local.set({uiPreferences:{...uiPreferences,...prefs}});
            }""", {"locale": locale, "theme": theme})
            page = session.open_page("library.html", wait_until="networkidle")
            page.set_viewport_size({"width": 1440, "height": 900})
            dialog = page.locator("#text-batch-dialog")
            menu = page.locator('.project-row[data-collection-id="target"] .project-menu')
            if not menu.locator("summary").is_visible():
                page.locator("#toggle-filters").click()
            menu.locator("summary").click()
            menu.get_by_role("button", name="Batch analysis" if locale == "en" else "批量分析", exact=True).click()
            expect(page.locator("#batch-text-status")).to_have_value("missing")
            page.set_viewport_size({"width": width, "height": 900 if width > 500 else 844})
            page.locator("#batch-scope-types-title").click()
            expect(page.locator("#batch-scope-types input").first).to_be_visible()
            assert dialog.evaluate("el => el.scrollWidth <= el.clientWidth")
            capture(page, artifacts / f"{locale}-{theme}-{width}.png")
            page.locator("#text-batch-close").click()
        assert worker.evaluate("batchCalls") == 1
        assert not session.page_errors, session.page_errors
        print({"three_entries": True, "project_and_type_scope": True, "skip_analyzed": True,
               "close_continue_reopen": True, "only_one_mock_request": True,
               "unchanged_outside_cases_and_projects": True, "screenshots": str(artifacts)})


if __name__ == "__main__":
    main()
