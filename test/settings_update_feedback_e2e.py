"""Offline background checks stay quiet; explicit checks give local, temporary feedback."""
from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import expect

from e2e_support import base_entry, extension_session


def screenshot(page, path):
    page.mouse.move(0, 0)
    page.screenshot(path=str(path), animations="disabled")


def assert_frame(page):
    metrics = page.locator("#settings-dialog").evaluate("""dialog => {
      const footer = dialog.querySelector('.settings-about').getBoundingClientRect();
      const panel = dialog.querySelector('[data-settings-panel]:not([hidden])');
      const p = panel.getBoundingClientRect();
      const button = dialog.querySelector('#check-extension-update').getBoundingClientRect();
      return {footerTop: footer.top, footerBottom: footer.bottom, panelBottom: p.bottom,
        buttonLeft: button.left, buttonRight: button.right, buttonBottom: button.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        panelOverflow: panel.scrollWidth > panel.clientWidth,
        footerOverflow: dialog.querySelector('.settings-about').scrollWidth > dialog.querySelector('.settings-about').clientWidth};
    }""")
    assert metrics["panelBottom"] <= metrics["footerTop"] + 1, metrics
    assert metrics["footerBottom"] <= metrics["viewportHeight"], metrics
    assert 0 <= metrics["buttonLeft"] < metrics["buttonRight"] <= metrics["viewportWidth"], metrics
    assert metrics["buttonBottom"] <= metrics["viewportHeight"], metrics
    assert not metrics["panelOverflow"] and not metrics["footerOverflow"], metrics
    return metrics


def main():
    output = Path(os.environ.get("PD_E2E_ARTIFACT_DIR", "/tmp/pd-settings-update-feedback"))
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for width, height, theme, locale in [
        (1280, 900, "dark", "zh-CN"), (390, 844, "dark", "zh-CN"),
        (1280, 900, "light", "en"), (390, 844, "light", "en"),
    ]:
        with extension_session("pd-settings-offline-", viewport={"width": width, "height": height}) as session:
            setup = session.open_page("collector.html")
            session.seed_storage(setup, {
                "entries": [base_entry("kept", "保留案例", "原资料不变", "content:prompt:text")],
                "uiPreferences": {"theme": theme, "locale": locale, "motion": "reduced"},
                "extensionUpdateState": {"checkStatus": "error", "lastError": "Failed to fetch"},
            })
            session.context.set_offline(True)
            # Chromium's page offline emulation does not cover extension workers.
            # Fail only the release request at the worker's network boundary.
            session.context.service_workers[0].evaluate("""() => {
              const originalFetch = globalThis.fetch;
              const release = chrome.runtime.getManifest().homepage_url.replace(/\\/$/, '') + '/releases/latest';
              globalThis.fetch = (url, ...args) => String(url) === release
                ? Promise.reject(new TypeError('Failed to fetch'))
                : originalFetch(url, ...args);
            }""")
            page = session.open_page("library.html", wait_until="networkidle")
            expect(page.locator("body")).to_have_attribute("data-library-state", "ready")
            page.locator("#open-settings").click()
            expect(page.locator("#settings-general-panel")).to_be_visible()
            expect(page.locator("#ui-theme")).to_have_value(theme)
            expect(page.locator("#ui-diagnostics")).to_be_hidden()
            feedback = page.locator("#update-feedback")
            expect(feedback).to_have_text("")
            assert_frame(page)
            screenshot(page, output / f"general-{width}-{locale}.png")
            # A passive status event must not replay a saved error.
            status = page.evaluate("async () => (await chrome.runtime.sendMessage({type: 'GET_EXTENSION_UPDATE_STATUS'})).status")
            session.context.service_workers[0].evaluate("""async state => {
              await chrome.runtime.sendMessage({type: 'EXTENSION_UPDATE_STATUS_CHANGED',
                status: {...state, checkStatus: 'error', lastError: 'Failed to fetch'}});
            }""", status)
            expect(feedback).to_have_text("")
            page.locator("#settings-general-panel").evaluate("el => el.scrollTop = el.scrollHeight")
            assert_frame(page)
            screenshot(page, output / f"scrolled-{width}-{locale}.png")

            # The real update lifecycle persists and broadcasts the injected network failure.
            page.locator("#check-extension-update").click()
            expected = "当前未联网，联网后再检查更新" if locale == "zh-CN" else "You’re offline. Reconnect to check for updates."
            expect(feedback).to_have_text(expected)
            assert feedback.evaluate("e => !e.classList.contains('is-error') && !e.classList.contains('error')")
            assert_frame(page)
            screenshot(page, output / f"offline-check-{width}-{locale}.png")
            expect(feedback).to_have_text("", timeout=6000)
            page.locator("#settings-close").click()
            page.locator("#open-settings").click()
            expect(feedback).to_have_text("")

            page.locator('[data-settings-tab="tasks"]').click()
            page.locator("#ui-diagnostics").scroll_into_view_if_needed()
            expect(page.locator("#ui-diagnostics")).to_be_visible()
            assert_frame(page)
            screenshot(page, output / f"maintenance-{width}-{locale}.png")
            page.locator("#ui-diagnostics").check()
            page.wait_for_function("""async () => (await chrome.storage.local.get('uiPreferences')).uiPreferences.diagnosticsEnabled""")
            # A known available release still retains its badge/action while offline.
            status = page.evaluate("async () => (await chrome.runtime.sendMessage({type: 'GET_EXTENSION_UPDATE_STATUS'})).status")
            session.context.service_workers[0].evaluate("""async state => {
              await chrome.runtime.sendMessage({type: 'EXTENSION_UPDATE_STATUS_CHANGED',
                status: {...state, updateAvailable: true, canApply: true, lastError: 'Failed to fetch'}});
            }""", status)
            expect(page.locator("#apply-extension-update")).to_be_visible()
            expect(page.locator("#settings-update-badge")).not_to_have_attribute("hidden", "")
            expect(feedback).to_have_text("")
            assert_frame(page)
            screenshot(page, output / f"available-{width}-{locale}.png")
            saved = page.evaluate("async () => (await chrome.runtime.sendMessage({type: 'GET_STATE'})).entries[0]")
            assert saved["text"] == "原资料不变"
            if width == 1280 and locale == "zh-CN":
                dark_surface = page.locator("#settings-dialog").evaluate("el => getComputedStyle(el).backgroundColor")
                page.locator('[data-settings-tab="general"]').click()
                with page.expect_navigation(wait_until="networkidle"):
                    page.locator("#ui-theme").select_option("system")
                expect(page.locator("body")).to_have_attribute("data-library-state", "ready")
                page.locator("#open-settings").click()
                expect(page.locator("#ui-theme")).to_have_value("system")
                page.emulate_media(color_scheme="dark")
                expect(page.locator("html")).to_have_attribute("data-theme", "system")
                expect(page.locator("#settings-dialog")).to_have_css("background-color", dark_surface)
                page.emulate_media(color_scheme="light")
                expect(page.locator("#settings-dialog")).not_to_have_css("background-color", dark_surface)
                assert page.evaluate("async () => (await chrome.storage.local.get('uiPreferences')).uiPreferences.theme") == "system"
                expect(feedback).to_have_text("")
            results.append({"width": width, "theme": theme, "locale": locale, "offlineQuiet": True,
                            "explicitCheckTransient": True, "availableActionPreserved": True})
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
