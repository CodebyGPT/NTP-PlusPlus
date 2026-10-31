import assert from 'node:assert/strict';

import {
  isWebUrl,
  normalizeHost,
  prepareTiles,
  rootOf,
  TILE_COUNT,
} from '../src/topsites.js';

const many = Array.from({ length: TILE_COUNT + 5 }, (_, index) => ({
  url: `https://s${index}.example/page`,
  title: `S${index}`,
}));
assert.equal(prepareTiles(many).length, TILE_COUNT);

const sample = [
  { url: 'https://a.example/x', title: 'A' },
  { url: 'https://a.example/x', title: 'A duplicate' },
  { url: 'https://b.example/', title: 'B' },
  { url: 'https://www.c.example/p', title: 'C' },
  { url: 'mailto:someone@example.com', title: 'Mail' },
];

assert.deepEqual(
  prepareTiles(sample).map((tile) => tile.url),
  ['https://a.example/x', 'https://b.example/', 'https://www.c.example/p'],
);

assert.deepEqual(
  prepareTiles(sample, { domainOnly: true }).map((tile) => tile.url),
  ['https://a.example/', 'https://b.example/', 'https://www.c.example/'],
);

assert.deepEqual(
  prepareTiles(sample, {
    hiddenKeys: new Set(['https://a.example/']),
  }).map((tile) => tile.url),
  ['https://b.example/', 'https://www.c.example/p'],
);

// Exact host matching: excluding baidu.com must not hide baike.baidu.com.
const domains = [
  { url: 'https://baidu.com/', title: 'Baidu' },
  { url: 'https://baike.baidu.com/item/x', title: 'Baike' },
];
assert.deepEqual(
  prepareTiles(domains, { excludeHosts: new Set(['baidu.com']) }).map(
    (tile) => tile.url,
  ),
  ['https://baike.baidu.com/item/x'],
);

assert.deepEqual(
  prepareTiles(sample, {
    excludeHosts: new Set(['c.example']),
  }).map((tile) => tile.url),
  ['https://a.example/x', 'https://b.example/'],
);

assert.equal(normalizeHost('www.c.example'), 'c.example');
assert.equal(normalizeHost('baike.baidu.com'), 'baike.baidu.com');
assert.equal(rootOf('https://www.c.example/p?q=1'), 'https://www.c.example/');
assert.equal(isWebUrl('https://example.com'), true);
assert.equal(isWebUrl('file:///tmp/x'), false);

console.log('topsites checks passed');
