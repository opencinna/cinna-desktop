/**
 * Receiving bytes from an attached stream, and extracting tar archives
 * safely (see tarCheck.ts for the rules).
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, openSync, readSync, closeSync } from 'node:fs'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { runCollect } from './procs'
import { checkTar, verifyTree, type TarSummary } from './tarCheck'
import { VaultdError } from './util'

/** A unique scratch path under the vault's tmp dir. */
export function scratch(tmp: string, label: string): string {
  return join(tmp, `${label}-${randomBytes(8).toString('hex')}`)
}

/** Write everything the socket sends (until its end) to `file`; return its sha256 and length. */
export function receiveToFile(socket: Socket, file: string, mode = 0o600): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let bytes = 0
    const out = createWriteStream(file, { mode })
    let failed = false
    const fail = (err: Error): void => {
      if (failed) return
      failed = true
      out.destroy()
      reject(err)
    }
    socket.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      bytes += chunk.length
      if (!out.write(chunk)) {
        socket.pause()
        out.once('drain', () => socket.resume())
      }
    })
    socket.on('end', () => {
      out.end(() => {
        if (!failed) resolve({ sha256: hash.digest('hex'), bytes })
      })
    })
    socket.on('error', fail)
    socket.on('close', (hadError) => {
      if (!socket.readableEnded) fail(new Error(hadError ? 'stream broke' : 'stream closed early'))
    })
    out.on('error', fail)
    socket.resume()
  })
}

function sniff(file: string): Buffer {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(6)
    const n = readSync(fd, head, 0, 6, 0)
    return head.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/** A plain tar path for `file`: itself, or a gunzipped copy. xz/zstd/bzip2 are refused. */
export async function plainTar(file: string, tmp: string): Promise<string> {
  const head = sniff(file)
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const out = scratch(tmp, 'gunzip') + '.tar'
    await pipeline(createReadStream(file), createGunzip(), createWriteStream(out, { mode: 0o600 }))
    return out
  }
  if (head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) ||
      (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) ||
      head.subarray(0, 3).toString('latin1') === 'BZh') {
    throw new VaultdError('invalid', 'Archive refused: only plain or gzip tar is accepted.')
  }
  return file
}

/**
 * Check `tarFile` header by header, extract it into the fresh directory
 * `dest` with the system tar, then walk the result again.
 */
export async function extractChecked(tarFile: string, dest: string, env: Record<string, string>): Promise<TarSummary> {
  const summary = checkTar(tarFile)
  mkdirSync(dest, { recursive: true, mode: 0o755 })
  // `-o`: owner from the extracting user (GNU: --no-same-owner; bsdtar: same meaning).
  // Both tars also refuse `..` and strip a leading `/` by default.
  const result = await runCollect('tar', ['-x', '-o', '-f', tarFile, '-C', dest], { env, cwd: dest, timeoutMs: 30 * 60_000 })
  if (result.code !== 0) throw new VaultdError('invalid', 'Archive could not be extracted.')
  verifyTree(dest)
  return summary
}
