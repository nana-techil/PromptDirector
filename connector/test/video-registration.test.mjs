import test from 'node:test';
import assert from 'node:assert/strict';
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
      await assert.rejects(registerVideoViews('new-component.json', { ...next,
        async write(view) {
          await next.write(view);
          if (view === 'Registry64') {
            if (laterWriter) await external.write('Registry32');
            throw failure;
          }
        }
      }), error => error === failure);
      const actual = await next.snapshot();
      assert.deepEqual(actual[0], laterWriter ? present('later-component.json') : before[0]);
      assert.deepEqual(actual[1], before[1]);
    }
  } finally {
    for (const registry of [old, next, external]) for (const view of views) await registry.restoreIfCurrent(view, '', { exists: false });
  }
});
