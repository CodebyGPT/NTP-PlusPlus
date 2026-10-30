import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldCloseHiddenTab, shouldCloseTab } from '../src/auto-close.js';

const selfTab = { id: 1, windowId: 10 };

test('closes when another tab activates in the same window', () => {
  assert.equal(shouldCloseTab({ tabId: 2, windowId: 10 }, selfTab), true);
});

test('stays open when its own tab is activated', () => {
  assert.equal(shouldCloseTab({ tabId: 1, windowId: 10 }, selfTab), false);
});

test('closes when a tab in another window is activated', () => {
  assert.equal(shouldCloseTab({ tabId: 2, windowId: 11 }, selfTab), true);
});

test('does nothing without a current tab', () => {
  assert.equal(shouldCloseTab({ tabId: 2, windowId: 10 }, undefined), false);
});

test('does nothing when the current tab has no usable ids', () => {
  assert.equal(shouldCloseTab({ tabId: 2, windowId: 10 }, {}), false);
});

test('closes a hidden tab that is no longer active', () => {
  assert.equal(shouldCloseHiddenTab({ active: false }), true);
});

test('keeps a hidden tab that is still active and navigating', () => {
  assert.equal(shouldCloseHiddenTab({ active: true }), false);
});

test('does nothing when the hidden tab state is unavailable', () => {
  assert.equal(shouldCloseHiddenTab(undefined), false);
});
