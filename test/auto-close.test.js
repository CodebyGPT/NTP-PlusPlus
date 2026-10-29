import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldCloseTab } from '../src/auto-close.js';

const selfTab = { id: 1, windowId: 10 };

test('closes when another tab activates in the same window', () => {
  assert.equal(shouldCloseTab({ tabId: 2, windowId: 10 }, selfTab), true);
});

test('stays open when its own tab is activated', () => {
  assert.equal(shouldCloseTab({ tabId: 1, windowId: 10 }, selfTab), false);
});

test('stays open when a tab in another window is activated', () => {
  assert.equal(shouldCloseTab({ tabId: 2, windowId: 11 }, selfTab), false);
});

test('does nothing without a current tab', () => {
  assert.equal(shouldCloseTab({ tabId: 2, windowId: 10 }, undefined), false);
});

test('does nothing when the current tab has no usable ids', () => {
  assert.equal(shouldCloseTab({ tabId: 2, windowId: 10 }, {}), false);
});
