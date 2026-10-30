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
