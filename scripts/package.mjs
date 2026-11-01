// Builds the two release archives.
//
// The zip writer is hand-rolled for one reason: Compress-Archive (and .NET's
// ZipFile) write entry names with backslashes on Windows, and Firefox rejects
// such an archive as corrupt. Every entry name here uses forward slashes.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, relative, sep } from 'node:path';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function listFiles(root, prefix = '') {
  const files = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = join(prefix, name);
    if (statSync(join(root, path)).isDirectory()) {
      files.push(...listFiles(root, path));
    } else {
      files.push(path.split(sep).join('/'));
    }
  }
  return files;
}

export function writeZip(root, outPath) {
  const entries = [];
  const chunks = [];
  let offset = 0;

  for (const name of listFiles(root)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = readFileSync(join(root, name));
    const packed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0x21, 12); // date: 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);

    entries.push({ nameBytes, crc, packedSize: packed.length, size: raw.length, offset });
    chunks.push(header, nameBytes, packed);
    offset += header.length + nameBytes.length + packed.length;
  }

  const centralStart = offset;
  for (const entry of entries) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.packedSize, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE(0, 38); // external attrs
    header.writeUInt32LE(entry.offset, 42);
    chunks.push(header, entry.nameBytes);
    offset += header.length + entry.nameBytes.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  mkdirSync(join(outPath, '..'), { recursive: true });
  writeFileSync(outPath, Buffer.concat(chunks));
  return entries.map((entry) => entry.nameBytes.toString('utf8'));
}

export function entryNames(zipPath) {
  const buffer = readFileSync(zipPath);
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) {
    throw new Error(`${zipPath} has no end-of-central-directory record`);
  }
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`bad central directory entry at ${at}`);
    }
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    names.push(buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

const TARGETS = ['chrome', 'firefox'];
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;

export function packageTargets(distRoot = 'dist', version = VERSION) {
  const built = [];
  for (const target of TARGETS) {
    const out = join(distRoot, `NTPPlusPlus-${target}-${version}.zip`);
    writeZip(join(distRoot, target), out);
    built.push({ target, path: out, entries: entryNames(out) });
  }
  return built;
}

if (process.argv[1] && process.argv[1].endsWith('package.mjs')) {
  for (const built of packageTargets()) {
    console.log(`${relative(process.cwd(), built.path)}  ${built.entries.length} files`);
  }
}
