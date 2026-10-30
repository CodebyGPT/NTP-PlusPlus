const browserApi = globalThis.browser;
const extensionApi = browserApi ?? globalThis.chrome;

const NTP_URL = extensionApi.runtime.getURL('newtab.html');

// Chrome reports an overridden new tab as chrome://newtab/ in the tabs API,
// even though the rendered document is the extension page.
const NTP_URLS = new Set([
  NTP_URL,
  'chrome://newtab/',
  'edge://newtab/',
  'about:newtab',
]);

function queryTabs(queryInfo) {
  if (browserApi?.tabs) {
    return browserApi.tabs.query(queryInfo);
  }

  return new Promise((resolve) => {
    extensionApi.tabs.query(queryInfo, resolve);
  });
}

function removeTab(tabId) {
  if (browserApi?.tabs) {
    return browserApi.tabs.remove(tabId);
  }

  return new Promise((resolve) => {
    extensionApi.tabs.remove(tabId, () => {
      // Reading lastError prevents Chrome from logging an unchecked runtime error.
      void extensionApi.runtime.lastError;
      resolve();
    });
  });
}

function isNtpTab(tab) {
  return [tab.url, tab.pendingUrl].some(
    (url) => typeof url === 'string' && NTP_URLS.has(url),
  );
}

async function closeOtherNtpTabs(tabIdToKeep) {
  const tabs = await queryTabs({});
  const ntpTabs = tabs.filter(
    (tab) => tab.id !== tabIdToKeep && isNtpTab(tab),
  );

  await Promise.all(ntpTabs.map((tab) => removeTab(tab.id)));
}

function closeOtherNtpTabsSafely(tabIdToKeep) {
  closeOtherNtpTabs(tabIdToKeep).catch(() => {});
}

extensionApi.tabs.onActivated.addListener(({ tabId }) => {
  closeOtherNtpTabsSafely(tabId);
});

extensionApi.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === extensionApi.windows.WINDOW_ID_NONE) {
    return;
  }

  queryTabs({ active: true, windowId })
    .then(([activeTab]) => closeOtherNtpTabsSafely(activeTab?.id))
    .catch(() => {});
});
