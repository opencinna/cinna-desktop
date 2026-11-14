/** Test harness: an in-process fake-mode vaultd in a temp dir, a client, token minting and a tiny tar writer. */
import { createHmac, randomBytes, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalClaims, GatedAction } from '../../../../../src/shared/vault/protocol'
import { parseArgs } from '../src/config'
import { createVaultd, type Vaultd, type VaultdOptions } from '../src/server'
import { setQuiet } from '../src/util'

export const KEY_HEX = 'ab'.repeat(32)
export const VAULT_ID = 'vault-test-1'

export interface Harness {
  dir: string
  root: string
  sock: string
  helperSock: string
  vaultd: Vaultd
  stop(): Promise<void>
}

export async function startVaultd(extraArgs: string[] = [], options: VaultdOptions = {}, vaultId: string | null = VAULT_ID): Promise<Harness> {
  setQuiet(true)
  // Short base: unix socket paths are limited to ~104 bytes on macOS.
  const dir = mkdtempSync(join(tmpdir(), 'vd-'))
  const root = join(dir, 'root')
  const sock = join(dir, 'v.sock')
  const helperSock = join(dir, 'h.sock')
  const config = parseArgs([
    '--fake', '--root', root, '--listen', sock, '--helper-listen', helperSock,
    '--approval-key', KEY_HEX, ...(vaultId ? ['--vault-id', vaultId] : []), ...extraArgs
  ])
  const vaultd = createVaultd(config, options)
  await vaultd.listen()
  return {
    dir, root, sock, helperSock, vaultd,
    async stop() {
      await vaultd.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export function mint(
  action: GatedAction,
  opts: { detail?: string; vaultId?: string; exp?: number; key?: string; nonce?: string; proxyCred?: string } = {}
): string {
  const claims: ApprovalClaims = {
    v: 1,
    vaultId: opts.vaultId ?? VAULT_ID,
    action,
    detailSha256: createHash('sha256').update(opts.detail ?? 'free text').digest('hex'),
    nonce: opts.nonce ?? randomBytes(12).toString('hex'),
    exp: opts.exp ?? Date.now() + 60_000,
    ...(opts.proxyCred ? { proxyCred: opts.proxyCred } : {})
  }
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const mac = createHmac('sha256', Buffer.from(opts.key ?? KEY_HEX, 'hex')).update(body).digest('base64url')
  return `${body}.${mac}`
}

export interface RpcError { code: number; message: string; data?: { code: string } }
export interface Notification { method: string; params: Record<string, unknown> }

export class Client {
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: RpcError) => void }>()
  readonly notifications: Notification[] = []
  private waiters: { match: (n: Notification) => boolean; resolve: (n: Notification) => void }[] = []

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const msg = JSON.parse(this.buffer.slice(0, nl)) as { id?: number; result?: unknown; error?: RpcError; method?: string; params?: Record<string, unknown> }
        this.buffer = this.buffer.slice(nl + 1)
        if (msg.method) {
          const n = { method: msg.method, params: msg.params ?? {} }
          this.notifications.push(n)
          this.waiters = this.waiters.filter((w) => (w.match(n) ? (w.resolve(n), false) : true))
        } else if (typeof msg.id === 'number') {
          const p = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) p?.reject(msg.error)
          else p?.resolve(msg.result)
        }
      }
    })
  }

  static async open(sock: string): Promise<Client> {
    const socket = connect(sock)
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    socket.write('{"type":"control"}\n')
    return new Client(socket)
  }

  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }))
  }

  /** The error's `data.code` (or the JSON-RPC code), or 'ok' when the call succeeded. */
  async code(method: string, params: Record<string, unknown> = {}): Promise<string> {
    try {
      await this.call(method, params)
      return 'ok'
    } catch (err) {
      const e = err as RpcError
      return e.data?.code ?? String(e.code)
    }
  }

  waitFor(match: (n: Notification) => boolean, timeoutMs = 10_000): Promise<Notification> {
    const found = this.notifications.find(match)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('notification timeout')), timeoutMs)
      this.waiters.push({ match, resolve: (n) => { clearTimeout(timer); resolve(n) } })
    })
  }

  close(): void {
    this.socket.destroy()
  }
}

/** Attach to a stream. Resolves with the socket once connected. */
export async function attach(sock: string, stream: string): Promise<Socket> {
  const socket = connect(sock)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.write(JSON.stringify({ type: 'attach', stream }) + '\n')
  return socket
}

/** Collect everything a socket sends until it closes. */
export function collect(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    socket.on('data', (d: Buffer) => parts.push(d))
    socket.on('error', () => {})
    socket.on('close', () => resolve(Buffer.concat(parts)))
  })
}

// ---------------------------------------------------------------------------
// A minimal ustar writer, so tests can craft archives no real tar would make.

export interface TarEntry {
  name: string
  type?: '0' | '2' | '5' | '1' | '3'
  data?: string | Buffer
  link?: string
  mode?: number
}

function header(name: string, size: number, type: string, link: string, mode: number): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'ascii')
  h.write('0000000\0', 108, 'ascii')
  h.write('0000000\0', 116, 'ascii')
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  h.write('00000000000\0', 136, 'ascii')
  h.write('        ', 148, 'ascii')
  h.write(type, 156, 'ascii')
  h.write(link, 157, 100, 'utf8')
  h.write('ustar\0', 257, 'ascii')
  h.write('00', 263, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return h
}

export function makeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const type = e.type ?? '0'
    const data = type === '0' ? Buffer.from(e.data ?? '') : Buffer.alloc(0)
    parts.push(header(e.name, data.length, type, e.link ?? '', e.mode ?? (type === '5' ? 0o755 : 0o644)))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

export function sendAll(socket: Socket, data: Buffer): void {
  socket.end(data)
}
