import { applyTranslations, t } from './i18n.js';
import {
  buildRecentCards,
  buildSessionRows,
  charLimitForWidth,
  ELLIPSIS,
  limitCardText,
  limitLabel,
  TITLE_SEPARATOR,
} from './stack.js';
import { createSiteIcon } from './icons.js';
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
const SNAPSHOT_CAP_KEY = 'ntp-snapshot-cap';
const SNAPSHOT_CAP_OPTIONS = [720, 1080, 1440, 2160];
const DEFAULT_SNAPSHOT_CAP = 1080;
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
// Read back from CSS so the icon column and the gap between it and the text
// stay one source of truth; the text limit is derived from them.
const TAB_ICON_SIZE_PROPERTY = '--ntp-card-tab-icon-size';
const TAB_ICON_GAP_PROPERTY = '--ntp-card-tab-gap';
// CSS swaps the two tile styles off this class; Chromium is the default so an
// unknown browser falls back to it.
const FIREFOX_STYLE_CLASS = 'ntp-firefox-style';
const LETTER_FAVICONS_CLASS = 'ntp-letter-favicons';
// The pinned list lets each column be dragged wider. These are the CSS custom
// properties that carry the widths, one per draggable column.
const SESSION_COLUMN_PROPERTIES = {
  select: '--ntp-session-col-select',
  icon: '--ntp-session-col-icon',
  title: '--ntp-session-col-title',
  url: '--ntp-session-col-url',
  kind: '--ntp-session-col-kind',
  time: '--ntp-session-col-time',
};
const SESSION_COLUMN_MIN_WIDTH = '3rem';
const SESSION_CLOSED_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'short',
});

const tilesElement = document.getElementById('ntp-tiles');
const settingsButton = document.getElementById('ntp-settings-button');
const settingsDialog = document.getElementById('ntp-settings');
const domainOnlyInput = document.getElementById('opt-domain-only');
const excludeBookmarksInput = document.getElementById('opt-exclude-bookmarks');
const firefoxStyleInput = document.getElementById('opt-firefox-style');
const snapshotCapInput = document.getElementById('opt-snapshot-cap');
const recentCountInput = document.getElementById('opt-recent-count');
const excludePrivilegedInput = document.getElementById('opt-exclude-privileged');
const excludeWindowsInput = document.getElementById('opt-exclude-windows');
const letterFaviconsInput = document.getElementById('opt-letter-favicons');
const recentElement = document.getElementById('ntp-recent');
const sessionListElement = document.getElementById('ntp-session-list');
const copyIconTemplate = document.getElementById('ntp-card-copy-icon');
const hiddenKeys = new Set(readStoredArray(HIDDEN_SITES_KEY));
const settings = {
  domainOnly: readStoredFlag(DOMAIN_ONLY_KEY),
  excludeBookmarks: readStoredFlag(EXCLUDE_BOOKMARKS_KEY),
  firefoxStyle: readStoredFlag(TILE_STYLE_KEY, IS_FIREFOX),
  snapshotCap: readStoredCount(SNAPSHOT_CAP_KEY, DEFAULT_SNAPSHOT_CAP),
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

function createTileElement(tile) {
  const item = document.createElement('li');
  item.className = 'ntp-tile';

  const link = document.createElement('a');
  link.className = 'ntp-tile-link';
  link.href = tile.url;
  link.title = tile.title;

  const icon = createSiteIcon({
    url: tile.sourceUrl ?? tile.url,
    title: tile.title,
    favicon: tile.favicon,
    variant: 'tile',
  });

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

  if (snapshotCapInput) {
    snapshotCapInput.value = String(settings.snapshotCap);
    // The background worker does the resizing and cannot read localStorage, so
    // the same value is mirrored into storage.local. Written on load as well,
    // because local storage may have been cleared independently.
    extensionApi?.storage?.local
      ?.set({ [SNAPSHOT_CAP_KEY]: settings.snapshotCap })
      .catch?.(() => {});
    snapshotCapInput.addEventListener('change', () => {
      const value = Number(snapshotCapInput.value);
      settings.snapshotCap = SNAPSHOT_CAP_OPTIONS.includes(value)
        ? value
        : DEFAULT_SNAPSHOT_CAP;
      saveStoredCount(SNAPSHOT_CAP_KEY, settings.snapshotCap);
      extensionApi?.storage?.local
        ?.set({ [SNAPSHOT_CAP_KEY]: settings.snapshotCap })
        .catch?.(() => {});
      logEvent('settings:snapshot-cap', { value: settings.snapshotCap });
    });
  }

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

  // Debug only: swaps every tile icon for its letter so the fallback can be
  // eyeballed. Deliberately not stored - a reload starts from real icons.
  if (letterFaviconsInput) {
    letterFaviconsInput.addEventListener('change', () => {
      document.body.classList.toggle(
        LETTER_FAVICONS_CLASS,
        letterFaviconsInput.checked,
      );
      logEvent('settings:letter-favicons', { value: letterFaviconsInput.checked });
    });
  }
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
  if (!isWindow) {
    bar.append(
      createSiteIcon({ url: card.url, title: card.title, variant: 'card' }),
    );
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
        createSiteIcon({
          url: card.url,
          title: card.title,
          variant: 'placeholder',
        }),
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

// Copied lines are markdown links: the shape every editor, chat box and issue
// tracker turns back into a working link.
function tabsText(card) {
  return card.tabs.map((tab) => `[${tab.title}](${tab.url})`).join('\n');
}

function windowLabel(card) {
  return t('windowCardTitle', [tabLine(card.head), String(card.count)]);
}

// The sentence wraps a variable-length tab line inside fixed words, so the tab
// line is folded on its own budget and the rendered sentence is then split
// around it: the fixed words get bold, the quoted tab line stays regular, and
// the quotes stay with the words they belong to.
function fillWindowTitle(title, card, limit) {
  const head = tabLine(card.head);
  const count = String(card.count);
  // Same count string the sentence will use, so the reserve is exact.
  const reserve = t('windowCardTitle', ['', count]).length;
  const headText = limitLabel(head, Math.max(1, limit - reserve));
  const sentence = t('windowCardTitle', [headText, count]);
  const at = sentence.indexOf(headText);

  title.replaceChildren();

  if (at < 0) {
    title.textContent = limitLabel(sentence, limit);
    return;
  }

  const words = document.createElement('span');
  words.className = 'ntp-card-window-words';
  words.textContent = sentence.slice(0, at);

  const quote = document.createElement('span');
  quote.className = 'ntp-card-window-quote';
  quote.textContent = headText;

  const rest = document.createElement('span');
  rest.className = 'ntp-card-window-words';
  rest.textContent = sentence.slice(at + headText.length);

  title.append(words, quote, rest);
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
  const contentWidth = list.clientWidth - paddingInline;
  // A row that carries an icon has that much less room for text.
  const iconWidth =
    (parseFloat(style.getPropertyValue(TAB_ICON_SIZE_PROPERTY)) || 0) +
    (parseFloat(style.getPropertyValue(TAB_ICON_GAP_PROPERTY)) || 0);
  const limitFor = (withIcon) =>
    charLimitForWidth(withIcon ? contentWidth - iconWidth : contentWidth, charWidth);
  const rowHeight = measureRowHeight();
  const rows = Math.max(
    1,
    Math.floor((list.clientHeight - paddingBlock) / (rowHeight || 1)),
  );
  // Too many tabs: the last line becomes the ellipsis, still a normal row, so
  // the list stays centred.
  const truncated = card.tabs.length > rows;
  const shown = truncated ? card.tabs.slice(0, rows - 1) : card.tabs;

  const rowElements = shown.map((tab) =>
    createTabRow(
      limitLabel(tabLine(tab), limitFor(true)),
      createSiteIcon({ url: tab.url, title: tab.title, variant: 'tab' }),
    ),
  );
  if (truncated) {
    rowElements.push(createTabRow(ELLIPSIS));
  }

  list.replaceChildren(...rowElements);
}

function createTabRow(text, icon) {
  const row = document.createElement('div');
  row.className = 'ntp-card-tab-row';
  const label = document.createElement('span');
  label.className = 'ntp-card-tab-label';
  label.textContent = text;
  if (icon) {
    row.append(icon);
  }
  row.append(label);
  return row;
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
      fillWindowTitle(
        label.querySelector('.ntp-card-title'),
        card,
        charLimitForWidth(label.clientWidth, charWidth),
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

  renderSessionList(sessions);

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

let sessionRows = [];
const selectedSessions = new Set();

// A pinned row is a checkbox, the site icon, and then the fields the API gives
// us. The window row carries a disclosure button instead of a second copy of
// its tabs, which stay in child rows until it is opened.
function createSessionRow(row) {
  const element = document.createElement('div');
  element.className = `ntp-session-entry is-${row.kind}`;
  element.dataset.sessionId = row.sessionId;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'ntp-session-check';
  check.dataset.sessionCheck = row.sessionId;
  check.checked = selectedSessions.has(row.sessionId);
  check.addEventListener('change', () => {
    if (check.checked) {
      selectedSessions.add(row.sessionId);
    } else {
      selectedSessions.delete(row.sessionId);
    }
    updateRestoreButton();
    logEvent('sessions:select', { selected: selectedSessions.size });
  });

  const leading = document.createElement('span');
  leading.className = 'ntp-session-leading';
  leading.append(check);
  if (row.kind === 'window') {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ntp-session-expand';
    toggle.dataset.sessionExpand = row.sessionId;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', t('sessionExpand'));
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      element.classList.toggle('is-open', open);
      const children = element.querySelector('.ntp-session-children');
      if (children) {
        children.hidden = !open;
      }
    });
    leading.prepend(toggle);
  }

  const kind = document.createElement('span');
  kind.className = 'ntp-session-kind';
  kind.textContent =
    row.kind === 'window'
      ? `${t('sessionKindWindow')} · ${row.count}`
      : t('sessionKindTab');

  const title = document.createElement('span');
  title.className = 'ntp-session-title';
  title.textContent = row.title;
  title.title = row.title;

  const url = document.createElement('span');
  url.className = 'ntp-session-url';
  url.textContent = row.url;
  url.title = row.url;

  const time = document.createElement('span');
  time.className = 'ntp-session-time';
  time.textContent = row.lastModified
    ? SESSION_CLOSED_FORMAT.format(new Date(row.lastModified))
    : '';
  if (row.lastModified) {
    time.title = new Date(row.lastModified).toISOString();
  }

  const line = document.createElement('div');
  line.className = `ntp-session-row is-${row.kind}`;
  line.append(
    leading,
    createSiteIcon({ url: row.url, title: row.title, variant: 'tab' }),
    title,
    url,
    kind,
    time,
  );
  element.append(line);

  if (row.kind === 'window') {
    const children = document.createElement('div');
    children.className = 'ntp-session-children';
    children.hidden = true;
    children.append(...row.tabs.map((tab) => createSessionChildRow(tab)));
    element.append(children);
  }

  return element;
}

function createSessionChildRow(tab) {
  const element = document.createElement('div');
  element.className = 'ntp-session-entry is-child';

  const spacer = document.createElement('span');
  spacer.className = 'ntp-session-leading';

  const title = document.createElement('span');
  title.className = 'ntp-session-title';
  title.textContent = tab.title;
  title.title = tab.title;

  const url = document.createElement('span');
  url.className = 'ntp-session-url';
  url.textContent = tab.url;
  url.title = tab.url;

  const kind = document.createElement('span');
  kind.className = 'ntp-session-kind';

  const time = document.createElement('span');
  time.className = 'ntp-session-time';

  const line = document.createElement('div');
  line.className = 'ntp-session-row is-child';
  line.append(
    spacer,
    createSiteIcon({ url: tab.url, title: tab.title, variant: 'tab' }),
    title,
    url,
    kind,
    time,
  );
  element.append(line);
  return element;
}

function createSessionHeader() {
  const header = document.createElement('div');
  header.className = 'ntp-session-header';

  const cells = [
    ['select', ''],
    ['icon', ''],
    ['title', t('sessionHeaderTitle')],
    ['url', t('sessionHeaderUrl')],
    ['kind', t('sessionHeaderKind')],
    ['time', t('sessionHeaderClosed')],
  ].map(([column, label]) => {
    const cell = document.createElement('span');
    cell.className = `ntp-session-cell ntp-session-heading-${column}`;
    cell.textContent = label;
    if (SESSION_COLUMN_PROPERTIES[column]) {
      cell.append(createColumnResizer(column));
    }
    return cell;
  });

  const actions = document.createElement('span');
  actions.className = 'ntp-session-actions';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.id = 'ntp-session-restore';
  restore.className = 'ntp-session-restore';
  restore.disabled = true;
  restore.textContent = t('sessionRestore');
  restore.addEventListener('click', () => {
    restoreSelectedSessions();
  });
  actions.append(restore);

  header.append(...cells, actions);
  return header;
}

// Dragging a column edge sets one custom property and lets the shared grid
// template do the rest, so the header and every row stay aligned for free.
function createColumnResizer(column) {
  const handle = document.createElement('span');
  handle.className = 'ntp-session-resizer';
  handle.dataset.sessionResizer = column;

  handle.addEventListener('pointerdown', (event) => {
    const heading = handle.parentElement;
    const startX = event.clientX;
    const startWidth = heading.getBoundingClientRect().width;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; the drag still works.
    }

    const move = (moveEvent) => {
      const width = Math.max(0, startWidth + moveEvent.clientX - startX);
      sessionListElement.style.setProperty(
        SESSION_COLUMN_PROPERTIES[column],
        `max(${SESSION_COLUMN_MIN_WIDTH}, ${Math.round(width)}px)`,
      );
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      logEvent('sessions:column', { column });
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  });

  return handle;
}

function updateRestoreButton() {
  const restore = document.getElementById('ntp-session-restore');
  if (restore) {
    restore.disabled = selectedSessions.size === 0;
  }
}

async function restoreSelectedSessions() {
  const ids = [...selectedSessions];
  if (ids.length === 0) {
    return;
  }

  let restored = 0;
  for (const sessionId of ids) {
    try {
      await extensionApi.sessions.restore(sessionId);
      restored += 1;
    } catch (error) {
      logEvent('sessions:restore-error', {
        sessionId,
        message: error?.message,
      });
    }
  }

  selectedSessions.clear();
  updateRestoreButton();
  logEvent('sessions:restore', { requested: ids.length, restored });
  await refreshRecentCards();
}

// The list is complete on purpose: it ignores the card settings and shows every
// session the API is still holding.
function renderSessionList(sessions) {
  if (!sessionListElement) {
    return;
  }

  sessionRows = buildSessionRows(sessions);
  const known = new Set(sessionRows.map((row) => row.sessionId));
  for (const sessionId of [...selectedSessions]) {
    if (!known.has(sessionId)) {
      selectedSessions.delete(sessionId);
    }
  }

  sessionListElement.replaceChildren(
    createSessionHeader(),
    ...sessionRows.map((row) => createSessionRow(row)),
  );
  updateRestoreButton();
  logEvent('sessions:list', { rows: sessionRows.length });
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
