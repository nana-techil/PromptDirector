"""Access interstitials must never become saved references; embedded widgets are valid content."""
from e2e_support import extension_session

with extension_session('pd-capture-access-gate-') as run:
    panel = run.open_page('collector.html')
    source = panel.evaluate("async()=>String((await import('./page-capture.js')).collectPageCaptureSnapshot)")
    page = run.context.new_page()
    run.context.route('https://capture-fixture.example/**', lambda route: route.fulfill(
        body='' if route.request.url.endswith('.js') else '<!doctype html><title>Creative reference</title><main><h1>Gym cinematic reference</h1><p>Complete original camera and lighting directions for the training scene.</p></main>',
        content_type='application/javascript' if route.request.url.endswith('.js') else 'text/html'))
    page.goto('https://capture-fixture.example/work')
    page.evaluate("()=>{const script=document.createElement('script');script.src='/cdn-cgi/challenge-platform/widget.js';document.head.append(script);}")
    def capture():
        return page.evaluate('async source=>await(0,eval)(`(${source})`)({serializeErrors:true})', source)
    assert capture()['candidates'], 'A page with an embedded widget must remain capturable'
    page.evaluate("()=>{const script=document.createElement('script');script.textContent='window._cf_chl_opt={};';document.head.append(script);document.body.innerHTML='<main>Checking browser access</main>';}")
    blocked = capture()
    assert blocked['captureError']['code'] == 'CAPTURE_ACCESS_REQUIRED', blocked
    assert 'candidates' not in blocked, 'Verification text must not become a complete case'
    print({'accessGateRejected': True, 'embeddedWidgetPreserved': True})
