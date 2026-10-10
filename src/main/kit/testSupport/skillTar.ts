/**
 * Tests only: a minimal tar writer for skill archive fixtures — ustar
 * headers, pax extended headers and GNU long names — so the reader's
 * refusals can be proved on archives no well-behaved tool would write.
 */
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

export interface TarMember {
  name: string
  /** `0` file (default), `5` folder, `1` hard link, `2` symlink, `3` char device, `6` FIFO. */
  type?: '0' | '5' | '1' | '2' | '3' | '6'
  body?: string | Buffer
  mode?: number
  linkname?: string
  /** How a long name travels: a pax `x` header (default) or a GNU `L` member. */
  longName?: 'pax' | 'gnu'
}

function header(name: string, type: string, size: number, mode: number, linkname = ''): Buffer {
  const block = Buffer.alloc(512)
  block.write(name.slice(0, 100), 0, 'utf8')
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii')
  block.write('0000000\0', 108, 'ascii')
  block.write('0000000\0', 116, 'ascii')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  block.write('00000000000\0', 136, 'ascii')
  block.write(type, 156, 'ascii')
  block.write(linkname.slice(0, 100), 157, 'utf8')
  block.write('ustar\0', 257, 'ascii')
  block.write('00', 263, 'ascii')
  block.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}

function padded(data: Buffer): Buffer {
  const rest = data.length % 512
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)])
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (`${length}${body}`.length !== length) length = `${length}${body}`.length
  return `${length}${body}`
}

/** The tar stream for `members`, ending in two zero blocks. */
export function tarOf(members: TarMember[]): Buffer {
  const parts: Buffer[] = []
  for (const member of members) {
    const type = member.type ?? '0'
    const body = Buffer.from(member.body ?? '')
    const mode = member.mode ?? (type === '5' ? 0o755 : 0o644)
    let name = member.name
    if (Buffer.byteLength(name) > 100) {
      if (member.longName === 'gnu') {
        const data = Buffer.from(`${name}\0`)
        parts.push(header('././@LongLink', 'L', data.length, 0o644), padded(data))
      } else {
        const data = Buffer.from(paxRecord('path', name))
        parts.push(header('PaxHeader/x', 'x', data.length, 0o644), padded(data))
      }
      name = name.slice(0, 100)
    }
    const size = type === '0' ? body.length : 0
    parts.push(header(name, type, size, mode, member.linkname ?? ''))
    if (size > 0) parts.push(padded(body))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

export function tgzOf(members: TarMember[]): Buffer {
  return gzipSync(tarOf(members))
}

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A valid skill as core serves it: `skills/<name>/SKILL.md` (+ a script). */
export function skillTgz(name: string, description = 'Looks things up.'): Buffer {
  return tgzOf([
    { name: `skills/${name}/SKILL.md`, body: `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n` },
    { name: `skills/${name}/scripts/run.sh`, body: '#!/bin/sh\necho hi\n', mode: 0o755 }
  ])
}

/**
 * Built by cinna-core's own `SkillCatalogService._build_archive_bytes`
 * (Python 3.9 `tarfile`, PAX format): `erp-lookup` with `SKILL.md`
 * (one `api_token` credential slot `erp-api`), an executable `scripts/run.sh`
 * and a file whose path is over 100 characters, so it carries a pax header.
 */
export const CORE_BUILT_ERP_LOOKUP = {
  sha256: '74af2d086cc01d1363b7aa846c73f7fb0cefb28c721f2837288e3f1bd1e8f1bc',
  base64:
    'H4sIAAAAAAAC/+3Wz0vDMBQH8J77V0Q8p2m7dcOB4EVQ3GEoniW2zyWsS0KS6vzvfdvAscnwsh+I73Pp+lJeDu03b2Gm2zYI8I631s46J54e7sfjbN4kB5OjQb+/uqLda14WxffvVb0oq16VsDw5gS5E6XH75H/inKdGzmHENp9A2kCovXZRWzNiY6yxqLSZBtY5pg3eALt9nGRp7aEBE7VswyhljLPQ2rjuJJ3GCmPx02FvvHuJdgYmXe6XPgdg6x2C8J3JgsrShJxDJjJxM5GLO5AN+OPssSf3m/znu/nH0iBhC8r/0RXlFXMyquvwYxA0tg5Cco+r4LFopvzNtviV8OWBwaPlrguK4ypfduD2HZesAa460+DJwGslvawj+CCMjRD4h8bH5LrVsgdOGcr9eZ3itf82//O82s5/Dx8f0Pw/hQbAUQYp/5v8b/8xO9T8H1bV/vyX5c787xeDIeX/FC4vxKs2IqgUamWZ0nQYEEIIIYQQQgghhBBCCCGE/GlfM3fAawAoAAA='
}
