// Classic script: Chrome loads it as an MV3 service worker and Firefox 109-120
// as an event page, and a classic script is valid in both. It must stay
// self-contained (no imports) for the Firefox <115 fallback below.

const api = globalThis.browser ?? globalThis.chrome;

const OPEN_SNAPSHOT_KEY = 'ntp-open-snapshots';
const CLOSED_SNAPSHOT_KEY = 'ntp-closed-snapshots';
const SNAPSHOT_MESSAGE = 'ntp:snapshots';

// Capture wants detail (it is the only chance to see the page), while the
// re-encode only has to survive one downscale, so it can be cheaper. Both land
// in memory-only session storage: 11 snapshots at 1080p stay well under the
// 10 MB quota.
const SNAPSHOT_CAPTURE_QUALITY = 80;
const SNAPSHOT_QUALITY = 70;

// The cap is a user setting, so it lives in storage.local where both the new
// tab page and this worker can see it. Boxes are 16:9 and named by their short
// side, the way displays are sold.
const SNAPSHOT_CAP_KEY = 'ntp-snapshot-cap';
const SNAPSHOT_CAP_DEFAULT = 1080;
const SNAPSHOT_CAPS = {
  720: { width: 1280, height: 720 },
  1080: { width: 1920, height: 1080 },
  1440: { width: 2560, height: 1440 },
  2160: { width: 3840, height: 2160 },
};

// One open entry per live tab. A tab the user has not revisited still needs its
// entry to become a closed snapshot, so the cap covers a window's worth of
// recently used tabs rather than the 3 slots the new tab page displays.
const OPEN_SNAPSHOT_LIMIT = 8;
const SNAPSHOT_SLOTS = 3;

const WEB_PROTOCOLS = new Set(['http:', 'https:']);

// String.fromCharCode takes the chunk as separate arguments, so a whole frame
// in one call can overflow the argument limit.
const BASE64_CHUNK_SIZE = 0x8000;
const DATA_URL_PREFIX = 'data:';
const BASE64_MARKER = ';base64,';

// session storage is memory-only and never touches disk. Firefox <115 has no
// storage.session, so keep a same-lifetime object as the fallback.
const sessionStore = api.storage?.session;
const memoryStore = {};

let inFlight = false;

async function read(key, fallback) {
  if (sessionStore) {
    try {
      const values = await sessionStore.get(key);
      if (key in values) {
        return values[key];
      }
    } catch {
      // Private windows or a suspended worker can refuse storage; memory still
      // answers this session.
    }
  }

  return key in memoryStore ? memoryStore[key] : fallback;
}

async function write(key, value) {
  memoryStore[key] = value;

  if (!sessionStore) {
    return;
  }

  try {
    await sessionStore.set({ [key]: value });
  } catch {
    // The memory copy above is the fallback.
  }
}

function isWebUrl(url) {
  try {
    return WEB_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function dataUrlToBlob(dataUrl) {
  const markerIndex = dataUrl.indexOf(BASE64_MARKER);
  const mimeType = dataUrl.slice(DATA_URL_PREFIX.length, markerIndex);
  const binary = atob(dataUrl.slice(markerIndex + BASE64_MARKER.length));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';

  for (let index = 0; index < bytes.length; index += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK_SIZE));
  }

  return `${DATA_URL_PREFIX}${blob.type}${BASE64_MARKER}${btoa(binary)}`;
}

// A missing or malformed setting is not worth an error: the default cap is
// always a sane answer, so this never rejects.
async function readSnapshotCap() {
  try {
    const values = await api.storage?.local?.get(SNAPSHOT_CAP_KEY);
    const cap = SNAPSHOT_CAPS[Number(values?.[SNAPSHOT_CAP_KEY])];

    if (cap) {
      return cap;
    }
  } catch {
    // Fall through to the default.
  }

  return SNAPSHOT_CAPS[SNAPSHOT_CAP_DEFAULT];
}

// Capture already costs a browser call, so re-encode only when the frame is
// larger than the chosen cap; the canvas path is best-effort and falls back
// silently.
async function downscale(dataUrl) {
  try {
    const cap = await readSnapshotCap();
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));

    if (bitmap.width <= cap.width && bitmap.height <= cap.height) {
      bitmap.close();
      return dataUrl;
    }

    const scale = Math.min(cap.width / bitmap.width, cap.height / bitmap.height);
    const canvas = new OffscreenCanvas(
      Math.round(bitmap.width * scale),
      Math.round(bitmap.height * scale),
    );
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: SNAPSHOT_QUALITY,
    });

    return await blobToDataUrl(blob);
  } catch {
    return dataUrl;
  }
}

async function captureTab(tabId) {
  // Chromium rate-limits captureVisibleTab to roughly two calls per second, so
  // a burst of tab events drops the extra captures instead of queueing them.
  if (inFlight) {
    return;
  }

  inFlight = true;

  try {
    const tab = await api.tabs.get(tabId);

    // Background tabs cannot be captured, and non-web pages (browser UI, the
    // extension's own new tab page) are excluded by the protocol check.
    if (!tab?.active || !isWebUrl(tab.url)) {
      return;
    }

    const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: SNAPSHOT_CAPTURE_QUALITY,
    });
    const open = await read(OPEN_SNAPSHOT_KEY, []);
    const entry = { tabId, url: tab.url, dataUrl: await downscale(dataUrl) };
    const nextOpen = [...open.filter((item) => item.tabId !== tabId), entry];

    // Most recent capture is last; slice keeps the newest entries.
    await write(OPEN_SNAPSHOT_KEY, nextOpen.slice(-OPEN_SNAPSHOT_LIMIT));
  } catch {
    // Capture fails on unfocused windows, protected pages and rate limits, and
    // none of those are worth surfacing to the user.
  } finally {
    inFlight = false;
  }
}

api.tabs.onActivated.addListener(({ tabId }) => {
  captureTab(tabId);
});

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Reaching "complete" means the page the user sees has changed.
  if (changeInfo.status === 'complete' && tab?.active) {
    captureTab(tabId);
  }
});

// windowId -1 means no window is focused.
api.windows?.onFocusChanged.addListener(async (windowId) => {
  if (windowId < 0) {
    return;
  }

  try {
    const tabs = await api.tabs.query({ active: true, windowId });
    if (tabs[0]) {
      captureTab(tabs[0].id);
    }
  } catch {
    // The window may be gone by the time the query resolves.
  }
});

api.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  // Closing a window is not the user closing one tab; skip the whole burst.
  if (removeInfo?.isWindowClosing) {
    return;
  }

  const open = await read(OPEN_SNAPSHOT_KEY, []);
  const entry = open.find((item) => item.tabId === tabId);

  if (!entry) {
    return;
  }

  const closed = await read(CLOSED_SNAPSHOT_KEY, []);
  const snapshots = { url: entry.url, dataUrl: entry.dataUrl };
  const nextClosed = [
    snapshots,
    ...closed.filter((item) => item.url !== entry.url),
  ];

  // Newest first, and a repeated URL keeps only its latest capture.
  await write(CLOSED_SNAPSHOT_KEY, nextClosed.slice(0, SNAPSHOT_SLOTS));
  await write(
    OPEN_SNAPSHOT_KEY,
    open.filter((item) => item.tabId !== tabId),
  );
});

api.runtime.onMessage.addListener((message) => {
  if (message?.type !== SNAPSHOT_MESSAGE) {
    return undefined;
  }

  // Returning the promise answers asynchronously in both browsers.
  return read(CLOSED_SNAPSHOT_KEY, []).then((snapshots) => ({ snapshots }));
});
