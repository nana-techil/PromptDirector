"""Real X DOM extraction, shared capture save and original-file readback in an isolated profile."""
import base64
import json
import struct
import tempfile
import zlib
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from e2e_support import EXTENSION_DIR, extension_session


def png(width, height, color):
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))
    pixels = (b"\0" + bytes(color) * width) * height
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


def main(originals=None):
    images = {"first": (png(680, 380, (40, 80, 120)), png(4096, 2286, (40, 80, 120))),
              "second": (png(900, 506, (120, 80, 40)), png(3840, 2160, (120, 80, 40)))}
    if originals:
        images = {name: (images[name][0], Path(path).read_bytes()) for name, path in originals.items()}
    with tempfile.TemporaryDirectory(prefix="pd-x-originals-extension-") as temp:
        ext = Path(temp)
        for path in EXTENSION_DIR.iterdir():
            if path.name not in ("manifest.json", "background.js"):
                (ext / path.name).symlink_to(path, target_is_directory=path.is_dir())
        manifest = json.loads((EXTENSION_DIR / "manifest.json").read_text())
        manifest["host_permissions"] += ["https://x.com/*", "https://pbs.twimg.com/*"]
        (ext / "manifest.json").write_text(json.dumps(manifest))
        (ext / "background.js").write_text((EXTENSION_DIR / "background.js").read_text()
            + "\nglobalThis.imageTestDispatch=dispatchAgentOperation;\n")
        with extension_session("pd-x-originals-", extension_dir=ext) as run:
            panel = run.open_page("collector.html")
            run.seed_storage(panel, {"entries": [], "capturePermissionOnboarding": {
                "version": 1, "acknowledgedAt": "2026-10-20T00:00:00Z", "clipboardIncluded": False}})
            def media_route(route):
                url = urlparse(route.request.url)
                data = images[url.path.split("/")[-1]][parse_qs(url.query).get("name") == ["orig"]]
                route.fulfill(body=data, content_type="image/jpeg" if data[:2] == b"\xff\xd8" else "image/png",
                              headers={"Access-Control-Allow-Origin": "*"})
            run.context.route("https://pbs.twimg.com/media/**", media_route)
            def page_route(route):
                work = route.request.url
                body = f"""<!doctype html><title>X original photo fixture</title>
                <link rel="canonical" href="{work}">
                <article data-testid="tweet"><div data-testid="User-Name"><a href="/artist">Artist</a></div>
                <a href="{work}"><time>Today</time></a>
                <div data-testid="tweetText">Character reference with exact original photos.</div>
                <a href="{work}/photo/1"><img width="340" height="190"
                src="https://pbs.twimg.com/media/first?format=png&name=small"></a>
                <a href="{work}/photo/2"><img width="450" height="253"
                src="https://pbs.twimg.com/media/second?format=png&name=900x900"></a></article>"""
                route.fulfill(body=body, content_type="text/html")
            run.context.route("https://x.com/**", page_route)
            source = run.context.new_page()
            source.goto("https://x.com/artist/status/123")
            worker = run.context.service_workers[0]
            # Replace only the remote CDN transport; production download validation, save and storage run unchanged.
            worker.evaluate("""images => {
              const networkFetch = fetch; globalThis.imageRequests = []; globalThis.originalFailure = false;
              globalThis.fetch = async (input, options) => {
                const url = new URL(typeof input === 'string' ? input : input.url);
                if (url.hostname !== 'pbs.twimg.com') return networkFetch(input, options);
                imageRequests.push(url.href);
                const original = url.searchParams.get('name') === 'orig';
                if (original && originalFailure) return new Response('unavailable', {status:403});
                const data = images[url.pathname.split('/').pop()][original ? 1 : 0];
                const bytes=Uint8Array.from(atob(data), c => c.charCodeAt(0));
                return new Response(bytes, {headers:{'content-type':bytes[0]===255 ? 'image/jpeg' : 'image/png'}});
              };
            }""", {key: [base64.b64encode(data).decode() for data in values] for key, values in images.items()})
            def call(name, value):
                return worker.evaluate("([name,value])=>imageTestDispatch(name,value)", [name, value])
            def done(name, value):
                result = call(name, value)
                while result["state"] in ("queued", "running"):
                    result = call("get_task", {"requestId": value["requestId"], "waitMs": 15000})
                assert result["state"] == "completed", result
                return result["result"]
            def capture(identifier, fail=False):
                worker.evaluate("(fail)=>{originalFailure=fail;imageRequests=[]}", fail)
                work = f"https://x.com/artist/status/{identifier}"
                source.goto(work)
                tab_id = panel.evaluate("async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id", work)
                prepared = done("prepare_capture", {"requestId": f"preview-{identifier}", "tabId": tab_id})
                photo_case = next(c for c in prepared["candidates"] if c["canonicalUrl"] == work)
                assert len(photo_case["media"]) == 2, photo_case
                assert all("name=orig" in m["url"] for m in photo_case["media"]), photo_case
                selected = done("update_capture", {"requestId": f"select-{identifier}",
                    "captureId": prepared["captureId"], "expectedRevision": prepared["revision"],
                    "selections": [{"candidateId": photo_case["id"], "includeText": True,
                                    "selectedMediaIds": [m["id"] for m in photo_case["media"]]}]})
                # Denied session permission must remain denied; public smaller photos still remain usable.
                if fail:
                    worker.evaluate("""async captureId => {
                      const key='agentCapture:'+captureId;
                      const capture=(await chrome.storage.local.get(key))[key];
                      capture.batch.sessionMediaAllowed=false;
                      await chrome.storage.local.set({[key]:capture});
                    }""", prepared["captureId"])
                receipt = done("save_capture", {"requestId": f"save-{identifier}",
                    "captureId": prepared["captureId"], "expectedRevision": selected["revision"]})
                result = receipt["results"][0]
                assert result["status"] == ("partial" if fail else "saved"), receipt
                if fail:
                    assert len([w for w in result["warnings"] if "较小图片" in w]) == 2, result
                state = panel.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
                entry = next(e for e in state["entries"] if e["id"] == result["entryId"])
                assert len(entry["mediaAssets"]) == 2, entry
                for asset in entry["mediaAssets"]:
                    name = urlparse(asset["sourceUrl"]).path.split("/")[-1]
                    expected = images[name][0 if fail else 1]
                    actual = panel.evaluate("""async id => {
                      const blob=await (await import('./media-store.js')).getMediaBlob(id);
                      const bitmap=await createImageBitmap(blob);
                      const size=[bitmap.width,bitmap.height];bitmap.close();
                      return {bytes:Array.from(new Uint8Array(await blob.arrayBuffer())),size};
                    }""", asset["id"])
                    assert bytes(actual["bytes"]) == expected
                    assert actual["size"] == [asset["width"], asset["height"]], asset
                    assert ("name=orig" in asset["sourceUrl"]) != fail
                return entry["id"], worker.evaluate("()=>imageRequests")
            saved_id, requests = capture("123")
            assert len(requests) == 2 and all("name=orig" in u for u in requests), requests
            fallback_id, _ = capture("124", fail=True)
            run.restart_browser(extension_dir=ext)
            panel = run.open_page("collector.html")
            entries = panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
            assert {e["id"] for e in entries} == {saved_id, fallback_id}
            restored = next(e for e in entries if e["id"] == saved_id)
            assert [(m["width"], m["height"]) for m in restored["mediaAssets"]] == [(4096, 2286), (3840, 2160)]
            print(json.dumps({"originalBytesAndDimensions": True, "smallerImageReportsPartial": True,
                              "restartReadback": True, "realLibraryWrites": 0, "paidCalls": 0}))


if __name__ == "__main__":
    main()
