import { access, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

const SHARED_FILES = [
  'background.js',
  'i18n.js',
  'newtab.css',
  'newtab.html',
  'newtab.js',
  'stack.js',
  'topsites.js',
];

const LOCALES_DIR = '_locales';

const FIREFOX_ADDON_ID = 'ntp-plusplus@example.com';
const FIREFOX_MIN_VERSION = '109.0';
const CHROME_MIN_VERSION = '121';

const FORBIDDEN_PATTERNS = [
  { pattern: /\bsetInterval\s*\(/, reason: 'polling timer' },
  { pattern: /\bsetTimeout\s*\(/, reason: 'timer' },
  { pattern: /\bfetch\s*\(/, reason: 'network request' },
  { pattern: /\bXMLHttpRequest\b/, reason: 'network request' },
  { pattern: /\bWebSocket\b/, reason: 'network request' },
  { pattern: /\bEventSource\b/, reason: 'network request' },
  { pattern: /\bsendBeacon\b/, reason: 'network request' },
  { pattern: /https?:\/\//, reason: 'remote URL' },
];

async function readSource(file) {
  return readFile(path.join(SOURCE_DIR, file), 'utf8');
}

async function readLocaleCatalog(locale) {
  const file = path.join(SOURCE_DIR, LOCALES_DIR, locale, 'messages.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

async function validateLocales(manifest) {
  const defaultLocale = manifest.default_locale;
  if (!defaultLocale) {
    throw new Error('manifest.json must define default_locale');
  }

  const entries = await readdir(path.join(SOURCE_DIR, LOCALES_DIR), {
    withFileTypes: true,
  });
  const locales = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (!locales.includes(defaultLocale)) {
    throw new Error(`Missing default locale directory: ${LOCALES_DIR}/${defaultLocale}`);
  }

  const defaultCatalog = await readLocaleCatalog(defaultLocale);
  const defaultKeys = Object.keys(defaultCatalog).sort();
  if (defaultKeys.length === 0) {
    throw new Error(`Default locale has no messages: ${defaultLocale}`);
  }

  for (const locale of locales) {
    const catalog = await readLocaleCatalog(locale);
    const keys = Object.keys(catalog).sort();
    if (keys.join('\n') !== defaultKeys.join('\n')) {
      throw new Error(`Locale message keys differ from default: ${locale}`);
    }

    for (const key of keys) {
      if (typeof catalog[key]?.message !== 'string' || !catalog[key].message.trim()) {
        throw new Error(`Empty message "${key}" in locale: ${locale}`);
      }
    }
  }
}

async function validateSource() {
  for (const file of SHARED_FILES) {
    const source = await readSource(file);

    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(source)) {
        throw new Error(`${file} contains ${reason}: ${pattern}`);
      }
    }
  }

  const css = await readSource('newtab.css');
  if (!css.includes('prefers-color-scheme: dark')) {
    throw new Error('newtab.css must provide a dark color-scheme fallback');
  }
}

async function buildTarget(target, manifest) {
  const targetDir = path.join(DIST_DIR, target);
  await mkdir(targetDir, { recursive: true });

  for (const file of SHARED_FILES) {
    await cp(path.join(SOURCE_DIR, file), path.join(targetDir, file));
  }

  await cp(
    path.join(SOURCE_DIR, LOCALES_DIR),
    path.join(targetDir, LOCALES_DIR),
    { recursive: true },
  );

  await writeFile(
    path.join(targetDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  for (const file of SHARED_FILES) {
    await access(path.join(targetDir, file));
  }
  await access(
    path.join(targetDir, LOCALES_DIR, manifest.default_locale, 'messages.json'),
  );
  await access(path.join(targetDir, 'manifest.json'));
}

async function main() {
  await validateSource();

  const baseManifest = JSON.parse(await readSource('manifest.json'));
  await validateLocales(baseManifest);
  const targets = {
    // Chrome 121+ only honours service_worker, Firefox has no service_worker
    // support and skips the whole background when one is declared.
    chrome: {
      ...baseManifest,
      minimum_chrome_version: CHROME_MIN_VERSION,
      permissions: ['sessions', 'storage', 'tabs', 'topSites', 'favicon'],
      host_permissions: ['<all_urls>'],
      background: { service_worker: 'background.js' },
    },
    firefox: {
      ...baseManifest,
      permissions: ['sessions', 'storage', 'theme', 'tabs', 'topSites', 'bookmarks'],
      host_permissions: ['<all_urls>'],
      background: { scripts: ['background.js'] },
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ADDON_ID,
          strict_min_version: FIREFOX_MIN_VERSION,
        },
      },
    },
  };

  await rm(DIST_DIR, { recursive: true, force: true });
  for (const [target, manifest] of Object.entries(targets)) {
    await buildTarget(target, manifest);
  }

  console.log(`Built ${Object.keys(targets).join(', ')} into dist/.`);
}

main().catch((error) => {
  console.error(`Build failed: ${error.message}`);
  process.exitCode = 1;
});
