const browserApi = globalThis.browser;
const extensionApi = browserApi ?? globalThis.chrome;

const THEME_BACKGROUND_PROPERTY = '--ntp-bg';
const THEME_BACKGROUND_KEYS = ['ntp_background', 'frame'];
const RGB_CHANNEL_COUNT = 3;

const TAB_STRIP_BUSY_ERROR =
  'Tabs cannot be edited right now (user may be dragging a tab).';

const logLines = [];
let logElement;

const selfTab = getCurrentTab().catch(() => undefined);

function stringifyDetails(details) {
  if (details === undefined) {
    return '';
  }

  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return ` ${String(details)}`;
  }
}

function logEvent(name, details) {
  const line = `[${new Date().toISOString()}] ${name}${stringifyDetails(details)}`;
  logLines.push(line);
  console.log(line);

  if (logElement) {
    logElement.textContent = logLines.join('\n');
    logElement.scrollTop = logElement.scrollHeight;
  }
}

function createDiagnosticsPanel() {
  const panel = document.createElement('section');
  panel.id = 'ntp-diagnostics';

  const header = document.createElement('header');
  const title = document.createElement('strong');
  title.textContent = 'Just a NTP 诊断日志';
  const hint = document.createElement('span');
  hint.textContent = '选中日志后右键复制';

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = '复制全部';
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(logLines.join('\n'));
      copyButton.textContent = '已复制';
    } catch (error) {
      logEvent('copy:error', { message: error?.message });
    }
  });

  header.append(title, hint, copyButton);

  const log = document.createElement('pre');
  log.id = 'ntp-diagnostics-log';
  log.setAttribute('aria-live', 'polite');

  panel.append(header, log);
  document.body.append(panel);
  logElement = log;
}

function logPageState(name) {
  let version;
  try {
    version = extensionApi.runtime.getManifest().version;
  } catch {
    version = 'unknown';
  }

  logEvent(name, {
    href: location.href,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    version,
  });
}

createDiagnosticsPanel();
logPageState('page:load');

function toCssColor(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (
    Array.isArray(value) &&
    value.length === RGB_CHANNEL_COUNT &&
    value.every(Number.isFinite)
  ) {
    return `rgb(${value.join(' ')})`;
  }

  return undefined;
}

function pickThemeBackground(theme) {
  for (const key of THEME_BACKGROUND_KEYS) {
    const color = toCssColor(theme?.colors?.[key]);
    if (color) {
      return color;
    }
  }

  return undefined;
}

function applyTheme(theme) {
  const background = pickThemeBackground(theme);
  const rootStyle = document.documentElement.style;

  if (background) {
    rootStyle.setProperty(THEME_BACKGROUND_PROPERTY, background);
  } else {
    rootStyle.removeProperty(THEME_BACKGROUND_PROPERTY);
  }
}

async function refreshTheme() {
  const themeApi = browserApi?.theme;
  if (!themeApi?.getCurrent) {
    return;
  }

  try {
    const tab = await selfTab;
    const theme = tab
      ? await themeApi.getCurrent(tab.windowId)
      : await themeApi.getCurrent();
    applyTheme(theme);
  } catch (error) {
    // The CSS color-scheme fallback remains usable without theme access.
    logEvent('theme:error', { message: error?.message });
    applyTheme(undefined);
  }
}

function listenForThemeChanges() {
  const themeApi = browserApi?.theme;
  if (!themeApi?.getCurrent) {
    return;
  }

  refreshTheme();
  themeApi.onUpdated.addListener(async ({ theme, windowId }) => {
    const tab = await selfTab;
    if (windowId !== undefined && tab?.windowId !== windowId) {
      return;
    }
    applyTheme(theme);
  });
}

function getCurrentTab() {
  if (browserApi?.tabs) {
    return browserApi.tabs.getCurrent();
  }

  return new Promise((resolve, reject) => {
    extensionApi.tabs.getCurrent((tab) => {
      const error = extensionApi.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(tab);
      }
    });
  });
}

function queryTabs(queryInfo) {
  if (browserApi?.tabs) {
    return browserApi.tabs.query(queryInfo);
  }

  return new Promise((resolve, reject) => {
    extensionApi.tabs.query(queryInfo, (tabs) => {
      const error = extensionApi.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(tabs);
      }
    });
  });
}

function closeTab(tabId) {
  if (browserApi?.tabs) {
    return browserApi.tabs.remove(tabId);
  }

  return new Promise((resolve, reject) => {
    extensionApi.tabs.remove(tabId, () => {
      const error = extensionApi.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve();
      }
    });
  });
}

let isClosing = false;
let pendingClose = false;

async function closeIfNotOnlyTab(source) {
  logEvent('close:check', {
    source,
    isClosing,
    pendingClose,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  });

  if (isClosing) {
    logEvent('close:skip', { reason: 'already closing' });
    return;
  }

  let tab;
  try {
    tab = await selfTab;
  } catch (error) {
    logEvent('close:error', { stage: 'selfTab', message: error?.message });
    return;
  }

  logEvent('close:selfTab', {
    tab: tab
      ? { id: tab.id, windowId: tab.windowId, active: tab.active, url: tab.url }
      : null,
  });

  if (!tab) {
    logEvent('close:skip', { reason: 'no current tab' });
    return;
  }

  let tabs;
  try {
    tabs = await queryTabs({ windowId: tab.windowId });
  } catch (error) {
    logEvent('close:error', { stage: 'queryTabs', message: error?.message });
    return;
  }

  logEvent('close:windowTabs', {
    count: tabs.length,
    ids: tabs.map((item) => item.id),
    activeIds: tabs.filter((item) => item.active).map((item) => item.id),
  });

  // A hidden tab that is still active is navigating, not switched away from.
  const selfInWindow = tabs.find((item) => item.id === tab.id);
  if (selfInWindow?.active) {
    pendingClose = false;
    logEvent('close:skip', { reason: 'tab still active (navigating)' });
    return;
  }

  // Keep the last tab so losing focus cannot close the whole window.
  if (tabs.length <= 1) {
    pendingClose = false;
    logEvent('close:skip', { reason: 'only tab in window' });
    return;
  }

  isClosing = true;
  logEvent('close:attempt', { tabId: tab.id });

  try {
    await closeTab(tab.id);
    pendingClose = false;
    logEvent('close:success', { tabId: tab.id });
  } catch (error) {
    const message = error?.message;
    isClosing = false;
    pendingClose = true;
    logEvent('close:failure', { tabId: tab.id, message });

    // Chrome temporarily rejects tab edits while the tab strip is busy.
    // Retry only on a later browser event; never schedule a timer.
    if (message === TAB_STRIP_BUSY_ERROR) {
      logEvent('close:waiting-for-tab-event');
    }
  }
}

function retryPendingClose(source) {
  if (!pendingClose || document.visibilityState !== 'hidden') {
    return;
  }

  logEvent('close:retry', { source });
  closeIfNotOnlyTab(source);
}

function logFocusEvent(name) {
  logEvent(name, {
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  });
}

function closeWhenFocusIsLost() {
  window.addEventListener('blur', () => {
    logFocusEvent('window:blur');
    closeIfNotOnlyTab('window:blur');
  });

  window.addEventListener('focus', () => {
    logFocusEvent('window:focus');
  });

  document.addEventListener('visibilitychange', () => {
    logFocusEvent('document:visibilitychange');
    if (document.visibilityState === 'hidden') {
      closeIfNotOnlyTab('document:visibilitychange');
    }
  });

  window.addEventListener('pagehide', () => {
    logEvent('page:pagehide');
  });

  window.addEventListener('pageshow', () => {
    logEvent('page:pageshow');
  });

  window.addEventListener('beforeunload', () => {
    logEvent('page:beforeunload');
  });

  if (extensionApi.tabs?.onActivated) {
    extensionApi.tabs.onActivated.addListener((activeInfo) => {
      logEvent('tabs:onActivated', activeInfo);
      retryPendingClose('tabs:onActivated');
    });
  }

  if (extensionApi.tabs?.onHighlighted) {
    extensionApi.tabs.onHighlighted.addListener((highlightInfo) => {
      logEvent('tabs:onHighlighted', highlightInfo);
      retryPendingClose('tabs:onHighlighted');
    });
  }

  if (extensionApi.tabs?.onUpdated) {
    extensionApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
      logEvent('tabs:onUpdated', { tabId, status: changeInfo.status });
      retryPendingClose('tabs:onUpdated');
    });
  }

  if (extensionApi.tabs?.onMoved) {
    extensionApi.tabs.onMoved.addListener((tabId, moveInfo) => {
      logEvent('tabs:onMoved', { tabId, ...moveInfo });
      retryPendingClose('tabs:onMoved');
    });
  }

  if (extensionApi.windows?.onFocusChanged) {
    extensionApi.windows.onFocusChanged.addListener((windowId) => {
      logEvent('windows:onFocusChanged', { windowId });
      if (windowId !== extensionApi.windows.WINDOW_ID_NONE) {
        retryPendingClose('windows:onFocusChanged');
      }
    });
  }

  // A new tab opened in the background is already hidden on load.
  if (document.visibilityState === 'hidden') {
    closeIfNotOnlyTab('page-load-hidden');
  }
}

listenForThemeChanges();
closeWhenFocusIsLost();
