import { hostOf, isWebUrl, letterColors } from './topsites.js';

// One place that knows how a site icon is obtained and how it degrades. Every
// surface (tiles, card title bars, tab rows, snapshot placeholders) calls
// createSiteIcon() and gets the same behaviour: the real favicon when it is
// available offline, otherwise the generated letter badge.
const FAVICON_ENDPOINT = '/_favicon/';
const FAVICON_SIZE = 64;
const ICON_LOADED_CLASS = 'has-icon';
const NO_INITIAL = '?';

// Chromium and Firefox disagree about what they hand over, and the UA is the
// only reliable split (some Chromium builds expose a Firefox-style `browser`
// alias, so feature detection would mislead).
const IS_FIREFOX = /Firefox\//.test(globalThis.navigator?.userAgent ?? '');

// Which classes each surface expects. The wrapper is the same everywhere; only
// the class names differ so existing styling and tests keep working.
const VARIANTS = {
  tile: {
    root: 'ntp-tile-icon',
    image: 'ntp-tile-favicon',
    letter: 'ntp-tile-letter',
  },
  card: {
    root: 'ntp-card-icon',
    image: 'ntp-card-favicon',
    letter: 'ntp-card-bar-letter',
  },
  tab: {
    root: 'ntp-card-tab-icon',
    image: 'ntp-card-tab-image',
    letter: 'ntp-card-tab-letter',
  },
  placeholder: {
    root: 'ntp-card-icon ntp-card-placeholder-icons',
    image: 'ntp-card-placeholder',
    letter: 'ntp-card-placeholder-letter',
  },
};

/**
 * The favicon URL for a site, or undefined when there is none to be had
 * offline. Callers never need to know which case they are in.
 */
export function iconSource({ url, favicon } = {}) {
  if (favicon) {
    return favicon;
  }

  // Firefox only offers favIconUrl as a remote address; loading it would be a
  // network request, which this extension never makes.
  if (IS_FIREFOX) {
    return undefined;
  }

  // The Chromium favicon store only knows web pages: ask it about
  // chrome://settings and it answers with its generic globe, which would be a
  // lie. The generated letter stands in instead.
  if (!isWebUrl(url)) {
    return undefined;
  }

  const api = globalThis.browser ?? globalThis.chrome;
  const endpoint = api?.runtime?.getURL?.(FAVICON_ENDPOINT);
  if (!endpoint) {
    return undefined;
  }
  return `${endpoint}?pageUrl=${encodeURIComponent(url)}&size=${FAVICON_SIZE}`;
}

// First letter for anything without an icon: the site's host, or the text
// itself when the URL has no host to speak of.
export function siteInitial(url = '') {
  const host = hostOf(url) || String(url);
  return host.slice(0, 1).toUpperCase() || NO_INITIAL;
}

/**
 * A site icon element: the favicon when one can be loaded, with the generated
 * letter badge behind it so a failed load falls back without any extra work.
 * `variant` only picks the class names, never the behaviour.
 */
export function createSiteIcon({ url, title, favicon, variant = 'card' } = {}) {
  const names = VARIANTS[variant] ?? VARIANTS.card;

  const root = document.createElement('span');
  root.className = `site-icon ${names.root}`;

  const source = iconSource({ url, favicon });
  if (source) {
    const image = document.createElement('img');
    image.className = `site-icon-image ${names.image}`;
    image.alt = '';
    image.width = FAVICON_SIZE;
    image.height = FAVICON_SIZE;
    image.addEventListener('load', () => root.classList.add(ICON_LOADED_CLASS));
    image.addEventListener('error', () => {
      root.classList.remove(ICON_LOADED_CLASS);
      image.remove();
    });
    image.src = source;
    root.append(image);
  }

  const letter = document.createElement('span');
  letter.className = `site-icon-letter ${names.letter}`;
  letter.setAttribute('aria-hidden', 'true');

  const glyph = document.createElement('span');
  glyph.className = 'site-icon-glyph';
  const initial = (title ?? '').trim().charAt(0).toUpperCase();
  glyph.textContent = initial || siteInitial(url);
  letter.append(glyph);

  const colors = letterColors(url ?? title ?? '');
  letter.style.backgroundColor = colors.background;
  letter.style.color = colors.text;

  root.append(letter);
  return root;
}
