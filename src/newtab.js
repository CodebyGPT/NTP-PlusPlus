import { shouldCloseHiddenTab, shouldCloseTab } from './auto-close.js';

const browserApi = globalThis.browser;
const extensionApi = browserApi ?? globalThis.chrome;

const THEME_BACKGROUND_PROPERTY = '--ntp-bg';
const THEME_BACKGROUND_KEYS = ['ntp_background', 'frame'];
const RGB_CHANNEL_COUNT = 3;

const selfTab = getCurrentTab().catch(() => undefined);

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
  } catch {
    // The CSS color-scheme fallback remains usable without theme access.
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

  return new Promise((resolve) => {
    extensionApi.tabs.getCurrent((tab) => resolve(tab));
  });
}

function closeTab(tabId) {
  if (browserApi?.tabs) {
    browserApi.tabs.remove(tabId).catch(() => {});
    return;
  }

  extensionApi.tabs.remove(tabId, () => {
    // Reading lastError prevents Chrome from logging an unchecked runtime error.
    void extensionApi.runtime.lastError;
  });
}

function closeWhenAnotherTabActivates() {
  extensionApi.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await selfTab;
    if (shouldCloseTab(activeInfo, tab)) {
      closeTab(tab.id);
    }
  });
}

function closeWhenAnotherWindowGetsFocus() {
  const windowsApi = extensionApi.windows;
  if (!windowsApi?.onFocusChanged) {
    return;
  }

  windowsApi.onFocusChanged.addListener(async (windowId) => {
    const tab = await selfTab;
    if (
      tab &&
      windowId !== windowsApi.WINDOW_ID_NONE &&
      windowId !== tab.windowId
    ) {
      closeTab(tab.id);
    }
  });
}

function getTab(tabId) {
  if (browserApi?.tabs) {
    return browserApi.tabs.get(tabId);
  }

  return new Promise((resolve) => {
    extensionApi.tabs.get(tabId, (tab) => {
      // Reading lastError prevents Chrome from logging an unchecked runtime error.
      void extensionApi.runtime.lastError;
      resolve(tab);
    });
  });
}

function closeWhenHidden() {
  const closeIfInBackground = async () => {
    if (document.visibilityState !== 'hidden') {
      return;
    }

    const tab = await selfTab;
    if (!tab || document.visibilityState !== 'hidden') {
      return;
    }

    let currentTab;
    try {
      currentTab = await getTab(tab.id);
    } catch {
      return;
    }

    // A hidden but still-active tab is navigating away (for example, a
    // bookmark click), not switched away from. Closing it would kill the tab
    // that is loading the destination, and the whole window if it was alone.
    if (shouldCloseHiddenTab(currentTab)) {
      closeTab(tab.id);
    }
  };

  document.addEventListener('visibilitychange', closeIfInBackground);
  // A tab opened in the background never receives visibilitychange; close it now.
  closeIfInBackground();
}

listenForThemeChanges();
closeWhenAnotherTabActivates();
closeWhenAnotherWindowGetsFocus();
closeWhenHidden();
