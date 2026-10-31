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

// Memphis palette: the eighties design movement's loud primaries — hot pink,
// sunshine yellow, teal, cobalt — with a few near-blacks so the contrast test
// has white-letter backgrounds to pick from too.
export const LETTER_COLORS = [
  '#ff5d8f',
  '#ffd23f',
  '#4ecdc4',
  '#ff6b35',
  '#f7b32b',
  '#a8e6cf',
  '#b8b5ff',
  '#ffadad',
  '#3d5a80',
  '#2b2d42',
  '#6a4c93',
  '#264653',
  '#1b998b',
  '#e63946',
  '#8e5572',
  '#457b9d',
];

const LETTER_TEXT_DARK = '#14161a';
const LETTER_TEXT_LIGHT = '#ffffff';
const COLOR_RADIX = 16;
const FULL_CHANNEL = 255;
const HASH_MULTIPLIER = 31;

function channelLuminance(channel) {
  const value = channel / FULL_CHANNEL;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

// WCAG relative luminance, so the text colour choice is measurable rather than
// eyeballed.
export function relativeLuminance(hex) {
  const value = hex.replace('#', '');
  const red = Number.parseInt(value.slice(0, 2), COLOR_RADIX);
  const green = Number.parseInt(value.slice(2, 4), COLOR_RADIX);
  const blue = Number.parseInt(value.slice(4, 6), COLOR_RADIX);
  return (
    0.2126 * channelLuminance(red) +
    0.7152 * channelLuminance(green) +
    0.0722 * channelLuminance(blue)
  );
}

export function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function letterTextColor(background) {
  const againstDark = contrastRatio(background, LETTER_TEXT_DARK);
  const againstLight = contrastRatio(background, LETTER_TEXT_LIGHT);
  return againstDark >= againstLight ? LETTER_TEXT_DARK : LETTER_TEXT_LIGHT;
}

// Hashed rather than Math.random(): the palette still looks scattered across
// tiles, but a site keeps its colour when the grid re-renders.
export function letterColors(key) {
  let hash = 0;
  for (const character of String(key)) {
    hash = (hash * HASH_MULTIPLIER + character.codePointAt(0)) % 0xffffffff;
  }
  const background = LETTER_COLORS[hash % LETTER_COLORS.length];
  return { background, text: letterTextColor(background) };
}
