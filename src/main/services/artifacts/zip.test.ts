import { describe, expect, it } from 'vitest'
import { inflateRawSync } from 'node:zlib'
import { buildZip, crc32, crc32ForTest } from './zip'

/** Read a zip back through its central directory, as an unzipper would. */
function parseZip(zip: Buffer): Array<{ name: string; data: Buffer; mode: number; crc: number }> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end).toBeGreaterThanOrEqual(0)
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const out: Array<{ name: string; data: Buffer; mode: number; crc: number }> = []
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50)
    const flags = zip.readUInt16LE(at + 8)
    expect(flags & 0x0800).toBe(0x0800)
    const method = zip.readUInt16LE(at + 10)
    const crc = zip.readUInt32LE(at + 16)
    const compressed = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const extra = zip.readUInt16LE(at + 30)
    const comment = zip.readUInt16LE(at + 32)
    const mode = zip.readUInt32LE(at + 38) >>> 16
    const local = zip.readUInt32LE(at + 42)
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    expect(zip.readUInt32LE(local)).toBe(0x04034b50)
    const localName = zip.readUInt16LE(local + 26)
    const localExtra = zip.readUInt16LE(local + 28)
    const start = local + 30 + localName + localExtra
    const body = zip.subarray(start, start + compressed)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    expect(data.length).toBe(size)
    out.push({ name, data, mode, crc })
    at += 46 + nameLength + extra + comment
  }
  return out
}

describe('buildZip', () => {
  it('round-trips names, bytes and modes through the central directory', () => {
    const entries = [
      { name: 'index.html', data: Buffer.from('<h1>Q3</h1>'.repeat(50)) },
      { name: 'data/rows.csv', data: Buffer.from('a,b\n1,2\n') },
      { name: 'данные/é.txt', data: Buffer.from('unicode name') },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'random.bin', data: Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7919) % 251)) }
    ]
    const parsed = parseZip(buildZip(entries))
    expect(parsed.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name))
    parsed.forEach((entry, i) => {
      expect(entry.data.equals(entries[i].data)).toBe(true)
      expect(entry.crc).toBe(crc32(entries[i].data))
      expect(entry.mode).toBe(0o100644)
    })
  })

  it('an empty archive is just its end record', () => {
    expect(parseZip(buildZip([]))).toEqual([])
  })

  it('the table crc32 agrees with the known value and with zlib', () => {
    const data = Buffer.from('123456789')
    expect(crc32ForTest.table(data)).toBe(0xcbf43926)
    expect(crc32(data)).toBe(0xcbf43926)
  })
})
