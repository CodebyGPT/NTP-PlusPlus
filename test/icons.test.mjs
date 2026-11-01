import assert from 'node:assert/strict';

// The Firefox/Chromium split is read once at module load from the UA, so each
// browser is imported as a fresh module instance with its own URL.
const CHROMIUM_UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/121.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';
const ENDPOINT = '/_favicon/';
const INLINE_FAVICON = 'data:image/png;base64,AAAA';

function stubBrowser(userAgent) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent },
    configurable: true,
  });
  globalThis.chrome = globalThis.browser = {
    runtime: { getURL: (path) => `extension://test${path}` },
  };
}

stubBrowser(CHROMIUM_UA);
const chromium = await import('../src/icons.js');

stubBrowser(FIREFOX_UA);
const firefox = await import('../src/icons.js?firefox');

// Chromium: the internal favicon store, addressed by the page URL.
const chromiumSource = chromium.iconSource({ url: 'https://example.com/a b' });
assert.equal(
  chromiumSource,
  `extension://test${ENDPOINT}?pageUrl=${encodeURIComponent('https://example.com/a b')}&size=64`,
);
assert.ok(chromiumSource.includes('size=64'));

// An inline favicon (Firefox topSites hands these over) beats everything.
assert.equal(
  chromium.iconSource({ url: 'https://example.com/', favicon: INLINE_FAVICON }),
  INLINE_FAVICON,
);
assert.equal(
  firefox.iconSource({ url: 'https://example.com/', favicon: INLINE_FAVICON }),
  INLINE_FAVICON,
);

// Firefox only offers remote favIconUrl values, which this extension never
// loads, so there is nothing to return.
assert.equal(firefox.iconSource({ url: 'https://example.com/' }), undefined);

// Privileged pages: the Chromium store would answer with its generic globe.
assert.equal(chromium.iconSource({ url: 'chrome://settings/' }), undefined);
assert.equal(chromium.iconSource({ url: 'about:blank' }), undefined);
assert.equal(firefox.iconSource({ url: 'chrome://settings/' }), undefined);

// No call site has to ask which case it is in: undefined means "use the letter".
assert.equal(chromium.iconSource(), undefined, 'a missing url must not throw');

assert.equal(chromium.siteInitial('https://example.com/path'), 'E');
assert.equal(chromium.siteInitial('chrome://settings/'), 'S');
assert.equal(chromium.siteInitial('about:blank'), 'A');
assert.equal(chromium.siteInitial(''), '?');
assert.equal(chromium.siteInitial(), '?');

console.log('icons checks passed');
