import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

const SHARED_FILES = [
  'newtab.css',
  'newtab.html',
  'newtab.js',
];

const FIREFOX_ADDON_ID = 'just-a-ntp@example.com';
const FIREFOX_MIN_VERSION = '109.0';

const FORBIDDEN_PATTERNS = [
  { pattern: /\bsetInterval\s*\(/, reason: 'polling timer' },
  { pattern: /\bsetTimeout\s*\(/, reason: 'timer-based scheduling' },
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

  await writeFile(
    path.join(targetDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  for (const file of SHARED_FILES) {
    await access(path.join(targetDir, file));
  }
  await access(path.join(targetDir, 'manifest.json'));
}

async function main() {
  await validateSource();

  const baseManifest = JSON.parse(await readSource('manifest.json'));
  const targets = {
    chrome: {
      ...baseManifest,
      permissions: ['tabs'],
      host_permissions: ['<all_urls>'],
    },
    firefox: {
      ...baseManifest,
      permissions: ['theme', 'tabs'],
      host_permissions: ['<all_urls>'],
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
