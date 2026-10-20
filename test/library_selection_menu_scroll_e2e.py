"""Management menus must remain reachable after the library leaves its first screen."""
from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import expect

from e2e_support import base_entry, extension_session, scroll_to_case


def open_menu(page, name):
    menu = page.locator(f"#selection-{name}-menu")
    menu.locator(":scope > summary").click()
    panel = menu.locator(".selection-menu-panel")
    expect(panel).to_be_visible()
    geometry = panel.evaluate("""panel => {
      const r = panel.getBoundingClientRect();
      const button = [...panel.querySelectorAll('button, input, select')]
        .find(el => !el.disabled && el.getBoundingClientRect().height > 0);
      const b = button.getBoundingClientRect();
      return {top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        reachable: button.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2))};
    }""")
    assert geometry["top"] >= 0 and geometry["bottom"] <= geometry["viewportHeight"], geometry
    assert geometry["left"] >= 0 and geometry["right"] <= geometry["viewportWidth"], geometry
    assert geometry["reachable"], geometry
    return panel


def main():
    artifacts = Path(os.environ.get("PD_E2E_ARTIFACT_DIR", "/tmp/pd-selection-menu-scroll"))
    artifacts.mkdir(parents=True, exist_ok=True)
    results = []
    for width, theme, locale in [(1280, "dark", "zh-CN"), (760, "light", "en"), (390, "dark", "zh-CN")]:
        with extension_session("pd-selection-menu-scroll-", viewport={"width": width, "height": 760}) as session:
            setup = session.open_page("collector.html")
            session.seed_storage(setup, {
                "schemaVersion": 28,
                "entries": [base_entry(f"scroll-{i}", f"滚动管理案例 {i}", "管理回归内容\n" * 12,
                                       "content:prompt:text", i % 60) for i in range(90)],
                "uiPreferences": {"locale": locale, "theme": theme, "motion": "reduced"},
            })
            page = session.open_page("library.html", wait_until="networkidle")
            expect(page.locator("body")).to_have_attribute("data-library-state", "ready")
            page.locator("#select-cases").click()
            expect(page.locator("#share-bar")).to_be_visible()
            for index in range(2):
                page.locator("#case-list > .case-card").nth(index).click()
            selected = page.locator(".case-card.selected-for-share").evaluate_all(
                "cards => cards.map(card => card.dataset.entryId)")

            for scroll_y in [0, 900, 2000]:
                page.evaluate("(y) => scrollTo(0, y)", scroll_y)
                page.wait_for_function("(y) => Math.abs(scrollY - y) < 1", arg=scroll_y)
                for name in ["project", "classification", "label", "more"]:
                    open_menu(page, name)
                    if name == "more" and scroll_y == 2000:
                        page.screenshot(path=str(artifacts / f"more-{width}-{theme}-{locale}.png"),
                                        animations="disabled")
                    page.keyboard.press("Escape")
                    expect(page.locator(f"#selection-{name}-menu")).not_to_have_attribute("open", "")
                    assert page.evaluate("scrollY") == scroll_y

            open_menu(page, "more")
            page.locator("#selection-clear").click()
            expect(page.locator("#selection-selected-actions")).to_be_hidden()
            page.locator("#share-cancel").click()
            expect(page.locator("#select-cases")).to_be_visible()

            # A real batch action after scrolling must target the original selection.
            page.locator("#select-cases").click()
            expect(page.locator("#share-bar")).to_be_visible()
            for entry_id in selected:
                scroll_to_case(page, entry_id)
                page.locator(f'.case-card[data-entry-id="{entry_id}"]').click()
            page.evaluate("scrollTo(0, 900)")
            page.wait_for_function("scrollY === 900")
            open_menu(page, "label")
            page.locator("#selection-label-input").fill("滚动后管理")
            page.locator("#selection-add-labels").click()
            expect(page.locator("#selection-label-menu")).not_to_have_attribute("open", "")
            tagged = page.evaluate("""async () => {
              const state = await chrome.runtime.sendMessage({type: 'GET_STATE'});
              return state.entries.filter(e => e.customLabels.includes('滚动后管理')).map(e => e.id);
            }""")
            assert sorted(tagged) == sorted(selected), tagged
            expect(page.locator("#select-cases")).to_be_visible()
            results.append({"width": width, "theme": theme, "locale": locale,
                            "scrollPositions": [0, 900, 2000], "tagged": tagged})
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
