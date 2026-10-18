from __future__ import annotations

import tempfile
from pathlib import Path

from playwright.sync_api import expect

from e2e_support import base_entry, extension_session


PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="


def image_entry(entry_id: str, title: str, text: str, minute: int) -> dict:
    entry = base_entry(entry_id, title, text, "content:prompt:image", minute)
    asset_id = f"{entry_id}-image"
    entry["mediaAssets"] = [{
        "id": asset_id,
        "kind": "image",
        "usage": "content",
        "storageMode": "managed",
        "mimeType": "image/png",
        "width": 1,
        "height": 1,
        "capturedAt": "2026-08-05T00:00:00.000Z",
        "reviewStatus": "verified",
    }]
    entry["primaryMediaId"] = asset_id
    return entry


def main() -> None:
    project_entry = image_entry("project-private", "无提示词图片", "", 0)
    visible_entry = image_entry("library-visible", "资料库图片", "柔和自然光", 1)
    project_id = "collection:visibility-e2e"
    screenshots = Path(tempfile.gettempdir())

    with extension_session("prompt-director-ui-regressions-", viewport={"width": 1440, "height": 900}) as session:
        setup = session.open_page("collector.html")
        setup.evaluate(
            """async ({entries, png, projectId}) => {
              const {saveMediaBlob} = await import(chrome.runtime.getURL('media-store.js'));
              const {applyFixedAnalysisTags, createFixedFacetCatalog} = await import(chrome.runtime.getURL('tag-taxonomy.js'));
              const bytes = Uint8Array.from(atob(png), value => value.charCodeAt(0));
              const blob = new Blob([bytes], {type: 'image/png'});
              let state = {facetCatalog: createFixedFacetCatalog(), entries};
              state = applyFixedAnalysisTags(state, 'project-private', [{g: 'style.render', t: '共同质感'}], {
                source: 'deepseek_text'
              }).state;
              for (const entry of entries) await saveMediaBlob(entry.primaryMediaId, blob, {checkCapacity: false});
              await chrome.storage.local.clear();
              await chrome.storage.local.set({
                schemaVersion: 24,
                entries: state.entries,
                facetCatalog: state.facetCatalog,
                organizerState: {
                  version: 5,
                  collections: [{
                    id: projectId,
                    name: '项目隐藏验收',
                    order: 0,
                    entryIds: ['project-private'],
                    visibility: 'library',
                  }]
                }
              });
            }""",
            {"entries": [project_entry, visible_entry], "png": PNG_BASE64, "projectId": project_id},
        )

        library = session.open_page("library.html", wait_until="networkidle")
        expect(library.locator("body")).to_have_attribute("data-library-state", "ready")
        expect(library.locator("#case-list > .case-card")).to_have_count(2)
        assert library.locator("#import-candidates").count() == 0
        assert library.get_by_text("高级工具", exact=True).count() == 0

        project_row = library.locator(".project-row", has_text="项目隐藏验收")
        project_row.locator("summary").click()
        project_row.get_by_role("button", name="仅项目可见", exact=True).click()
        expect(library.locator("#feedback")).to_contain_text("项目显示范围已更新")
        expect(library.locator("#case-list > .case-card")).to_have_count(1)
        visibility = library.evaluate(
            "async id => (await chrome.storage.local.get('organizerState')).organizerState.collections.find(item => item.id === id).visibility",
            project_id,
        )
        assert visibility == "project-only", visibility

        project_filter = library.locator(".project-filter", has_text="项目隐藏验收")
        project_filter.click()
        expect(library.locator("#case-list > .case-card")).to_have_count(1)
        selected_style = project_filter.evaluate(
            "button => ({background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color, shadow: getComputedStyle(button).boxShadow})"
        )
        assert selected_style["background"] != "rgba(0, 0, 0, 0)", selected_style
        assert selected_style["shadow"] != "none", selected_style

        library.locator('[data-sidebar-module="tags"] .sidebar-module-toggle').click()
        library.locator('.facet-filter[data-facet-id="style"] > summary').click()
        facet_button = library.locator('[data-facet-node-id="style.render"]')
        expect(facet_button).to_be_visible()
        library.evaluate(
            """() => {
              window.__projectNavigationNode = document.querySelector('#collection-filters').firstElementChild;
              window.__facetNavigationNode = document.querySelector('#facet-filters').firstElementChild;
            }"""
        )
        facet_button.click()
        expect(facet_button).to_have_attribute("aria-pressed", "true")
        navigation_reused = library.evaluate(
            """() => ({
              project: window.__projectNavigationNode === document.querySelector('#collection-filters').firstElementChild,
              facet: window.__facetNavigationNode === document.querySelector('#facet-filters').firstElementChild
            })"""
        )
        assert navigation_reused == {"project": True, "facet": True}, navigation_reused

        library.locator("#case-list > .case-card").click()
        expect(library.locator("#detail-drawer")).to_have_attribute("data-entry-id", "project-private")
        # Confirmed 2026-10-16 layout: media and case information are two continuous panes side by
        # side on one screen, sharing the theme content surface; only the reading region scrolls.
        detail_surface = library.locator(".detail-primary").evaluate(
            """primary => {
              const rect = node => { const r = node.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height}; };
              const body = primary.querySelector('.detail-body');
              const gallery = primary.querySelector('.detail-visual-gallery');
              const reading = body?.querySelector('.detail-reading');
              const footer = primary.querySelector('.detail-workspace-footer');
              return {
                workspace: primary.classList.contains('detail-workspace'),
                gallery: rect(gallery),
                body: rect(body),
                footer: rect(footer),
                reading: reading ? {overflowY: getComputedStyle(reading).overflowY, scrollHeight: reading.scrollHeight, clientHeight: reading.clientHeight} : null,
                bodyBackground: getComputedStyle(body).backgroundColor,
                mediaBackground: getComputedStyle(gallery).backgroundColor,
                drawerBackground: getComputedStyle(document.querySelector('#detail-drawer')).backgroundColor,
                horizontalOverflow: primary.scrollWidth > primary.clientWidth,
                viewportHeight: innerHeight
              };
            }"""
        )
        assert detail_surface["workspace"], detail_surface
        assert detail_surface["gallery"]["right"] <= detail_surface["body"]["left"] + 1, detail_surface
        assert detail_surface["body"]["left"] > detail_surface["gallery"]["left"], detail_surface
        assert abs(detail_surface["gallery"]["top"] - detail_surface["body"]["top"]) <= 1, detail_surface
        assert detail_surface["bodyBackground"] == detail_surface["mediaBackground"] == detail_surface["drawerBackground"], detail_surface
        assert detail_surface["bodyBackground"] not in {"rgb(0, 0, 0)", "rgb(255, 255, 255)"}, detail_surface
        assert detail_surface["footer"]["bottom"] <= detail_surface["viewportHeight"] + 1, detail_surface
        assert detail_surface["reading"] and detail_surface["reading"]["overflowY"] in {"auto", "scroll"}, detail_surface
        assert detail_surface["horizontalOverflow"] is False, detail_surface
        expect(library.locator("#detail-prev")).to_be_disabled()
        expect(library.locator("#detail-next")).to_be_disabled()
        library.screenshot(path=str(screenshots / "promptdirector-library-detail-light.png"), full_page=True)

        composer = session.open_page("composer.html", wait_until="networkidle")
        # Confirmed 2026-10-18: task, target model and output language are inferred per request,
        # not manual composer settings; the remaining three switches are compact (30px each).
        for removed in ("#composer-route", "#composer-platform", "#composer-output-language"):
            expect(composer.locator(removed)).to_have_count(0)
        expect(composer.locator("#composer-production-review")).not_to_be_visible()
        expect(composer.locator("#composer-thinking")).not_to_be_visible()
        expect(composer.locator("#composer-applied-skills")).to_be_hidden()
        expect(composer.locator("#composer-attachment-local")).to_be_visible()
        expect(composer.locator("#composer-reference-open")).to_be_visible()
        composer.screenshot(path=str(screenshots / "promptdirector-composer-desktop.png"), full_page=True)
        composer.locator("#composer-options > summary").click()
        expect(composer.locator("#composer-production-review")).to_be_visible()
        expect(composer.locator("#composer-thinking")).to_be_visible()
        expect(composer.locator("#composer-create-image")).to_be_visible()
        toggle_metrics = composer.locator(".composer-option-toggles").evaluate(
            """node => {
              const rows = [...node.querySelectorAll('.composer-option-toggle')].map(row => row.getBoundingClientRect().height);
              return {
                rows,
                total: node.getBoundingClientRect().height,
                switches: [...node.querySelectorAll('input.ui-switch')].map(input => ({role: input.getAttribute('role'), type: input.type})),
                overflow: node.scrollWidth > node.clientWidth
              };
            }"""
        )
        assert len(toggle_metrics["rows"]) == 3 and all(abs(height - 30) < 1 for height in toggle_metrics["rows"]), toggle_metrics
        assert abs(toggle_metrics["total"] - 90) < 2, toggle_metrics
        assert all(item == {"role": "switch", "type": "checkbox"} for item in toggle_metrics["switches"]), toggle_metrics
        assert toggle_metrics["overflow"] is False, toggle_metrics

        composer.set_viewport_size({"width": 390, "height": 844})
        composer.locator("#composer-options").evaluate("details => { details.open = false; }")
        composer.wait_for_timeout(250)
        footer_geometry = composer.locator(".composer-input-footer").evaluate(
            """footer => {
              const rect = footer.getBoundingClientRect();
              const controls = [...footer.querySelectorAll('.composer-input-tools > *, .composer-input-actions > *')]
                .filter(node => node.getClientRects().length && !node.classList.contains("sr-only"))
                .map(node => node.getBoundingClientRect()).filter(item => item.width > 0 && item.height > 0);
              const rows = [];
              for (const item of controls) {
                const row = rows.find(row => item.top < row.bottom && item.bottom > row.top);
                if (row) { row.top = Math.min(row.top, item.top); row.bottom = Math.max(row.bottom, item.bottom); }
                else rows.push({top:item.top, bottom:item.bottom});
              }
              const gap = parseFloat(getComputedStyle(footer).rowGap) || 0;
              return {
                height: rect.height, rows, controls: controls.map(item => ({top:item.top,bottom:item.bottom,width:item.width,height:item.height})),
                compact: rows.length <= 2 && rect.height <= rows.reduce((sum, item) => sum + item.bottom - item.top, (rows.length-1)*gap) + 1,
                groupsOverlap: controls.some((item,index) => controls.slice(index+1).some(other => item.left < other.right && item.right > other.left && item.top < other.bottom && item.bottom > other.top)),
                overflow: controls.some(item => item.left < rect.left - 1 || item.right > rect.right + 1 || item.top < rect.top - 1 || item.bottom > rect.bottom + 1)
              };
            }"""
        )
        assert footer_geometry["compact"] is True, footer_geometry
        assert footer_geometry["groupsOverlap"] is False, footer_geometry
        assert footer_geometry["overflow"] is False, footer_geometry
        composer.screenshot(path=str(screenshots / "promptdirector-composer-mobile.png"), full_page=True)

        icon = library.locator(".brand-mark")
        icon_metrics = icon.evaluate(
            "image => ({naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: image.getBoundingClientRect().width})"
        )
        assert icon_metrics == {"naturalWidth": 128, "naturalHeight": 128, "width": 28}, icon_metrics
        print({
            "visibility": visibility,
            "navigation_reused": navigation_reused,
            "detail_surface": detail_surface,
            "composer_mobile": footer_geometry,
            "screenshots": [
                str(screenshots / "promptdirector-library-detail-light.png"),
                str(screenshots / "promptdirector-composer-desktop.png"),
                str(screenshots / "promptdirector-composer-mobile.png"),
            ],
        })


if __name__ == "__main__":
    main()
