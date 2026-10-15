/**
 * Minimal ZIP reader.
 *
 * Written rather than depended on: a plugin installed into a DSH profile is loaded
 * by the Host's loader and must not import anything it did not ship, so a runtime
 * `require('fflate')` would work only by accident. Node's `zlib` already has the
 * only hard part (`inflateRawSync`), and the archive format around it is a few
 * fixed-layout records, so the reader is small enough to own.
 *
 * Only what an archive of text files needs is supported: stored and deflated
 * entries, read through the central directory. Anything else is reported as
 * unsupported rather than guessed at. Zip64 and encrypted entries are refused.
 *
 * @module core/zip
 */

import { inflateRawSync } from 'node:zlib';

/** One file recovered from an archive. */
export interface ZipEntry {
  /** Path as recorded in the archive, with forward slashes. */
  readonly name: string;
  /** Extracted bytes. */
  readonly data: Buffer;
}

/** Why an archive could not be read. */
export interface ZipFailure {
  /** Stable code. */
  readonly code: string;
  /** English explanation. */
  readonly message: string;
}

/** Result of reading an archive. */
export type ZipResult = { readonly ok: true; readonly entries: ZipEntry[] } | { readonly ok: false; readonly error: ZipFailure };

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;

/** CRC-32 table, built once. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 of a buffer, as the ZIP format records it. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Find the end-of-central-directory record, searching back over the comment. */
function findEndRecord(view: Buffer): number {
  const earliest = Math.max(0, view.length - 0xffff - 22);
  for (let offset = view.length - 22; offset >= earliest; offset -= 1) {
    if (view.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

/**
 * Read every file from a ZIP archive held in memory.
 * @param archive - the raw archive bytes.
 * @returns the entries, or why the archive could not be read.
 */
export function readZip(archive: Buffer): ZipResult {
  if (archive.length < 22) {
    return { ok: false, error: { code: 'error.zip.truncated', message: 'The archive is too small to be a ZIP file.' } };
  }

  const end = findEndRecord(archive);
  if (end < 0) {
    return { ok: false, error: { code: 'error.zip.format', message: 'The download is not a ZIP archive (no end-of-directory record).' } };
  }

  // Zip64 keeps its real counts in a separate record this reader does not follow.
  for (let offset = end - 20; offset >= 0 && offset >= end - 64; offset -= 1) {
    const signature = archive.readUInt32LE(offset);
    if (signature === ZIP64_LOCATOR || signature === ZIP64_END) {
      return { ok: false, error: { code: 'error.zip.zip64', message: 'This archive needs Zip64, which is not supported.' } };
    }
  }

  const entryCount = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      return { ok: false, error: { code: 'error.zip.damaged', message: 'The archive directory is damaged or truncated.' } };
    }

    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    cursor += 46 + nameLength + extraLength + commentLength;

    // Directories carry no data.
    if (name.endsWith('/')) continue;
    if ((flags & 0x1) === 1) {
      return { ok: false, error: { code: 'error.zip.encrypted', message: `"${name}" is encrypted, which is not supported.` } };
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      return { ok: false, error: { code: 'error.zip.zip64', message: 'This archive needs Zip64, which is not supported.' } };
    }

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      return { ok: false, error: { code: 'error.zip.damaged', message: `The entry "${name}" has no readable header.` } };
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      try {
        data = inflateRawSync(compressed);
      } catch {
        return { ok: false, error: { code: 'error.zip.deflate', message: `The entry "${name}" could not be decompressed.` } };
      }
    } else {
      return { ok: false, error: { code: 'error.zip.method', message: `The entry "${name}" uses compression method ${String(method)}, which is not supported.` } };
    }

    if (data.length !== uncompressedSize) {
      return { ok: false, error: { code: 'error.zip.size', message: `The entry "${name}" did not decompress to its recorded size.` } };
    }
    if (crc32(data) !== expectedCrc) {
      return { ok: false, error: { code: 'error.zip.crc', message: `The entry "${name}" failed its checksum; the download may be damaged.` } };
    }

    entries.push({ name, data });
  }

  return { ok: true, entries };
}
