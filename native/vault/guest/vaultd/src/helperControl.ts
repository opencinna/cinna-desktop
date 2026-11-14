/**
 * The helper's control socket (vsock 5001, never reachable from main):
 * ndjson `{"op":"ping"}`, `{"op":"suspend"}`, `{"op":"resume","key":"<hex>"}`,
 * `{"op":"subscribe"}`, each answered with `{"ok":true}` or
 * `{"ok":false,"error":"..."}`. A subscribed connection also receives
 * `{"event":"exec-end","proxyCred":"<cred>"}` (D37) and stays usable for the
 * other ops.
 *
 * Suspend/resume drive `cryptsetup luksSuspend|luksResume vault`. The key
 * goes to cryptsetup on stdin (`--key-file=-`) as the same hex text
 * vault-init used for luksOpen — never on argv, never in a file, and never a
 * JS string (D39): lines are Buffers, the key's bytes are cut out of the line
 * by byte search and blanked before the rest is parsed, and every copy is
 * zeroed. Fake mode acknowledges without doing anything.
 */
import type { Socket } from 'node:net'
import { runCollect } from './procs'
import { log } from './util'

export const LUKS_NAME = 'vault'

export interface HelperOps {
  suspend(): Promise<void>
  /** `key` is the 64 ASCII hex bytes; the caller zeroes it afterwards. */
  resume(key: Buffer): Promise<void>
}

export function cryptsetupOps(path: string): HelperOps {
  const env = { PATH: path, LANG: 'C' }
  return {
    async suspend() {
      const r = await runCollect('cryptsetup', ['luksSuspend', LUKS_NAME], { env, timeoutMs: 60_000 })
      if (r.code !== 0) throw new Error('luksSuspend failed')
    },
    async resume(key) {
      const input = Buffer.from(key)
      try {
        const r = await runCollect('cryptsetup', ['luksResume', LUKS_NAME, '--key-file=-'], { env, input, timeoutMs: 60_000 })
        if (r.code !== 0) throw new Error('luksResume failed')
      } finally {
        input.fill(0)
      }
    }
  }
}

export const fakeOps: HelperOps = { async suspend() {}, async resume() {} }

/** Most helper connections at once (the helper keeps one subscriber and opens one per op). */
export const HELPER_CONNECTIONS_MAX = 8
const HELPER_LINE_MAX = 4096
const KEY_LENGTH = 64

/**
 * Exec-end events for the helper's subscribers. A credential is reported
 * ended when the last running exec that carries it ends, so two concurrent
 * execs of one session token do not cut each other off.
 */
export class HelperEvents {
  private readonly subscribers = new Set<Socket>()
  private readonly running = new Map<string, number>()

  subscribe(socket: Socket): void {
    this.subscribers.add(socket)
    socket.on('close', () => this.subscribers.delete(socket))
  }

  execStarted(cred: string): void {
    this.running.set(cred, (this.running.get(cred) ?? 0) + 1)
  }

  execEnded(cred: string): void {
    const left = (this.running.get(cred) ?? 1) - 1
    if (left > 0) {
      this.running.set(cred, left)
      return
    }
    this.running.delete(cred)
    this.emit({ event: 'exec-end', proxyCred: cred })
  }

  private emit(event: object): void {
    const line = JSON.stringify(event) + '\n'
    for (const socket of this.subscribers) if (!socket.destroyed && socket.writable) socket.write(line)
  }
}

const KEY_FIELD = Buffer.from('"key"')

function isHexByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66)
}

/**
 * Cut the `"key":"<64 lowercase hex>"` value out of a request line: returns a
 * fresh Buffer with the key's bytes (or `bad` when a key field is there but
 * malformed, `none` without one) and overwrites them in `line` with `0`, so
 * the line can then be JSON-parsed without the key ever becoming a string.
 */
export function takeKey(line: Buffer): Buffer | 'none' | 'bad' {
  const at = line.indexOf(KEY_FIELD)
  if (at === -1) return 'none'
  let i = at + KEY_FIELD.length
  while (i < line.length && (line[i] === 0x20 || line[i] === 0x09)) i++
  if (line[i] !== 0x3a) return 'bad'
  i++
  while (i < line.length && (line[i] === 0x20 || line[i] === 0x09)) i++
  if (line[i] !== 0x22) return 'bad'
  const start = i + 1
  let end = start
  while (end < line.length && line[end] !== 0x22) end++
  if (end >= line.length) return 'bad'
  let ok = end - start === KEY_LENGTH
  for (let k = start; k < end; k++) if (!isHexByte(line[k])) ok = false
  const key = ok ? Buffer.from(line.subarray(start, end)) : null
  line.fill(0x30, start, end)
  return key ?? 'bad'
}

export function serveHelper(socket: Socket, ops: HelperOps, events: HelperEvents): void {
  let pending: Buffer[] = []
  let pendingBytes = 0
  let queue = Promise.resolve()
  const reply = (value: object): void => {
    if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n')
  }
  const wipe = (): void => {
    for (const b of pending) b.fill(0)
    pending = []
    pendingBytes = 0
  }
  const handle = async (line: Buffer): Promise<void> => {
    let key: Buffer | 'none' | 'bad' = 'none'
    let op: unknown
    try {
      key = takeKey(line)
      try {
        op = (JSON.parse(line.toString('utf8')) as { op?: unknown }).op
      } catch {
        reply({ ok: false, error: 'bad request' })
        return
      }
    } finally {
      line.fill(0)
    }
    try {
      if (op === 'ping') {
        reply({ ok: true })
      } else if (op === 'subscribe') {
        events.subscribe(socket)
        reply({ ok: true })
      } else if (op === 'suspend') {
        await ops.suspend()
        log('info', 'data disk suspended')
        reply({ ok: true })
      } else if (op === 'resume') {
        if (!Buffer.isBuffer(key)) {
          reply({ ok: false, error: 'bad key' })
          return
        }
        await ops.resume(key)
        log('info', 'data disk resumed')
        reply({ ok: true })
      } else {
        reply({ ok: false, error: 'unknown op' })
      }
    } catch (err) {
      log('error', 'helper op failed', { op: typeof op === 'string' ? op.slice(0, 32) : 'invalid' })
      reply({ ok: false, error: (err as Error).message })
    } finally {
      if (Buffer.isBuffer(key)) key.fill(0)
    }
  }
  socket.on('data', (chunk: Buffer) => {
    let from = 0
    let nl: number
    while ((nl = chunk.indexOf(0x0a, from)) !== -1) {
      const part = chunk.subarray(from, nl)
      const line = Buffer.concat([...pending, part])
      wipe()
      from = nl + 1
      if (line.length > HELPER_LINE_MAX) {
        line.fill(0)
        chunk.fill(0)
        socket.destroy()
        return
      }
      if (line.some((b) => b !== 0x20 && b !== 0x0d && b !== 0x09)) queue = queue.then(() => handle(line))
      else line.fill(0)
    }
    if (from < chunk.length) {
      const rest = Buffer.from(chunk.subarray(from))
      pending.push(rest)
      pendingBytes += rest.length
    }
    chunk.fill(0)
    if (pendingBytes > HELPER_LINE_MAX) {
      wipe()
      socket.destroy()
    }
  })
  socket.on('close', wipe)
  socket.on('error', () => {})
}
