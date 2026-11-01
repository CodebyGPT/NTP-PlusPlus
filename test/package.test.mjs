import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryNames, writeZip } from '../src/../scripts/package.mjs';

const root = mkdtempSync(join(tmpdir(), 'ntp-package-'));
try {
  mkdirSync(join(root, '_locales', 'zh_CN'), { recursive: true });
  writeFileSync(join(root, 'manifest.json'), '{"name":"x"}');
  writeFileSync(join(root, '_locales', 'zh_CN', 'messages.json'), '{"a":{"message":"b"}}');

  const zip = join(root, 'out.zip');
  const names = writeZip(root, zip);

  // The whole point: forward slashes, never the Windows separator.
  assert.deepEqual(names, ['_locales/zh_CN/messages.json', 'manifest.json']);
  assert.deepEqual(entryNames(zip), names);
  console.log('package checks passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
