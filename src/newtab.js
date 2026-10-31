import { applyTranslations, t } from './i18n.js';
import {
  hostOf,
  isWebUrl,
  normalizeHost,
  prepareTiles,
  TILE_COUNT,
  TOP_SITES_FETCH_LIMIT,
} from './topsites.js';

const extensionApi = globalThis.browser ?? globalThis.chrome;

// Some Chromium builds expose a Firefox-style `browser` alias, so the presence
// of browser.topSites says nothing. The UA is the reliable cross-browser split:
// Firefox also supports topSites options and bookmarks, Chromium caps at 10.
const IS_FIREFOX = /Firefox\//.test(navigator.userAgent);

const FAVICON_SIZE = 64;
const FAVICON_ENDPOINT = '/_favicon/';
const HIDDEN_SITES_KEY = 'ntp-hidden-sites';
const DOMAIN_ONLY_KEY = 'ntp-domain-only';
const EXCLUDE_BOOKMARKS_KEY = 'ntp-exclude-bookmarks';
const TILE_STYLE_KEY = 'ntp-tile-style';
// CSS swaps the two tile styles off this class; Chromium is the default so an
// unknown browser falls back to it.
const FIREFOX_STYLE_CLASS = 'ntp-firefox-style';

const tilesElement = document.getElementById('ntp-tiles');
const settingsButton = document.getElementById('ntp-settings-button');
const settingsDialog = document.getElementById('ntp-settings');
const domainOnlyInput = document.getElementById('opt-domain-only');
const excludeBookmarksInput = document.getElementById('opt-exclude-bookmarks');
const firefoxStyleInput = document.getElementById('opt-firefox-style');
const hiddenKeys = new Set(readStoredArray(HIDDEN_SITES_KEY));
const settings = {
  domainOnly: readStoredFlag(DOMAIN_ONLY_KEY),
  excludeBookmarks: readStoredFlag(EXCLUDE_BOOKMARKS_KEY),
  firefoxStyle: readStoredFlag(TILE_STYLE_KEY, IS_FIREFOX),
};
let topSites = [];
let excludedHosts = new Set();

const THEME_BACKGROUND_PROPERTY = '--ntp-bg';
const THEME_BACKGROUND_KEYS = ['ntp_background', 'frame'];
const RGB_CHANNEL_COUNT = 3;
const DEBUG_FLAG = 'debug';

const showDiagnostics = new URLSearchParams(location.search).has(DEBUG_FLAG);

const logLines = [];
let logElement;

const selfTab = extensionApi.tabs.getCurrent().catch(() => undefined);

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
  title.textContent = t('diagnosticsTitle');
  const hint = document.createElement('span');
  hint.textContent = t('diagnosticsHint');

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = t('copyAll');
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(logLines.join('\n'));
      copyButton.textContent = t('copied');
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

applyTranslations();
applyTileStyle();
if (showDiagnostics) {
  createDiagnosticsPanel();
}
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
  const themeApi = extensionApi.theme;
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
  const themeApi = extensionApi.theme;
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

function readStoredArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveStoredArray(key, values) {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Private windows may refuse storage; the in-memory set still works.
  }
}

function readStoredFlag(key, fallback = false) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === 'true';
  } catch {
    return fallback;
  }
}

function saveStoredFlag(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Same as above: keep the in-memory setting for this page.
  }
}

function faviconSource(tile) {
  if (tile.favicon) {
    return tile.favicon;
  }

  if (IS_FIREFOX) {
    return undefined;
  }

  // Chromium needs the "favicon" permission for this internal endpoint.
  const endpoint = extensionApi.runtime.getURL(FAVICON_ENDPOINT);
  return `${endpoint}?pageUrl=${encodeURIComponent(tile.sourceUrl)}&size=${FAVICON_SIZE}`;
}

function createTileElement(tile) {
  const item = document.createElement('li');
  item.className = 'ntp-tile';

  const link = document.createElement('a');
  link.className = 'ntp-tile-link';
  link.href = tile.url;
  link.title = tile.title;

  const icon = document.createElement('span');
  icon.className = 'ntp-tile-icon';

  const source = faviconSource(tile);
  if (source) {
    const image = document.createElement('img');
    image.className = 'ntp-tile-favicon';
    image.alt = '';
    image.width = FAVICON_SIZE;
    image.height = FAVICON_SIZE;
    image.addEventListener('load', () => icon.classList.add('has-favicon'));
    image.addEventListener('error', () => image.remove());
    image.src = source;
    icon.append(image);
  }

  const letter = document.createElement('span');
  letter.className = 'ntp-tile-letter';
  letter.dataset.tileLetter = '';
  letter.textContent = tile.title.trim().charAt(0).toUpperCase() || '?';
  icon.append(letter);

  const title = document.createElement('span');
  title.className = 'ntp-tile-title';
  title.textContent = tile.title;

  link.append(icon, title);
  item.append(link);

  if (IS_FIREFOX) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ntp-tile-remove';
    remove.dataset.tileRemove = '';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `${t('removeSite')} ${tile.title}`);
    remove.addEventListener('click', () => {
      hiddenKeys.add(tile.key);
      saveStoredArray(HIDDEN_SITES_KEY, [...hiddenKeys]);
      renderTiles();
      logEvent('topsites:remove', { key: tile.key, hidden: hiddenKeys.size });
    });
    item.append(remove);
  }

  return item;
}

function renderTiles() {
  if (!tilesElement) {
    return;
  }

  const tiles = prepareTiles(topSites, {
    domainOnly: settings.domainOnly,
    excludeHosts: excludedHosts,
    hiddenKeys,
  });
  tilesElement.replaceChildren(...tiles.map(createTileElement));
  logEvent('topsites:render', {
    total: topSites.length,
    shown: tiles.length,
    limit: TILE_COUNT,
  });
}

async function setupTopSites() {
  try {
    topSites = IS_FIREFOX
      ? await extensionApi.topSites.get({
          includeFavicon: true,
          limit: TOP_SITES_FETCH_LIMIT,
        })
      : await extensionApi.topSites.get();
    if (!Array.isArray(topSites)) {
      topSites = [];
    }
    logEvent('topsites:loaded', { count: topSites.length });
  } catch (error) {
    topSites = [];
    logEvent('topsites:error', { message: error?.message });
  }

  await refreshExcludedHosts();
  renderTiles();
}

function collectBookmarkHosts(nodes, hosts) {
  for (const node of nodes ?? []) {
    if (isWebUrl(node?.url)) {
      hosts.add(normalizeHost(hostOf(node.url)));
    }
    if (Array.isArray(node?.children)) {
      collectBookmarkHosts(node.children, hosts);
    }
  }
  return hosts;
}

async function refreshExcludedHosts() {
  if (!settings.excludeBookmarks || !IS_FIREFOX) {
    excludedHosts = new Set();
    return;
  }

  try {
    const tree = await extensionApi.bookmarks.getTree();
    excludedHosts = collectBookmarkHosts(tree, new Set());
    logEvent('bookmarks:loaded', { hosts: excludedHosts.size });
  } catch (error) {
    excludedHosts = new Set();
    logEvent('bookmarks:error', { message: error?.message });
  }
}

function applyTileStyle() {
  document.body.classList.toggle(FIREFOX_STYLE_CLASS, settings.firefoxStyle);
}

function setupSettings() {
  if (!settingsButton || !settingsDialog) {
    return;
  }

  domainOnlyInput.checked = settings.domainOnly;
  excludeBookmarksInput.checked = settings.excludeBookmarks;
  firefoxStyleInput.checked = settings.firefoxStyle;

  // Chromium returns at most 10 top sites, so excluding bookmarks would leave
  // holes in a full grid. Disable the option there instead of reloading.
  if (!IS_FIREFOX) {
    excludeBookmarksInput.disabled = true;
    excludeBookmarksInput
      .closest('.ntp-settings-option')
      ?.classList.add('is-disabled');
  }

  settingsButton.addEventListener('click', () => {
    if (!settingsDialog.open) {
      settingsDialog.showModal();
      logEvent('settings:open');
    }
  });

  settingsDialog.addEventListener('click', (event) => {
    if (event.target === settingsDialog) {
      settingsDialog.close();
    }
  });

  for (const button of settingsDialog.querySelectorAll('[data-close-settings]')) {
    button.addEventListener('click', () => settingsDialog.close());
  }

  settingsDialog.addEventListener('close', () => logEvent('settings:close'));

  domainOnlyInput.addEventListener('change', () => {
    settings.domainOnly = domainOnlyInput.checked;
    saveStoredFlag(DOMAIN_ONLY_KEY, settings.domainOnly);
    renderTiles();
    logEvent('settings:domain-only', { value: settings.domainOnly });
  });

  excludeBookmarksInput.addEventListener('change', async () => {
    settings.excludeBookmarks = excludeBookmarksInput.checked;
    saveStoredFlag(EXCLUDE_BOOKMARKS_KEY, settings.excludeBookmarks);
    await refreshExcludedHosts();
    renderTiles();
    logEvent('settings:exclude-bookmarks', {
      value: settings.excludeBookmarks,
    });
  });

  firefoxStyleInput.addEventListener('change', () => {
    settings.firefoxStyle = firefoxStyleInput.checked;
    saveStoredFlag(TILE_STYLE_KEY, settings.firefoxStyle);
    applyTileStyle();
    logEvent('settings:tile-style', { firefoxStyle: settings.firefoxStyle });
  });
}

let isClosing = false;

async function closeIfNotOnlyTab(source) {
  logEvent('close:check', {
    source,
    isClosing,
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
    tabs = await extensionApi.tabs.query({ windowId: tab.windowId });
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
    logEvent('close:skip', { reason: 'tab still active (navigating)' });
    return;
  }

  // Keep the last tab so losing focus cannot close the whole window.
  if (tabs.length <= 1) {
    logEvent('close:skip', { reason: 'only tab in window' });
    return;
  }

  isClosing = true;
  logEvent('close:attempt', { tabId: tab.id });
  window.close();
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
    } else {
      isClosing = false;
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

  // A new tab opened in the background is already hidden on load.
  if (document.visibilityState === 'hidden') {
    closeIfNotOnlyTab('page-load-hidden');
  }
}

listenForThemeChanges();
closeWhenFocusIsLost();
setupSettings();
setupTopSites();
