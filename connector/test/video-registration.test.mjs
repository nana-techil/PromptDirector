import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerVideoViews, windowsVideoRegistry } from '../register-video.mjs';

const views = ['Registry32', 'Registry64'];
const present = value => ({ exists: true, hasValue: true, value, kind: 'String' });
function registryFixture(initial, { failAfterWrite = false, externalWrite = false, rollbackFailure = false } = {}) {
  const state = structuredClone(initial);
  const failure = new Error('Second registry view failed');
  return { state, failure, registry: {
    async snapshot() { return structuredClone(state); },
    async write(view, value) {
      const index = views.indexOf(view);
      if (index === 0 || failAfterWrite) state[index] = present(value);
      if (index === 1) {
        if (externalWrite) state[0] = present('later-external-installation');
        throw failure;
      }
    },
    async restoreIfCurrent(view, expected, previous) {
      const index = views.indexOf(view);
      if (rollbackFailure) throw new Error('Restoration was blocked');
      if (state[index].value === expected) state[index] = structuredClone(previous);
    }
  } };
}

for (const failAfterWrite of [false, true]) {
  test(`a failed second view ${failAfterWrite ? 'readback' : 'write'} restores the previous host and the absent-view state`, async () => {
    const initial = [present('previous-component'), { exists: false }];
    const { state, failure, registry } = registryFixture(initial, { failAfterWrite });
    await assert.rejects(registerVideoViews('new-component', registry), error => error === failure);
    assert.deepEqual(state, initial);
  });
}

test('failure rollback never overwrites a registration changed by a later external writer', async () => {
  const initial = [present('previous-component'), present('previous-component-64')];
  const { state, failure, registry } = registryFixture(initial, { failAfterWrite: true, externalWrite: true });
  await assert.rejects(registerVideoViews('new-component', registry), error => error === failure);
  assert.deepEqual(state, [present('later-external-installation'), initial[1]]);
});

test('a rollback failure retains the original installation error and reports the restoration failures separately', async () => {
  const { failure, registry } = registryFixture([{ exists: false }, { exists: false }], { rollbackFailure: true });
  await assert.rejects(registerVideoViews('new-component', registry), error => error === failure);
  assert.deepEqual(failure.rollbackErrors, ['Restoration was blocked', 'Restoration was blocked']);
  assert.equal(failure.message, 'Second registry view failed');
});

test('Windows uses the real registry to restore a failed second view without clobbering a later writer', { skip: process.platform !== 'win32' }, async () => {
  const keyName = `Software\\PromptDirectorSourceTests\\${randomUUID()}`;
  const old = windowsVideoRegistry({ registration: 'previous-component.json' }, { keyName });
  const next = windowsVideoRegistry({ registration: 'new-component.json' }, { keyName });
  const external = windowsVideoRegistry({ registration: 'later-component.json' }, { keyName });
  try {
    await old.write('Registry32');
    const before = await next.snapshot();
    for (const laterWriter of [false, true]) {
      const failure = new Error('Injected second-view readback failure');
      let afterExternal;
      await assert.rejects(registerVideoViews('new-component.json', { ...next,
        async write(view) {
          await next.write(view);
          if (view === 'Registry64') {
            if (laterWriter) {
              await external.write('Registry32');
              // HKCU Software may be shared by both views on this Windows.
              afterExternal = await next.snapshot();
            }
            throw failure;
          }
        }
      }), error => error === failure);
      const actual = await next.snapshot();
      if (laterWriter) assert.equal(afterExternal[0].value, 'later-component.json');
      for (const index of [0, 1]) {
        assert.deepEqual(actual[index], afterExternal?.[index].value === 'later-component.json'
          ? afterExternal[index] : before[index]);
      }
    }
  } finally {
    for (const registry of [old, next, external]) for (const view of views) await registry.restoreIfCurrent(view, undefined, { exists: false });
  }
});

// Emulate only the reg.exe boundary; run the production snapshot, Unicode
// parsing, readback, ownership checks and rollback on every development OS.
function regFixture(initial = [{ exists: false }, { exists: false }]) {
  const state = structuredClone(initial), calls = [];
  const keyName = 'Software\\PromptDirectorSourceTests\\fixture';
  const key = `HKEY_CURRENT_USER\\${keyName}`;
  const missing = () => Object.assign(new Error('localized registry error'), { code: 1 });
  let fail;
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(file, 'C:\\Windows\\System32\\reg.exe');
    assert.equal(options.shell, undefined);
    const index = args.at(-1) === '/reg:32' ? 0 : 1;
    const current = state[index];
    if (fail?.(args, index)) throw missing();
    const [operation, target] = args;
    if (operation === 'query') {
      if (target === key && !current.exists) throw missing();
      return { stdout: Buffer.from(`${target}\r\n${target !== key && current.exists ? key : ''}\r\n`) };
    }
    if (operation === 'export') {
      if (!current.exists) throw missing();
      await writeFile(args[2], Buffer.from(`\ufeffWindows Registry Editor Version 5.00\r\n\r\n[${key}]\r\n${current.entry || ''}\r\n${current.otherValues ? '"Other"="keep"\r\n' : ''}${current.subkeys ? `\r\n[${key}\\Child]\r\n` : ''}`, 'utf16le'));
    } else if (operation === 'add') {
      current.exists = true;
      current.entry = '@=' + JSON.stringify(args[args.indexOf('/d') + 1]);
    } else if (operation === 'import') {
      current.entry = (await readFile(target, 'utf16le')).split('\r\n').find(line => line.startsWith('@='));
    } else if (operation === 'delete') {
      if (args.includes('/ve')) delete current.entry;
      else state[index] = { exists: false };
    } else assert.fail(`Unexpected command ${operation}`);
    return { stdout: Buffer.alloc(0) };
  };
  const registration = 'C:\\Users\\中文 A & B%20!\\视频组件\\com.promptdirector.video.json';
  const registry = windowsVideoRegistry({ registration }, { keyName, env: { SystemRoot: 'C:\\Windows', PATH: '' }, exec });
  return { state, calls, registry, registration, setFailure: callback => { fail = callback; } };
}

test('reg.exe first install, reinstall and uninstall preserve Unicode and shell characters in both views without PowerShell', async () => {
  const f = regFixture();
  await registerVideoViews(f.registration, f.registry);
  await registerVideoViews(f.registration, f.registry);
  for (const snapshot of await f.registry.snapshot()) assert.equal(snapshot.value, f.registration);
  for (const view of views) await f.registry.restoreIfCurrent(view, f.registration, { exists: false });
  assert.deepEqual(await f.registry.snapshot(), [{ exists: false }, { exists: false }]);
  const writes = f.calls.filter(call => call.args[0] === 'add');
  assert.equal(writes.length, 4);
  for (const call of writes) assert.equal(call.args[call.args.indexOf('/d') + 1], f.registration);
});

for (const entry of ['@="旧组件\\\\manifest.json"', '@=hex(2):25,00,54,00,45,00,4d,00,50,00,25,00,00,00', '@=dword:0000002a', '@=hex:00,ff,1a', undefined]) {
  test(`reg.exe restores the original default value and type after second-view readback failure: ${entry}`, async () => {
    const initial = [{ exists: true, entry, otherValues: true, subkeys: true }, { exists: false }];
    const f = regFixture(initial);
    const before = await f.registry.snapshot();
    let failed = false;
    f.setFailure((args, index) => {
      if (index === 1 && args[0] === 'export' && !failed) { failed = true; return true; }
      return false;
    });
    await assert.rejects(registerVideoViews(f.registration, f.registry), /localized/u);
    assert.deepEqual(await f.registry.snapshot(), before);
  });
}

test('snapshot access errors abort before any writes, rather than being treated as an absent key', async () => {
  const f = regFixture([{ exists: true, entry: '@="keep"' }, { exists: false }]);
  f.setFailure(args => args[0] === 'query' && args[1].endsWith('\\fixture'));
  await assert.rejects(registerVideoViews(f.registration, f.registry), /localized/u);
  assert.equal(f.calls.filter(call => call.args[0] === 'add').length, 0);
});

test('uninstall preserves another installation and unrelated values/subkeys at the owned registration key', async () => {
  const f = regFixture([{ exists: true, entry: '@="another-component.json"' }, { exists: true, otherValues: true, subkeys: true }]);
  await f.registry.write('Registry64');
  for (const view of views) await f.registry.restoreIfCurrent(view, f.registration, { exists: false });
  const actual = await f.registry.snapshot();
  assert.equal(actual[0].value, 'another-component.json');
  assert.equal(actual[1].exists, true);
  assert.equal(actual[1].hasValue, false);
  assert.equal(actual[1].otherValues, true);
  assert.equal(actual[1].subkeys, true);
});

test('real Windows Unicode paths survive install, reinstall, removal and readback in both registry views', { skip: process.platform !== 'win32' }, async () => {
  const keyName = `Software\\PromptDirectorSourceTests\\${randomUUID()}`;
  const registration = win32.join(process.env.TEMP, '视频 source & %20!', 'manifest.json');
  const registry = windowsVideoRegistry({ registration }, { keyName });
  try {
    await registerVideoViews(registration, registry);
    await registerVideoViews(registration, registry);
    for (const item of await registry.snapshot()) assert.equal(item.value, registration);
  } finally {
    for (const view of views) await registry.restoreIfCurrent(view, registration, { exists: false });
  }
  for (const item of await registry.snapshot()) assert.equal(item.hasValue || false, false);
});
