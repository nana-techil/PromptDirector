import test from 'node:test';
import assert from 'node:assert/strict';
import { videoComponentInstallRequest } from '../extension/video-component-config.js';

for (const locale of ['zh-CN', 'en']) {
  test(`the ${locale} Agent request uses the configured public guide and asks for real verification, without pinning a stale release`, () => {
    const request = videoComponentInstallRequest(locale, 'https://github.com/example/product/');
    assert(request.includes('https://github.com/example/product/blob/main/tools/video-component/INSTALL-AGENT.md'));
    assert(!request.includes('video-v0.1.0'));
    assert(request.includes('Python'));
    assert(request.includes('Chrome'));
    assert.match(request, /未验证|unverified/u);
    assert.match(request, /本机|computer/u);
  });
}

test('the installation request does not send users to an insecure or non-GitHub guide', () => {
  for (const homepage of ['http://github.com/example/product', 'https://example.com/product']) {
    assert.throws(() => videoComponentInstallRequest('zh-CN', homepage), /下载地址/u);
  }
});
