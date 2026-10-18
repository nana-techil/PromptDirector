import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoComponentSetup, VIDEO_SETUP_KEY, VIDEO_SETUP_ALARM } from '../extension/video-component-setup.js';
import { videoComponentDownload } from '../extension/video-component-config.js';
import { operationBudget } from '../extension/resource-policy.js';

function fixture(initial = {}) {
  const data = { [VIDEO_SETUP_KEY]: initial }, scheduled = [], notices = [], urls = [], alarms = new Map();
  let ready = false, resumed = 0, downloads = 0, exists = true;
  let download = { state: 'in_progress', bytesReceived: 100, totalBytes: 1000 };
  const storage = { async get(key) { return structuredClone({ [key]: data[key] }); }, async set(values) { Object.assign(data, structuredClone(values)); } };
  const options = { storage, inspect: async () => { if (!ready) throw new Error('host missing'); return { available: true }; },
    platform: async () => ({ os: 'mac' }), homepage: 'https://github.com/example/product',
    downloads: { async download({ url }) { downloads++; urls.push(url); return 7; }, async search() { return [download]; } },
    fetchImpl: async () => ({ ok: exists, status: exists ? 200 : 404 }),
    alarms: { async create(name, value) { alarms.set(name, value); }, async clear(name) { return alarms.delete(name); } },
    resume: async () => { resumed++; }, notify: state => notices.push(state), now: () => 1000,
    schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel: () => {} };
  return { options, setup: createVideoComponentSetup(options), data, scheduled, notices, urls, alarms,
    get resumed() { return resumed; }, get downloads() { return downloads; },
    ready() { ready = true; }, absent() { exists = false; }, complete() { download = { state: 'complete' }; }, interrupt() { download = { state: 'interrupted' }; }, review() { download = { state: 'in_progress', danger: 'uncommon' }; } };
}

test('both supported systems receive the free source installer; unsupported systems are not offered an unusable package', () => {
  assert.match(videoComponentDownload('mac', 'https://github.com/a/b'), /PromptDirector-Video-Source\.zip$/u);
  assert.equal(videoComponentDownload('win', 'https://github.com/a/b'), videoComponentDownload('mac', 'https://github.com/a/b'));
  assert.throws(() => videoComponentDownload('linux', 'https://github.com/a/b'), /Windows/u);
  assert.throws(() => videoComponentDownload('mac', 'http://malicious.test'), /下载地址/u);
});

test('one explicit setup downloads once, reports real bytes, then resumes the pending save only after native readiness', async () => {
  const f = fixture();
  assert.equal(f.scheduled.length, 0, 'no perpetual startup checks');
  assert.equal((await f.setup.start()).phase, 'downloading');
  assert.equal(f.downloads, 1);
  await f.setup.start(); assert.equal(f.downloads, 1, 'reopening setup cannot duplicate downloads');
  assert.equal((await f.setup.check()).bytesReceived, 100);
  f.complete(); assert.equal((await f.setup.check()).phase, 'installing');
  assert.equal(f.resumed, 0, 'a downloaded file is not a successful installation');
  f.ready(); assert.equal((await f.setup.check()).phase, 'ready'); assert.equal(f.resumed, 1);
  await f.setup.check(); assert.equal(f.resumed, 1, 'completion cannot replay a successful save');
});

test('closing and reopening the sidebar recovers the durable installation and resumes the same task', async () => {
  const f = fixture(); await f.setup.start(); await f.setup.stop(); f.complete();
  const reopened = createVideoComponentSetup(f.options);
  assert.equal((await reopened.check()).phase, 'installing');
  f.ready(); await reopened.check(); assert.equal(f.resumed, 1); assert.equal(f.downloads, 1);
});

test('an unpublished or interrupted installer is an actionable failure without a broken download or false success', async () => {
  const absent = fixture(); absent.absent();
  assert.equal((await absent.setup.start()).phase, 'failed'); assert.equal(absent.downloads, 0); assert.equal(absent.resumed, 0);
  assert.match(absent.data[VIDEO_SETUP_KEY].message, /尚未发布/u);
  const interrupted = fixture(); await interrupted.setup.start(); interrupted.interrupt();
  assert.equal((await interrupted.setup.check()).phase, 'failed'); assert.equal(interrupted.resumed, 0);
});

test('an already installed component needs no new download and continues the pending capture', async () => {
  const f = fixture(); f.ready(); assert.equal((await f.setup.start()).phase, 'ready');
  assert.equal(f.downloads, 0); assert.equal(f.resumed, 1);
});

test('browser download review needs a user decision and a removed installer can be downloaded again explicitly', async () => {
  const f = fixture(); await f.setup.start(); f.review();
  assert.equal((await f.setup.check()).phase, 'review'); assert.equal(f.resumed, 0);
  f.complete(); assert.equal((await f.setup.check()).phase, 'installing');
  assert.equal((await f.setup.start({ restart: true })).phase, 'downloading');
  assert.equal(f.downloads, 2, 'only the explicit retry starts a second download');
});

test('clicking setup from settings and the sidebar at the same time starts one installer download', async () => {
  const f = fixture();
  await Promise.all([f.setup.start(), f.setup.start()]);
  assert.equal(f.downloads, 1);
});

test('native inspection backs off during an unfinished installation and explicit continue checks immediately', async () => {
  const f = fixture(); const delays = []; let probes = 0;
  f.options.schedule = (_callback, delay) => { delays.push(delay); return delays.length; };
  f.options.inspect = async () => { probes++; return { available: false }; };
  const setup = createVideoComponentSetup(f.options);
  await setup.start(); f.complete();
  for (let i = 0; i < 7; i++) await setup.check();
  assert(delays.at(-1) > delays[0]);
  assert(delays.at(-1) <= 60_000);
  const before = probes; await setup.continue(); assert.equal(probes, before + 1);
});

test('a one-shot installation alarm wakes a new worker without reopening the sidebar or redownloading', async () => {
  const f = fixture(); await f.setup.start(); f.complete();
  assert(f.alarms.has(VIDEO_SETUP_ALARM), 'the explicit installation must survive loss of its memory timer');
  // Chrome discards the worker and all its scheduled callbacks. Only the
  // durable state and named alarm are available to this fresh instance.
  f.scheduled.length = 0;
  const restarted = createVideoComponentSetup(f.options);
  await restarted.check();
  assert.equal((await restarted.get()).phase, 'installing');
  f.scheduled.length = 0; f.ready();
  const awakened = createVideoComponentSetup(f.options);
  await Promise.all([awakened.check(), awakened.restore()]);
  assert.equal(f.resumed, 1); assert.equal(f.downloads, 1);
  assert.equal(f.alarms.has(VIDEO_SETUP_ALARM), false, 'ready must retire the wakeup');
  await createVideoComponentSetup(f.options).restore();
  assert.equal(f.resumed, 1, 'worker restoration must not repeat a completed save');
});

test('restoring an active installation re-arms a lost alarm with its existing backoff and deadline', async () => {
  const f = fixture(); await f.setup.start(); f.complete();
  for (let n = 0; n < 7; n++) await f.setup.check();
  f.alarms.clear(); f.scheduled.length = 0;
  const restarted = createVideoComponentSetup(f.options);
  await restarted.restore();
  assert.equal(f.alarms.get(VIDEO_SETUP_ALARM).when - f.options.now(), 60_000);
  assert.equal((await restarted.get()).startedAt, 1000, 'worker restart cannot renew the user operation budget');
  assert.equal(f.downloads, 1);
  f.options.now = () => 1000 + operationBudget().maxDurationMs;
  let probes = 0; f.options.inspect = async () => { probes++; return { available: true }; };
  await createVideoComponentSetup(f.options).restore();
  assert.equal((await restarted.get()).phase, 'paused');
  assert.equal(probes, 0, 'expired installation must wait for an explicit Continue');
  assert.equal(f.resumed, 0); assert.equal(f.alarms.size, 0);
});

test('worker restoration never polls an idle or terminal setup, and interrupted downloads clear their wakeup', async () => {
  for (const phase of ['idle', 'ready', 'failed', 'paused']) {
    const f = fixture({ phase }); let probes = 0;
    f.options.inspect = async () => { probes++; return { available: false }; };
    f.alarms.set(VIDEO_SETUP_ALARM, { when: 1000 });
    await createVideoComponentSetup(f.options).restore();
    assert.equal(probes, 0); assert.equal(f.scheduled.length, 0); assert.equal(f.alarms.size, 0);
  }
  const f = fixture(); await f.setup.start(); f.interrupt();
  assert.equal((await createVideoComponentSetup(f.options).check()).phase, 'failed');
  assert.equal(f.alarms.size, 0); assert.equal(f.resumed, 0);
});
