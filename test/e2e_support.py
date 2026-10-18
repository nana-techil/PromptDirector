from __future__ import annotations

import os
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, Page, Playwright, TimeoutError as PlaywrightTimeoutError, sync_playwright


SOURCE_EXTENSION_DIR = Path(__file__).resolve().parents[1] / "extension"
EXTENSION_DIR = Path(
    os.environ.get("PROMPTDIRECTOR_E2E_EXTENSION_DIR", str(SOURCE_EXTENSION_DIR))
).resolve()
AI_TASK_IDS = (
    "textTags",
    "skillExtraction",
    "creativePlanning",
    "imageAnalysis",
    "videoAnalysis",
    "imageGeneration",
    "videoGeneration",
)


@dataclass
class ExtensionTestSession:
    context: BrowserContext
    extension_id: str
    profile_dir: Path
    page_errors: list[str]
    playwright: Playwright

    def restart_browser(self, *, extension_dir: Path = EXTENSION_DIR) -> None:
        """Reopen the same disposable profile, discarding all worker/page memory."""
        self.context.close()
        self.context = launch_context(self.playwright, str(self.profile_dir), viewport={"width": 1280, "height": 900},
                                      accept_downloads=True, extension_dir=extension_dir)
        self.context.on("page", lambda page: record_page_errors(page, self.page_errors))

    def open_page(self, path: str, *, wait_until: str = "domcontentloaded") -> Page:
        page = self.context.new_page()
        record_page_errors(page, self.page_errors)
        page.goto(f"chrome-extension://{self.extension_id}/{path}", wait_until=wait_until)
        return page

    def seed_storage(self, page: Page, payload: dict) -> None:
        seed_extension_storage(page, payload)


def seed_extension_storage(page: Page, payload: dict) -> None:
    """Seed a fixture only after the extension's first state migration has settled."""
    result = page.evaluate(
        """async (payload) => {
          await chrome.runtime.sendMessage({type: 'GET_STATE'});
          await chrome.storage.local.clear();
          await chrome.storage.local.set(payload);
          const state = await chrome.runtime.sendMessage({type: 'GET_STATE'});
          const expectedEntryIds = (payload.entries ?? []).map((entry) => entry.id);
          const actualEntryIds = new Set((state.entries ?? []).map((entry) => entry.id));
          const expectedRunIds = (payload.creativeRuns ?? []).map((run) => run.id);
          const actualRunIds = new Set((state.creativeRuns ?? []).map((run) => run.id));
          const missingEntryIds = expectedEntryIds.filter((id) => !actualEntryIds.has(id));
          const missingRunIds = expectedRunIds.filter((id) => !actualRunIds.has(id));
          const missingSessionIds = [];
          for (const session of payload.composerSessions ?? []) {
            const response = await chrome.runtime.sendMessage({
              type: 'GET_COMPOSER_SESSION',
              sessionId: session.id
            });
            if (!response?.ok) missingSessionIds.push(session.id);
          }
          return {ok: state.ok, missingEntryIds, missingRunIds, missingSessionIds};
        }""",
        payload,
    )
    assert result["ok"] is True, result
    assert not result["missingEntryIds"], result
    assert not result["missingRunIds"], result
    assert not result["missingSessionIds"], result


def wait_for_async_condition(page: Page, expression: str, *, arg=None, timeout: int = 30_000):
    """Poll the resolved value: wait_for_function treats a Promise itself as truthy."""
    deadline = time.monotonic() + timeout / 1000
    value = None
    while time.monotonic() < deadline:
        value = page.evaluate(expression, arg)
        if value:
            return value
        page.wait_for_timeout(50)
    raise AssertionError(f"异步状态条件未满足：{expression}; 最后结果：{value}")


@contextmanager
def extension_session(
    profile_prefix: str,
    *,
    viewport: dict | None = None,
    accept_downloads: bool = True,
    extension_dir: Path = EXTENSION_DIR,
    preserve_http_cache: bool = False,
    show_scrollbars: bool = False,
    extra_args: list[str] | None = None,
) -> Iterator[ExtensionTestSession]:
    with tempfile.TemporaryDirectory(prefix=profile_prefix) as profile:
        with sync_playwright() as playwright:
            context = launch_context(
                playwright,
                profile,
                viewport=viewport or {"width": 1280, "height": 900},
                accept_downloads=accept_downloads,
                extension_dir=extension_dir,
                preserve_http_cache=preserve_http_cache,
                show_scrollbars=show_scrollbars,
                extra_args=extra_args,
            )
            page_errors: list[str] = []
            context.on("page", lambda page: record_page_errors(page, page_errors))
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
                run = ExtensionTestSession(context, worker.url.split("/")[2], Path(profile), page_errors, playwright)
                yield run
                assert not page_errors, f"扩展页面出现运行时错误：{page_errors}"
            finally:
                (run.context if 'run' in locals() else context).close()


def launch_context(
    playwright: Playwright,
    profile_dir: str,
    *,
    viewport: dict,
    accept_downloads: bool,
    extension_dir: Path = EXTENSION_DIR,
    preserve_http_cache: bool = False,
    show_scrollbars: bool = False,
    extra_args: list[str] | None = None,
) -> BrowserContext:
    network_blocked = os.environ.get("PROMPTDIRECTOR_E2E_BLOCK_EXTERNAL_NETWORK") == "1"
    cache_safe_args = ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] if network_blocked and preserve_http_cache else []
    context = playwright.chromium.launch_persistent_context(
        profile_dir,
        headless=True,
        # Headless Chromium hides tracks by default, masking scroll affordance bugs.
        ignore_default_args=["--hide-scrollbars"] if show_scrollbars else None,
        channel=os.environ.get("PROMPTDIRECTOR_E2E_CHANNEL", "chromium"),
        accept_downloads=accept_downloads,
        viewport=viewport,
        locale="zh-CN",
        permissions=["clipboard-read", "clipboard-write"],
        args=[
            f"--disable-extensions-except={extension_dir}",
            f"--load-extension={extension_dir}",
            *cache_safe_args,
            *(extra_args or []),
        ],
    )
    worker = wait_for_extension_worker(context)
    bootstrap = context.new_page()
    bootstrap_errors: list[str] = []
    record_page_errors(bootstrap, bootstrap_errors)
    try:
        bootstrap.goto(f"chrome-extension://{worker.url.split('/')[2]}/collector.html", wait_until="domcontentloaded")
        bootstrap.evaluate("async () => chrome.runtime.sendMessage({type: 'GET_STATE'})")
        assert not bootstrap_errors, f"扩展首次初始化出现运行时错误：{bootstrap_errors}"
    finally:
        bootstrap.close()
    # Playwright routing disables native HTTP cache. Cache tests block external
    # DNS at launch instead, retaining actual conditional requests to loopback.
    if network_blocked and not preserve_http_cache:
        # Real local TLS fixtures still exercise fetch/streaming while CI blocks
        # external services. Match the hostname, never a URL prefix.
        context.route("https://**/*", lambda route: route.continue_()
                      if urlparse(route.request.url).hostname in {"127.0.0.1", "localhost", "::1"}
                      else route.abort("blockedbyclient"))
    return context


def wait_for_extension_worker(context: BrowserContext):
    try:
        return context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
    except PlaywrightTimeoutError:
        # Playwright can miss an already-running MV3 target at browser startup:
        # https://github.com/microsoft/playwright/issues/39075
        # Recover only that observed debugger-attachment race in this isolated
        # profile. A missing worker or a second startup failure still fails.
        page = context.new_page()
        cdp = context.new_cdp_session(page)
        try:
            targets = cdp.send("Target.getTargets")["targetInfos"]
            workers = [target for target in targets if target["type"] == "service_worker"
                       and target["url"].startswith("chrome-extension://")]
            if len(workers) != 1:
                raise
            extension_id = workers[0]["url"].split("/")[2]
            print("[E2E] Reattaching to an existing extension worker missed at startup.")
            cdp.send("ServiceWorker.enable")
            cdp.send("ServiceWorker.stopAllWorkers")
            page.goto(f"chrome-extension://{extension_id}/collector.html", wait_until="domcontentloaded")
            state = page.evaluate("async () => chrome.runtime.sendMessage({type: 'GET_STATE'})")
            assert state.get("ok") is True, "Restarted extension worker did not initialize"
            return context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
        finally:
            cdp.detach()
            page.close()


def record_page_errors(page: Page, errors: list[str]) -> None:
    def record(error: Exception) -> None:
        message = str(error)
        csp_probe = (
            message.startswith("Evaluating a string as JavaScript violates the following Content Security Policy directive")
            and "'unsafe-eval' is not an allowed source" in message
            and "script-src 'self'" in message
        )
        if not csp_probe:
            errors.append(f"{page.url}: {message}")

    page.on("pageerror", record)


def ai_configuration_fixture(
    *,
    providers: dict,
    assignments: dict,
    auto_analyze_imports: bool = False,
) -> dict:
    """Build the one persisted Registry v4 shape used by extension E2E fixtures."""
    return {
        "aiProviderRegistry": {"version": 4, "providers": providers},
        "aiTaskAssignments": {
            task_id: assignments.get(task_id, {"providerId": "", "model": ""})
            for task_id in AI_TASK_IDS
        },
        "aiPreferences": {"autoAnalyzeImports": auto_analyze_imports},
    }


def wait_for_download(page: Page, after_id: int = 0, timeout_seconds: float = 12) -> tuple[Path, int]:
    deadline = time.monotonic() + timeout_seconds
    records: list[dict] = []
    while time.monotonic() < deadline:
        records = page.evaluate("async () => chrome.downloads.search({orderBy: ['-startTime'], limit: 10})")
        for record in records:
            path = Path(record.get("filename", ""))
            if record.get("id", 0) > after_id and record.get("state") == "complete" and path.exists():
                return path, record["id"]
        page.wait_for_timeout(100)
    raise AssertionError(f"没有生成新的下载；下载记录：{records}")


def base_entry(entry_id: str, title: str, text: str, content_id: str, saved_minute: int = 0) -> dict:
    return {
        "schemaVersion": 24,
        "id": entry_id,
        "title": title,
        "text": text,
        "url": f"https://fixture.invalid/{entry_id}",
        "savedAt": f"2026-08-02T08:{saved_minute:02d}:00.000Z",
        "classification": {"pathIds": [content_id], "status": "confirmed", "source": "manual"},
        "facetAssignments": [],
        "analysisCandidates": [],
        "analysisBreakdown": [],
        "rejectedCandidateKeys": [],
        "negativeTerms": [],
        "customLabels": [],
        "mediaAssets": [],
        "timeNotes": [],
    }


def scroll_to_case(page, entry_id: str) -> None:
    """Reach an original via real scrolling, including virtual/unmounted cards."""
    total = page.evaluate("async () => { const {getLibraryStorage}=await import(chrome.runtime.getURL('library-storage.js')); return (await getLibraryStorage().get('entries')).entries.length; }")
    page.evaluate('scrollTo(0,0)')
    selector = f'.case-card[data-entry-id="{entry_id}"]'
    for _ in range(total * 2):
        page.wait_for_timeout(50)
        card = page.locator(selector)
        if card.count():
            card.scroll_into_view_if_needed()
            return
        page.evaluate('scrollBy(0,innerHeight/2)')
    raise AssertionError(f'Case {entry_id} was not reachable through the gallery')


def copy_analysis_diagnostics(page: Page) -> str:
    """Use the visible support action without depending on the system clipboard."""
    if page.locator('#copy-analysis-diagnostics').is_hidden():
        open_task_settings(page)
        page.locator('[data-settings-tab="general"]').click()
        page.locator('#ui-diagnostics').check()
        page.locator('[data-settings-tab="tasks"]').click()
    page.evaluate('''() => {
      window.copiedAnalysisDiagnostics = null;
      navigator.clipboard.writeText = async text => { window.copiedAnalysisDiagnostics = text; };
    }''')
    page.locator('#copy-analysis-diagnostics').click()
    page.wait_for_function('window.copiedAnalysisDiagnostics !== null')
    return page.evaluate('window.copiedAnalysisDiagnostics')


def apply_retained_recovery(page: Page, action: str, job_id=None):
    """Exercise retained recovery safety in disposable profiles after retiring its UI."""
    result = page.evaluate('''async ({action, jobId}) => {
      const preview = await chrome.runtime.sendMessage({type:'PREVIEW_LIBRARY_UNDO',action,jobId});
      if (!preview?.ok) return preview;
      return chrome.runtime.sendMessage({type:action,jobId,confirmationToken:preview.confirmationToken});
    }''', {'action': action, 'jobId': job_id})
    assert result.get('ok'), result
    return result


def open_library_analysis(page: Page):
    """Reach whole-library scoped analysis through the existing selection tools."""
    page.wait_for_function("document.body.dataset.libraryState === 'ready'")
    if page.locator('#settings-dialog').is_visible():
        page.locator('#settings-close').click()
    if page.locator('#selection-select-filtered').is_hidden():
        page.locator('#select-cases').click()
    page.locator('#selection-select-filtered').click()
    page.locator('#selection-more-menu > summary').click()
    page.locator('#selection-text-analyze').click()
    page.locator('#batch-scope-project').select_option('')


def open_task_settings(page: Page):
    """Return from case management to the actual inline settings entry."""
    if page.locator('#text-batch-dialog').is_visible():
        page.locator('#text-batch-close').click()
    if not page.locator('#settings-dialog').is_visible():
        if page.locator('#share-cancel').is_visible():
            page.locator('#share-cancel').click()
        page.locator('#open-settings').click()
    page.locator('[data-settings-tab="tasks"]').click()
