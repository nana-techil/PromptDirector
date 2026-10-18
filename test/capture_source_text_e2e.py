"""Read the actual source extractor on HTTP pages, without an extension/profile.

Paragraph boundaries must survive source-backed saves; code whitespace and the
exclusion of input/draft/capture-UI content must remain intact.
"""
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / 'extension'), **kwargs)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, channel=os.environ.get('PROMPTDIRECTOR_E2E_CHANNEL', 'chromium'))
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_port}/agent-capture-preview.js')
            page.evaluate("""async () => {
              const {readCaptureSource} = await import('/agent-capture-preview.js');
              window.readSource = readCaptureSource;
            }""")
            examples = [
                ('paragraph prompt', '<div style="white-space:pre-wrap"><p>Complete scene.</p><p>HEX VALUES: ["#123456"]</p></div>', 'Complete scene.\n\nHEX VALUES: ["#123456"]'),
                ('line breaks and inline words', '<div>First <strong>bold</strong> word.<br>Second line.</div>', 'First bold word.\nSecond line.'),
                ('block layout', '<div><div>First block</div><div>Second block</div></div>', 'First block\nSecond block'),
                ('formatted HTML', '<section>\n  <p>First <em>exact</em> paragraph.</p>\n  <p>Second paragraph.</p>\n</section>', 'First exact paragraph.\n\nSecond paragraph.'),
                ('code original', '<pre>  line one\n\n\n\tline two\n</pre>', '  line one\n\n\n\tline two\n'),
                ('nested code original', '<section><p>Original code:</p><pre>  one\n\n\n\ttwo</pre><p>After code.</p></section>', 'Original code:\n\n  one\n\n\n\ttwo\n\nAfter code.'),
                ('code boundary preserves indentation and trailing spaces', '<div>Before<pre>  one  \n\ttwo  </pre>After</div>', 'Before\n  one  \n\ttwo  \nAfter'),
                ('private controls excluded', '<div><p>Saved paragraph.</p><textarea>PRIVATE_DRAFT</textarea><input value="PRIVATE_INPUT"><script>PRIVATE_SCRIPT</script><style>PRIVATE_STYLE</style><div data-promptdirector-capture-ui>PRIVATE_CAPTURE_UI</div><p>Next paragraph.</p></div>', 'Saved paragraph.\n\nNext paragraph.'),
            ]
            replay = os.environ.get('PD_SOURCE_REPLAY_JSON')
            if replay:
                actual = json.loads(Path(replay).read_text())
                examples.append(('actual webpage prompt replay', actual['html'], actual['text']))
            for name, html, expected in examples:
                result = page.evaluate("""html => {
                  document.body.innerHTML = '<main id="fixture">' + html + '</main>';
                  const before = document.body.innerHTML;
                  const read = window.readSource('#fixture > :first-child');
                  return {read, unchanged:before === document.body.innerHTML};
                }""", html)
                assert result['read']['ok'], (name, result)
                assert result['read']['text'] == expected, (name, result['read']['text'], expected)
                assert result['unchanged'], 'Reading must not alter the user webpage or draft'
                print(f'PASS: {name} ({len(expected)} characters)')
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
