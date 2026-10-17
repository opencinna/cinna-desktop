/**
 * A minimal zip writer for artifact uploads: deflate (or store, when deflate
 * does not help), UTF-8 names, regular-file permissions, no zip64 — an
 * upload is at most 2000 files and 50 MB (A11), far inside the classic
 * format. Written here rather than pulled in as a dependency.
 */

import * as zlib from 'node:zlib'

export interface ZipEntry {
  /** `/`-separated, relative. */
  name: string
  data: Buffer
  mtime?: Date
}

let crcTable: Uint32Array | null = null

function tableCrc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** `zlib.crc32` where this Node has it (22.2+), else a table. */
export function crc32(data: Buffer): number {
  const native = (zlib as unknown as { crc32?: (data: Buffer) => number }).crc32
  return typeof native === 'function' ? native(data) >>> 0 : tableCrc32(data)
}

/** Exposed for the test that checks both give the same answer. */
export const crc32ForTest = { table: tableCrc32 }

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  }
}

const UTF8_FLAG = 0x0800
/** Unix, zip 2.0. */
const MADE_BY = (3 << 8) | 20
const NEEDED = 20
/** `-rw-r--r--` regular file, in the high half of the external attributes. */
const REGULAR_FILE_ATTRS = (0o100644 << 16) >>> 0

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const deflated = zlib.deflateRawSync(entry.data)
    const store = deflated.length >= entry.data.length
    const body = store ? entry.data : deflated
    const method = store ? 0 : 8
    const { time, date } = dosDateTime(entry.mtime ?? new Date())

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(NEEDED, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(MADE_BY, 4)
    central.writeUInt16LE(NEEDED, 6)
    central.writeUInt16LE(UTF8_FLAG, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(REGULAR_FILE_ATTRS, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, directory, end])
}
