from __future__ import annotations

from playwright.sync_api import expect

from e2e_support import ai_configuration_fixture, base_entry, extension_session


PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="


def image_entry(entry_id: str, title: str, minute: int) -> dict:
    entry = base_entry(entry_id, title, f"{title} 的共享提示词", "content:prompt:image", minute)
    asset_id = f"{entry_id}-image"
    entry["mediaAssets"] = [{
        "id": asset_id,
        "kind": "image",
        "usage": "content",
        "storageMode": "managed",
        "mimeType": "image/png",
        "width": 1,
        "height": 1,
        "capturedAt": "2026-08-24T00:00:00.000Z",
        "reviewStatus": "verified",
    }]
    entry["primaryMediaId"] = asset_id
    return entry


def assert_current_preview(dialog, *, expected_model: str, forbidden_model: str) -> None:
    expect(dialog).to_be_visible()
    expect(dialog.locator("#vision-batch-summary")).to_contain_text("2 个案例 · 2 次图片请求")
    expect(dialog.locator("#vision-batch-start")).to_be_visible()
    expect(dialog.locator("#vision-batch-start")).to_be_enabled()
    expect(dialog.locator("#vision-batch-service")).to_contain_text(expected_model)
    service_text = dialog.locator("#vision-batch-service").text_content() or ""
    assert forbidden_model not in service_text, service_text


def main() -> None:
    entries = [
        image_entry("vision-entry-a", "批量入口案例 A", 0),
        image_entry("vision-entry-b", "批量入口案例 B", 1),
    ]

    providers = {
        "custom-media": {
            "endpoint": "https://fixture.invalid/v1/responses",
            "protocol": "responses",
            "apiKey": "fixture-key",
            "consent": True,
            "models": {"imageAnalysis": "deepseek-v4-vision"},
        },
    }
    assignments = {
        "imageAnalysis": {"providerId": "custom-media", "model": "deepseek-v4-vision"},
    }

    with extension_session("prompt-director-vision-batch-entry-", viewport={"width": 1440, "height": 900}) as session:
        setup = session.open_page("collector.html")
        setup.evaluate("async () => chrome.runtime.sendMessage({type: 'GET_STATE'})")
        session.seed_storage(setup, {
            "schemaVersion": 25,
            "entries": entries,
            "uiPreferences": {"locale": "zh-CN", "theme": "dark", "motion": "system"},
            "organizerState": {
                "version": 5,
                "collections": [{
                    "id": "collection:vision-batch",
                    "name": "批量入口验收项目",
                    "order": 0,
                    "entryIds": [entry["id"] for entry in entries],
                    "visibility": "library",
                }],
            },
            **ai_configuration_fixture(providers=providers, assignments=assignments),
        })
        setup.evaluate(
            """async ({entries, png}) => {
              const {saveMediaBlob} = await import(chrome.runtime.getURL('media-store.js'));
              const {createVisionBatchJob} = await import(chrome.runtime.getURL('analysis-batch.js'));
              const bytes = Uint8Array.from(atob(png), value => value.charCodeAt(0));
              const blob = new Blob([bytes], {type: 'image/png'});
              for (const entry of entries) {
                await saveMediaBlob(entry.primaryMediaId, blob, {checkCapacity: false});
              }
              const {getLibraryStorage} = await import(chrome.runtime.getURL('library-storage.js'));
              const storage = getLibraryStorage();
              const stored = await storage.get('entries');
              const job = createVisionBatchJob(stored.entries, {
                id: 'completed-old-vision-job',
                entryIds: stored.entries.map(entry => entry.id),
                includeAllImages: false,
                reanalyze: false,
                providerType: 'compatible',
                providerId: 'custom-media',
                model: 'gpt-old',
                now: '2026-08-24T00:00:00.000Z'
              });
              job.status = 'completed';
              job.updatedAt = '2026-08-24T00:05:00.000Z';
              job.items = job.items.map((item, index) => ({
                ...item,
                status: 'succeeded',
                attempts: 1,
                claimId: `done-${index + 1}`,
              }));
              job.usage = {promptTokens: 8, completionTokens: 4, totalTokens: 12, cacheHitTokens: 0};
              await storage.set({batchJob: job});
            }""",
            {"entries": entries, "png": PNG_BASE64},
        )

        library = session.open_page("library.html", wait_until="networkidle")
        expect(library.locator("#case-list > .case-card")).to_have_count(2)
        project_menu = library.locator("#collection-filters details.project-menu")
        project_menu.locator(":scope > summary").click()
        project_menu.get_by_role("button", name="批量分析").click()

        expect(library.locator('#text-batch-dialog')).to_be_visible()
        expect(library.locator('#batch-scope-project')).to_have_value('collection:vision-batch')
        library.locator('[data-batch-kind="image"]').click()
        dialog = library.locator("#text-batch-dialog")
        assert_current_preview(dialog, expected_model="deepseek-v4-vision", forbidden_model="gpt-old")

        dialog.locator("#text-batch-close").click()
        expect(dialog).not_to_be_visible()

        library.locator("#select-cases").click()
        library.locator("#selection-select-filtered").click()
        expect(library.locator("#share-count")).to_have_text("已选 2")
        library.locator("#selection-more-menu > summary").click()
        expect(library.locator("#selection-analyze")).to_be_enabled()
        library.locator("#selection-analyze").click()

        assert_current_preview(dialog, expected_model="deepseek-v4-vision", forbidden_model="gpt-old")

        dialog.locator("#text-batch-close").click()
        library.evaluate("""async () => {
          const {getLibraryStorage} = await import(chrome.runtime.getURL('library-storage.js'));
          const storage = getLibraryStorage();
          const {batchJob} = await storage.get('batchJob');
          batchJob.status = 'paused';
          batchJob.items.forEach(item => { item.status = 'pending'; item.claimId = ''; });
          await storage.set({batchJob});
        }""")
        library.reload(wait_until="networkidle")
        project_menu = library.locator("#collection-filters details.project-menu")
        project_menu.locator("summary").click()
        project_menu.get_by_role("button", name="批量分析", exact=True).click()
        expect(dialog.locator("#vision-batch-service")).to_contain_text("gpt-old")
        expect(library.locator("#batch-scope-project")).to_be_disabled()
        active = library.evaluate("async () => (await chrome.runtime.sendMessage({type:'GET_STATE'})).visionBatchJob")
        assert active['status'] == 'paused' and active['model'] == 'gpt-old', active

        print({
            "project_menu_entry_preselected": True,
            "selection_toolbar_entry_works": True,
            "stale_completed_job_did_not_override_preview_model": True,
            "running_task_preserved_after_route_changes": True,
        })


if __name__ == "__main__":
    main()
