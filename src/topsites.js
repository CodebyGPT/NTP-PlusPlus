export const TILE_COLUMNS = 5;
export const TILE_ROWS = 2;
export const TILE_COUNT = TILE_COLUMNS * TILE_ROWS;

// Firefox caps topSites.get() at 100; request the full pool so deleted tiles
// can be replaced by sites that do not fit in the 5x2 grid.
export const TOP_SITES_FETCH_LIMIT = 100;

const WEB_PROTOCOLS = new Set(['http:', 'https:']);

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function isWebUrl(url) {
  const parsed = parseUrl(url);
  return Boolean(parsed) && WEB_PROTOCOLS.has(parsed.protocol);
}

export function hostOf(url) {
  return parseUrl(url)?.hostname ?? '';
}

const WWW_PREFIX = 'www.';

// "example.com" and "www.example.com" are the same site for bookmark matching.
export function normalizeHost(host) {
  return host.startsWith(WWW_PREFIX) ? host.slice(WWW_PREFIX.length) : host;
}

export function rootOf(url) {
  const parsed = parseUrl(url);
  return parsed ? `${parsed.origin}/` : url;
}

// Hidden sites are keyed by origin, not by full page URL, so switching the
// "domain only" option cannot resurrect a site the user already removed.
export function siteKey(url) {
  return rootOf(url);
}

export function prepareTiles(sites, { domainOnly = false, excludeHosts, hiddenKeys } = {}) {
  const tiles = [];
  const seen = new Set();

  for (const site of sites ?? []) {
    if (!site || !isWebUrl(site.url)) {
      continue;
    }

    const host = hostOf(site.url);
    if (excludeHosts?.has(normalizeHost(host))) {
      continue;
    }

    const key = siteKey(site.url);
    if (hiddenKeys?.has(key)) {
      continue;
    }

    const url = domainOnly ? key : site.url;
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);

    tiles.push({
      url,
      key,
      host,
      sourceUrl: site.url,
      title: site.title || host,
      favicon: site.favicon,
    });

    if (tiles.length === TILE_COUNT) {
      break;
    }
  }

  return tiles;
}
