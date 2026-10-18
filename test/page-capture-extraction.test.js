import test from "node:test";
import assert from "node:assert/strict";
import { load } from "cheerio";
import { PAGE_CAPTURE_ADAPTERS, collectPageCaptureSnapshot } from "../extension/page-capture.js";

// Execute the serialized Chrome injection, including its real routing decisions.
const injected = (0, eval)(`(${collectPageCaptureSnapshot.toString()})`);

async function withPage(run, { url = "https://example.com/article", article = null } = {}) {
  const keys = ["window", "document", "location", "chrome", "Readability", "Element", "HTMLCanvasElement"];
  const original = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = { clone: 0, parse: 0 };
  const body = { innerText: "Visible fallback text remains available when article extraction cannot run.",
    scrollHeight: 800, querySelector: () => null, querySelectorAll: () => [] };
  Object.assign(globalThis, {
    window: { scrollX: 0, scrollY: 0, scrollTo: () => {} },
    document: { title: "Capture fixture", body, documentElement: { scrollHeight: 800 }, baseURI: url,
      querySelector: () => null, querySelectorAll: () => [],
      cloneNode: () => { calls.clone += 1; return {}; } },
    location: new URL(url), chrome: undefined,
    Readability: class { parse() { calls.parse += 1; return article; } }
  });
  try { await run({ calls, body }); }
  finally {
    for (const key of keys) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else delete globalThis[key];
    }
  }
}

test("structured detail captures preserve their exact works without cloning or parsing the page shell", async () => {
  for (const adapter of ["jimeng", "youtube", "bilibili", "douyin", "midjourney", "pinterest", "higgsfield"]) {
    await withPage(async ({ calls }) => {
      const candidate = { id: `${adapter}:work`, title: "Original work", contentText: "Full original prompt",
        media: [{ id: "original", kind: "video", url: "https://example.com/original.mp4" }],
        supplements: [{ kind: "text", text: "Original supplement" }] };
      for (const completeness of ["complete", "partial"]) {
        const result = await injected({ adapters: PAGE_CAPTURE_ADAPTERS,
          siteData: { adapter, captureScope: "asset", pageKind: "detail", completeness, candidates: [candidate] } });
        assert.deepEqual(result.candidates, [candidate], adapter);
        assert.equal(result.adapter, adapter);
        assert.equal(result.siteStatus, completeness, adapter);
        assert.deepEqual(calls, { clone: 0, parse: 0 }, adapter);
      }
    }, { url: `https://${PAGE_CAPTURE_ADAPTERS.find(item => item.id === adapter).hosts[0]}/work` });
  }
});

test("structured feeds retain every prepared candidate without a discarded article extraction", async () => {
  await withPage(async ({ calls }) => {
    const candidates = [{ id: "one", contentText: "First work" }, { id: "two", contentText: "Second work" }];
    const result = await injected({ adapters: PAGE_CAPTURE_ADAPTERS,
      siteData: { adapter: "jimeng", pageKind: "feed", completeness: "partial", candidates } });
    assert.deepEqual(result.candidates, candidates);
    assert.equal(result.siteStatus, "partial");
    assert.deepEqual(calls, { clone: 0, parse: 0 });
  });
});

test("generic capture still extracts the complete article once, including its final paragraph", async () => {
  const text = "Complete article introduction.\n\n" + "Original article paragraph. ".repeat(40).trim() + "\n\nFinal source paragraph.";
  await withPage(async ({ calls }) => {
    const result = await injected({ adapters: PAGE_CAPTURE_ADAPTERS });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].contentText, text);
    assert.equal(result.candidates[0].pageType, "article");
    assert.deepEqual(calls, { clone: 1, parse: 1 });
  }, { article: { title: "Full article", textContent: text, length: text.length, content: "" } });
});

test("specialized supplemental extraction and missing article fallback remain available", async () => {
  await withPage(async ({ calls, body }) => {
    const siteData = { adapter: "higgsfield", pageKind: "detail", pageType: "artwork", title: "Project",
      contentText: "Complete project brief", media: [], completeness: "complete" };
    const project = await injected({ adapters: PAGE_CAPTURE_ADAPTERS, siteData });
    assert.equal(project.candidates[0].contentText, siteData.contentText);
    const fallback = await injected({ adapters: PAGE_CAPTURE_ADAPTERS, siteData: { ...siteData, contentText: "" } });
    assert.equal(fallback.candidates[0].contentText, body.innerText);
    assert.deepEqual(calls, { clone: 2, parse: 2 });
  }, { url: "https://higgsfield.ai/projects/fixture" });
});

test("Liblib model detail scope preserves its title, full description and nested media without author or recommended cards", () => {
  const $ = load(`<main><div class="flex gap-4"><div class="flex-1 min-w-0">
    <div class="ModelInfoHead_modelInfoHead__fixture"><span class="ModelInfoHead_title__fixture">Original model</span></div>
    <div class="model-info-left"><div class="ModelVersion_modelVersion__fixture"><img src="https://liblib.cloud/work.png?x-oss-process=image/resize,w_1000" /></div>
      <div class="ModelDescription_desc__fixture"><p>Full description and original prompt.</p><video src="https://liblib.cloud/nested.mp4"></video><p>Final paragraph.</p></div></div>
    </div><aside><img src="https://liblib.cloud/avatar.png" /></aside></div>
    <section><h3>讨论</h3><img src="https://liblib.cloud/work.png?x-oss-process=image/resize,w_568" /><img src="https://liblib.cloud/recommendation.png" /></section></main>`);
  const adapter = PAGE_CAPTURE_ADAPTERS.find(item => item.id === "liblibai");
  const root = $(adapter.fields.content[0]);
  assert.equal(root.length, 1);
  assert.equal(root.find(adapter.fields.title[0]).text(), "Original model");
  assert.match(root.text(), /Final paragraph/u);
  assert.doesNotMatch(root.text(), /讨论/u);
  assert.deepEqual(root.find("img,video").map((_, node) => $(node).attr("src")).get(), [
    "https://liblib.cloud/work.png?x-oss-process=image/resize,w_1000", "https://liblib.cloud/nested.mp4"
  ]);
  assert.equal(adapter.fields.contentPageType, "artwork");
});

test("missing Liblib model body cannot become a discussion case, while image and feed pages keep whole-page fallback", async () => {
  await withPage(async ({ calls }) => {
    const result = await injected({ adapters: PAGE_CAPTURE_ADAPTERS });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.siteStatus, "partial");
    assert.deepEqual(calls, { clone: 0, parse: 0 });
  }, { url: "https://www.liblib.art/modelinfo/model-id" });
  for (const path of ["/imageinfo/work-id", "/feed"]) {
    await withPage(async ({ body }) => {
      const result = await injected({ adapters: PAGE_CAPTURE_ADAPTERS });
      assert.equal(result.candidates[0].contentText, body.innerText);
    }, { url: `https://www.liblib.art${path}` });
  }
});

test("Behance detail scope excludes outside projects while preserving grid images and nested videos", () => {
  const $ = load(`<main><div id="project-modules"><section class="project-module-container"><div class="project-module-text">First paragraph.</div></section>
    <section class="project-module-container"><div class="project-module grid--main"><picture><img src="https://example.com/work.jpg" /></picture></div></section>
    <section class="project-module-container"><video src="https://example.com/film.mp4"></video><p>Final project paragraph.</p></section></div>
    <aside><img src="https://example.com/other-project.jpg" /></aside></main>`);
  const adapter = PAGE_CAPTURE_ADAPTERS.find(item => item.id === "behance");
  const root = $(adapter.fields.content[0]);
  assert.equal(root.length, 1);
  assert.deepEqual(root.find("img,video").map((_, node) => $(node).attr("src")).get(), ["https://example.com/work.jpg", "https://example.com/film.mp4"]);
  assert.match(root.text(), /Final project paragraph/u);
});

test("scoped artwork snapshot drops listing covers but keeps actual image variants, nested video and complete source text", async () => {
  await withPage(async () => {
    class Element {}
    globalThis.Element = Element;
    globalThis.HTMLCanvasElement = class extends Element {};
    const imageUrl = "https://example.com/project-display.jpg";
    const originalUrl = "https://example.com/project-original.jpg";
    const videoUrl = "https://example.com/nested.mp4";
    const makeMedia = (tag, src) => Object.assign(new Element(), {
      localName: tag, tagName: tag.toUpperCase(), src, currentSrc: src, srcset: "", childNodes: [], complete: false,
      width: 800, height: 600, naturalWidth: 800, naturalHeight: 600,
      matches: selector => selector.split(",").includes(tag), closest: () => null, hasAttribute: () => false,
      getAttribute: name => name === "src" ? src : "", querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, bottom: 600, width: 800, height: 600 })
    });
    const nodes = [makeMedia("img", imageUrl), makeMedia("video", videoUrl)];
    const text = "Opening paragraph.\n\nComplete original description.\n\nFinal project paragraph.";
    const root = { innerText: text, textContent: text, innerHTML: "", childNodes: nodes,
      querySelector: () => null, querySelectorAll: selector => selector === "img" ? [nodes[0]] : selector === "img,video" ? nodes : [],
      cloneNode: () => root };
    document.querySelector = selector => selector === "#project-modules" ? root : null;
    const siteData = { adapter: "behance", pageKind: "detail", title: "Actual project", contentText: "Short metadata description", media: [
      { id: "cover", kind: "image", url: "https://example.com/listing-cover.jpg" },
      { id: "original", kind: "image", url: originalUrl, variants: [{ url: imageUrl }] }
    ] };
    const result = await injected({ adapters: PAGE_CAPTURE_ADAPTERS, siteData });
    assert.equal(result.captureError, undefined);
    assert.equal(result.candidates[0].title, "Actual project");
    assert.equal(result.candidates[0].contentText, text);
    assert.equal(result.candidates[0].pageType, "artwork");
    assert.deepEqual(result.candidates[0].media.map(item => item.url), [originalUrl, videoUrl]);
  }, { url: "https://www.behance.net/gallery/123/project" });
});

test("scoped article normalization never promotes hidden gallery templates into source paragraphs, but retains visible code examples", () => {
  // Run the actual injection helper against a parsed DOM. The live failure was
  // a div containing a script[type=text/html], promoted into <p><script>...</p>.
  const $ = load(`<div id="project-modules"><div>Opening source paragraph.</div>
    <div><script type="text/html" class="js-lightbox-overlay-slide"><div class="other-projects">RECOMMENDED_TEMPLATE_ONLY</div></script></div>
    <div><style>.INTERNAL_STYLE_ONLY { display:none }</style></div>
    <template><p>INACTIVE_TEMPLATE_ONLY</p></template><noscript>DISABLED_SCRIPT_ONLY</noscript>
    <pre><code>&lt;script&gt;visibleCodeExample()&lt;/script&gt;</code></pre>
    <div>Final source paragraph.</div><img src="https://example.com/original.jpg" /><video src="https://example.com/original.mp4"></video></div>`);
  class ParsedNode {
    constructor(node) { this.node = node; }
    get innerHTML() { return $(this.node).html(); }
    set innerHTML(value) { $(this.node).html(value); }
    get textContent() { return $(this.node).text(); }
    matches(selector) { return $(this.node).is(selector); }
    querySelector(selector) { const node = $(this.node).find(selector)[0]; return node ? new ParsedNode(node) : null; }
    querySelectorAll(selector) { return $(this.node).find(selector).toArray().map(node => new ParsedNode(node)); }
    cloneNode() { return new ParsedNode($(this.node).clone()[0]); }
    replaceWith(node) { $(this.node).replaceWith(node.node); }
    remove() { $(this.node).remove(); }
  }
  const source = collectPageCaptureSnapshot.toString();
  const helper = source.slice(source.indexOf("function contentRootHtml("), source.indexOf("function collectTextBlocks("));
  const normalize = new Function("document", "renderedElements", "genericCapture", "cleanBlockText", `return (${helper.trim()});`)(
    { createElement: tag => new ParsedNode($(`<${tag}></${tag}>`)[0]) }, () => [], false, value => String(value || "").trim());
  const html = normalize(new ParsedNode($("#project-modules")[0]));
  const result = load(html);
  assert.equal(result("script,style,template,noscript").length, 0);
  assert.doesNotMatch(result.root().text(), /RECOMMENDED_TEMPLATE_ONLY|INTERNAL_STYLE_ONLY|INACTIVE_TEMPLATE_ONLY|DISABLED_SCRIPT_ONLY/u);
  assert.match(result.root().text(), /Opening source paragraph/u);
  assert.match(result.root().text(), /Final source paragraph/u);
  assert.equal(result("pre code").text(), "<script>visibleCodeExample()</script>");
  assert.equal(result("img,video").length, 2);
});

test("loaded decorative icons do not report missing originals, while unloaded and broken article images remain pending", async () => {
  const source = collectPageCaptureSnapshot.toString();
  const helper = source.slice(source.indexOf("async function prepareArticleImages("), source.indexOf("async function prepareContentMedia("));
  const prepare = new Function("collectImageVariants", "isExcludedMedia", "cancelled", "window", "waitForScrollRender", "waitForVisibleMedia", `return (${helper.trim()});`)(
    image => image.source ? [{ url: image.source }] : [], image => image.decorative, false,
    { scrollX: 0, scrollY: 0, scrollTo() {} }, async () => {}, async () => {});
  let attempted = 0;
  const image = properties => ({ complete: false, naturalWidth: 0, naturalHeight: 0, scrollIntoView() { attempted += 1; }, ...properties });
  const originals = Array.from({ length: 9 }, () => image({ source: "https://example.com/work.png" }));
  const icons = Array.from({ length: 7 }, () => image({ complete: true, naturalWidth: 24, naturalHeight: 24, decorative: true }));
  const root = { querySelectorAll: () => [...originals, ...icons] };
  assert.equal(await prepare(root), 0);
  assert.equal(attempted, 0, "Decorative icons must not trigger repeated scroll/loading work");
  const unloaded = image({ decorative: true });
  const broken = image({ complete: true, decorative: true });
  const realMissingSource = image({ complete: true, naturalWidth: 800, naturalHeight: 600 });
  root.querySelectorAll = () => [...originals, ...icons, unloaded, broken, realMissingSource];
  assert.equal(await prepare(root), 3, "Real missing sources remain explicit instead of becoming false success");
  assert.equal(attempted, 3);
});
