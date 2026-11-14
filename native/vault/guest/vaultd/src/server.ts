/**
 * cinna-vaultd's listeners. Every main connection starts with one hello
 * line: `{"type":"control"}` (JSON-RPC 2.0 ndjson follows) or
 * `{"type":"attach","stream":"<id>"}` (raw bytes of that stream follow).
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { VaultdMethod, VaultdNotification } from '../../../../../src/shared/vault/protocol'
import { layoutOf, type VaultdConfig } from './config'
import type { Conn, Ctx, Handler, Params } from './context'
import { authLogin, authStatus, engineKill, engineSpawn } from './engine'
import { exec } from './exec'
import { filesExport, filesImport, filesList } from './files'
import { cryptsetupOps, fakeOps, HELPER_CONNECTIONS_MAX, HelperEvents, serveHelper, type HelperOps } from './helperControl'
import { killGroup } from './procs'
import { runtimeInstall, runtimeStatus } from './runtime'
import { secretsDelete, secretsList, secretsPut } from './secrets'
import { secretsPutFile } from './secretFiles'
import {
  diskUsage, hello, kvGet, kvPut, layoutEnsure, transcriptAppend, transcriptDelete, transcriptList, transcriptRead
} from './state'
import { Streams } from './streams'
import { TokenVerifier } from './tokens'
import { log, VaultdError } from './util'

export const HANDLERS: Record<VaultdMethod, Handler> = {
  hello,
  'layout.ensure': layoutEnsure,
  'disk.usage': diskUsage,
  'runtime.status': runtimeStatus,
  'runtime.install': runtimeInstall,
  'files.import': filesImport,
  'files.export': filesExport,
  'files.list': filesList,
  exec,
  'secrets.put': secretsPut,
  'secrets.list': secretsList,
  'secrets.delete': secretsDelete,
  'secrets.putFile': secretsPutFile,
  'engine.spawn': engineSpawn,
  'engine.kill': engineKill,
  'auth.status': authStatus,
  'auth.login': authLogin,
  'transcript.append': transcriptAppend,
  'transcript.read': transcriptRead,
  'transcript.list': transcriptList,
  'transcript.delete': transcriptDelete,
  'kv.get': kvGet,
  'kv.put': kvPut
}

const HELLO_MAX = 4096
const HELLO_TIMEOUT_MS = 10_000
/** A control line; only `transcript.append` may carry more (a large transcript batch). */
export const LINE_MAX = 1024 * 1024
export const TRANSCRIPT_LINE_MAX = 8 * 1024 * 1024
/** Control connections main may hold at once (attached streams are not counted). */
export const CONTROL_CONNECTIONS_MAX = 16
/** Where a request's method has to appear for the larger limit (clients write `method` before `params`). */
const METHOD_PREFIX = 256
const TRANSCRIPT_METHOD = Buffer.from('"method":"transcript.append"')

/** The first METHOD_PREFIX bytes of a partial line. */
function headOf(parts: Buffer[]): Buffer {
  const head: Buffer[] = []
  let n = 0
  for (const part of parts) {
    if (n >= METHOD_PREFIX) break
    head.push(part)
    n += part.length
  }
  return head.length === 1 ? head[0] : Buffer.concat(head)
}

/** The byte limit for a (possibly partial) request line, from its first bytes. */
export function lineLimit(head: Buffer): number {
  return head.subarray(0, METHOD_PREFIX).includes(TRANSCRIPT_METHOD) ? TRANSCRIPT_LINE_MAX : LINE_MAX
}

/** JSON-RPC: -32000 for application errors, the string code in `data.code`. */
const RPC_APP_ERROR = -32000

export interface VaultdOptions {
  attachTimeoutMs?: number
  now?: () => number
  helperOps?: HelperOps
}

export interface Vaultd {
  ctx: Ctx
  listen(): Promise<void>
  close(): Promise<void>
}

/** Read the first line, then hand the socket (with any bytes past the line put back) to `next`. */
function readHello(socket: Socket, next: (hello: unknown) => void): void {
  let buf = Buffer.alloc(0)
  const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS)
  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    const nl = buf.indexOf(0x0a)
    if (nl === -1) {
      if (buf.length > HELLO_MAX) { clearTimeout(timer); socket.destroy() }
      return
    }
    clearTimeout(timer)
    socket.off('data', onData)
    socket.pause()
    const rest = buf.subarray(nl + 1)
    if (rest.length) socket.unshift(rest)
    let parsed: unknown
    try {
      parsed = JSON.parse(buf.subarray(0, nl).toString('utf8'))
    } catch {
      socket.destroy()
      return
    }
    next(parsed)
  }
  socket.on('data', onData)
  socket.on('error', () => clearTimeout(timer))
  socket.on('close', () => clearTimeout(timer))
}

function serveControl(ctx: Ctx, socket: Socket): void {
  const conn: Conn = {
    notify<M extends VaultdNotification>(method: M['method'], params: M['params']) {
      if (!socket.destroyed && socket.writable) socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    }
  }
  const send = (msg: object): void => {
    if (!socket.destroyed && socket.writable) socket.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  }
  const handle = async (line: string): Promise<void> => {
    let req: { id?: unknown; method?: unknown; params?: unknown }
    try {
      req = JSON.parse(line) as typeof req
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const id = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null
    if (typeof req.method !== 'string') {
      send({ id, error: { code: -32600, message: 'Invalid request' } })
      return
    }
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, req.method) ? HANDLERS[req.method as VaultdMethod] : null
    if (!handler) {
      if (id !== null) send({ id, error: { code: -32601, message: 'Method not found' } })
      return
    }
    const params = (req.params ?? {}) as Params
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      if (id !== null) send({ id, error: { code: -32602, message: 'Invalid params' } })
      return
    }
    try {
      const result = await handler(ctx, params, conn)
      if (id !== null) send({ id, result })
    } catch (err) {
      const known = err instanceof VaultdError
      if (!known) log('error', 'method failed', { method: req.method })
      else log('info', 'method refused', { method: req.method, code: err.code })
      if (id !== null) {
        send({
          id,
          error: {
            code: RPC_APP_ERROR,
            message: known ? err.message : 'Internal error.',
            data: { code: known ? err.code : 'internal' }
          }
        })
      }
    }
  }

  // Lines are collected as Buffers so the limits count bytes, not characters.
  let pending: Buffer[] = []
  let pendingBytes = 0
  socket.on('data', (chunk: Buffer) => {
    let from = 0
    let nl: number
    while ((nl = chunk.indexOf(0x0a, from)) !== -1) {
      const line = pending.length ? Buffer.concat([...pending, chunk.subarray(from, nl)]) : chunk.subarray(from, nl)
      pending = []
      pendingBytes = 0
      from = nl + 1
      if (line.length > lineLimit(line)) {
        socket.destroy()
        return
      }
      const text = line.toString('utf8').trim()
      // Requests run concurrently; responses carry their id.
      if (text) void handle(text)
    }
    if (from < chunk.length) {
      pending.push(chunk.subarray(from))
      pendingBytes += chunk.length - from
      if (pendingBytes > LINE_MAX && pendingBytes > lineLimit(headOf(pending))) socket.destroy()
    }
  })
  socket.on('error', () => {})
  socket.on('end', () => socket.end())
  socket.resume()
}

function serialQueue(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {})
    tails.set(key, tail)
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
    return run
  }
}

async function listenUnix(server: Server, path: string, mode: number): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) rmSync(path, { force: true })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  chmodSync(path, mode)
}

export function createVaultd(config: VaultdConfig, options: VaultdOptions = {}): Vaultd {
  const ctx: Ctx = {
    config,
    layout: layoutOf(config.root),
    tokens: new TokenVerifier(config, options.now),
    helperEvents: new HelperEvents(),
    streams: new Streams(options.attachTimeoutMs),
    engines: new Map(),
    serial: serialQueue()
  }
  const sockets = new Set<Socket>()
  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  }

  let controls = 0
  let helpers = 0
  const main = createServer({ allowHalfOpen: true }, (socket) => {
    track(socket)
    readHello(socket, (msg) => {
      const hello = msg as { type?: unknown; stream?: unknown }
      if (hello?.type === 'control') {
        if (controls >= CONTROL_CONNECTIONS_MAX) {
          log('warn', 'connection refused', { type: 'control', reason: 'too many' })
          socket.destroy()
          return
        }
        controls++
        socket.once('close', () => { controls-- })
        serveControl(ctx, socket)
      } else if (hello?.type === 'attach' && ctx.streams.attach(hello.stream, socket)) {
        socket.resume()
      } else {
        log('warn', 'connection refused', { type: String(hello?.type) })
        socket.destroy()
      }
    })
  })
  const helperOps = options.helperOps ?? (config.fake ? fakeOps : cryptsetupOps(config.path))
  const helper = config.helperListen
    ? createServer((socket) => {
        track(socket)
        if (helpers >= HELPER_CONNECTIONS_MAX) {
          socket.destroy()
          return
        }
        helpers++
        socket.once('close', () => { helpers-- })
        serveHelper(socket, helperOps, ctx.helperEvents)
      })
    : null

  return {
    ctx,
    async listen() {
      await listenUnix(main, config.listen, 0o600)
      if (helper && config.helperListen) await listenUnix(helper, config.helperListen, 0o600)
      log('info', 'listening', { fake: config.fake, helper: helper !== null })
    },
    async close() {
      ctx.streams.closeAll()
      for (const child of ctx.engines.values()) killGroup(child, 500)
      for (const socket of sockets) socket.destroy()
      await Promise.all([main, helper].filter((s): s is Server => s !== null && s.listening).map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve()))
      ))
    }
  }
}
