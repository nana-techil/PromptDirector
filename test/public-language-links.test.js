import test from 'node:test';
import assert from 'node:assert/strict';
import { curatedPublicUrl, curatedSubmissionUrl, CURATED_CATALOG_URL } from '../extension/curated-config.js';
import { agentConnectionRequest } from '../extension/agent-onboarding.js';
test('shared pack links carry the selected language and original pack identity', () => {
  for (const locale of ['en','zh-CN']) {
    const url = new URL(curatedPublicUrl(locale, '', {pack:'featured:vol-1'}));
    assert.equal(url.searchParams.get('pack'),'featured:vol-1');
    assert.equal(url.searchParams.get('lang'),locale);
    assert.equal(url.pathname.endsWith('/en/'),locale === 'en');
  }
  assert.equal(new URL(CURATED_CATALOG_URL).pathname.endsWith('/public-catalog.json'), true);
});
test('English case and Skill forms use the same submission kinds with localized entry points', () => {
  assert.equal(new URL(curatedSubmissionUrl('en')).searchParams.get('template'),'curated-submission-en.yml');
  assert.equal(new URL(curatedSubmissionUrl('en','skills')).searchParams.get('template'),'curated-skill-submission-en.yml');
  assert.equal(new URL(curatedSubmissionUrl('zh-CN')).searchParams.get('template'),'curated-submission.yml');
});
test('connection request gives an English guide without changing the library identity', () => {
  const id='12345678-1234-1234-1234-123456789abc';
  const english=agentConnectionRequest(id,'en','https://github.com/wchao6891/PromptDirector');
  assert.ok(english.includes('connector/INSTALL.en.md')); assert.ok(english.includes(id));
  assert.ok(agentConnectionRequest(id,'zh-CN','https://github.com/wchao6891/PromptDirector').includes('connector/INSTALL.md'));
});

test('About help actions have English labels as well as localized destinations', async () => {
  const { translateForLocale } = await import('../extension/i18n.js');
  for (const [zh,en] of [['打开','Open'],['使用指南','User guide'],['帮助与反馈','Help and feedback'],['隐私政策','Privacy policy']]) {
    assert.equal(translateForLocale(zh,'en'),en);
  }
});
