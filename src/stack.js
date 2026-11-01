import { isWebUrl } from './topsites.js';

export const SNAPSHOT_SLOTS = 3;
export const TITLE_SEPARATOR = ' - ';
export const ELLIPSIS = '…';

const MIN_CHAR_LIMIT = 1;
const TITLE_AND_URL_PARTS = 2;

// Cards can point at privileged pages too: the browser restores those happily,
// they just can never be captured. Only its own empty pages are dropped, since
// a card for "New Tab" carries no information and would push a real one out.
const SKIPPED_URLS = [
  'about:blank',
  'about:newtab',
  'about:home',
  'chrome-search://',
  'chrome://newtab',
  'edge://newtab',
  'brave://newtab',
  'vivaldi://newtab',
];
const UNRESTORABLE_PROTOCOLS = new Set(['data:', 'blob:', 'javascript:']);

// Firefox has about:config, about:preferences and friends; Chromium has
// chrome://, edge://, and so on. All of them restore fine, so anything that
// parses as a URL and is not one of the skips above becomes a card.
export function isCardUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (UNRESTORABLE_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }

  return !SKIPPED_URLS.some((prefix) => value.startsWith(prefix));
}


// Unknown ring shapes come from callers that were never populated, not from
// bad data, so a fresh ring is enough instead of throwing.
export function pushSnapshot(ring, entry, slots = SNAPSHOT_SLOTS) {
  const current = Array.isArray(ring) ? ring : [];
  if (!entry) {
    return current.slice(0, slots);
  }

  const url = typeof entry.url === 'string' ? entry.url : undefined;
  const rest =
    url === undefined ? current : current.filter((item) => item?.url !== url);

  return [entry, ...rest].slice(0, slots);
}

export function charLimitForWidth(contentWidthPx, charWidthPx) {
  if (
    !Number.isFinite(contentWidthPx) ||
    !Number.isFinite(charWidthPx) ||
    contentWidthPx <= 0 ||
    charWidthPx <= 0
  ) {
    return MIN_CHAR_LIMIT;
  }

  const budget = Math.floor(contentWidthPx / charWidthPx);
  const limit = Math.floor(
    (budget - TITLE_SEPARATOR.length) / TITLE_AND_URL_PARTS,
  );

  return Math.max(MIN_CHAR_LIMIT, limit);
}

export function limitLabel(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) {
    return value;
  }

  return value.slice(0, Math.max(0, limit - ELLIPSIS.length)) + ELLIPSIS;
}

export function limitCardText({ title, url } = {}, limit) {
  return { title: limitLabel(title, limit), url: limitLabel(url, limit) };
}

function takeSnapshot(snapshots, taken, url) {
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (snapshot?.url === url && !taken.has(snapshot)) {
      taken.add(snapshot);
      return snapshot.dataUrl;
    }
  }

  return undefined;
}

// sessions.getRecentlyClosed() lists a `window` instead of a `tab` for whole
// windows, and those have no single URL to show. `webOnly` additionally drops
// the privileged pages, for people who would rather not see chrome:// there.
export function toRecentSessions(sessions, { webOnly = false } = {}) {
  const recent = [];

  for (const entry of sessions ?? []) {
    const tab = entry?.tab;
    if (!tab || typeof tab.sessionId !== 'string') {
      continue;
    }

    if (webOnly ? !isWebUrl(tab.url) : !isCardUrl(tab.url)) {
      continue;
    }

    recent.push({
      sessionId: tab.sessionId,
      title: tab.title || tab.url,
      url: tab.url,
    });
  }

  return recent;
}

export function buildRecentCards(sessions, snapshots, maxCards, options) {
  const cards = [];
  const taken = new Set();
  const settings = options ?? {};

  for (const entry of sessions ?? []) {
    if (maxCards !== undefined && cards.length >= maxCards) {
      break;
    }

    if (entry?.window) {
      if (settings.excludeWindows) {
        continue;
      }

      const card = windowCard(entry.window, settings);
      if (card) {
        cards.push(card);
      }
      continue;
    }

    const tab = entry?.tab;
    if (!tab || typeof tab.sessionId !== 'string') {
      continue;
    }

    if (settings.webOnly ? !isWebUrl(tab.url) : !isCardUrl(tab.url)) {
      continue;
    }

    cards.push({
      kind: 'tab',
      sessionId: tab.sessionId,
      title: tab.title || tab.url,
      url: tab.url,
      snapshot: takeSnapshot(snapshots, taken, tab.url),
    });
  }

  return cards;
}

function windowTabs(window, options) {
  return (Array.isArray(window.tabs) ? window.tabs : [])
    .filter(
      (tab) =>
        tab && (options.webOnly ? isWebUrl(tab.url) : isCardUrl(tab.url)),
    )
    .map((tab) => ({
      title: tab.title || tab.url,
      url: tab.url,
      active: tab.active === true,
    }));
}

// A closed window is a single session covering many tabs, so it gets one card
// that lists them instead of a snapshot. The head line is the tab that was in
// front when the window closed, because that is the one people remember.
function windowCard(window, options) {
  const tabs = windowTabs(window, options);

  // A window whose every tab was filtered out has nothing to show or restore.
  if (tabs.length === 0) {
    return undefined;
  }

  const head = tabs.find((tab) => tab.active) ?? tabs[0];

  return {
    kind: 'window',
    sessionId: window.sessionId,
    head: { title: head.title, url: head.url },
    count: tabs.length,
    tabs: tabs.map(({ title, url }) => ({ title, url })),
  };
}

// The pinned list shows everything the API returns, so it is flat: one row per
// session, with a window row carrying its tabs for the expander. Ordering is
// the API's own (most recent first) and nothing here is capped or filtered by
// settings -- the list is a complete picture, not a preview.
// Session timestamps are documented as milliseconds, but Chromium reports
// seconds; anything small enough to predate this century is read as seconds.
const EPOCH_MILLIS_CUTOFF = 1e11;

function toEpochMillis(value) {
  const stamp = Number(value);
  if (!Number.isFinite(stamp) || stamp <= 0) {
    return 0;
  }
  return stamp < EPOCH_MILLIS_CUTOFF ? stamp * 1000 : stamp;
}

export function buildSessionRows(sessions, { webOnly = false } = {}) {
  const rows = [];

  for (const entry of sessions ?? []) {
    const lastModified = toEpochMillis(entry?.lastModified);

    if (entry?.window) {
      const tabs = windowTabs(entry.window, { webOnly });

      if (tabs.length === 0) {
        continue;
      }

      const head = tabs.find((tab) => tab.active) ?? tabs[0];

      rows.push({
        kind: 'window',
        sessionId: entry.window.sessionId,
        title: head.title,
        url: head.url,
        lastModified,
        count: tabs.length,
        tabs: tabs.map(({ title, url }) => ({ title, url })),
      });
      continue;
    }

    const tab = entry?.tab;
    if (!tab || typeof tab.sessionId !== 'string') {
      continue;
    }

    if (webOnly ? !isWebUrl(tab.url) : !isCardUrl(tab.url)) {
      continue;
    }

    rows.push({
      kind: 'tab',
      sessionId: tab.sessionId,
      title: tab.title || tab.url,
      url: tab.url,
      lastModified,
    });
  }

  return rows;
}
