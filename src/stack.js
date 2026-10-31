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
// windows, and those have no single URL to show.
export function toRecentSessions(sessions) {
  const recent = [];

  for (const entry of sessions ?? []) {
    const tab = entry?.tab;
    if (!tab || typeof tab.sessionId !== 'string' || !isCardUrl(tab.url)) {
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

export function buildRecentCards(sessions, snapshots, maxCards) {
  const cards = [];
  const taken = new Set();

  for (const session of toRecentSessions(sessions)) {
    if (maxCards !== undefined && cards.length >= maxCards) {
      break;
    }

    cards.push({
      ...session,
      snapshot: takeSnapshot(snapshots, taken, session.url),
    });
  }

  return cards;
}
