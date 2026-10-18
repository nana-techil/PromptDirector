import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../extension/${path}`, import.meta.url), 'utf8');

test('re-arranging the detail workspace restores focus on the equivalent control', () => {
  const workspace = source('detail-workspace.js');
  // The original focused node can be replaced while the prompt section refreshes.
  assert.match(workspace, /promptKey: focused\.closest\('\[data-prompt-key\]'\)\?\.dataset\.promptKey/);
  assert.match(workspace, /ariaLabel: focused\.getAttribute\('aria-label'\)/);
  assert.match(workspace, /if \(focused\) restoreWorkspaceFocus\(body, focused\);/);
  const restore = workspace.slice(workspace.indexOf('function restoreWorkspaceFocus'), workspace.indexOf('export function unwrapDetailWorkspace'));
  assert.match(restore, /if \(focused\.node\?\.isConnected\)/);
  // A control which already holds focus must keep it.
  assert.match(restore, /if \(active && active !== document\.body && active !== body && body\.contains\(active\)\) return;/);
  assert.match(restore, /getAttribute\('aria-label'\) === focused\.ariaLabel/);
});

test('an open popover menu survives a detail workspace re-arrange', () => {
  const workspace = source('detail-workspace.js');
  const menu = source('transient-menu.js');
  // Every open disclosure menu is asked to re-sync after the sections are re-attached,
  // because detaching the node hid its popover while preserving details.open.
  assert.match(workspace, /for \(const details of body\.querySelectorAll\('details\[open\]'\)\) details\.syncPopoverMenu\?\.\(\);/);
  assert.match(menu, /details\.syncPopoverMenu = sync;/);
  assert.match(menu, /if \(details\.syncPopoverMenu === sync\) delete details\.syncPopoverMenu;/);
});
