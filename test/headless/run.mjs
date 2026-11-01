// Headless contract tests for the NTP++ new-tab page.
//
//   node test/headless/run.mjs            # all scenarios
//   node test/headless/run.mjs --only=chrome
//
// Drives Chromium through the DevTools Protocol (no npm dependencies) and
// exercises the Chrome and Firefox (mocked `browser`) code paths.
//
// Layout assertions use the Firefox mock so the grid is always populated; the
// Chrome scenario mocks `chrome.topSites.get` for the same reason.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DIST_CHROME = path.join(ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(HERE, 'out');
const CHROME_PATH =
  process.env.CHROME_PATH ??
  'C:/Users/localuser/AppData/Local/Chromium/Application/chrome.exe';
const EN_CATALOG_PATH = path.join(
  ROOT,
  'src',
  '_locales',
  'en',
  'messages.json',
);
const EXTENSION_PAGE = 'newtab.html';

const BOOKMARK_URL = 'https://pinned.example.org/start';
const BOOKMARK_HOST = 'pinned.example.org';
const BOOKMARK_SUBDOMAIN = 'news.pinned.example.org';
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='%23cc3333'/%3E%3C/svg%3E";
const BOGUS_FAVICON = 'data:image/svg+xml,this-is-not-an-image';

// 14 sites: 10 fill the grid, #11 is the overflow refill, #13/#14 are
// duplicate domains, #3 has a broken favicon, #5 exactly matches the bookmark
// and #6 is a different host on the same registrable domain.
const MOCK_SITES = [
  {
    title: 'Alpha News — a deliberately long headline that wraps',
    url: 'https://alpha.example.com/one',
    favicon: FAVICON,
  },
  { title: 'Beta', url: 'https://beta.example.com/two', favicon: FAVICON },
  {
    title: 'Bogus Icon',
    url: 'https://bogus.example.net/unreachable',
    favicon: BOGUS_FAVICON,
  },
  { title: 'Delta', url: 'https://delta.example.com/four', favicon: FAVICON },
  { title: 'Pinned Bookmark', url: BOOKMARK_URL, favicon: FAVICON },
  {
    title: 'Pinned News',
    url: `https://${BOOKMARK_SUBDOMAIN}/sub`,
    favicon: FAVICON,
  },
  { title: 'Epsilon', url: 'https://epsilon.example.com/five', favicon: FAVICON },
  { title: 'Zeta', url: 'https://zeta.example.com/six', favicon: FAVICON },
  { title: 'Eta', url: 'https://eta.example.com/seven', favicon: FAVICON },
  { title: 'Theta', url: 'https://theta.example.com/eight', favicon: FAVICON },
  { title: 'Iota', url: 'https://iota.example.com/nine', favicon: FAVICON },
  { title: 'Kappa', url: 'https://kappa.example.com/ten', favicon: FAVICON },
  {
    title: 'Alpha Two',
    url: 'https://alpha.example.com/two',
    favicon: FAVICON,
  },
  {
    title: 'Pinned Second',
    url: 'https://pinned.example.org/second-page',
    favicon: FAVICON,
  },
];
const OVERFLOW_SITE_URL = MOCK_SITES[10].url;
const THETA_URL = MOCK_SITES[9].url;
const THETA_HOST = new URL(THETA_URL).hostname;

const RESULTS = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function check(scenario, name, fn) {
  try {
    const detail = await fn();
    RESULTS.push({ scenario, name, pass: true, detail });
    console.log(`PASS  ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    RESULTS.push({ scenario, name, pass: false, detail });
    console.log(`FAIL  ${name} — ${detail}`);
  }
}

function parseOnly(argv) {
  const arg = argv.find((item) => item.startsWith('--only='));
  if (!arg) {
    return ['chrome', 'firefox', 'layout', 'cards'];
  }
  const names = arg
    .slice('--only='.length)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const valid = names.filter((name) =>
    ['chrome', 'firefox', 'layout', 'cards'].includes(name),
  );
  if (valid.length === 0) {
    throw new Error(
      `--only expects chrome, firefox, layout or cards (got "${arg}")`,
    );
  }
  return valid;
}

function runBuild() {
  console.log('• Building extension: node scripts/build.mjs');
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `Build failed (exit ${result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  if (result.stdout?.trim()) {
    console.log(`  ${result.stdout.trim()}`);
  }
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

// Chromium derives an unpacked extension's id from its absolute path:
// SHA-256, first 16 bytes, each hex nibble mapped 0-f -> a-p.
// Windows hashes the UTF-16LE form of the native (backslash) path; POSIX uses
// UTF-8. Verified against EXTENSION_ID in chrome://extensions-internals.
function computeUnpackedExtensionId(extensionPath) {
  const absolute = path.resolve(extensionPath);
  const bytes =
    process.platform === 'win32'
      ? Buffer.from(absolute, 'utf16le')
      : Buffer.from(absolute, 'utf8');
  const hex = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  return [...hex]
    .map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)))
    .join('');
}

async function readPreferenceExtensionIds(userDataDir, distPath) {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    try {
      const prefs = JSON.parse(await readFile(prefsPath, 'utf8'));
      const ids = [];
      for (const [id, value] of Object.entries(
        prefs.extensions?.settings ?? {},
      )) {
        if (value?.path && samePath(value.path, distPath)) {
          ids.push(id);
        }
      }
      if (ids.length > 0) {
        return ids;
      }
    } catch {
      // Preferences does not exist yet (or is mid-write); retry.
    }
    await sleep(150);
  }
  return [];
}

function buildBrowserMock(catalog) {
  const bookmarkTree = [
    {
      id: '0',
      title: '',
      children: [
        {
          id: '1',
          title: 'Bookmarks bar',
          children: [
            { id: '2', title: 'Pinned Bookmark', url: BOOKMARK_URL },
            { id: '3', title: 'Theta', url: THETA_URL },
          ],
        },
      ],
    },
  ];

  return `(() => {
  const messages = ${JSON.stringify(catalog)};
  const sites = ${JSON.stringify(MOCK_SITES)};
  const bookmarkTree = ${JSON.stringify(bookmarkTree)};
  const tab = { id: 1, windowId: 1, active: true, url: location.href };

  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  });

  globalThis.browser = {
    i18n: {
      // Mirrors the real API: $name$ placeholders resolve through
      // placeholders[name].content ("$1") to the substitution at that index.
      getMessage(key, substitutions) {
        const entry = messages[key];
        if (!entry || typeof entry.message !== 'string') {
          return '';
        }
        const values =
          typeof substitutions === 'string' ? [substitutions] : substitutions || [];
        let out = entry.message.replace(/\\$([A-Za-z0-9_@]+)\\$/g, (match, name) => {
          const placeholder = entry.placeholders && entry.placeholders[name];
          if (!placeholder) {
            return match;
          }
          const index = Number(String(placeholder.content).replace(/\\$/g, ''));
          return Number.isInteger(index) && index > 0 ? String(values[index - 1] || '') : match;
        });
        // $1..$9 are predefined placeholders, so they never need declaring.
        for (let index = 0; index < values.length; index += 1) {
          out = out.split('$' + (index + 1)).join(String(values[index] || ''));
        }
        return out;
      },
    },
    topSites: {
      async get() {
        return sites.map((site) => ({ ...site }));
      },
    },
    bookmarks: {
      async getTree() {
        return bookmarkTree;
      },
    },
    tabs: {
      async getCurrent() {
        return { ...tab };
      },
      async query() {
        return [{ ...tab }];
      },
    },
    theme: {
      async getCurrent() {
        return undefined;
      },
      onUpdated: {
        addListener() {},
        removeListener() {},
      },
    },
    runtime: {
      getManifest() {
        return { version: 'test' };
      },
      getURL(path) {
        return 'chrome-extension://test/' + String(path).replace(/^\\//, '');
      },
    },
  };
})();`;
}

// Chromium 153 in this image exposes a Firefox-style `globalThis.browser`
// alias, which would flip the page's Firefox branch on. Remove it before page
// scripts so the Chrome scenario really runs the Chromium path, and supply the
// top-sites data headless Chromium cannot produce.
function buildChromePreload() {
  const sites = MOCK_SITES.map(({ title, url }) => ({ title, url }));
  return `(() => {
  try {
    delete globalThis.browser;
  } catch {}
  const sites = ${JSON.stringify(sites)};
  try {
    globalThis.chrome.topSites.get = async function topSitesGet() {
      return sites.map((site) => ({ ...site }));
    };
  } catch {}
})();`;
}

// Recently closed cards. A separate preload keeps the tile and layout
// scenarios on an empty sessions list, so their assertions stay unchanged.
const CARD_LONG_TITLE =
  'A deliberately long headline that cannot possibly fit in a title bar no matter how wide the window gets and must therefore be folded away with an ellipsis before it reaches the copy button';
const CARD_LONG_URL =
  'https://alpha.example.com/a/very/long/path/that/does/not/fit/in/the/title/bar/either/nor/in/a/wider/one/because/it/keeps/going/with/more?and=more&query=parameters#and-a-fragment';
const CARD_SNAPSHOT =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const CARD_SESSIONS = [
  { tab: { sessionId: 's-newest', title: 'Zeta', url: 'https://zeta.example.com/six' } },
  { tab: { sessionId: 's-middle', title: 'Eta', url: 'https://eta.example.com/seven' } },
  { tab: { sessionId: 's-oldest', title: CARD_LONG_TITLE, url: CARD_LONG_URL } },
  { tab: { sessionId: 's-extra', title: 'Fourth', url: 'https://iota.example.com/nine' } },
  { window: { sessionId: 's-window' } },
];
const CARD_SNAPSHOTS = [{ url: 'https://eta.example.com/seven', dataUrl: CARD_SNAPSHOT }];

// A closed window carries many tabs, which is the case the tab list exists for.
const WINDOW_TAB_COUNT = 200;
const WINDOW_HEAD = { title: 'Front page', url: 'https://front.example.com/' };
const WINDOW_TABS = Array.from({ length: WINDOW_TAB_COUNT }, (_, index) => ({
  title: `Tab number ${index + 1} with a long enough title to need folding`,
  url: `https://tabs.example.com/page/${index + 1}?with=a&fairly=long&query=string`,
  active: index === 3,
}));
WINDOW_TABS[3] = { ...WINDOW_TABS[3], ...WINDOW_HEAD };

function buildCardsPreload(catalog) {
  return `${buildBrowserMock(catalog)}
(() => {
  // Firefox user agent: sessions carry no inline icon, so cards render the
  // site initial. The icon branch is covered by the cascade probe below.
  const sessions = ${JSON.stringify(CARD_SESSIONS)};
  const snapshots = ${JSON.stringify(CARD_SNAPSHOTS)};
  const api = globalThis.browser;
  api.sessions = {
    async getRecentlyClosed() {
      return sessions;
    },
    async restore(sessionId) {
      globalThis.__restoredSession = sessionId;
    },
  };
  api.runtime.sendMessage = async (message) =>
    message && message.type === 'ntp:snapshots' ? { snapshots } : undefined;
})();`;
}

async function preloadSource(kind) {
  if (kind === 'chrome') {
    return buildChromePreload();
  }

  const catalog = JSON.parse(await readFile(EN_CATALOG_PATH, 'utf8'));
  return kind === 'cards' ? buildCardsPreload(catalog) : buildBrowserMock(catalog);
}

function createPage(cdp, sessionId, extensionUrl) {
  const page = {
    cdp,
    sessionId,
    extensionUrl,

    async evaluate(expression) {
      const result = await cdp.send(
        'Runtime.evaluate',
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
        sessionId,
      );
      if (result.exceptionDetails) {
        const description =
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'evaluation failed';
        throw new Error(description.split('\n')[0]);
      }
      return result.result.value;
    },

    async waitFor(expression, { timeout = 8000, interval = 100, label } = {}) {
      const start = Date.now();
      let lastError;
      while (Date.now() - start < timeout) {
        try {
          const value = await page.evaluate(expression);
          if (value) {
            return value;
          }
        } catch (error) {
          lastError = error;
        }
        await sleep(interval);
      }
      throw new Error(
        `Timed out after ${timeout}ms waiting for ${
          label ?? expression
        }${lastError ? ` (${lastError.message})` : ''}`,
      );
    },

    async clickAt(x, y) {
      const base = { x, y, button: 'left', clickCount: 1 };
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sessionId);
    },

    async moveMouse(x, y) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    },

    async navigate(url) {
      const loaded = waitForLoadEvent(cdp);
      await cdp.send('Page.navigate', { url }, sessionId);
      await loaded;
      await page.waitFor('document.readyState === "complete"', {
        label: 'document ready',
      });
    },

    async reload() {
      const loaded = waitForLoadEvent(cdp);
      await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
      await loaded;
      await page.waitFor('document.readyState === "complete"', {
        label: 'document ready after reload',
      });
    },
  };

  return page;
}

function waitForLoadEvent(cdp, timeout = 15000) {
  return new Promise((resolve) => {
    const off = cdp.on('Page.loadEventFired', () => {
      off();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      off();
      resolve();
    }, timeout);
  });
}

function createErrorCollector(cdp) {
  const errors = [];
  const offException = cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails;
    const text =
      details?.exception?.description ??
      details?.text ??
      'unknown exception';
    errors.push(`uncaught: ${text.split('\n')[0]}`);
  });
  const offLog = cdp.on('Log.entryAdded', (params) => {
    const entry = params.entry;
    if (!entry || entry.level !== 'error') {
      return;
    }
    // A deliberately-bogus favicon produces a resource load error; that is
    // expected test data, not a page bug. Uncaught JS still surfaces above.
    if (entry.source === 'network' || /Failed to load resource/i.test(entry.text)) {
      return;
    }
    errors.push(`log(${entry.source ?? 'unknown'}): ${entry.text}`);
  });

  return {
    errors,
    reset() {
      errors.length = 0;
    },
    off() {
      offException();
      offLog();
    },
  };
}

async function loadPage(page, { preload, clearStorage }) {
  await setPreload(page, preload);
  await page.navigate(page.extensionUrl);
  if (clearStorage) {
    await page.evaluate('localStorage.clear()');
    await page.reload();
  }
}

let preloadIdentifier;
let preloadKind = null;

async function setPreload(page, kind) {
  if (kind === preloadKind) {
    return;
  }

  if (preloadIdentifier) {
    await page.cdp.send(
      'Page.removeScriptToEvaluateOnNewDocument',
      { identifier: preloadIdentifier },
      page.sessionId,
    );
    preloadIdentifier = undefined;
  }
  preloadKind = kind;
  if (!kind) {
    return;
  }

  const source = await preloadSource(kind);
  const result = await page.cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source },
    page.sessionId,
  );
  preloadIdentifier = result.identifier;
}

async function resolveExtensionId(cdp, sessionId, userDataDir) {
  const fromPreferences = await readPreferenceExtensionIds(
    userDataDir,
    DIST_CHROME,
  );
  const computed = computeUnpackedExtensionId(DIST_CHROME);
  const candidates = [
    ...fromPreferences.map((id) => ({ id, method: 'Preferences' })),
    { id: computed, method: 'computed path hash' },
  ];
  const seen = new Set();
  const page = createPage(cdp, sessionId, '');

  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    const url = `chrome-extension://${candidate.id}/${EXTENSION_PAGE}`;
    try {
      await page.navigate(url);
    } catch {
      continue;
    }
    const loaded = await page
      .waitFor(
        `location.href.startsWith('chrome-extension://${candidate.id}/') && document.readyState === 'complete'`,
        { timeout: 4000, label: `extension page for ${candidate.id}` },
      )
      .then(() => true)
      .catch(() => false);
    if (loaded) {
      page.extensionUrl = url;
      return { ...candidate, page };
    }
  }

  throw new Error(
    `Could not load the unpacked extension. Tried: ${candidates
      .map((candidate) => `${candidate.id} (${candidate.method})`)
      .join(', ')}`,
  );
}

async function takeScreenshot(page, fileName) {
  await mkdir(OUT_DIR, { recursive: true });
  const result = await page.cdp.send(
    'Page.captureScreenshot',
    { format: 'png' },
    page.sessionId,
  );
  const target = path.join(OUT_DIR, fileName);
  await writeFile(target, Buffer.from(result.data, 'base64'));
  return path.relative(ROOT, target);
}

async function recordScreenshot(page, scenario, fileName) {
  try {
    const file = await takeScreenshot(page, fileName);
    RESULTS.push({
      scenario,
      name: `screenshot saved (${fileName})`,
      pass: true,
      detail: file,
    });
    console.log(`PASS  screenshot saved (${file})`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    RESULTS.push({
      scenario,
      name: `screenshot saved (${fileName})`,
      pass: false,
      detail,
    });
    console.log(`FAIL  screenshot saved (${fileName}) — ${detail}`);
  }
}

const VISIBLE_FN = `(element) => {
  if (!element) return false;
  if (element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}`;

const tileCountExpression = `document.querySelectorAll('#ntp-tiles .ntp-tile').length`;
const tileHrefsExpression = `[...document.querySelectorAll('#ntp-tiles .ntp-tile-link')].map((link) => link.href)`;

async function chromeScenario(page, errors) {
  console.log('\n== Chrome scenario ==');
  errors.reset();
  await loadPage(page, { preload: 'chrome', clearStorage: true });
  await page.waitFor(`${tileCountExpression} === 10`, {
    timeout: 10000,
    label: '10 chrome tiles',
  });
  await sleep(300);

  await check('chrome', 'no uncaught page errors', async () => {
    assert(
      errors.errors.length === 0,
      errors.errors.join(' | ') || 'errors recorded',
    );
    return '0 errors';
  });

  await check('chrome', '#ntp-tiles exists', async () => {
    const found = await page.waitFor(
      `Boolean(document.querySelector('#ntp-tiles'))`,
      { label: '#ntp-tiles' },
    );
    assert(found, '#ntp-tiles not found');
    return 'found';
  });

  await check(
    'chrome',
    'mocked chrome.topSites renders exactly 10 tiles',
    async () => {
      await page.waitFor(`${tileCountExpression} === 10`, {
        timeout: 10000,
        label: '10 tiles from chrome.topSites',
      });
      const count = await page.evaluate(tileCountExpression);
      assert(count === 10, `${count} tiles, expected 10`);
      return '10 tiles';
    },
  );

  await check(
    'chrome',
    'favicons use the /_favicon/ endpoint, not data URLs',
    async () => {
      const info = await page.waitFor(`(() => {
        const images = [...document.querySelectorAll('#ntp-tiles .ntp-tile-favicon')];
        const tiles = document.querySelectorAll('#ntp-tiles .ntp-tile').length;
        if (tiles !== 10) return 0;
        const endpoint = /^chrome-extension:\\/\\/[a-p]{32}\\/_favicon\\/\\?pageUrl=.+&size=64$/;
        const dataUrl = images.filter((image) => image.src.startsWith('data:'));
        const good = images.filter((image) => endpoint.test(image.src));
        return images.length > 0 && dataUrl.length === 0
          ? { images: images.length, good: good.length, sample: images[0].src }
          : 0;
      })()`, { label: 'favicon endpoint images' });
      assert(
        info.images === 10,
        `${info.images} favicon images, expected 10 (${info.sample})`,
      );
      assert(
        info.good === info.images,
        `${info.good}/${info.images} favics use /_favicon/ (${info.sample})`,
      );
      return `${info.images} /_favicon/ images`;
    },
  );

  await check(
    'chrome',
    'no .ntp-tile-remove buttons in the DOM',
    async () => {
      const count = await page.evaluate(
        `document.querySelectorAll('#ntp-tiles .ntp-tile-remove').length`,
      );
      assert(count === 0, `${count} remove button(s) rendered on Chromium`);
      return '0 remove buttons';
    },
  );

  await recordScreenshot(page, 'chrome', 'chrome-newtab.png');

  await check(
    'chrome',
    '#opt-exclude-bookmarks is disabled with is-disabled label',
    async () => {
      const state = await page.evaluate(`(() => {
        const input = document.querySelector('#opt-exclude-bookmarks');
        if (!input) return null;
        return {
          tag: input.tagName,
          disabled: input.disabled,
          labelClass: input.closest('.ntp-settings-option')?.className ?? '',
        };
      })()`);
      assert(state, '#opt-exclude-bookmarks not found');
      assert(
        state.disabled === true,
        `expected disabled, got ${JSON.stringify(state)}`,
      );
      assert(
        state.labelClass.split(/\s+/).includes('is-disabled'),
        `option label missing is-disabled class (${JSON.stringify(state)})`,
      );
      return 'disabled + .is-disabled';
    },
  );

  await check('chrome', 'settings dialog is a native <dialog>', async () => {
    const info = await page.evaluate(`(() => {
      const dialog = document.querySelector('#ntp-settings');
      if (!dialog) return null;
      return {
        tag: dialog.tagName,
        isDialog: dialog instanceof HTMLDialogElement,
      };
    })()`);
    assert(info, '#ntp-settings not found');
    assert(
      info.tag === 'DIALOG' && info.isDialog,
      `expected DIALOG, got ${JSON.stringify(info)}`,
    );
    return 'native dialog';
  });

  await check('chrome', 'settings button opens dialog', async () => {
    await page.evaluate(`(() => {
      const button = document.querySelector('#ntp-settings-button');
      if (!button) throw new Error('missing #ntp-settings-button');
      button.click();
    })()`);
    await page.waitFor(
      `document.querySelector('#ntp-settings')?.open === true`,
      { label: 'dialog open' },
    );
    return 'dialog.open === true';
  });

  await sleep(250);
  await recordScreenshot(page, 'chrome', 'chrome-settings.png');

  await check('chrome', 'dialog ::backdrop is styled', async () => {
    const style = await page.evaluate(`(() => {
      const dialog = document.querySelector('#ntp-settings');
      if (!dialog?.open) return null;
      const computed = getComputedStyle(dialog, '::backdrop');
      return {
        background: computed.backgroundColor,
        filter: computed.backdropFilter,
      };
    })()`);
    assert(style, 'dialog is not open');
    const visible =
      (style.background &&
        style.background !== 'transparent' &&
        style.background !== 'rgba(0, 0, 0, 0)') ||
      (style.filter && style.filter !== 'none');
    assert(
      visible,
      `::backdrop has no visible styling (${JSON.stringify(style)})`,
    );
    return style.background;
  });

  await check('chrome', 'clicking the backdrop closes dialog', async () => {
    const rect = await page.evaluate(`(() => {
      const dialog = document.querySelector('#ntp-settings');
      if (!dialog?.open) return null;
      const box = dialog.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    })()`);
    // The click below lands on the backdrop only if the box stays clear of it.
    assert(
      rect && rect.x > 8 && rect.y > 8,
      `dialog box covers the viewport corner (${JSON.stringify(rect)})`,
    );
    await page.clickAt(8, 8);
    await page.waitFor(
      `document.querySelector('#ntp-settings')?.open === false`,
      { label: 'dialog closed by backdrop click' },
    );
    return 'closed at (8,8)';
  });

  await check('chrome', '[data-close-settings] closes dialog', async () => {
    await page.evaluate(`(() => {
      const button = document.querySelector('#ntp-settings-button');
      if (!button) throw new Error('missing #ntp-settings-button');
      button.click();
    })()`);
    await page.waitFor(
      `document.querySelector('#ntp-settings')?.open === true`,
      { label: 'dialog reopened' },
    );
    await page.evaluate(`(() => {
      const close = document.querySelector('#ntp-settings [data-close-settings]');
      if (!close) throw new Error('missing [data-close-settings]');
      close.click();
    })()`);
    await page.waitFor(
      `document.querySelector('#ntp-settings')?.open === false`,
      { label: 'dialog closed by close button' },
    );
    return 'closed';
  });

  await check(
    'chrome',
    'tile style defaults to Chromium chrome',
    async () => {
      const info = await page.evaluate(`(() => {
        const icon = document.querySelector('#ntp-tiles .ntp-tile-icon');
        const link = document.querySelector('#ntp-tiles .ntp-tile-link');
        if (!icon || !link) return null;
        return {
          bodyClass: document.body.className,
          iconRadius: getComputedStyle(icon).borderTopLeftRadius,
          linkBackground: getComputedStyle(link).backgroundColor,
        };
      })()`);
      assert(info, 'tile markup missing');
      assert(
        !info.bodyClass.split(/\\s+/).includes('ntp-firefox-style'),
        `unexpected Firefox style class (${info.bodyClass})`,
      );
      assert(
        info.iconRadius === '50%',
        `icon backing is ${info.iconRadius}, expected 50%`,
      );
      assert(
        info.linkBackground === 'rgba(0, 0, 0, 0)',
        `tile has a background at rest (${info.linkBackground})`,
      );
      return `round icon, transparent tile (${info.iconRadius})`;
    },
  );

  await check(
    'chrome',
    'titles stay on a single line',
    async () => {
      const info = await page.evaluate(`(() => {
        const title = document.querySelector('#ntp-tiles .ntp-tile-title');
        if (!title) return null;
        const original = title.textContent;
        title.textContent =
          'A deliberately long site title that would need a second line to fit';
        const style = getComputedStyle(title);
        const height = title.getBoundingClientRect().height;
        const lineHeight = Number.parseFloat(style.lineHeight);
        title.textContent = original;
        return {
          clamp: style.getPropertyValue('-webkit-line-clamp'),
          lines: lineHeight ? Math.round(height / lineHeight) : 0,
        };
      })()`);
      assert(info, 'tile title missing');
      assert(info.clamp === '1', `line clamp was "${info.clamp}", expected 1`);
      assert(info.lines === 1, `title rendered ${info.lines} lines, expected 1`);
      return '1 line';
    },
  );

  await check(
    'chrome',
    'square favicon corners stay inside the round backing',
    async () => {
      const info = await page.evaluate(`(() => {
        const icon = document.querySelector('#ntp-tiles .ntp-tile-icon');
        const image = icon?.querySelector('.ntp-tile-favicon');
        if (!icon || !image) return null;
        const iconBox = icon.getBoundingClientRect();
        const imageBox = image.getBoundingClientRect();
        const radius = iconBox.width / 2;
        const corner = Math.hypot(imageBox.width / 2, imageBox.height / 2);
        return {
          radius,
          corner,
          gap: radius - corner,
          iconSize: iconBox.width,
          faviconSize: imageBox.width,
        };
      })()`);
      assert(info, 'icon or favicon missing');
      assert(
        Math.abs(info.gap - 5) <= 1,
        `favicon corner is ${info.gap.toFixed(1)}px from the circle edge`,
      );
      assert(
        Math.abs(info.faviconSize - 25.6) < 0.5,
        `favicon is ${info.faviconSize.toFixed(1)}px, expected the Firefox-style 25.6px`,
      );
      return `${info.faviconSize.toFixed(1)}px favicon, ${info.gap.toFixed(1)}px corner gap`;
    },
  );

  await check(
    'chrome',
    'tile titles use the full tile width without overflowing it',
    async () => {
      const info = await page.evaluate(`(() => {
        const tile = document.querySelector('#ntp-tiles .ntp-tile');
        const title = tile?.querySelector('.ntp-tile-title');
        if (!tile || !title) return null;
        const tileBox = tile.getBoundingClientRect();
        const titleBox = title.getBoundingClientRect();
        return { tile: tileBox.width, title: titleBox.width };
      })()`);
      assert(info, 'tile or title missing');
      assert(
        info.title >= info.tile - 1,
        `title box is ${info.title.toFixed(1)}px inside a ${info.tile.toFixed(1)}px tile`,
      );
      assert(
        info.title <= info.tile + 0.5,
        `title box overflows the tile (${info.title.toFixed(1)} > ${info.tile.toFixed(1)})`,
      );
      return `${info.title.toFixed(1)}px of ${info.tile.toFixed(1)}px`;
    },
  );

  await check(
    'chrome',
    'the debug switch turns tile icons into letters',
    async () => {
      const readTiles = `(() => {
        const visible = ${VISIBLE_FN};
        return [...document.querySelectorAll('#ntp-tiles .ntp-tile-icon')].map((icon) => {
          const image = icon.querySelector('img');
          const letter = icon.querySelector('.ntp-tile-letter');
          return {
            image: Boolean(image) && visible(image),
            letter: Boolean(letter) && visible(letter),
            text: letter ? letter.textContent.trim() : '',
          };
        });
      })()`;

      const before = await page.evaluate(readTiles);
      assert(before.length === 10, `${before.length} tiles before the switch`);
      assert(
        before.every((tile) => tile.image && !tile.letter),
        'a tile was not showing its icon before the switch',
      );

      const toggle = async (checked) => {
        await page.evaluate(`(() => {
          const dialog = document.getElementById('ntp-settings');
          if (!dialog.open) {
            dialog.showModal();
          }
          const box = document.getElementById('opt-letter-favicons');
          box.checked = ${checked};
          box.dispatchEvent(new Event('change'));
        })()`);
      };

      await toggle(true);
      const degraded = await page.evaluate(readTiles);
      assert(
        degraded.every((tile) => !tile.image && tile.letter && tile.text.length > 0),
        `after the switch: ${JSON.stringify(degraded)}`,
      );

      const badges = await page.evaluate(`(() => {
        const letters = [...document.querySelectorAll('#ntp-tiles .ntp-tile-letter')];
        return letters.map((letter) => {
          const box = letter.getBoundingClientRect();
          const glyph = letter.querySelector('.site-icon-glyph');
          const rect = glyph.getBoundingClientRect();
          const style = getComputedStyle(letter);
          const glyphStyle = getComputedStyle(glyph);
          const tilt = new DOMMatrix(glyphStyle.transform).b;
          return {
            background: style.backgroundColor,
            color: style.color,
            glyphColor: glyphStyle.color,
            radius: Number.parseFloat(style.borderTopLeftRadius) / (style.borderTopLeftRadius.endsWith('%') ? 100 : 1),
            width: box.width,
            height: box.height,
            tilt,
            overspillX: rect.right - box.right,
            overspillY: rect.bottom - box.bottom,
            centreX: box.left + box.width / 2,
            centreY: box.top + box.height / 2,
            glyphCentreX: rect.left + rect.width / 2,
            glyphCentreY: rect.top + rect.height / 2,
            borderWidth: Number.parseFloat(style.borderTopWidth),
            overflow: style.overflow,
            userSelect: style.userSelect,
          };
        });
      })()`);
      assert(badges.length === 10, `letter badges: ${badges.length}`);
      for (const badge of badges) {
        assert(
          badge.background !== 'rgba(0, 0, 0, 0)' && badge.background !== 'transparent',
          `no fill: ${badge.background}`,
        );
        assert(
          badge.color === badge.glyphColor,
          `glyph colour drifts from its badge: ${badge.color} vs ${badge.glyphColor}`,
        );
        assert(badge.borderWidth === 0, `badge has an outline: ${badge.borderWidth}`);
        assert(
          Math.abs(badge.width - badge.height) < 1,
          `badge is not square: ${badge.width}x${badge.height}`,
        );
        assert(
          badge.radius > 0.05 && badge.radius < 0.5,
          `badge corners are not a rounded rectangle: ${badge.radius}`,
        );
        assert(Math.abs(badge.tilt) > 0.05, `glyph is not tilted: ${badge.tilt}`);
        assert(badge.overspillX > 0, `glyph never leaves the badge: ${badge.overspillX}`);
        assert(badge.overspillY > 0, `glyph never leaves the badge: ${badge.overspillY}`);
        assert(
          badge.glyphCentreX > badge.centreX && badge.glyphCentreY > badge.centreY,
          `glyph is not sitting in the lower right: ${badge.glyphCentreX},${badge.glyphCentreY} in ${badge.centreX},${badge.centreY}`,
        );
        assert(badge.overflow === 'hidden', `glyph overspill is visible: ${badge.overflow}`);
        assert(badge.userSelect === 'none', `glyph can be selected: ${badge.userSelect}`);
      }
      assert(
        new Set(badges.map((badge) => badge.background)).size > 3,
        `the palette collapsed to one colour: ${badges[0].background}`,
      );
      assert(
        new Set(badges.map((badge) => badge.color)).size === 2,
        `text colours: ${[...new Set(badges.map((badge) => badge.color))].join(', ')}`,
      );
      await page.evaluate(`document.getElementById('ntp-settings').close()`);
      await recordScreenshot(page, 'chrome', 'chrome-letter-icons.png');

      await toggle(false);
      const restored = await page.evaluate(readTiles);
      assert(
        restored.every((tile) => tile.image && !tile.letter),
        'icons did not come back when the switch was turned off',
      );
      await page.evaluate(`document.getElementById('ntp-settings').close()`);

      return `10 tiles: ${degraded[0].text} … then icons again`;
    },
  );

  await check(
    'chrome',
    'a partial last row stays centered',
    async () => {
      const info = await page.evaluate(`(() => {
        const list = document.querySelector('#ntp-tiles');
        const tiles = [...list.querySelectorAll('.ntp-tile')];
        if (tiles.length !== 10) return null;
        const removed = tiles.pop();
        removed.remove();
        const secondRow = tiles.slice(5);
        const first = secondRow[0].getBoundingClientRect();
        const last = secondRow[secondRow.length - 1].getBoundingClientRect();
        const box = list.getBoundingClientRect();
        const result = {
          count: tiles.length,
          leftGap: first.left - box.left,
          rightGap: box.right - last.right,
        };
        list.append(removed);
        return result;
      })()`);
      assert(info, 'expected 10 tiles before the check');
      assert(
        Math.abs(info.leftGap - info.rightGap) < 2,
        `9 tiles: last row is ${info.leftGap.toFixed(1)}px from the left and ` +
          `${info.rightGap.toFixed(1)}px from the right`,
      );
      return `${info.count} tiles, second row centered`;
    },
  );

  await check(
    'chrome',
    'hovering a tile draws the 3px tile background',
    async () => {
      const point = await page.evaluate(`(() => {
        const tile = document.querySelector('#ntp-tiles .ntp-tile');
        const box = tile.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`);
      await page.moveMouse(point.x, point.y);
      const style = await page.waitFor(`(() => {
        const link = document.querySelector('#ntp-tiles .ntp-tile-link');
        if (!link || !link.matches(':hover')) return 0;
        const computed = getComputedStyle(link);
        return computed.backgroundColor !== 'rgba(0, 0, 0, 0)'
          ? {
              background: computed.backgroundColor,
              radius: computed.borderTopLeftRadius,
            }
          : 0;
      })()`, { label: 'hover tile background' });
      assert(
        style.radius === '3px',
        `hover tile radius was ${style.radius}, expected 3px`,
      );
      await recordScreenshot(page, 'chrome', 'chrome-hover.png');
      await page.moveMouse(4, 4);
      await page.waitFor(`(() => {
        const link = document.querySelector('#ntp-tiles .ntp-tile-link');
        return link && getComputedStyle(link).backgroundColor === 'rgba(0, 0, 0, 0)';
      })()`, { label: 'hover tile background cleared' });
      return `3px radius, ${style.background}`;
    },
  );

  await check(
    'chrome',
    'tile style switch applies the Firefox style immediately',
    async () => {
      await page.evaluate(`(() => {
        const input = document.querySelector('#opt-firefox-style');
        if (!input) throw new Error('missing #opt-firefox-style');
        input.click();
      })()`);
      const switched = await page.waitFor(`(() => {
        const icon = document.querySelector('#ntp-tiles .ntp-tile-icon');
        if (!icon) return 0;
        const radius = getComputedStyle(icon).borderTopLeftRadius;
        return document.body.classList.contains('ntp-firefox-style') &&
          radius === '8px' ? { radius } : 0;
      })()`, { label: 'Firefox-style tiles applied' });
      await recordScreenshot(page, 'chrome', 'chrome-firefox-style.png');
      const stored = await page.evaluate(
        `localStorage.getItem('ntp-tile-style')`,
      );
      assert(stored === 'true', `style flag was stored as ${stored}`);
      await page.evaluate(`document.querySelector('#opt-firefox-style').click()`);
      await page.waitFor(
        `!document.body.classList.contains('ntp-firefox-style')`,
        { label: 'Chromium-style tiles restored' },
      );
      return `icon radius ${switched.radius}, persisted, restored`;
    },
  );

  await check(
    'chrome',
    'domain-only rewrites every tile to its origin',
    async () => {
      await page.evaluate(`(() => {
        const input = document.querySelector('#opt-domain-only');
        if (!input) throw new Error('missing #opt-domain-only');
        input.click();
      })()`);
      const info = await page.waitFor(`(() => {
        const links = [...document.querySelectorAll('#ntp-tiles .ntp-tile-link')];
        if (links.length !== 10) return 0;
        const ok = links.every((link) =>
          link.href.endsWith('/') &&
          new URL(link.href).pathname === '/'
        );
        return ok ? { count: links.length } : 0;
      })()`, { label: 'all chrome tile links rewritten to origins' });
      const checked = await page.evaluate(
        `document.querySelector('#opt-domain-only')?.checked === true`,
      );
      assert(checked, 'domain-only checkbox is not checked');
      return `${info.count} links rewritten`;
    },
  );

  await check(
    'chrome',
    'no uncaught page errors after settings interaction',
    async () => {
      assert(
        errors.errors.length === 0,
        errors.errors.join(' | ') || 'errors recorded',
      );
      return '0 errors';
    },
  );
}

async function firefoxScenario(page, errors) {
  console.log('\n== Firefox (mocked browser) scenario ==');
  errors.reset();
  await loadPage(page, { preload: 'firefox', clearStorage: true });
  await sleep(300);

  await check(
    'firefox',
    'Firefox user-agent override is active',
    async () => {
      const ua = await page.evaluate('navigator.userAgent');
      assert(
        typeof ua === 'string' && ua.includes('Firefox/'),
        `navigator.userAgent does not look like Firefox: ${ua}`,
      );
      return ua;
    },
  );

  await check('firefox', 'renders exactly 10 tiles from 14 sites', async () => {
    const count = await page.waitFor(
      `${tileCountExpression} === 10 ? 10 : 0`,
      { label: '10 tiles' },
    );
    return `${count} tiles`;
  });

  await check(
    'firefox',
    'remove buttons match the tile count',
    async () => {
      const info = await page.evaluate(`(() => ({
        tiles: document.querySelectorAll('#ntp-tiles .ntp-tile').length,
        removes: document.querySelectorAll('#ntp-tiles .ntp-tile-remove').length,
      }))()`);
      assert(info.tiles === 10, `${info.tiles} tiles, expected 10`);
      assert(
        info.removes === info.tiles,
        `${info.removes} remove buttons for ${info.tiles} tiles`,
      );
      return `${info.removes}/${info.tiles}`;
    },
  );

  await check(
    'firefox',
    'Firefox style is the default there: 8px icon backing, no tile background',
    async () => {
      const info = await page.evaluate(`(() => {
        const icon = document.querySelector('#ntp-tiles .ntp-tile-icon');
        const link = document.querySelector('#ntp-tiles .ntp-tile-link');
        if (!icon || !link) return null;
        return {
          bodyClass: document.body.className,
          iconRadius: getComputedStyle(icon).borderTopLeftRadius,
          linkBackground: getComputedStyle(link).backgroundColor,
          styleChecked: document.querySelector('#opt-firefox-style')?.checked,
          iconSize: icon.getBoundingClientRect().width,
        };
      })()`);
      assert(info, 'tile markup missing');
      assert(
        info.bodyClass.split(/\\s+/).includes('ntp-firefox-style'),
        `body missing ntp-firefox-style (${info.bodyClass})`,
      );
      assert(
        info.iconRadius === '8px',
        `icon backing is ${info.iconRadius}, expected 8px`,
      );
      assert(
        info.linkBackground === 'rgba(0, 0, 0, 0)',
        `Firefox tiles must not draw a tile background (${info.linkBackground})`,
      );
      assert(info.styleChecked === true, 'style checkbox not checked on Firefox');
      assert(
        Math.abs(info.iconSize - 40) < 0.5,
        `Firefox icon backing is ${info.iconSize.toFixed(1)}px, expected 40px`,
      );
      return `8px icon radius, 40px backing, transparent tile`;
    },
  );

  await check(
    'firefox',
    'titles wrap onto at most two lines',
    async () => {
      const info = await page.evaluate(`(() => {
        const title = document.querySelector('#ntp-tiles .ntp-tile-title');
        if (!title) return null;
        const original = title.textContent;
        title.textContent =
          'A deliberately long site title that needs to wrap onto a second line and then be clipped';
        const style = getComputedStyle(title);
        const height = title.getBoundingClientRect().height;
        const lineHeight = Number.parseFloat(style.lineHeight);
        title.textContent = original;
        return {
          clamp: style.getPropertyValue('-webkit-line-clamp'),
          lines: lineHeight ? Math.round(height / lineHeight) : 0,
        };
      })()`);
      assert(info, 'tile title missing');
      assert(info.clamp === '2', `line clamp was "${info.clamp}", expected 2`);
      assert(info.lines === 2, `title rendered ${info.lines} lines, expected 2`);
      return '2 lines';
    },
  );

  await check(
    'firefox',
    'remove buttons stay hidden until the tile is hovered',
    async () => {
      const atRest = await page.evaluate(`(() => {
        const tile = document.querySelector('#ntp-tiles .ntp-tile');
        const button = tile?.querySelector('.ntp-tile-remove');
        const icon = tile?.querySelector('.ntp-tile-icon');
        if (!button || !icon) return null;
        return {
          opacity: getComputedStyle(button).opacity,
          shadow: getComputedStyle(icon).boxShadow,
        };
      })()`);
      assert(atRest?.opacity === '0', `remove button opacity at rest was ${atRest?.opacity}`);
      assert(atRest?.shadow === 'none', `icon shadow at rest was ${atRest?.shadow}`);

      const point = await page.evaluate(`(() => {
        const tile = document.querySelector('#ntp-tiles .ntp-tile');
        const box = tile.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`);
      await page.moveMouse(point.x, point.y);
      const hovered = await page.waitFor(`(() => {
        const tile = document.querySelector('#ntp-tiles .ntp-tile');
        const button = tile?.querySelector('.ntp-tile-remove');
        const icon = tile?.querySelector('.ntp-tile-icon');
        if (!button || !icon) return 0;
        const transform = getComputedStyle(icon).transform;
        const shadow = getComputedStyle(icon).boxShadow;
        return getComputedStyle(button).opacity === '1' &&
          transform.startsWith('matrix(') && shadow !== 'none'
          ? { transform, shadow }
          : 0;
      })()`, { label: 'hover reveals remove button, scales icon and adds a shadow' });
      const scale = Number.parseFloat(hovered.transform.slice('matrix('.length));
      assert(
        Math.abs(scale - 1.3) < 0.01,
        `icon hover scale was ${scale}, expected 1.3`,
      );
      assert(
        hovered.shadow.includes('0, 0, 0'),
        `icon hover shadow was ${hovered.shadow}`,
      );
      await recordScreenshot(page, 'firefox', 'firefox-hover.png');

      await page.moveMouse(4, 4);
      await page.waitFor(`(() => {
        const tile = document.querySelector('#ntp-tiles .ntp-tile');
        const button = tile?.querySelector('.ntp-tile-remove');
        const icon = tile?.querySelector('.ntp-tile-icon');
        return button && getComputedStyle(button).opacity === '0' &&
          getComputedStyle(icon).boxShadow === 'none';
      })()`, { label: 'remove button hidden and shadow gone again' });

      return `opacity 0 -> 1 (${hovered.transform}, ${hovered.shadow}) -> 0`;
    },
  );

  await recordScreenshot(page, 'firefox', 'firefox-newtab.png');

  await check('firefox', 'broken favicon falls back to letter', async () => {
    const info = await page.waitFor(`(() => {
      const visible = ${VISIBLE_FN};
      const link = [...document.querySelectorAll('#ntp-tiles .ntp-tile-link')]
        .find((item) => item.href === ${JSON.stringify(MOCK_SITES[2].url)});
      if (!link) return 0;
      const tile = link.closest('.ntp-tile');
      const image = tile?.querySelector('img');
      const letter = tile?.querySelector('[data-tile-letter], .ntp-tile-letter');
      const result = {
        imageVisible: Boolean(image) && visible(image),
        letterVisible: Boolean(letter) && visible(letter),
        letterText: letter?.textContent ?? '',
      };
      return result.letterVisible && !result.imageVisible ? result : 0;
    })()`, { label: 'letter fallback visible' });
    assert(
      info.letterText.trim() === 'B',
      `letter text was "${info.letterText}", expected "B"`,
    );
    return 'image hidden, letter "B" visible';
  });

  await check(
    'firefox',
    'remove refills grid with the 11th site',
    async () => {
      const hrefs = await page.evaluate(tileHrefsExpression);
      assert(hrefs.length === 10, `${hrefs.length} tiles before removal`);
      assert(
        !hrefs.includes(OVERFLOW_SITE_URL),
        `${OVERFLOW_SITE_URL} was already visible before removal`,
      );
      const firstHref = hrefs[0];

      await page.evaluate(`(() => {
        const button = document.querySelector('#ntp-tiles .ntp-tile .ntp-tile-remove');
        if (!button) throw new Error('missing .ntp-tile-remove');
        button.click();
      })()`);

      await page.waitFor(
        `![...document.querySelectorAll('#ntp-tiles .ntp-tile-link')].some((link) => link.href === ${JSON.stringify(firstHref)})`,
        { label: 'removed tile href gone' },
      );
      await page.waitFor(
        `[...document.querySelectorAll('#ntp-tiles .ntp-tile-link')].some((link) => link.href === ${JSON.stringify(OVERFLOW_SITE_URL)})`,
        { label: '11th site appears' },
      );
      const count = await page.evaluate(tileCountExpression);
      assert(count === 10, `${count} tiles after refill, expected 10`);

      const hidden = await page.evaluate(
        `JSON.parse(localStorage['ntp-hidden-sites'] || '[]')`,
      );
      const origin = `${new URL(firstHref).origin}/`;
      assert(
        Array.isArray(hidden) && hidden.includes(origin),
        `localStorage['ntp-hidden-sites'] does not include ${origin} (${JSON.stringify(hidden)})`,
      );
      return `11th site refilled, ${origin} hidden`;
    },
  );

  await loadPage(page, { preload: 'firefox', clearStorage: true });

  await check(
    'firefox',
    'exclude bookmarks drops exact host, keeps subdomain',
    async () => {
      await page.waitFor(`${tileCountExpression} > 0`, { label: 'tiles' });
      const hasHostExpression = (host) =>
        `[...document.querySelectorAll('#ntp-tiles .ntp-tile-link')].some((link) => new URL(link.href).hostname === ${JSON.stringify(host)})`;

      await page.waitFor(hasHostExpression(BOOKMARK_HOST), {
        label: `initial ${BOOKMARK_HOST} tile`,
      });
      assert(
        await page.evaluate(hasHostExpression(BOOKMARK_SUBDOMAIN)),
        `${BOOKMARK_SUBDOMAIN} tile missing before toggle`,
      );
      await page.waitFor(hasHostExpression(THETA_HOST), {
        label: `initial ${THETA_HOST} tile`,
      });
      const storageBefore = await page.evaluate(
        `JSON.stringify({ ...localStorage })`,
      );

      await page.evaluate(`(() => {
        const input = document.querySelector('#opt-exclude-bookmarks');
        if (!input) throw new Error('missing #opt-exclude-bookmarks');
        input.click();
      })()`);

      await page.waitFor(`!(${hasHostExpression(BOOKMARK_HOST)})`, {
        label: 'bookmarked host removed',
      });
      const subdomainStillThere = await page.evaluate(
        hasHostExpression(BOOKMARK_SUBDOMAIN),
      );
      assert(
        subdomainStillThere,
        `${BOOKMARK_SUBDOMAIN} should survive exclude-bookmarks`,
      );
      assert(
        await page.evaluate(`!(${hasHostExpression(THETA_HOST)})`),
        `second bookmarked host ${THETA_HOST} should be dropped`,
      );
      await page.waitFor(
        `[...document.querySelectorAll('#ntp-tiles .ntp-tile-link')].some((link) => link.href === ${JSON.stringify(OVERFLOW_SITE_URL)})`,
        { label: 'overflow site backfills after bookmark exclusion' },
      );

      const checked = await page.evaluate(
        `document.querySelector('#opt-exclude-bookmarks')?.checked === true`,
      );
      assert(checked, 'exclude-bookmarks checkbox is not checked');

      const storageAfter = await page.evaluate(
        `JSON.stringify({ ...localStorage })`,
      );
      assert(
        storageAfter !== storageBefore,
        'localStorage did not change immediately after the toggle',
      );
      return 'bookmarked hosts gone, subdomain kept, overflow refilled';
    },
  );

  await page.reload();

  await check(
    'firefox',
    'exclude-bookmarks survives reload',
    async () => {
      await page.waitFor(`${tileCountExpression} > 0`, { label: 'tiles' });
      const hasHostExpression = (host) =>
        `[...document.querySelectorAll('#ntp-tiles .ntp-tile-link')].some((link) => new URL(link.href).hostname === ${JSON.stringify(host)})`;
      await page.waitFor(`!(${hasHostExpression(BOOKMARK_HOST)})`, {
        label: 'bookmarked host still absent after reload',
      });
      assert(
        await page.evaluate(hasHostExpression(BOOKMARK_SUBDOMAIN)),
        `${BOOKMARK_SUBDOMAIN} missing after reload`,
      );
      assert(
        await page.evaluate(`!(${hasHostExpression(THETA_HOST)})`),
        `${THETA_HOST} reappeared after reload`,
      );
      const checked = await page.evaluate(
        `document.querySelector('#opt-exclude-bookmarks')?.checked === true`,
      );
      assert(checked, 'exclude-bookmarks checkbox did not survive reload');
      return 'persisted';
    },
  );

  await loadPage(page, { preload: 'firefox', clearStorage: true });

  await check('firefox', 'domain-only rewrites links to origins', async () => {
    await page.waitFor(`${tileCountExpression} > 0`, { label: 'tiles' });
    await page.evaluate(`(() => {
      const input = document.querySelector('#opt-domain-only');
      if (!input) throw new Error('missing #opt-domain-only');
      input.click();
    })()`);
    const info = await page.waitFor(`(() => {
      const links = [...document.querySelectorAll('#ntp-tiles .ntp-tile-link')];
      if (links.length === 0) return 0;
      const rewritten = links.every((link) =>
        link.href.endsWith('/') && new URL(link.href).pathname === '/'
      );
      if (rewritten) {
        return { count: links.length };
      }
      return 0;
    })()`, { label: 'all tile links rewritten to origins' });
    const checked = await page.evaluate(
      `document.querySelector('#opt-domain-only')?.checked === true`,
    );
    assert(checked, 'domain-only checkbox is not checked');
    return `${info.count} links rewritten`;
  });

  await page.reload();

  await check(
    'firefox',
    'domain-only survives reload',
    async () => {
      await page.waitFor(`${tileCountExpression} > 0`, { label: 'tiles' });
      const info = await page.waitFor(`(() => {
        const links = [...document.querySelectorAll('#ntp-tiles .ntp-tile-link')];
        if (links.length === 0) return 0;
        const rewritten = links.every((link) =>
          link.href.endsWith('/') && new URL(link.href).pathname === '/'
        );
        return rewritten ? { count: links.length } : 0;
      })()`, { label: 'domain-only links after reload' });
      const checked = await page.evaluate(
        `document.querySelector('#opt-domain-only')?.checked === true`,
      );
      assert(checked, 'domain-only checkbox did not survive reload');
      return `${info.count} links still roots`;
    },
  );

  await check('firefox', 'no uncaught page errors', async () => {
    assert(
      errors.errors.length === 0,
      errors.errors.join(' | ') || 'errors recorded',
    );
    return '0 errors';
  });
}

async function layoutScenario(page, errors) {
  console.log('\n== Layout scenario (Firefox mock) ==');
  errors.reset();
  await loadPage(page, { preload: 'firefox', clearStorage: true });
  await page.waitFor(`${tileCountExpression} === 10`, {
    timeout: 10000,
    label: '10 tiles',
  });

  const layoutInfoExpression = `(() => {
    const grid = document.querySelector('#ntp-tiles');
    const root = document.documentElement;
    let columns = 0;
    if (grid) {
      const template = getComputedStyle(grid).gridTemplateColumns;
      if (template && template !== 'none') {
        columns = template.split(' ').filter(Boolean).length;
      }
      if (!columns) {
        columns = new Set(
          [...grid.querySelectorAll('.ntp-tile')].map((tile) => tile.offsetLeft),
        ).size;
      }
    }
    return {
      tiles: grid ? grid.querySelectorAll('.ntp-tile').length : 0,
      columns,
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  })()`;

  const viewports = [
    { width: 1280, height: 720, expectedColumns: 5 },
    { width: 480, height: 800, maxColumns: 5 },
    { width: 1920, height: 1080, expectedColumns: 5 },
  ];

  for (const viewport of viewports) {
    const label = `${viewport.width}x${viewport.height}`;
    await page.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      },
      page.sessionId,
    );
    await page.evaluate(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await sleep(150);

    let info;
    try {
      info = await page.evaluate(layoutInfoExpression);
    } catch (error) {
      info = { error: error.message };
    }

    await check('layout', `${label}: no scrollbars`, async () => {
      assert(!info.error, info.error);
      assert(
        info.scrollWidth <= info.innerWidth,
        `documentElement.scrollWidth ${info.scrollWidth} > innerWidth ${info.innerWidth}`,
      );
      assert(
        info.scrollHeight <= info.innerHeight,
        `documentElement.scrollHeight ${info.scrollHeight} > innerHeight ${info.innerHeight}`,
      );
      return `scroll ${info.scrollWidth}x${info.scrollHeight} <= viewport ${info.innerWidth}x${info.innerHeight}`;
    });

    try {
      const file = await takeScreenshot(page, `layout-${label}.png`);
      RESULTS.push({
        scenario: 'layout',
        name: `${label}: screenshot saved`,
        pass: true,
        detail: file,
      });
      console.log(`PASS  ${label}: screenshot saved (${file})`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      RESULTS.push({
        scenario: 'layout',
        name: `${label}: screenshot saved`,
        pass: false,
        detail,
      });
      console.log(`FAIL  ${label}: screenshot saved — ${detail}`);
    }

    const columnCheck = viewport.expectedColumns
      ? {
          name: `${label}: grid has ${viewport.expectedColumns} columns`,
          test: (columns) => columns === viewport.expectedColumns,
          expected: `=== ${viewport.expectedColumns}`,
        }
      : {
          name: `${label}: grid has at most ${viewport.maxColumns} columns`,
          test: (columns) =>
            columns >= 1 && columns <= viewport.maxColumns,
          expected: `1..${viewport.maxColumns}`,
        };
    await check('layout', columnCheck.name, async () => {
      assert(!info.error, info.error);
      assert(info.tiles === 10, `${info.tiles} tiles, expected 10`);
      assert(
        columnCheck.test(info.columns),
        `grid has ${info.columns} columns, expected ${columnCheck.expected}`,
      );
      return `${info.columns} columns`;
    });
  }

  await page.cdp.send(
    'Emulation.clearDeviceMetricsOverride',
    {},
    page.sessionId,
  );
  await check('layout', 'no uncaught page errors', async () => {
    assert(
      errors.errors.length === 0,
      errors.errors.join(' | ') || 'errors recorded',
    );
    return '0 errors';
  });
}

function translateY(transform) {
  const match = /matrix\(([^)]+)\)/.exec(transform ?? '');
  return match ? Number(match[1].split(',')[5]) : 0;
}

// The cards are sized from the stage they fill, so the scenarios need real
// viewport sizes rather than the headless window's default 758x391.
const CARD_VIEWPORT_WIDTH = 1440;
const CARD_VIEWPORT_HEIGHT = 900;
const NARROW_VIEWPORT_WIDTH = 420;
const NARROW_VIEWPORT_HEIGHT = 800;

async function setViewport(page, width, height) {
  await page.cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
    page.sessionId,
  );
}

// Geometry of the newest card against the stage that holds it, read once so
// both the short-window and the landscape checks measure the same things.
const cardGeometry = `(() => {
  const card = document.querySelectorAll('.ntp-card:not(.ntp-session-list)')[2];
  const rect = card.getBoundingClientRect();
  const stage = document.getElementById('ntp-recent');
  const box = stage.getBoundingClientRect();
  return {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    stageWidth: Math.round(box.width),
    stageTop: Math.round(box.top),
    stageBottom: Math.round(box.bottom),
    stageHeight: Math.round(box.height),
    liftedTop: Math.round(
      Math.min(
        ...[...stage.children]
          .filter((child) => !child.hidden)
          .map((child) => child.getBoundingClientRect().top),
      ),
    ),
    reserved: Math.round(parseFloat(getComputedStyle(stage).marginBlockStart)),
    screenRatio: window.screen.width / window.screen.height,
  };
})()`;

function assertCardFillsStage(info) {
  // The card is exactly as wide as its stage, and as tall as the display ratio
  // makes it. Height is never clamped to the viewport: a short window lets the
  // card run off the bottom edge rather than squash it.
  assert(
    Math.abs(info.width - info.stageWidth) < 2,
    `card is ${info.width}px wide, expected the full stage width ${info.stageWidth}px`,
  );
  const ratio = info.width / info.height;
  assert(
    Math.abs(ratio - info.screenRatio) < 0.02,
    `card ratio ${ratio.toFixed(3)} vs screen ${info.screenRatio.toFixed(3)} (${info.width}x${info.height})`,
  );
  // Nothing may shrink the card to fit vertically.
  assert(
    Math.abs(info.height - info.width / info.screenRatio) < 2,
    `card is ${info.height}px tall, expected ${(info.width / info.screenRatio).toFixed(1)} at ratio ${info.screenRatio.toFixed(2)}`,
  );
  // The lifted cards fill the room the stage's top margin reserved for them,
  // so there is no blank band between the tiles and the stack.
  assert(
    Math.abs(info.liftedTop - (info.stageTop - info.reserved)) < 2,
    `blank above the stack: top card at ${info.liftedTop}, want ${info.stageTop - info.reserved}`,
  );
  return `${info.width}x${info.height} at ratio ${info.screenRatio.toFixed(2)}, stage ${info.stageWidth}x${info.stageHeight}`;
}

async function cardsScenario(page, errors) {
  console.log('\n== Recent cards scenario ==');
  errors.reset();
  // A desktop-sized viewport: the cards are sized from the stage they fill, so
  // the headless window's default 758x391 leaves them only a few dozen px tall.
  await setViewport(page, CARD_VIEWPORT_WIDTH, CARD_VIEWPORT_HEIGHT);
  await loadPage(page, { preload: 'cards', clearStorage: true });
  await page.waitFor(`document.querySelectorAll('.ntp-card:not(.ntp-session-list)').length === 2`, {
    timeout: 10000,
    label: '2 recent cards',
  });
  await sleep(300);

  await check('cards', 'the recent count defaults to 2', async () => {
    const value = await page.evaluate(
      `document.getElementById('opt-recent-count').value`,
    );
    assert(value === '2', `default is ${value}`);
    return `default ${value}`;
  });

  await check('cards', 'caps the stack at 3 and paints the newest on top', async () => {
    await page.evaluate(`(() => {
      const select = document.getElementById('opt-recent-count');
      select.value = '3';
      select.dispatchEvent(new Event('change'));
    })()`);
    await page.waitFor(`document.querySelectorAll('.ntp-card:not(.ntp-session-list)').length === 3`, {
      timeout: 3000,
      label: 'three cards',
    });
    const hrefs = await page.evaluate(
      `[...document.querySelectorAll('.ntp-card-open')].map((link) => link.href)`,
    );
    assert(hrefs.length === 3, `${hrefs.length} cards rendered`);
    assert(
      hrefs[2] === 'https://zeta.example.com/six',
      `top card is ${hrefs[2]}`,
    );
    assert(hrefs[0] === CARD_LONG_URL, `bottom card is ${hrefs[0]}`);
    return hrefs.length + ' cards, newest last';
  });

  await check('cards', 'the stack tapers and peeks past the viewport', async () => {
    const info = await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.ntp-card:not(.ntp-session-list)')];
      const rects = cards.map((card) => card.getBoundingClientRect());
      const bar = cards[2].querySelector('.ntp-card-bar').getBoundingClientRect();
      return {
        widths: rects.map((rect) => Math.round(rect.width)),
        tops: rects.map((rect) => Math.round(rect.top)),
        bottoms: rects.map((rect) => Math.round(rect.bottom)),
        barHeight: Math.round(bar.height),
        innerHeight: window.innerHeight,
      };
    })()`);
    // DOM order is oldest -> newest, so widths must grow towards the newest.
    assert(
      info.widths[0] < info.widths[1] && info.widths[1] < info.widths[2],
      `cards are not tapered: ${info.widths.join('/')}`,
    );
    const peeks = [info.tops[2] - info.tops[1], info.tops[1] - info.tops[0]];
    assert(
      peeks.every(
        (peek) => peek > info.barHeight * 1.3 && peek < info.barHeight * 1.7,
      ),
      `peek is ${peeks.join('/')}px, bar is ${info.barHeight}px`,
    );
    assert(
      info.bottoms[2] > info.innerHeight,
      `newest card ends at ${info.bottoms[2]} in a ${info.innerHeight}px viewport`,
    );
    return `${info.widths.join('/')}px wide, newest cut off at the bottom`;
  });

  await check('cards', 'card group fills the stage at the display ratio', async () => {
    const info = await page.evaluate(cardGeometry);
    return assertCardFillsStage(info);
  });

  await check('cards', 'long title and url fold with one shared limit', async () => {
    const info = await page.evaluate(`(() => {
      const labels = [...document.querySelectorAll('.ntp-card-label')];
      const oldest = labels[0];
      const newest = labels[labels.length - 1];
      return {
        title: oldest.querySelector('.ntp-card-title').textContent,
        url: oldest.querySelector('.ntp-card-url').textContent,
        joined: oldest.textContent,
        shortTitle: newest.querySelector('.ntp-card-title').textContent,
        shortUrl: newest.querySelector('.ntp-card-url').textContent,
      };
    })()`);

    assert(
      info.joined.includes(' - '),
      `title and url are not joined with a separator: ${info.joined}`,
    );
    assert(info.title.endsWith('…'), `title not folded: ${info.title}`);
    assert(info.url.endsWith('…'), `url not folded: ${info.url}`);
    assert(
      info.title.length === info.url.length,
      `folding limits differ: ${info.title.length} vs ${info.url.length}`,
    );
    assert(info.shortTitle === 'Zeta', `short title changed: ${info.shortTitle}`);
    assert(
      info.shortUrl === 'https://zeta.example.com/six',
      `short url changed: ${info.shortUrl}`,
    );
    return `${info.title.length} characters per field`;
  });

  await check('cards', 'snapshot lands only on the matching url', async () => {
    const flags = await page.evaluate(
      `[...document.querySelectorAll('.ntp-card:not(.ntp-session-list)')].map((card) => Boolean(card.querySelector('.ntp-card-snapshot img:not(.ntp-card-placeholder)')))`,
    );
    assert(flags[1] === true, 'the matching card has no snapshot');
    assert(
      flags[0] === false && flags[2] === false,
      `unexpected snapshots: ${flags.join(',')}`,
    );
    return flags.join(',');
  });

  await check('cards', 'missing snapshots fall back to a centered marker', async () => {
    const info = await page.evaluate(`(async () => {
      const empty = [...document.querySelectorAll('.ntp-card-snapshot.is-empty')];
      const first = empty[0];
      if (!first) return { count: 0 };
      const letter = first.querySelector('.ntp-card-placeholder-letter');
      const box = first.getBoundingClientRect();
      const letterRect = letter?.getBoundingClientRect();
      // Probe the icon cascade: the real favicon <img> only exists on
      // Chromium, so a stand-in proves the shared .site-icon rules keep the
      // marker small instead of letting it fill the card.
      const probe = document.createElement('span');
      probe.className = 'site-icon ntp-card-placeholder-icons';
      const probeImage = document.createElement('img');
      probeImage.className = 'site-icon-image ntp-card-placeholder';
      probeImage.src = ${JSON.stringify(CARD_SNAPSHOT)};
      probe.append(probeImage);
      first.append(probe);
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      const iconRect = probeImage.getBoundingClientRect();
      return {
        count: empty.length,
        letter: letter?.textContent ?? '',
        filled: Boolean(first.querySelector('.ntp-card-snapshot img:not(.ntp-card-placeholder)')),
        iconWidth: Math.round(iconRect.width),
        iconHeight: Math.round(iconRect.height),
        boxWidth: Math.round(box.width),
        boxHeight: Math.round(box.height),
        letterCenteredX: letterRect
          ? Math.abs(letterRect.left + letterRect.width / 2 - (box.left + box.width / 2))
          : 999,
        letterCenteredY: letterRect
          ? Math.abs(letterRect.top + letterRect.height / 2 - (box.top + box.height / 2))
          : 999,
      };
    })()`);
    assert(info.count === 2, `${info.count} empty snapshots`);
    assert(info.letter.length === 1, `no icon and no initial: '${info.letter}'`);
    assert(!info.filled, 'the placeholder card also has a snapshot image');
    assert(
      info.letterCenteredX < 2 && info.letterCenteredY < 2,
      `marker off center: ${info.letterCenteredX}x${info.letterCenteredY}`,
    );
    assert(
      info.iconWidth > 8 && info.iconWidth < info.boxWidth / 2,
      `icon is ${info.iconWidth}x${info.iconHeight} in a ${info.boxWidth}x${info.boxHeight} card`,
    );
    return `${info.count} placeholders, icon ${info.iconWidth}px, "${info.letter}" centered`;
  });

  await check('cards', 'copy button is a sibling, not inside the link', async () => {
    const info = await page.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.ntp-card-copy')];
      return {
        count: buttons.length,
        nested: document.querySelectorAll('.ntp-card-open button').length,
        label: buttons[0]?.getAttribute('aria-label') ?? '',
        svg: buttons[0]?.querySelector('svg.ntp-card-copy-icon')?.namespaceURI ?? '',
        pseudo: getComputedStyle(buttons[0], '::before').content,
      };
    })()`);
    assert(info.count === 3, `${info.count} copy buttons`);
    assert(info.nested === 0, 'a button is nested inside a card link');
    assert(info.label.length > 0, 'copy button has no accessible name');
    assert(
      info.svg === 'http://www.w3.org/2000/svg',
      `copy glyph is not an SVG: ${info.svg}`,
    );
    assert(info.pseudo === 'none', `copy button still draws a CSS glyph: ${info.pseudo}`);
    return info.label;
  });

  await check('cards', 'the copy button reacts to a press', async () => {
    const point = await page.evaluate(`(() => {
      const box = document.querySelector('.ntp-card-copy').getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    })()`);
    const readStyle = () =>
      page.evaluate(`(() => {
        const style = getComputedStyle(document.querySelector('.ntp-card-copy'));
        const matrix = style.transform === 'none' ? new DOMMatrix() : new DOMMatrix(style.transform);
        return { background: style.backgroundColor, scale: Number(matrix.a.toFixed(3)) };
      })()`);

    const idle = await readStyle();
    await page.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' },
      page.sessionId,
    );
    await page.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      page.sessionId,
    );
    await sleep(120);
    const pressed = await readStyle();
    await page.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      page.sessionId,
    );
    await page.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: 2, y: 2, button: 'none' },
      page.sessionId,
    );
    await sleep(250);
    const released = await readStyle();
    // Let the stack finish sliding back before the next check hovers a card.
    await sleep(600);

    assert(
      pressed.scale < idle.scale - 0.05,
      `press did not scale the button: ${idle.scale} -> ${pressed.scale}`,
    );
    assert(
      pressed.background !== idle.background,
      `press did not change the background: ${pressed.background}`,
    );
    assert(
      released.scale > pressed.scale + 0.05,
      `button stayed pressed after release: ${pressed.scale} -> ${released.scale}`,
    );
    return `${idle.scale} -> ${pressed.scale} -> ${released.scale}`;
  });

  await check('cards', 'clicking the card restores its session', async () => {
    await page.evaluate(`document.querySelectorAll('.ntp-card-open')[2].click()`);
    const restored = await page.waitFor('globalThis.__restoredSession', {
      timeout: 3000,
      label: 'sessions.restore call',
    });
    assert(restored === 's-newest', `restored ${restored}`);
    return restored;
  });

  await check('cards', 'the pushed cards keep a peek at the bottom edge', async () => {
    const geometry = `(() => {
      const cards = [...document.querySelectorAll('.ntp-card:not(.ntp-session-list)')];
      const bar = cards[2].querySelector('.ntp-card-bar');
      return {
        tops: cards.map((card) => Math.round(card.getBoundingClientRect().top)),
        barHeight: Math.round(bar.getBoundingClientRect().height),
        innerHeight: window.innerHeight,
        stageTop: Math.round(document.getElementById('ntp-recent').getBoundingClientRect().top),
      };
    })()`;
    const point = await page.evaluate(`(() => {
      const card = document.querySelectorAll('.ntp-card:not(.ntp-session-list)')[1];
      const rect = card.getBoundingClientRect();
      const bar = card.querySelector('.ntp-card-bar').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(bar.top + bar.height / 2) };
    })()`);

    await page.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' },
      page.sessionId,
    );
    await sleep(700);

    const hovered = await page.evaluate(geometry);
    assert(
      hovered.tops[2] > hovered.stageTop + 100,
      `the card above did not drop: ${hovered.tops[2]} vs stage top ${hovered.stageTop}`,
    );
    // 1.5 bar heights stay on screen, so the bar and a sliver of the snapshot
    // can still be pointed at.
    const peek = hovered.innerHeight - hovered.tops[2];
    assert(
      Math.abs(peek - 1.5 * hovered.barHeight) < 6,
      `peek is ${peek}px, want ${(1.5 * hovered.barHeight).toFixed(0)}px of a ${hovered.barHeight}px bar`,
    );
    // The stack's own spacing is untouched.
    assert(
      Math.abs(hovered.tops[0] - hovered.tops[1]) > 40,
      `stack offsets lost: tops ${hovered.tops.join(',')}`,
    );

    await recordScreenshot(page, 'cards', 'chrome-cards-hover.png');

    await page.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: 2, y: 2, button: 'none' },
      page.sessionId,
    );
    await sleep(700);
    const reset = await page.evaluate(geometry);
    assert(
      Math.abs(reset.tops[2] - hovered.stageTop) < 2,
      `card did not go back: ${reset.tops[2]} vs ${hovered.stageTop}`,
    );
    return `peek ${peek}px of ${hovered.barHeight}px bar`;
  });

  await check('cards', 'character limit follows the title bar width', async () => {
    await setViewport(page, NARROW_VIEWPORT_WIDTH, NARROW_VIEWPORT_HEIGHT);
    await sleep(500);
    const narrow = await page.evaluate(`(() => {
      const label = document.querySelectorAll('.ntp-card-label')[2];
      const stage = document.getElementById('ntp-recent');
      return {
        title: label.querySelector('.ntp-card-title').textContent,
        url: label.querySelector('.ntp-card-url').textContent,
        width: label.clientWidth,
        stageHeight: stage.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    })()`);

    await setViewport(page, CARD_VIEWPORT_WIDTH, CARD_VIEWPORT_HEIGHT);
    await sleep(500);
    const wide = await page.evaluate(`(() => {
      const label = document.querySelectorAll('.ntp-card-label')[2];
      return {
        url: label.querySelector('.ntp-card-url').textContent,
        width: label.clientWidth,
      };
    })()`);

    assert(narrow.width < wide.width, `bar did not narrow: ${narrow.width}`);
    assert(
      narrow.url.endsWith('…'),
      `url still fits at ${narrow.width}px: ${narrow.url}`,
    );
    assert(
      wide.url === 'https://zeta.example.com/six',
      `url stayed folded at ${wide.width}px: ${wide.url}`,
    );
    assert(narrow.stageHeight > 0, 'the card stage collapsed at 420px');
    assert(
      narrow.scrollWidth <= narrow.innerWidth &&
        narrow.scrollHeight <= narrow.innerHeight,
      `narrow viewport scrolls: ${narrow.scrollWidth}x${narrow.scrollHeight} in ${narrow.innerWidth}x${narrow.innerHeight}`,
    );
    return `${narrow.width}px folds, ${wide.width}px fits`;
  });

  await recordScreenshot(page, 'cards', 'chrome-cards.png');

  await check('cards', 'card group fills a landscape stage', async () => {
    await setViewport(page, 1600, 900);
    await sleep(500);
    const info = await page.evaluate(cardGeometry);
    const summary = assertCardFillsStage(info);
    assert(
      info.stageHeight > 100,
      `the landscape stage has no height: ${info.stageHeight}px`,
    );
    await recordScreenshot(page, 'cards', 'chrome-cards-wide.png');
    await setViewport(page, CARD_VIEWPORT_WIDTH, CARD_VIEWPORT_HEIGHT);
    await sleep(500);
    return summary;
  });

  await check('cards', 'a flat window keeps the ratio instead of squashing the cards', async () => {
    await setViewport(page, 1200, 400);
    await sleep(500);
    const info = await page.evaluate(`(() => {
      const card = document.querySelectorAll('.ntp-card:not(.ntp-session-list)')[2];
      const rect = card.getBoundingClientRect();
      const stage = document.getElementById('ntp-recent');
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
        stageWidth: Math.round(stage.getBoundingClientRect().width),
        stageHeight: Math.round(stage.getBoundingClientRect().height),
        screenRatio: window.screen.width / window.screen.height,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    })()`);
    await setViewport(page, CARD_VIEWPORT_WIDTH, CARD_VIEWPORT_HEIGHT);
    await sleep(500);

    const ratio = info.width / info.height;
    assert(
      info.stageHeight < info.stageWidth / info.screenRatio,
      `this window is not flat enough to test: stage ${info.stageWidth}x${info.stageHeight}`,
    );
    // The card keeps its shape and overflows the short viewport instead.
    assert(
      Math.abs(ratio - info.screenRatio) < 0.02,
      `flat window squashed the card: ${info.width}x${info.height} (ratio ${ratio.toFixed(3)}, want ${info.screenRatio.toFixed(3)})`,
    );
    assert(
      info.bottom > info.innerHeight,
      `the card should run off the bottom edge: bottom ${info.bottom} vs viewport ${info.innerHeight}`,
    );
    assert(
      info.scrollWidth <= info.innerWidth,
      `the card overflowed sideways: ${info.scrollWidth} in ${info.innerWidth}`,
    );
    return `${info.width}x${info.height} at ratio ${info.screenRatio.toFixed(2)}, bottom ${info.bottom} past ${info.innerHeight}`;
  });

  await check('cards', 'snapshots fade out with depth', async () => {
    const ratios = JSON.parse(
      await page.evaluate(`JSON.stringify(
        [...document.querySelectorAll('.ntp-card-snapshot')].map((node) => {
          const match = getComputedStyle(node).filter.match(/saturate\\(([\\d.]+)\\)/);
          return match ? Number(match[1]) : null;
        }),
      )`),
    );
    assert(ratios.length === 3, `expected 3 snapshots, got ${ratios.length}`);
    const [furthest, middle, nearest] = ratios;
    assert(
      Math.abs(nearest - 0.6) < 0.01,
      `nearest should keep 60%: ${nearest}`,
    );
    assert(
      Math.abs(middle - 0.35) < 0.01,
      `middle should sit halfway: ${middle}`,
    );
    assert(
      Math.abs(furthest - 0.1) < 0.01,
      `furthest should drop to 10%: ${furthest}`,
    );
    return ratios.map((ratio) => ratio.toFixed(2)).join(' / ');
  });

  await check('cards', 'the settings limit applies 1', async () => {
    await page.evaluate(`(() => {
      const select = document.getElementById('opt-recent-count');
      select.value = '1';
      select.dispatchEvent(new Event('change'));
    })()`);
    await page.waitFor(`document.querySelectorAll('.ntp-card:not(.ntp-session-list)').length === 1`, {
      timeout: 3000,
      label: 'one card',
    });
    const alone = await page.evaluate(
      `(getComputedStyle(document.querySelector('.ntp-card-snapshot')).filter.match(/saturate\\(([\\d.]+)\\)/) || [])[1] || ''`,
    );
    assert(
      Math.abs(Number(alone) - 0.6) < 0.01,
      `a lone card should keep the 60% cap: ${alone}`,
    );
    return `1 card after change, saturate ${alone}`;
  });


  await check('cards', 'the snapshot size setting offers four caps', async () => {
    const options = await page.evaluate(`(() => {
      const select = document.getElementById('opt-snapshot-cap');
      return {
        values: [...select.options].map((option) => option.value),
        labels: [...select.options].map((option) => option.textContent),
        selected: select.value,
      };
    })()`);
    assert(
      options.values.join(',') === '720,1080,1440,2160',
      `options are ${options.values.join(',')}`,
    );
    assert(
      options.labels.join(',') === '720P,1080P,2K,4K',
      `labels are ${options.labels.join(',')}`,
    );
    assert(options.selected === '1080', `default is ${options.selected}`);

    await page.evaluate(`(() => {
      const select = document.getElementById('opt-snapshot-cap');
      select.value = '2160';
      select.dispatchEvent(new Event('change'));
    })()`);
    const after = await page.evaluate(
      `localStorage.getItem('ntp-snapshot-cap')`,
    );
    assert(after === '2160', `stored ${after}`);

    await page.evaluate(`(() => {
      const select = document.getElementById('opt-snapshot-cap');
      select.value = '1080';
      select.dispatchEvent(new Event('change'));
    })()`);
    return `default 1080P, then ${after}`;
  });

  await check('cards', 'privileged pages get a card with a letter icon', async () => {
    // Privileged pages can never be captured, and the favicon store only knows
    // web pages, so both the bar and the snapshot fall back to the initial.
    await page.evaluate(`(() => {
      const api = globalThis.browser ?? globalThis.chrome;
      api.sessions.getRecentlyClosed = async () => [
        { tab: { sessionId: 's-priv', title: 'Settings', url: 'chrome://settings/' } },
        { tab: { sessionId: 's-prefs', title: 'Preferences', url: 'about:preferences' } },
        { tab: { sessionId: 's-blank', title: 'New Tab', url: 'chrome://newtab/' } },
        { tab: { sessionId: 's-data', title: 'Data', url: 'data:text/html,x' } },
      ];
      api.sessions.restore = async (sessionId) => {
        globalThis.__restoredSession = sessionId;
      };
      api.runtime.sendMessage = async () => ({ snapshots: [] });
      globalThis.__restoredSession = undefined;
      const select = document.getElementById('opt-recent-count');
      select.value = '3';
      select.dispatchEvent(new Event('change'));
    })()`);
    // On by default, so every page in this fixture (all privileged) is dropped.
    const checked = await page.evaluate(
      `document.getElementById('opt-exclude-privileged').checked`,
    );
    assert(checked === true, `the toggle starts unchecked: ${checked}`);
    await sleep(300);
    const hidden = await page.evaluate(
      `document.querySelectorAll('.ntp-card:not(.ntp-session-list)').length`,
    );
    assert(hidden === 0, `${hidden} privileged cards slipped past the default`);

    await page.evaluate(`(() => {
      const box = document.getElementById('opt-exclude-privileged');
      box.checked = false;
      box.dispatchEvent(new Event('change'));
    })()`);
    await page.waitFor(`document.querySelectorAll('.ntp-card:not(.ntp-session-list)').length === 2`, {
      timeout: 3000,
      label: 'two privileged cards',
    });

    const info = await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.ntp-card:not(.ntp-session-list)')];
      const newest = cards[cards.length - 1];
      const bar = newest.querySelector('.ntp-card-bar');
      const letter = bar.querySelector('.ntp-card-bar-letter');
      const placeholder = newest.querySelector('.ntp-card-placeholder-letter');
      return {
        count: cards.length,
        urls: cards.map((card) =>
          card.querySelector('.ntp-card-url').textContent),
        href: newest.querySelector('.ntp-card-open').getAttribute('href'),
        letter: letter ? letter.textContent : '',
        favicons: bar.querySelectorAll('.ntp-card-favicon').length,
        placeholder: placeholder ? placeholder.textContent : '',
        snapshots: document.querySelectorAll('.ntp-card-snapshot img').length,
      };
    })()`);

    assert(info.count === 2, `skipped pages still rendered: ${info.urls}`);
    assert(
      info.urls[0] === 'about:preferences' && info.urls[1] === 'chrome://settings/',
      `wrong order: ${info.urls}`,
    );
    assert(info.href === 'chrome://settings/', `href is ${info.href}`);
    assert(info.letter === 'S', `bar letter is "${info.letter}"`);
    assert(info.favicons === 0, `${info.favicons} favicons on a privileged card`);
    assert(info.placeholder === 'S', `placeholder is "${info.placeholder}"`);
    assert(info.snapshots === 0, `${info.snapshots} snapshots on a privileged card`);

    await recordScreenshot(page, 'cards', 'chrome-cards-privileged.png');

    await page.evaluate(`document.querySelectorAll('.ntp-card-open')[1].click()`);
    const restored = await page.evaluate(`globalThis.__restoredSession`);
    assert(restored === 's-priv', `restored ${restored}`);

    const stored = await page.evaluate(
      `localStorage.getItem('ntp-exclude-privileged')`,
    );
    assert(stored === 'false', `stored flag is ${stored}`);

    return `2 cards, no favicon, letter "${info.letter}"`;
  });

  await check('cards', 'a closed window gets a card that lists its tabs', async () => {
    const unchecked = await page.evaluate(
      `document.getElementById('opt-exclude-windows').checked`,
    );
    assert(unchecked === false, `windows start excluded: ${unchecked}`);

    await page.evaluate(`(() => {
      const api = globalThis.browser ?? globalThis.chrome;
      api.sessions.getRecentlyClosed = async () => [
        { window: { sessionId: 's-w1', tabs: ${JSON.stringify(WINDOW_TABS)} } },
      ];
      api.sessions.restore = async (sessionId) => {
        globalThis.__restoredSession = sessionId;
      };
      api.runtime.sendMessage = async () => ({ snapshots: [] });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { globalThis.__copied = text; } },
      });
      globalThis.__restoredSession = undefined;
      globalThis.__copied = undefined;
      const select = document.getElementById('opt-recent-count');
      select.value = '3';
      select.dispatchEvent(new Event('change'));
    })()`);
    await page.waitFor(`document.querySelectorAll('.ntp-card:not(.ntp-session-list)').length === 1`, {
      timeout: 3000,
      label: 'one window card',
    });

    const info = await page.evaluate(`(() => {
      const card = document.querySelector('.ntp-card:not(.ntp-session-list)');
      const bar = card.querySelector('.ntp-card-bar');
      const list = card.querySelector('.ntp-card-tabs');
      const rows = [...list.querySelectorAll('.ntp-card-tab-row')];
      const style = getComputedStyle(list);
      const box = list.getBoundingClientRect();
      const first = rows[0].getBoundingClientRect();
      const last = rows[rows.length - 1].getBoundingClientRect();
      const label = rows[rows.length - 1].querySelector('.ntp-card-tab-label');
      const labelBox = label.getBoundingClientRect();
      const padding = parseFloat(style.paddingInlineStart) + parseFloat(style.paddingInlineEnd);
      return {
        icons: bar.querySelectorAll('.site-icon').length,
        title: card.querySelector('.ntp-card-title').textContent,
        titleWeights: [...card.querySelector('.ntp-card-title').children].map((part) =>
          getComputedStyle(part).fontWeight,
        ),
        rows: rows.map((row) => row.querySelector('.ntp-card-tab-label').textContent),
        rowIcons: rows.map((row) => row.querySelectorAll('.site-icon').length),
        snapshots: card.querySelectorAll('.ntp-card-snapshot img').length,
        topGap: first.top - box.top - parseFloat(style.paddingBlockStart),
        bottomGap: box.bottom - last.bottom - parseFloat(style.paddingBlockEnd),
        leftGap: labelBox.left - box.left - parseFloat(style.paddingInlineStart),
        rightGap: box.right - parseFloat(style.paddingInlineEnd) - labelBox.right,
        contentWidth: box.width - padding,
      };
    })()`);

    assert(info.icons === 0, `${info.icons} icons in a window title bar`);
    assert(info.snapshots === 0, 'a window card should have no snapshot');
    assert(
      info.title.startsWith('A window containing'),
      `title is "${info.title}"`,
    );
    assert(
      info.title.endsWith('tabs in total'),
      `title does not read as a sentence: "${info.title}"`,
    );
    assert(
      info.titleWeights.length === 3 &&
        info.titleWeights[0] === '700' &&
        info.titleWeights[2] === '700' &&
        info.titleWeights[1] !== '700',
      `bold parts are ${info.titleWeights.join('/')}`,
    );
    assert(
      info.title.includes('Front page') &&
        info.title.includes(String(WINDOW_TAB_COUNT)),
      `title lost its front tab or count: "${info.title}"`,
    );
    assert(info.rows.length > 2, `only ${info.rows.length} rows`);
    assert(
      info.rows.length < WINDOW_TAB_COUNT,
      `${info.rows.length} rows for ${WINDOW_TAB_COUNT} tabs`,
    );
    assert(
      info.rows[info.rows.length - 1] === '…',
      `last row is "${info.rows[info.rows.length - 1]}"`,
    );
    assert(
      info.rows[0].length < WINDOW_TABS[0].title.length + WINDOW_TABS[0].url.length + 3,
      `first row was not folded: "${info.rows[0]}"`,
    );
    assert(
      info.rowIcons.slice(0, -1).every((count) => count === 1),
      `a row lost its icon: ${info.rowIcons.join(',')}`,
    );
    assert(
      Math.abs(info.topGap - info.bottomGap) < 2,
      `list is not centred: ${info.topGap} vs ${info.bottomGap}`,
    );
    assert(
      Math.abs(info.leftGap - info.rightGap) < 2,
      `rows are not centred across: ${info.leftGap} vs ${info.rightGap}`,
    );

    await recordScreenshot(page, 'cards', 'chrome-cards-window.png');

    await page.evaluate(`document.querySelector('.ntp-card-copy').click()`);
    const copied = await page.evaluate(`globalThis.__copied`);
    const lines = String(copied).split('\n');
    assert(lines.length === WINDOW_TAB_COUNT, `copied ${lines.length} lines`);
    assert(
      lines[0] === `[${WINDOW_TABS[0].title}](${WINDOW_TABS[0].url})`,
      `first copied line is "${lines[0]}"`,
    );
    assert(
      lines.every((line) => /^\[[^\]]+\]\([^)]+\)$/.test(line)),
      `a copied line is not a markdown link: "${lines.find((line) => !/^\[[^\]]+\]\([^)]+\)$/.test(line))}"`,
    );

    await page.evaluate(`document.querySelector('.ntp-card-open').click()`);
    const restored = await page.evaluate(`globalThis.__restoredSession`);
    assert(restored === 's-w1', `restored ${restored}`);

    return `${info.rows.length} rows, last one "…", ${lines.length} lines copied`;
  });

  await check('cards', 'the session list can be switched off and back on', async () => {
    const info = await page.evaluate(`(() => {
      const list = document.getElementById('ntp-session-list');
      const input = document.getElementById('opt-session-list');
      return {
        checked: input.checked,
        hidden: list.hidden,
        rows: list.querySelectorAll('.ntp-session-entry').length,
        // hidden alone is not enough: the author display:flex rule would win
        // over the UA's [hidden] rule and leave an empty frame on screen.
        display: getComputedStyle(list).display,
        box: Math.round(list.getBoundingClientRect().width),
        cards: document.querySelectorAll('.ntp-card:not(.ntp-session-list)').length,
      };
    })()`);
    assert(info.checked === true, 'the session list is off by default');
    assert(info.hidden === false, 'the session list is hidden by default');
    assert(info.display !== 'none', 'the default list is not painted');

    // Off: the card has to leave the screen entirely, not just lose its rows.
    await page.evaluate(`(() => {
      const input = document.getElementById('opt-session-list');
      input.checked = false;
      input.dispatchEvent(new Event('change'));
    })()`);
    await page.waitFor(`getComputedStyle(document.getElementById('ntp-session-list')).display === 'none'`, {
      timeout: 3000,
      label: 'the session list to disappear',
    });
    const stored = await page.evaluate(
      `JSON.parse(localStorage.getItem('ntp-session-list'))`,
    );
    assert(stored === false, `the choice was not stored: ${stored}`);

    const cards = await page.evaluate(
      `document.querySelectorAll('.ntp-card:not(.ntp-session-list)').length`,
    );
    assert(cards >= 1, 'switching the list off took the other cards with it');

    // Back on for the checks below, which are all about the list itself.
    await page.evaluate(`(() => {
      const input = document.getElementById('opt-session-list');
      input.checked = true;
      input.dispatchEvent(new Event('change'));
    })()`);
    await page.waitFor(`getComputedStyle(document.getElementById('ntp-session-list')).display !== 'none'`, {
      timeout: 3000,
      label: 'the session list to come back',
    });
    return 'on by default, gone when switched off, back when switched on';
  });

  await check('cards', 'the pinned tray lists every session and restores a selection', async () => {
    await page.evaluate(`(() => {
      const api = globalThis.browser ?? globalThis.chrome;
      api.sessions.getRecentlyClosed = async () => [
        { tab: { sessionId: 'p-1', title: 'Pinned one', url: 'https://one.example/alpha' }, lastModified: 1700000000000 },
        { tab: { sessionId: 'p-2', title: 'Pinned two', url: 'https://two.example/beta' }, lastModified: 1699999000000 },
        { window: { sessionId: 'p-w', tabs: [
          { title: 'Inner one', url: 'https://inner.example/one' },
          { title: 'Inner two', url: 'https://inner.example/two', active: true },
        ] } },
      ];
      api.sessions.restore = async (sessionId) => {
        globalThis.__restoredSession = sessionId;
      };
      globalThis.__restoredSession = undefined;
      const select = document.getElementById('opt-recent-count');
      select.value = '1';
      select.dispatchEvent(new Event('change'));
    })()`);
    await page.waitFor(`document.querySelectorAll('#ntp-session-list > .ntp-session-entry').length === 3`, {
      timeout: 3000,
      label: 'three pinned rows',
    });

    const info = await page.evaluate(`(() => {
      const list = document.getElementById('ntp-session-list');
      const box = list.getBoundingClientRect();
      const style = getComputedStyle(list);
      const entries = [...list.querySelectorAll(':scope > .ntp-session-entry')];
      const headings = [...list.querySelectorAll('.ntp-session-cell')].map((cell) => cell.textContent.trim());
      const expand = list.querySelector('.ntp-session-expand');
      const children = list.querySelector('.ntp-session-children');
      return {
        rows: entries.length,
        bottomGap: window.innerHeight - box.bottom,
        leftGap: Math.round(box.left),
        radiusTop: style.borderTopLeftRadius,
        radiusBottom: style.borderBottomLeftRadius,
        headings,
        restoreDisabled: document.getElementById('ntp-session-restore').disabled,
        kinds: entries.map((entry) => entry.querySelector('.ntp-session-kind').textContent),
        lastTimes: entries.map((entry) => entry.querySelector('.ntp-session-time').textContent),
        columns: entries.map((entry) => entry.querySelector('.ntp-session-row').children.length),
        hasExpand: Boolean(expand),
        childrenHidden: children ? children.hidden : null,
        childrenCount: children ? children.querySelectorAll('.ntp-session-row').length : 0,
        cardZ: Number(getComputedStyle(document.querySelector('.ntp-card:not(.ntp-session-list)')).zIndex),
        listZ: Number(getComputedStyle(list).zIndex),
        listFirst: document.getElementById('ntp-recent').firstElementChild === list,
        listIndex: getComputedStyle(list).getPropertyValue('--ntp-card-index').trim(),
        cardCount: document.querySelectorAll('.ntp-card:not(.ntp-session-list)').length,
        // The list shows one bar of itself; the card below it sits a full step
        // further down, which is what makes the strip that tall.
        listStrip: (() => {
          const listTop = list.getBoundingClientRect().top;
          const next = [...document.querySelectorAll('.ntp-card:not(.ntp-session-list)')]
            .map((card) => card.getBoundingClientRect().top)
            .sort((a, b) => a - b)[0];
          const bar = Number.parseFloat(
            getComputedStyle(list).getPropertyValue('--ntp-card-bar-block-size'),
          ) * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
          return { strip: Math.round(next - listTop), bar: Math.round(bar) };
        })(),
      };
    })()`);

    assert(info.rows === 3, `pinned rows: ${info.rows}`);
    assert(info.restoreDisabled === true, 'restore starts enabled with nothing selected');
    // Same frame as every other card: it is the last layer of the tower.
    assert(info.listZ === info.cardZ, `the list is not framed like a card: ${info.listZ} vs ${info.cardZ}`);
    assert(info.listFirst === true, 'the list is not painted first');
    assert(
      Number(info.listIndex) === info.cardCount,
      `list stack index: ${info.listIndex} for ${info.cardCount} cards`,
    );
    assert(
      Math.abs(info.listStrip.strip - info.listStrip.bar) < 3,
      `the list peaks by more than one bar: ${info.listStrip.strip}px vs ${info.listStrip.bar}px`,
    );
    assert(
      info.headings.filter(Boolean).length >= 4,
      `column headings missing: ${info.headings.join('|')}`,
    );
    assert(info.kinds[2].includes('·'), `window row has no tab count: ${info.kinds[2]}`);
    assert(info.lastTimes[0] !== '', 'a closed time was dropped');
    // Absolute time first, then the bracketed relative time.
    assert(
      /\d.*\(.+\)$/.test(info.lastTimes[0]),
      `no relative time in brackets: ${info.lastTimes[0]}`,
    );
    assert(info.columns.every((count) => count === 6), `row cells: ${info.columns.join(',')}`);
    assert(info.hasExpand && info.childrenHidden === true, 'the window row is not collapsed');
    assert(info.childrenCount === 2, `window children: ${info.childrenCount}`);

    // Expanding is a plain button toggling hidden rows, so no re-render is
    // needed and the selection survives it.
    await page.evaluate(`document.querySelector('.ntp-session-expand').click()`);
    const expanded = await page.evaluate(`(() => {
      const children = document.querySelector('.ntp-session-children');
      return {
        hidden: children.hidden,
        open: document.querySelector('.ntp-session-expand').getAttribute('aria-expanded'),
        visible: children.querySelectorAll('.ntp-session-row').length,
      };
    })()`);
    assert(expanded.hidden === false, 'the window row did not expand');
    assert(expanded.open === 'true', `aria-expanded: ${expanded.open}`);
    assert(expanded.visible === 2, `visible children: ${expanded.visible}`);

    // Dragging a column edge widens that column only.
    const widths = await page.evaluate(`(async () => {
      const before = document.querySelector('.ntp-session-row .ntp-session-title').getBoundingClientRect().width;
      const handle = document.querySelector('[data-session-resizer="title"]');
      const heading = handle.parentElement;
      const box = heading.getBoundingClientRect();
      const options = { bubbles: true, pointerId: 1, clientY: box.top + box.height / 2 };
      handle.dispatchEvent(new PointerEvent('pointerdown', { ...options, clientX: box.right - 2 }));
      handle.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: box.right + 60 }));
      handle.dispatchEvent(new PointerEvent('pointerup', { ...options, clientX: box.right + 60 }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const after = document.querySelector('.ntp-session-row .ntp-session-title').getBoundingClientRect().width;
      return { before, after };
    })()`);
    assert(
      widths.after > widths.before + 20,
      `column did not grow: ${widths.before} -> ${widths.after}`,
    );

    // Selecting a row arms the header button; restoring clears the selection.
    await page.evaluate(`(() => {
      const check = document.querySelector('.ntp-session-check');
      check.checked = true;
      check.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const armed = await page.evaluate(
      `document.getElementById('ntp-session-restore').disabled`,
    );
    assert(armed === false, 'the restore button stayed disabled after selecting a row');

    await page.evaluate(`document.getElementById('ntp-session-restore').click()`);
    await page.waitFor(`globalThis.__restoredSession === 'p-1'`, {
      timeout: 3000,
      label: 'restored the selected session',
    });
    const settled = await page.evaluate(`(() => ({
      restored: globalThis.__restoredSession,
      disabled: document.getElementById('ntp-session-restore').disabled,
    }))()`);
    assert(settled.restored === 'p-1', `restored ${settled.restored}`);
    assert(settled.disabled === true, 'the selection survived the restore');

    await page.evaluate(`(() => {
      document.getElementById('ntp-session-list').style.removeProperty('--ntp-session-col-title');
      const select = document.getElementById('opt-recent-count');
      select.value = '3';
      select.dispatchEvent(new Event('change'));
    })()`);
    await page.waitFor(`document.querySelectorAll('.ntp-card:not(.ntp-session-list)').length === 3`, {
      timeout: 3000,
      label: 'three cards over the tray',
    });
    await page.evaluate(`(() => {
      const expand = document.querySelector('.ntp-session-expand');
      if (expand && expand.getAttribute('aria-expanded') !== 'true') {
        expand.click();
      }
    })()`);
    await recordScreenshot(page, 'cards', 'chrome-session-list.png');

    // The tray is the base of the tower: it is lifted one step above the
    // oldest card, so a strip of it shows, and pointing at that strip drops
    // every card the same way pointing at a card drops the ones above it.
    const base = await page.evaluate(`(() => {
      const list = document.getElementById('ntp-session-list').getBoundingClientRect();
      const cards = [...document.querySelectorAll('.ntp-card:not(.ntp-session-list)')];
      return {
        listTop: list.top,
        listBottom: list.bottom,
        listLeft: list.left,
        cardTop: Math.min(...cards.map((card) => card.getBoundingClientRect().top)),
        tops: cards.map((card) => card.getBoundingClientRect().top),
        classes: document.body.className,
        width: list.width,
        cardWidths: cards.map((card) => Math.round(card.getBoundingClientRect().width)),
        stageWidth: document.getElementById('ntp-recent').getBoundingClientRect().width,
      };
    })()`);
    assert(base.listTop < base.cardTop, `the tray does not peek above the stack: ${base.listTop} vs ${base.cardTop}`);
    assert(
      Math.round(base.width) < Math.min(...base.cardWidths),
      `the tray is not the smallest card: ${Math.round(base.width)} vs ${base.cardWidths.join(',')}`,
    );

    await page.moveMouse(base.listLeft + base.width / 2, base.listTop + 8);
    await sleep(600);
    const lifted = await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.ntp-card:not(.ntp-session-list)')];
      return {
        open: document.body.classList.contains('ntp-session-open'),
        tops: cards.map((card) => Math.round(card.getBoundingClientRect().top)),
        bar: Math.round(cards[0].querySelector('.ntp-card-bar').getBoundingClientRect().height),
      };
    })()`);
    assert(lifted.open === true, 'pointing at the tray did not open it');
    assert(
      lifted.tops.every((top) => top > base.cardTop + 100),
      `the stack did not drop for the tray: ${lifted.tops.join(',')}`,
    );
    await recordScreenshot(page, 'cards', 'chrome-session-list-open.png');

    await page.moveMouse(4, 4);
    await sleep(600);
    const closed = await page.evaluate(`(() => ({
      open: document.body.classList.contains('ntp-session-open'),
      top: Math.round(document.querySelector('.ntp-card:not(.ntp-session-list)').getBoundingClientRect().top),
    }))()`);
    assert(closed.open === false, 'the tray stayed open after the pointer left');
    assert(
      Math.abs(closed.top - base.cardTop) < 2,
      `the stack did not come back: ${closed.top} vs ${base.cardTop}`,
    );

    return `${info.rows} rows, list card at the back, restore wired`;
  });

  await check('cards', 'a narrow window keeps the restore button reachable', async () => {
    await setViewport(page, 640, 800);
    // The columns keep their widths, so the list scrolls sideways; the button
    // has to stay pinned to the right edge of the scrollport either way.
    await page.evaluate(
      `document.getElementById('ntp-session-list').scrollLeft = 0`,
    );
    const where = await page.evaluate(`(() => {
      const button = document.getElementById('ntp-session-restore');
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return {
        right: Math.round(box.right),
        width: Math.round(box.width),
        viewport: window.innerWidth,
        scrollLeft: Math.round(document.getElementById('ntp-session-list').scrollLeft),
        hit: hit === button || button.contains(hit),
      };
    })()`);
    assert(
      where.right <= where.viewport,
      `the restore button is off screen: ${where.right} > ${where.viewport}`,
    );
    assert(where.hit === true, 'the restore button is not clickable');
    await setViewport(page, CARD_VIEWPORT_WIDTH, CARD_VIEWPORT_HEIGHT);
    return `button at ${where.right} of ${where.viewport}`;
  });

  await check('cards', 'no uncaught page errors', async () => {
    assert(
      errors.errors.length === 0,
      errors.errors.join(' | ') || 'errors recorded',
    );
    return '0 errors';
  });
}

function printSummary() {
  const failed = RESULTS.filter((result) => !result.pass);
  const passed = RESULTS.length - failed.length;
  console.log(
    `\n== Summary: ${passed} passed, ${failed.length} failed, ${RESULTS.length} assertions ==`,
  );
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const result of failed) {
      console.log(`  [${result.scenario}] ${result.name}`);
      console.log(`      ${result.detail}`);
    }
  }
  return failed.length > 0 ? 1 : 0;
}

async function main() {
  const only = parseOnly(process.argv.slice(2));
  console.log(`Scenarios: ${only.join(', ')}`);

  runBuild();

  const userDataDir = await mkdtemp(
    path.join(tmpdir(), 'ntp-plusplus-headless-'),
  );
  let browser;
  let exitCode = 0;

  try {
    console.log(`\n• Launching ${CHROME_PATH}`);
    browser = await launchChromium({
      chromePath: CHROME_PATH,
      userDataDir,
      distPath: DIST_CHROME,
    });
    const { cdp } = browser;

    const { targetInfos } = await cdp.send('Target.getTargets');
    const pageTarget = targetInfos.find((target) => target.type === 'page');
    if (!pageTarget) {
      throw new Error('No initial page target found in Chromium');
    }

    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);

    const errors = createErrorCollector(cdp);
    cdp.on('Target.detachedFromTarget', (params) => {
      if (params.sessionId === sessionId) {
        errors.errors.push('page target detached (page closed?)');
      }
    });

    const resolved = await resolveExtensionId(cdp, sessionId, userDataDir);
    const page = resolved.page;
    console.log(
      `• Extension id: ${resolved.id} (resolved via ${resolved.method})`,
    );

    if (only.includes('chrome')) {
      await chromeScenario(page, errors);
    }
    if (only.includes('firefox')) {
      await firefoxScenario(page, errors);
    }
    if (only.includes('layout')) {
      await layoutScenario(page, errors);
    }
    if (only.includes('cards')) {
      await cardsScenario(page, errors);
    }

    errors.off();
    exitCode = printSummary();
  } catch (error) {
    console.error(
      `\nFATAL: ${error instanceof Error ? error.stack ?? error.message : error}`,
    );
    if (browser) {
      const { stderr } = browser.diagnostics();
      if (stderr.trim()) {
        console.error(`\nChromium stderr:\n${stderr.trim()}`);
      }
    }
    exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    await rm(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => {});
  }

  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(`FATAL: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
