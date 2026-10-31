import { applyTranslations, t } from './i18n.js';
import {
  buildRecentCards,
  charLimitForWidth,
  ELLIPSIS,
  limitCardText,
  limitLabel,
  TITLE_SEPARATOR,
} from './stack.js';
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
// Privileged pages are restorable but cannot be captured; some people would
// rather not see them in the card stack at all, so this defaults to excluding.
const EXCLUDE_PRIVILEGED_KEY = 'ntp-exclude-privileged';
// Closed windows restore as a whole and list their tabs, which some people find
// noisy next to single pages, so this is off by default.
const EXCLUDE_WINDOWS_KEY = 'ntp-exclude-windows';
const TILE_STYLE_KEY = 'ntp-tile-style';
const RECENT_COUNT_KEY = 'ntp-recent-count';
const RECENT_COUNT_OPTIONS = [1, 2, 3];
const DEFAULT_RECENT_COUNT = 3;
// The background script answers this; both sides spell it out because a
// classic service-worker script cannot import shared modules on Firefox.
const SNAPSHOT_MESSAGE = 'ntp:snapshots';
// Proportional fonts have no single character width, so averaging over a mixed
// sample keeps the computed limit from jumping on every resize step.
const CHAR_SAMPLE = 'mnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CHAR_SAMPLE_REPEAT = 2;
// Cards keep the display's own aspect ratio so a wide screen gets wide cards.
const CARD_ASPECT_PROPERTY = '--ntp-card-aspect';
// CSS swaps the two tile styles off this class; Chromium is the default so an
// unknown browser falls back to it.
const FIREFOX_STYLE_CLASS = 'ntp-firefox-style';

const tilesElement = document.getElementById('ntp-tiles');
const settingsButton = document.getElementById('ntp-settings-button');
const settingsDialog = document.getElementById('ntp-settings');
const domainOnlyInput = document.getElementById('opt-domain-only');
const excludeBookmarksInput = document.getElementById('opt-exclude-bookmarks');
const firefoxStyleInput = document.getElementById('opt-firefox-style');
const recentCountInput = document.getElementById('opt-recent-count');
const excludePrivilegedInput = document.getElementById('opt-exclude-privileged');
const excludeWindowsInput = document.getElementById('opt-exclude-windows');
const recentElement = document.getElementById('ntp-recent');
const copyIconTemplate = document.getElementById('ntp-card-copy-icon');
const hiddenKeys = new Set(readStoredArray(HIDDEN_SITES_KEY));
const settings = {
  domainOnly: readStoredFlag(DOMAIN_ONLY_KEY),
  excludeBookmarks: readStoredFlag(EXCLUDE_BOOKMARKS_KEY),
  firefoxStyle: readStoredFlag(TILE_STYLE_KEY, IS_FIREFOX),
  recentCount: readStoredCount(RECENT_COUNT_KEY, DEFAULT_RECENT_COUNT),
  // Default on: this is how the cards behaved before privileged pages showed up.
  excludePrivileged: readStoredFlag(EXCLUDE_PRIVILEGED_KEY, true),
  excludeWindows: readStoredFlag(EXCLUDE_WINDOWS_KEY),
};
let topSites = [];
let excludedHosts = new Set();
let recentCards = [];

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

function readStoredCount(key, fallback) {
  try {
    const value = Number(localStorage.getItem(key));
    return RECENT_COUNT_OPTIONS.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveStoredCount(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // The in-memory setting still applies until this page closes.
  }
}

function faviconSource(tile) {
  if (tile.favicon) {
    return tile.favicon;
  }

  if (IS_FIREFOX) {
    return undefined;
  }

  // The favicon store only knows web pages: ask it about chrome://settings and
  // it answers with its generic globe, which would be a lie. The letter stands
  // in instead.
  if (tile.sourceUrl && !isWebUrl(tile.sourceUrl)) {
    return undefined;
  }

  // Chromium needs the "favicon" permission for this internal endpoint.
  const endpoint = extensionApi.runtime.getURL(FAVICON_ENDPOINT);
  return `${endpoint}?pageUrl=${encodeURIComponent(tile.sourceUrl)}&size=${FAVICON_SIZE}`;
}

// A first letter for anything without an icon: the site's host, or the text
// itself when the URL has no host to speak of.
function initialOf(url) {
  const host = hostOf(url) || url;
  return host.slice(0, 1).toUpperCase() || '?';
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

  if (recentCountInput) {
    recentCountInput.value = String(settings.recentCount);
    recentCountInput.addEventListener('change', () => {
      const value = Number(recentCountInput.value);
      settings.recentCount = RECENT_COUNT_OPTIONS.includes(value)
        ? value
        : DEFAULT_RECENT_COUNT;
      saveStoredCount(RECENT_COUNT_KEY, settings.recentCount);
      logEvent('settings:recent-count', { value: settings.recentCount });
      refreshRecentCards();
    });
  }

  if (excludePrivilegedInput) {
    excludePrivilegedInput.checked = settings.excludePrivileged;
    excludePrivilegedInput.addEventListener('change', () => {
      settings.excludePrivileged = excludePrivilegedInput.checked;
      saveStoredFlag(EXCLUDE_PRIVILEGED_KEY, settings.excludePrivileged);
      logEvent('settings:exclude-privileged', {
        value: settings.excludePrivileged,
      });
      refreshRecentCards();
    });
  }

  if (excludeWindowsInput) {
    excludeWindowsInput.checked = settings.excludeWindows;
    excludeWindowsInput.addEventListener('change', () => {
      settings.excludeWindows = excludeWindowsInput.checked;
      saveStoredFlag(EXCLUDE_WINDOWS_KEY, settings.excludeWindows);
      logEvent('settings:exclude-windows', { value: settings.excludeWindows });
      refreshRecentCards();
    });
  }
}

// The copy glyph lives in a <template> in the HTML: inline SVG markup parses
// into the SVG namespace there, so no xmlns string is needed in JS.
function createPlaceholderIcon(source, url) {
  const icon = document.createElement('img');
  icon.className = 'ntp-card-placeholder';
  icon.alt = '';
  icon.width = FAVICON_SIZE;
  icon.height = FAVICON_SIZE;
  icon.addEventListener('error', () => icon.replaceWith(createPlaceholderLetter(url)));
  icon.src = source;
  return icon;
}

// Firefox sessions carry no inline favicon, and loading the remote favIconUrl
// would break the no-remote-resources rule, so the site's initial stands in.
function createPlaceholderLetter(url) {
  const letter = document.createElement('span');
  letter.className = 'ntp-card-placeholder-letter';
  letter.setAttribute('aria-hidden', 'true');
  letter.textContent = initialOf(url);
  return letter;
}

function createCardElement(card, stackIndex) {
  const isWindow = card.kind === 'window';
  const item = document.createElement('article');
  item.className = 'ntp-card';
  item.style.setProperty('--ntp-card-index', String(stackIndex));

  const link = document.createElement('a');
  link.className = 'ntp-card-open';
  link.href = isWindow ? card.head.url : card.url;
  link.title = isWindow
    ? windowLabel(card)
    : `${card.title}${TITLE_SEPARATOR}${card.url}`;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    restoreSession(card);
  });

  const bar = document.createElement('div');
  bar.className = 'ntp-card-bar';

  // A window has no icon of its own, so its bar starts straight at the title.
  const source = isWindow ? undefined : faviconSource({ sourceUrl: card.url });
  if (source) {
    const image = document.createElement('img');
    image.className = 'ntp-card-favicon';
    image.alt = '';
    image.width = FAVICON_SIZE;
    image.height = FAVICON_SIZE;
    image.addEventListener('load', () => bar.classList.add('has-favicon'));
    image.addEventListener('error', () => image.remove());
    image.src = source;
    bar.append(image);
  }

  if (!isWindow) {
    const letter = document.createElement('span');
    letter.className = 'ntp-card-bar-letter';
    letter.setAttribute('aria-hidden', 'true');
    letter.textContent = initialOf(card.url);
    bar.append(letter);
  }

  const label = document.createElement('span');
  label.className = 'ntp-card-label';
  const title = document.createElement('span');
  title.className = 'ntp-card-title';
  title.textContent = isWindow ? windowLabel(card) : card.title;
  label.append(title);
  if (!isWindow) {
    const url = document.createElement('span');
    url.className = 'ntp-card-url';
    url.textContent = card.url;
    label.append(document.createTextNode(TITLE_SEPARATOR), url);
  }
  bar.append(label);

  const body = document.createElement('div');
  if (isWindow) {
    // Filled in by applyCardText(): that is the only place that knows how much
    // room the card ended up with.
    body.className = 'ntp-card-tabs';
  } else {
    body.className = 'ntp-card-snapshot';
    if (card.snapshot) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = card.snapshot;
      body.append(image);
    } else {
      body.classList.add('is-empty');
      body.append(
        source
          ? createPlaceholderIcon(source, card.url)
          : createPlaceholderLetter(card.url),
      );
    }
  }

  link.append(bar, body);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ntp-card-copy';
  copy.setAttribute('aria-label', t('copyLink'));
  if (copyIconTemplate) {
    copy.append(copyIconTemplate.content.cloneNode(true));
  }
  copy.addEventListener('click', async (event) => {
    // A pointer click leaves the button focused, and `:focus-within` would keep
    // the stack opened up long after the cursor left. Keyboard users keep the
    // focus so they can go on tabbing.
    if (event.detail > 0) {
      copy.blur();
    }
    // A window copies every tab it held, one "title - url" line each.
    const payload = isWindow ? tabsText(card) : card.url;
    try {
      await navigator.clipboard.writeText(payload);
      logEvent('recent:copy', {
        url: isWindow ? card.head.url : card.url,
        lines: isWindow ? card.count : 1,
      });
    } catch (error) {
      logEvent('recent:copy-error', { message: error?.message });
    }
  });

  item.append(link, copy);
  return item;
}

async function restoreSession(card) {
  try {
    await extensionApi.sessions.restore(card.sessionId);
    logEvent('recent:restore', {
      sessionId: card.sessionId,
      url: card.kind === 'window' ? card.head.url : card.url,
    });
  } catch (error) {
    // The session may already be gone; a window cannot be reopened by URL, but
    // its front tab still can.
    logEvent('recent:restore-error', { message: error?.message });
    location.href = card.kind === 'window' ? card.head.url : card.url;
  }
}

// Every tab line, and the clipboard payload for a window card, share one shape.
function tabLine(tab) {
  return `${tab.title}${TITLE_SEPARATOR}${tab.url}`;
}

function tabsText(card) {
  return card.tabs.map(tabLine).join('\n');
}

function windowLabel(card) {
  return t('windowCardTitle', [tabLine(card.head), String(card.count)]);
}

function measureCharWidth() {
  const sample = document.createElement('span');
  sample.className = 'ntp-card-measure';
  sample.textContent = CHAR_SAMPLE.repeat(CHAR_SAMPLE_REPEAT);
  document.body.append(sample);
  const width = sample.getBoundingClientRect().width / sample.textContent.length;
  sample.remove();
  return width;
}

// Row height comes from the same styling the real rows use, so a font change
// moves the computed row count along with it.
function measureRowHeight() {
  const sample = document.createElement('div');
  sample.className = 'ntp-card-tab-row';
  // Out of flow: measuring must not nudge the page for a frame.
  sample.style.position = 'absolute';
  sample.style.visibility = 'hidden';
  sample.textContent = CHAR_SAMPLE.slice(0, 1);
  document.body.append(sample);
  const height = sample.getBoundingClientRect().height;
  sample.remove();
  return height;
}

function fillWindowCard(cardElement, card, charWidth) {
  const list = cardElement.querySelector('.ntp-card-tabs');
  if (!list) {
    return;
  }

  const style = getComputedStyle(list);
  const paddingBlock =
    parseFloat(style.paddingBlockStart) + parseFloat(style.paddingBlockEnd);
  const paddingInline =
    parseFloat(style.paddingInlineStart) + parseFloat(style.paddingInlineEnd);
  const limit = charLimitForWidth(
    list.clientWidth - paddingInline,
    charWidth,
  );
  const rowHeight = measureRowHeight();
  const rows = Math.max(
    1,
    Math.floor((list.clientHeight - paddingBlock) / (rowHeight || 1)),
  );
  // Too many tabs: the last line becomes the ellipsis, still a normal row, so
  // the list stays centred.
  const truncated = card.tabs.length > rows;
  const shown = truncated ? card.tabs.slice(0, rows - 1) : card.tabs;
  const lines = shown.map((tab) => limitLabel(tabLine(tab), limit));
  if (truncated) {
    lines.push(ELLIPSIS);
  }

  list.replaceChildren(
    ...lines.map((line) => {
      const row = document.createElement('div');
      row.className = 'ntp-card-tab-row';
      row.textContent = line;
      return row;
    }),
  );
}

function applyCardText() {
  if (!recentElement) {
    return;
  }

  const cards = recentElement.querySelectorAll('.ntp-card');
  if (cards.length === 0) {
    return;
  }

  const charWidth = measureCharWidth();
  // DOM order is oldest first, the card list is newest first.
  const ordered = [...recentCards].reverse();

  cards.forEach((cardElement, index) => {
    const card = ordered[index];
    if (!card) {
      return;
    }

    const label = cardElement.querySelector('.ntp-card-label');
    if (card.kind === 'window') {
      // One sentence, so it gets the whole bar rather than half of it.
      const limit = charLimitForWidth(label.clientWidth, charWidth);
      label.querySelector('.ntp-card-title').textContent = limitLabel(
        windowLabel(card),
        limit,
      );
      fillWindowCard(cardElement, card, charWidth);
      return;
    }

    const limit = charLimitForWidth(label.clientWidth, charWidth);
    const text = limitCardText(card, limit);
    label.querySelector('.ntp-card-title').textContent = text.title;
    label.querySelector('.ntp-card-url').textContent = text.url;
  });
}

function renderRecentCards() {
  if (!recentElement) {
    return;
  }

  const total = recentCards.length;
  recentElement.style.setProperty('--ntp-card-count', String(Math.max(1, total)));
  // Later siblings paint on top, so the newest card has to come last.
  recentElement.replaceChildren(
    ...[...recentCards]
      .reverse()
      .map((card, index) => createCardElement(card, total - 1 - index)),
  );
  applyCardText();
}

async function refreshRecentCards() {
  if (!recentElement) {
    return;
  }

  let sessions = [];
  try {
    sessions = await extensionApi.sessions.getRecentlyClosed();
  } catch (error) {
    logEvent('sessions:error', { message: error?.message });
  }

  let snapshots = [];
  try {
    const response = await extensionApi.runtime.sendMessage({
      type: SNAPSHOT_MESSAGE,
    });
    snapshots = Array.isArray(response?.snapshots) ? response.snapshots : [];
  } catch (error) {
    logEvent('snapshots:error', { message: error?.message });
  }

  recentCards = buildRecentCards(sessions, snapshots, settings.recentCount, {
    webOnly: settings.excludePrivileged,
    excludeWindows: settings.excludeWindows,
  });
  renderRecentCards();
  logEvent('recent:render', {
    count: recentCards.length,
    limit: settings.recentCount,
    snapshots: snapshots.length,
  });
}

// The cards keep the display's aspect ratio however the window is shaped. A
// window too short lets them run past the bottom edge instead of squashing
// them: the ratio is a hard rule, the fit is not. Screen size never changes
// mid-session on desktop, so the ratio is read once per render.
function applyCardAspect() {
  const width = window.screen?.width;
  const height = window.screen?.height;
  if (!(width > 0) || !(height > 0)) {
    return;
  }
  document.documentElement.style.setProperty(
    CARD_ASPECT_PROPERTY,
    `${width} / ${height}`,
  );
}

function setupRecentCards() {
  if (!recentElement) {
    return;
  }

  // resize is an event, not a poll: the character limit only needs revisiting
  // when the stage actually changes width.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      applyCardText();
    }).observe(recentElement);
  }

  applyCardAspect();
  refreshRecentCards();
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
setupRecentCards();
