import test from 'node:test';
import assert from 'node:assert/strict';
import { requestTimeoutMs, timeoutMessage, CONNECTOR_TIMEOUT_MS, TASK_WAIT_MS } from '../request-policy.mjs';

test('long polling retains the full response allowance after its declared wait', () => {
  for (const operation of ['get_task', 'wait_workspace_changes']) {
    assert.equal(requestTimeoutMs(operation, { waitMs: TASK_WAIT_MS }), TASK_WAIT_MS + CONNECTOR_TIMEOUT_MS);
    assert.equal(requestTimeoutMs(operation, { waitMs: 0 }), CONNECTOR_TIMEOUT_MS);
  }
});
test('writes and original-media verification get more time without slowing offline handshakes', () => {
  for (const operation of ['edit_case', 'save_skill', 'finish_transfer', 'read_media']) assert(requestTimeoutMs(operation) > requestTimeoutMs('search_cases'));
  assert.equal(requestTimeoutMs('status'), CONNECTOR_TIMEOUT_MS);
  assert.match(timeoutMessage('save_material', { requestId: 'same-request' }), /原请求编号/);
  assert(!timeoutMessage('search_cases').includes('写入'));
  assert(!timeoutMessage('edit_case').includes('查询 get_task'));
});
