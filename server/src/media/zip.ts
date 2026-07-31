import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

/*
 * A minimal, streaming ZIP writer.
 *
 * Store-only — no deflate. Every file in this library is already compressed
 * (H.264, JPEG, PNG), so deflating them costs CPU to produce a *larger*
 * archive. Storing is both the correct choice and the one that needs no
 * dependency: adding `archiver` for this would mean a Docker image rebuild
 * for what amounts to a hundred lines of well-specified header layout.
 */

const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/**
 * Bit 3: sizes and CRC follow the data in a descriptor rather than preceding
 * it, which is what lets us stream a file we have not read yet.
 * Bit 11: the filename is UTF-8.
 */
const FLAGS = 0x0008 | 0x0800;

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

function crc32(chunk: Buffer, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < chunk.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ chunk[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, which is what the format stores. */
function dosDateTime(date: Date): { time: number; date: number } {
  // The epoch is 1980, and seconds only have two-second resolution.
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export type ZipEntry = {
  /** Path inside the archive. Must already be unique and sanitised. */
  name: string;
  /** Absolute path on disk. */
  path: string;
  modifiedAt: Date;
};

/**
 * ZIP has 32-bit size fields. Beyond this an archive needs the ZIP64
 * extensions, which is a lot of extra format for a "save these few clips"
 * button — the route refuses the request instead, with a message that says so.
 */
export const ZIP_MAX_BYTES = 0xffffffff;

/**
 * Stream a ZIP built from the given files.
 *
 * Each file is read exactly once. Nothing is buffered beyond the current
 * chunk, so a 3 GB archive costs no more memory than a 3 MB one.
 */
export function createZipStream(entries: readonly ZipEntry[]): Readable {
  type Central = {
    name: Buffer;
    crc: number;
    size: number;
    offset: number;
    time: number;
    date: number;
  };

  async function* generate(): AsyncGenerator<Buffer> {
    const central: Central[] = [];
    let offset = 0;

    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const { time, date } = dosDateTime(entry.modifiedAt);

      const header = Buffer.alloc(30);
      header.writeUInt32LE(LOCAL_HEADER, 0);
      header.writeUInt16LE(20, 4); // version needed
      header.writeUInt16LE(FLAGS, 6);
      header.writeUInt16LE(0, 8); // method: stored
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      // CRC and sizes are unknown until the file has been read; they go in
      // the data descriptor after it.
      header.writeUInt32LE(0, 14);
      header.writeUInt32LE(0, 18);
      header.writeUInt32LE(0, 22);
      header.writeUInt16LE(name.length, 26);
      header.writeUInt16LE(0, 28); // extra field length

      const localOffset = offset;
      yield header;
      yield name;
      offset += header.length + name.length;

      let crc = 0;
      let size = 0;

      for await (const chunk of createReadStream(entry.path)) {
        const buffer = chunk as Buffer;
        crc = crc32(buffer, crc);
        size += buffer.length;
        offset += buffer.length;
        yield buffer;
      }

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      yield descriptor;
      offset += descriptor.length;

      central.push({ name, crc, size, offset: localOffset, time, date });
    }

    // ── Central directory ────────────────────────────────────────────────
    const directoryStart = offset;

    for (const item of central) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL_HEADER, 0);
      record.writeUInt16LE(20, 4); // version made by
      record.writeUInt16LE(20, 6); // version needed
      record.writeUInt16LE(FLAGS, 8);
      record.writeUInt16LE(0, 10); // method: stored
      record.writeUInt16LE(item.time, 12);
      record.writeUInt16LE(item.date, 14);
      record.writeUInt32LE(item.crc, 16);
      record.writeUInt32LE(item.size, 20);
      record.writeUInt32LE(item.size, 24);
      record.writeUInt16LE(item.name.length, 28);
      record.writeUInt16LE(0, 30); // extra
      record.writeUInt16LE(0, 32); // comment
      record.writeUInt16LE(0, 34); // disk number
      record.writeUInt16LE(0, 36); // internal attrs
      record.writeUInt32LE(0, 38); // external attrs
      record.writeUInt32LE(item.offset, 42);

      yield record;
      yield item.name;
      offset += record.length + item.name.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL, 0);
    end.writeUInt16LE(0, 4); // this disk
    end.writeUInt16LE(0, 6); // disk with central directory
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - directoryStart, 12);
    end.writeUInt32LE(directoryStart, 16);
    end.writeUInt16LE(0, 20); // comment length
    yield end;
  }

  return Readable.from(generate());
}

/**
 * Make a filename safe for an archive, and unique within it.
 *
 * Clip titles are free text and routinely collide ("Untitled clip" ×4), which
 * would otherwise produce an archive whose entries silently overwrite each
 * other on extraction.
 */
export function uniqueEntryName(rawName: string, extension: string, taken: Set<string>): string {
  // An untitled clip falls back to its original filename, which already ends
  // in the extension about to be appended — otherwise "zt2.png" is saved as
  // "zt2.png.png". Only an exact match is stripped, so a title that genuinely
  // ends in something dot-ish ("Episode 1.5") keeps it.
  const withoutExtension = rawName.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
    ? rawName.slice(0, -(extension.length + 1))
    : rawName;

  const base =
    withoutExtension
      // Reserved on Windows or meaningful to a path. Spaces are deliberately
      // kept — stripping them turns "Dog versus sprinkler" into one word.
      .replace(/[/\\?%*:|"<>]/g, '')
      .replace(/\s+/g, ' ')
      // A leading dot hides the file on unix and confuses some extractors.
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 80) || 'clip';

  let candidate = `${base}.${extension}`;
  let counter = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} (${counter}).${extension}`;
    counter += 1;
  }

  taken.add(candidate.toLowerCase());
  return candidate;
}
