/**
 * A new tab should close as soon as any other tab becomes active, including a
 * tab in another window. Keeping this pure makes the rule testable in Node.
 *
 * @param {{ tabId: number }} activeInfo
 * @param {{ id?: number } | undefined} selfTab
 * @returns {boolean}
 */
export function shouldCloseTab(activeInfo, selfTab) {
  if (!selfTab || typeof selfTab.id !== 'number') {
    return false;
  }

  return activeInfo.tabId !== selfTab.id;
}

/**
 * A hidden tab that is still the active tab in its window is navigating away
 * (for example, a bookmark click). Only a hidden tab that is no longer active
 * has been switched away from and may be closed.
 *
 * @param {{ active?: boolean } | undefined} tab
 * @returns {boolean}
 */
export function shouldCloseHiddenTab(tab) {
  return Boolean(tab && !tab.active);
}
