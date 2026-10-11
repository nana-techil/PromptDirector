from __future__ import annotations

import json
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone

from playwright.sync_api import expect

from e2e_support import extension_session


def session_value(index: int) -> dict:
    day_offsets = [0, 1, 3, 10]
    timestamp = (datetime.now(timezone.utc) - timedelta(days=day_offsets[index % len(day_offsets)], minutes=index)).isoformat()
    return {
        "id": f"layout-session-{index}",
        "title": f"布局对话 {index:02d}" + (" · 这是一个用于验证单行省略效果的特别长会话标题" if index == 0 else ""),
        "targetType": "image",
        "updatedAt": timestamp,
        "messages": [{
            "id": f"layout-message-{index}",
            "role": "user",
            "type": "request",
            "content": f"第 {index} 个布局测试对话",
            "createdAt": timestamp,
        }],
    }


def geometry(page) -> dict:
    return page.evaluate(
        """() => {
          const rect = selector => {
            const value = document.querySelector(selector).getBoundingClientRect();
            return {top: value.top, bottom: value.bottom, height: value.height};
          };
          const sessions = document.querySelector('.composer-session-list');
          return {
            viewport: window.innerHeight,
            shell: rect('.composer-shell'),
            nav: rect('.composer-nav'),
            input: rect('.composer-input-area'),
            timeline: rect('.composer-chat-scroll'),
            sessions: {
              clientHeight: sessions.clientHeight,
              scrollHeight: sessions.scrollHeight,
              overflowY: getComputedStyle(sessions).overflowY,
            },
          };
        }"""
    )


def assert_stable(first: dict, last: dict) -> None:
    drift = {
        "shell": last["shell"]["bottom"] - first["shell"]["bottom"],
        "nav": last["nav"]["bottom"] - first["nav"]["bottom"],
        "input": last["input"]["bottom"] - first["input"]["bottom"],
    }
    assert max(abs(value) for value in drift.values()) <= 1, drift
    assert last["nav"]["bottom"] <= last["viewport"] + 1, last
    assert last["input"]["bottom"] <= last["viewport"] + 1, last
    assert last["sessions"]["scrollHeight"] > last["sessions"]["clientHeight"], last
    assert last["sessions"]["overflowY"] == "auto", last


def assert_last_session_reachable(page) -> dict:
    # Locator.hover/click can scroll overflow:hidden ancestors and hide this bug.
    # A user wheel must reach the last whole row without shifting the outer nav.
    bounds = page.locator('#composer-session-list').bounding_box()
    page.mouse.move(bounds['x'] + 30, bounds['y'] + 30)
    page.mouse.wheel(0, 10000)
    page.wait_for_function("() => {const e=document.querySelector('#composer-session-list');return e.scrollTop >= e.scrollHeight-e.clientHeight-1}")
    value = page.evaluate("""() => {
      const list=document.querySelector('#composer-session-list');
      const nav=document.querySelector('.composer-nav-section');
      const row=[...list.querySelectorAll('.composer-session-item')].at(-1);
      const r=row.getBoundingClientRect();
      const hit=document.elementFromPoint(r.left+30,r.bottom-3);
      return {lastId:row.dataset.sessionId,hitId:hit?.closest('.composer-session-item')?.dataset.sessionId,
        lastBottom:r.bottom,listBottom:list.getBoundingClientRect().bottom,navBottom:nav.getBoundingClientRect().bottom,
        outerScrollTop:nav.scrollTop,viewport:innerHeight};
    }""")
    assert value['lastBottom'] <= min(value['navBottom'],value['viewport'])+1, value
    assert value['hitId'] == value['lastId'] and value['outerScrollTop'] == 0, value
    return value


def main() -> None:
    sessions = [session_value(index) for index in range(30)]
    with extension_session("prompt-director-session-layout-", viewport={"width": 1280, "height": 900}) as run:
        setup = run.open_page("collector.html")
        run.seed_storage(setup, {"schemaVersion": 24, "composerSessions": sessions})
        composer = run.open_page("composer.html?session=layout-session-0", wait_until="networkidle")

        expect(composer.locator(".composer-session-group-label")).to_have_text(["今天", "昨天", "近 7 天", "更早"])
        long_title = composer.locator('.composer-session-item[data-session-id="layout-session-0"] strong')
        assert long_title.evaluate("node => node.scrollWidth > node.clientWidth")
        session_alignment = composer.locator('.composer-session-item[data-session-id="layout-session-0"] > button:first-child').evaluate(
            """node => {
              const button = node.getBoundingClientRect();
              const title = node.querySelector('strong').getBoundingClientRect();
              const style = getComputedStyle(node);
              return {justifyContent: style.justifyContent, textAlign: style.textAlign, buttonLeft: button.left, titleLeft: title.left, paddingLeft: parseFloat(style.paddingLeft)};
            }"""
        )
        assert session_alignment["justifyContent"] in {"start", "flex-start"}, session_alignment
        assert session_alignment["textAlign"] == "left", session_alignment
        assert abs(session_alignment["titleLeft"] - session_alignment["buttonLeft"] - session_alignment["paddingLeft"]) <= 1, session_alignment
        out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-session-scroll'));out.mkdir(parents=True,exist_ok=True)
        reachability=[]
        for locale,theme in [('zh-CN','dark'),('en','light')]:
            composer.evaluate("async prefs=>chrome.storage.local.set({uiPreferences:prefs})",{'locale':locale,'theme':theme,'motion':'reduced'})
            for width,height in [(1280,600),(390,500)]:
                composer.set_viewport_size({'width':width,'height':height})
                composer.reload(wait_until='networkidle')
                if width == 390:
                    composer.locator('#composer-nav-open').click()
                    composer.wait_for_function("()=>document.querySelector('#composer-nav').getBoundingClientRect().left>=0")
                try:
                    reachability.append({'locale':locale,'width':width,**assert_last_session_reachable(composer)})
                except Exception:
                    print({'locale':locale,'width':width,'geometry':geometry(composer)},flush=True)
                    composer.screenshot(path=str(out/'failure.png'))
                    raise
                composer.screenshot(path=str(out/f'session-bottom-{locale}-{width}.png'))
        composer.evaluate("async()=>chrome.storage.local.set({uiPreferences:{locale:'zh-CN',theme:'dark',motion:'reduced'}})")
        composer.set_viewport_size({'width':1280,'height':900});composer.reload(wait_until='networkidle')
        row=composer.locator('.composer-session-item[data-session-id="layout-session-1"]')
        row.hover();row.locator('.composer-session-delete').click()
        delete_dialog = composer.locator("#promptdirector-app-dialog")
        expect(delete_dialog).to_contain_text("删除这段对话？")
        delete_dialog.get_by_role("button", name="取消", exact=True).click()
        expect(delete_dialog).to_have_count(0)

        desktop_first = geometry(composer)
        for index in range(1, 30):
            composer.locator(".composer-session-item > button:first-child", has_text=f"布局对话 {index:02d}").click()
        desktop_last = geometry(composer)
        assert_stable(desktop_first, desktop_last)

        composer.set_viewport_size({"width": 390, "height": 844})
        composer.locator("#composer-nav-open").click()
        mobile_first = geometry(composer)
        for index in range(29):
            composer.locator("#composer-nav-open").click() if index else None
            composer.locator(".composer-session-item > button:first-child", has_text=f"布局对话 {index:02d}").click()
        composer.locator("#composer-nav-open").click()
        mobile_last = geometry(composer)
        assert_stable(mobile_first, mobile_last)

        result = {
            "wheelLastRow": reachability,
            "desktopDrift": {
                "nav": desktop_last["nav"]["bottom"] - desktop_first["nav"]["bottom"],
                "input": desktop_last["input"]["bottom"] - desktop_first["input"]["bottom"],
            },
            "mobileDrift": {
                "nav": mobile_last["nav"]["bottom"] - mobile_first["nav"]["bottom"],
                "input": mobile_last["input"]["bottom"] - mobile_first["input"]["bottom"],
            },
            "sessionScroll": mobile_last["sessions"],
        }
        (out/"results.json").write_text(json.dumps(result,ensure_ascii=False,indent=2))
        print(result)


if __name__ == "__main__":
    main()
