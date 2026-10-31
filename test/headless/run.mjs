// Headless contract tests for the Just a NTP new-tab page.
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
  { title: 'Alpha', url: 'https://alpha.example.com/one', favicon: FAVICON },
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
    return ['chrome', 'firefox', 'layout'];
  }
  const names = arg
    .slice('--only='.length)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const valid = names.filter((name) =>
    ['chrome', 'firefox', 'layout'].includes(name),
  );
  if (valid.length === 0) {
    throw new Error(
      `--only expects chrome, firefox or layout (got "${arg}")`,
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
      getMessage(key) {
        const entry = messages[key];
        return entry && typeof entry.message === 'string' ? entry.message : '';
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

  const source =
    kind === 'firefox'
      ? buildBrowserMock(JSON.parse(await readFile(EN_CATALOG_PATH, 'utf8')))
      : buildChromePreload();
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
    assert(
      rect && rect.x > 20 && rect.y > 20,
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

  await check('firefox', 'delete buttons are visible', async () => {
    const visible = await page.waitFor(`(() => {
      const visible = ${VISIBLE_FN};
      return [...document.querySelectorAll('#ntp-tiles .ntp-tile-remove')]
        .filter(visible).length;
    })()`, { label: '10 visible remove buttons' });
    assert(visible === 10, `${visible} visible remove buttons, expected 10`);
    return '10 visible';
  });

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
    path.join(tmpdir(), 'just-a-ntp-headless-'),
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
