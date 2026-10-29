/**
 * A new tab should close when another tab becomes active in its own window.
 * Keeping this pure makes the window/tab rules testable without a browser.
 *
 * @param {{ tabId: number, windowId: number }} activeInfo
 * @param {{ id?: number, windowId?: number } | undefined} selfTab
 * @returns {boolean}
 */
export function shouldCloseTab(activeInfo, selfTab) {
  if (!selfTab) {
    return false;
  }

  if (typeof selfTab.id !== 'number' || typeof selfTab.windowId !== 'number') {
    return false;
  }

  return (
    activeInfo.tabId !== selfTab.id && activeInfo.windowId === selfTab.windowId
  );
}
