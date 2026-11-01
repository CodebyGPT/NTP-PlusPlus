import assert from 'node:assert/strict';

import {
  buildRecentCards,
  buildSessionRows,
  charLimitForWidth,
  ELLIPSIS,
  limitCardText,
  limitLabel,
  pushSnapshot,
  SNAPSHOT_SLOTS,
  TITLE_SEPARATOR,
  toRecentSessions,
} from '../src/stack.js';

assert.equal(SNAPSHOT_SLOTS, 3);
assert.equal(TITLE_SEPARATOR, ' - ');
assert.equal(ELLIPSIS, '…');

// Newest entry first, oldest dropped once the ring is full.
const first = { url: 'https://a.example/', dataUrl: 'data:a' };
const second = { url: 'https://b.example/', dataUrl: 'data:b' };
const third = { url: 'https://c.example/', dataUrl: 'data:c' };
const fourth = { url: 'https://d.example/', dataUrl: 'data:d' };

let ring = pushSnapshot([], first);
ring = pushSnapshot(ring, second);
ring = pushSnapshot(ring, third);
assert.deepEqual(
  ring.map((entry) => entry.url),
  ['https://c.example/', 'https://b.example/', 'https://a.example/'],
);

ring = pushSnapshot(ring, fourth);
assert.equal(ring.length, SNAPSHOT_SLOTS);
assert.deepEqual(
  ring.map((entry) => entry.url),
  ['https://d.example/', 'https://c.example/', 'https://b.example/'],
);

// Revisiting a URL moves it to the front instead of duplicating it.
const replacement = { url: 'https://c.example/', dataUrl: 'data:c2' };
ring = pushSnapshot(ring, replacement);
assert.deepEqual(
  ring.map((entry) => entry.url),
  ['https://c.example/', 'https://d.example/', 'https://b.example/'],
);
assert.equal(ring[0].dataUrl, 'data:c2');

// A non-array ring and an entry without a usable url must not throw.
assert.deepEqual(pushSnapshot(undefined, first), [first]);
assert.deepEqual(pushSnapshot(null, { dataUrl: 'data:x' }).length, 1);
assert.deepEqual(pushSnapshot(ring, null), ring);
assert.equal(pushSnapshot(ring, first, 1).length, 1);

const wide = charLimitForWidth(600, 10);
const narrow = charLimitForWidth(300, 10);
assert.ok(narrow < wide, 'narrower containers allow fewer characters');
assert.ok(charLimitForWidth(1200, 10) > wide, 'wider containers allow more');
assert.equal(charLimitForWidth(10, 10), 1);
assert.equal(charLimitForWidth(0, 10), 1);
assert.equal(charLimitForWidth(-40, 10), 1);
assert.equal(charLimitForWidth(Number.NaN, 10), 1);
assert.equal(charLimitForWidth(400, 0), 1);
assert.ok(Number.isInteger(wide));

assert.equal(limitLabel('short', 10), 'short');
assert.equal(limitLabel('abcdef', 4), 'abc…');
assert.equal(limitLabel('abcdef', 1), '…');
assert.equal(limitLabel(null, 10), '');
assert.deepEqual(limitCardText({ title: 'abcdef', url: 'ghijkl' }, 4), {
  title: 'abc…',
  url: 'ghi…',
});
assert.deepEqual(limitCardText({}, 4), { title: '', url: '' });

const sessions = [
  { tab: { sessionId: 's1', title: 'Alpha', url: 'https://a.example/' } },
  { window: { sessionId: 'w1', tabs: [] } },
  { tab: { sessionId: 's2', url: 'https://b.example/page' } },
  { tab: { sessionId: 's3', title: 'Local', url: 'file:///tmp/x' } },
  { tab: { sessionId: 's4', title: 'Settings', url: 'chrome://settings/' } },
  { tab: { sessionId: 's5', title: 'New Tab', url: 'chrome://newtab/' } },
  { tab: { sessionId: 's6', title: 'Blank', url: 'about:blank' } },
  { tab: { sessionId: 's7', title: 'Data', url: 'data:text/html,x' } },
];

// Window sessions, the browser's own empty pages and non-restorable schemes
// have no card to show. Privileged pages do: the browser restores those too.
assert.deepEqual(toRecentSessions(sessions), [
  { sessionId: 's1', title: 'Alpha', url: 'https://a.example/' },
  {
    sessionId: 's2',
    title: 'https://b.example/page',
    url: 'https://b.example/page',
  },
  { sessionId: 's3', title: 'Local', url: 'file:///tmp/x' },
  { sessionId: 's4', title: 'Settings', url: 'chrome://settings/' },
]);

const snapshots = [
  { url: 'https://a.example/', dataUrl: 'data:a1' },
  { url: 'https://b.example/page', dataUrl: 'data:b1' },
  { url: 'https://a.example/', dataUrl: 'data:a2' },
  { url: 'https://unknown.example/', dataUrl: 'data:u1' },
];

const cards = buildRecentCards(sessions, snapshots, 3);
assert.deepEqual(
  cards.map((card) => card.sessionId),
  ['s1', 's2', 's3'],
);
assert.equal(cards[0].snapshot, 'data:a1');
assert.equal(cards[1].snapshot, 'data:b1');
assert.equal(cards[1].title, 'https://b.example/page');
// Nothing was ever captured for a local file, so it keeps its own card anyway.
assert.equal(cards[2].snapshot, undefined);
assert.equal(cards[2].url, 'file:///tmp/x');

assert.equal(buildRecentCards(sessions, snapshots, 1).length, 1);

// Same url twice: each card takes a different snapshot, never the same one.
const repeated = [
  { tab: { sessionId: 's1', title: 'Alpha', url: 'https://a.example/' } },
  { tab: { sessionId: 's2', title: 'Alpha again', url: 'https://a.example/' } },
];
const paired = buildRecentCards(repeated, snapshots, 3);
assert.deepEqual(
  paired.map((card) => card.snapshot),
  ['data:a1', 'data:a2'],
);
assert.notEqual(paired[0].snapshot, paired[1].snapshot);

// The "exclude privileged pages" setting drops them and keeps the rest.
assert.deepEqual(
  toRecentSessions(sessions, { webOnly: true }).map((session) => session.sessionId),
  ['s1', 's2'],
);
assert.equal(buildRecentCards(sessions, snapshots, 3, { webOnly: true }).length, 2);

// Missing snapshot stays undefined rather than reusing an earlier one.
const unmatched = buildRecentCards(repeated, [snapshots[0]], 3);
assert.equal(unmatched[0].snapshot, 'data:a1');
assert.equal(unmatched[1].snapshot, undefined);

assert.deepEqual(buildRecentCards([], snapshots, 3), []);

// A closed window becomes one card that carries its tabs.
const windowSessions = [
  { tab: { sessionId: 's1', title: 'Alpha', url: 'https://a.example/' } },
  {
    window: {
      sessionId: 'w1',
      tabs: [
        { title: 'One', url: 'https://one.example/', active: false },
        { title: 'Two', url: 'https://two.example/', active: true },
        { title: 'Local', url: 'file:///tmp/x' },
      ],
    },
  },
];
const windowCards = buildRecentCards(windowSessions, [], 3);
assert.deepEqual(
  windowCards.map((card) => card.kind),
  ['tab', 'window'],
);
assert.equal(windowCards[1].sessionId, 'w1');
assert.equal(windowCards[1].count, 3);
assert.deepEqual(windowCards[1].head, { title: 'Two', url: 'https://two.example/' });
assert.deepEqual(
  windowCards[1].tabs.map((tab) => tab.url),
  ['https://one.example/', 'https://two.example/', 'file:///tmp/x'],
);
// No active tab: the first one stands in for the headline.
const noActive = buildRecentCards(
  [{ window: { sessionId: 'w2', tabs: [{ title: 'Only', url: 'https://only.example/' }] } }],
  [],
  3,
);
assert.deepEqual(noActive[0].head, { title: 'Only', url: 'https://only.example/' });
// A window counts against the card limit like any other session.
assert.equal(buildRecentCards(windowSessions, [], 1).length, 1);
// "Exclude windows" drops them, the tab card survives.
assert.deepEqual(
  buildRecentCards(windowSessions, [], 3, { excludeWindows: true }).map((card) => card.kind),
  ['tab'],
);
// "Exclude privileged pages" also filters the tabs inside the window, and a
// window left with nothing to show disappears instead of rendering empty.
const webWindows = buildRecentCards(windowSessions, [], 3, { webOnly: true });
assert.equal(webWindows[1].count, 2);
assert.deepEqual(
  buildRecentCards(
    [{ window: { sessionId: 'w3', tabs: [{ title: 'Blank', url: 'about:blank' }] } }],
    [],
    3,
  ),
  [],
);

// The pinned list keeps every session and adds the close timestamp, which is
// the one field the cards never needed.
const sessionRows = buildSessionRows([
  { tab: { sessionId: 't1', title: 'One', url: 'https://one.example/' }, lastModified: 1700000000000 },
  {
    window: {
      sessionId: 'w1',
      tabs: [
        { title: 'A', url: 'https://a.example/' },
        { title: 'B', url: 'https://b.example/', active: true },
      ],
    },
    lastModified: 1699999999000,
  },
]);
assert.deepEqual(
  sessionRows.map((row) => [row.kind, row.sessionId]),
  [
    ['tab', 't1'],
    ['window', 'w1'],
  ],
);
assert.equal(sessionRows[0].lastModified, 1700000000000);
assert.equal(sessionRows[1].count, 2);
assert.equal(sessionRows[1].title, 'B');
assert.deepEqual(
  sessionRows[1].tabs.map((tab) => tab.url),
  ['https://a.example/', 'https://b.example/'],
);
// Missing or junk timestamps read as 0 rather than NaN.
assert.equal(
  buildSessionRows([{ tab: { sessionId: 't2', url: 'https://two.example/' }, lastModified: 'nope' }])[0]
    .lastModified,
  0,
);
// A window with nothing restorable inside is dropped instead of listed empty.
assert.deepEqual(buildSessionRows([{ window: { sessionId: 'w2', tabs: [] } }]), []);

// Chromium hands out seconds where the docs promise milliseconds; both have to
// land on the same instant instead of somewhere in 1970.
assert.equal(
  buildSessionRows([
    { tab: { sessionId: 's1', url: 'https://s.example/' }, lastModified: 1700000000 },
  ])[0].lastModified,
  1700000000000,
);
// webOnly still filters privileged pages for people who asked for it.
assert.equal(
  buildSessionRows([{ tab: { sessionId: 't3', url: 'chrome://settings/' } }], { webOnly: true })
    .length,
  0,
);

console.log('stack checks passed');
