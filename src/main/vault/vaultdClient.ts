/**
 * JSON-RPC 2.0 client for cinna-vaultd (spec §4) over a {@link VaultChannel}.
 *
 * Every connection starts with one JSON line: `{"type":"control"}` for this
 * client, `{"type":"attach","stream":"<id>"}` for a raw stream a request
 * returned. Control traffic is ndjson. Errors carry vaultd's code in
 * `error.data.code` (`bad_token`, `not_found`, …).
 */
import type { VaultdHello, VaultdMethod, VaultdNotification, VaultdRequestMap } from '../../shared/vault/protocol'
import type { VaultChannel } from './backend'

/** JSON-RPC's "Method not found": a guest older than the method asked. */
export const RPC_METHOD_NOT_FOUND = -32601

export class VaultdError extends Error {
  /** `rpcCode`: the JSON-RPC error code vaultd answered (-32000 for its own refusals), when there was one. */
  constructor(readonly code: string, message: string, readonly rpcCode?: number) {
    super(message)
    this.name = 'VaultdError'
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null }

const DEFAULT_TIMEOUT_MS = 30_000
/** One ndjson line may not exceed this (a transcript read is the largest answer). */
const MAX_LINE_BYTES = 64 * 1024 * 1024

export interface VaultdClientOptions {
  /** Opens another connection to the same vault, for {@link VaultdClient.attach}. */
  openChannel: () => Promise<VaultChannel>
  requestTimeoutMs?: number
}

async function writeLine(writer: WritableStreamDefaultWriter<Uint8Array>, value: unknown): Promise<void> {
  await writer.write(new TextEncoder().encode(JSON.stringify(value) + '\n'))
}

export class VaultdClient {
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(notification: VaultdNotification) => void>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private nextId = 1
  private closedWith: Error | null = null
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>
  private readonly timeoutMs: number

  private constructor(private readonly channel: VaultChannel, private readonly options: VaultdClientOptions) {
    this.writer = channel.writable.getWriter()
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Sends the control hello on `channel` and starts reading. */
  static async connect(channel: VaultChannel, options: VaultdClientOptions): Promise<VaultdClient> {
    const client = new VaultdClient(channel, options)
    await writeLine(client.writer, { type: 'control' } satisfies VaultdHello)
    void client.readLoop()
    return client
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  onNotification(listener: (notification: VaultdNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  request<M extends VaultdMethod>(method: M, params: VaultdRequestMap[M]['params'], timeoutMs?: number): Promise<VaultdRequestMap[M]['result']> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const wait = timeoutMs ?? this.timeoutMs
      const timer = wait > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new VaultdError('timeout', `cinna-vaultd did not answer ${method} in time.`))
          }, wait)
        : null
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      writeLine(this.writer, { jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        if (entry.timer) clearTimeout(entry.timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /**
   * A new connection attached to `stream` (a stream id a request returned).
   * The returned channel carries the stream's raw bytes; closing its writable
   * is EOF for the guest side.
   */
  async attach(stream: string): Promise<VaultChannel> {
    const channel = await this.options.openChannel()
    const writer = channel.writable.getWriter()
    try {
      await writeLine(writer, { type: 'attach', stream } satisfies VaultdHello)
    } catch (error) {
      channel.close('attach failed')
      throw error
    } finally {
      writer.releaseLock()
    }
    return channel
  }

  close(reason = 'closed'): void {
    this.fail(new VaultdError('closed', reason))
    this.channel.close(reason)
  }

  private async readLoop(): Promise<void> {
    const reader = this.channel.readable.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        if (buffered.length > MAX_LINE_BYTES) throw new VaultdError('protocol', 'cinna-vaultd sent an oversized line.')
        let newline = buffered.indexOf('\n')
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim()
          buffered = buffered.slice(newline + 1)
          if (line) this.handle(line)
          newline = buffered.indexOf('\n')
        }
      }
      this.fail(new VaultdError('closed', 'cinna-vaultd closed the connection.'))
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handle(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: { code?: unknown } }; method?: unknown; params?: unknown }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message.method === 'string' && message.id === undefined) {
      for (const listener of this.listeners) {
        try {
          listener({ method: message.method, params: message.params } as VaultdNotification)
        } catch {
          // a listener's failure is its own
        }
      }
      return
    }
    if (typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    if (entry.timer) clearTimeout(entry.timer)
    if (message.error) {
      const code = typeof message.error.data?.code === 'string' ? message.error.data.code : 'internal'
      const rpcCode = typeof message.error.code === 'number' && Number.isInteger(message.error.code) ? message.error.code : undefined
      entry.reject(new VaultdError(code, typeof message.error.message === 'string' ? message.error.message : 'cinna-vaultd refused.', rpcCode))
      return
    }
    entry.resolve(message.result)
  }

  private fail(error: Error): void {
    if (this.closedWith) return
    this.closedWith = error
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    for (const listener of this.closeListeners) listener(error)
  }
}
