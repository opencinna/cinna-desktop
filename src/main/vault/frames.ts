/**
 * Main ⇄ VaultHelper stdio frames (spec §1, D25) and the session on top of
 * them. Pure hub core: the session takes a duplex of bytes and never spawns
 * anything; `host/desktop/vault/appleVzBackend.ts` hands it the helper's pipes.
 *
 * Frame: `u32 BE length` (of type + channel + payload) · `u8 type` ·
 * `u32 BE channel` · payload. Channel 0 carries JSON control; every other
 * channel is a byte stream to cinna-vaultd that the helper opened.
 */
import {
  HELPER_FRAME_HEADER_BYTES,
  HELPER_FRAME_MAX_PAYLOAD,
  HelperFrameType,
  type HelperEvent,
  type HelperMethod,
  type HelperRequestMap
} from '../../shared/vault/protocol'
import { VaultBackendError, type VaultChannel } from './backend'

export interface Frame {
  type: HelperFrameType
  channel: number
  payload: Uint8Array
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/** Bytes after the length prefix that every frame has: type + channel. */
const FIXED_AFTER_LENGTH = HELPER_FRAME_HEADER_BYTES - 4
const FRAME_TYPES = new Set<number>(Object.values(HelperFrameType))

export function encodeFrame(type: HelperFrameType, channel: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!FRAME_TYPES.has(type)) throw new FrameError(`Unknown frame type ${type}.`)
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffffffff) throw new FrameError('Bad channel id.')
  if (payload.byteLength > HELPER_FRAME_MAX_PAYLOAD) throw new FrameError('Frame payload too large.')
  if (type === HelperFrameType.ctl && channel !== 0) throw new FrameError('Control frames travel on channel 0 only.')
  const out = new Uint8Array(HELPER_FRAME_HEADER_BYTES + payload.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, FIXED_AFTER_LENGTH + payload.byteLength)
  view.setUint8(4, type)
  view.setUint32(5, channel)
  out.set(payload, HELPER_FRAME_HEADER_BYTES)
  return out
}

/**
 * Incremental decoder: feed it chunks as they arrive (split or coalesced), get
 * whole frames back. A bad length or type is unrecoverable, since the stream
 * has lost its framing; the decoder throws and stays broken.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0)
  private broken: FrameError | null = null

  push(chunk: Uint8Array): Frame[] {
    if (this.broken) throw this.broken
    this.buffer = this.buffer.byteLength === 0 ? chunk.slice() : concat(this.buffer, chunk)
    const frames: Frame[] = []
    let offset = 0
    while (this.buffer.byteLength - offset >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset)
      const length = view.getUint32(0)
      if (length < FIXED_AFTER_LENGTH || length > FIXED_AFTER_LENGTH + HELPER_FRAME_MAX_PAYLOAD) {
        this.broken = new FrameError(`Bad frame length ${length}.`)
        throw this.broken
      }
      if (this.buffer.byteLength - offset < 4 + length) break
      const type = view.getUint8(4)
      if (!FRAME_TYPES.has(type)) {
        this.broken = new FrameError(`Unknown frame type ${type}.`)
        throw this.broken
      }
      const channel = view.getUint32(5)
      const start = offset + HELPER_FRAME_HEADER_BYTES
      frames.push({ type: type as HelperFrameType, channel, payload: this.buffer.slice(start, offset + 4 + length) })
      offset += 4 + length
    }
    this.buffer = offset === 0 ? this.buffer : this.buffer.slice(offset)
    return frames
  }

  /** Bytes held for an incomplete frame. */
  get pending(): number {
    return this.buffer.byteLength
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

// ---------------------------------------------------------------------------
// Session

/** The helper's stdio, as the session needs it. */
export interface HelperDuplex {
  /** Resolves once the bytes are handed off (after a drain when the pipe is full). */
  write(bytes: Uint8Array): Promise<void> | void
  onData(listener: (bytes: Uint8Array) => void): void
  onClose(listener: (error?: Error) => void): void
  /** Stop reading the helper's output (a channel's consumer is behind). */
  pause?(): void
  resume?(): void
}

export interface HelperSessionOptions {
  /** Default per-request timeout. `vault.unlock` and `vault.approve` wait on a person, so they pass their own. */
  requestTimeoutMs?: number
  /** Bytes queued for one channel's reader before the helper's output is paused. */
  channelHighWaterMark?: number
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  /** Runs synchronously when the result arrives, before any other frame is handled. */
  onResult?: (result: unknown) => void
}

interface ChannelState {
  controller: ReadableStreamDefaultController<Uint8Array> | null
  /** Frames that arrived before the readable was started. */
  early: Uint8Array[]
  readClosed: boolean
  writeClosed: boolean
  dead: Error | null
  congested: boolean
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_HIGH_WATER = 1024 * 1024

export class HelperSession {
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<number, Pending>()
  private readonly channels = new Map<number, ChannelState>()
  private readonly eventListeners = new Set<(event: HelperEvent) => void>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private readonly congested = new Set<number>()
  private nextId = 1
  private closedWith: Error | null = null
  private readonly timeoutMs: number
  private readonly highWater: number

  constructor(private readonly duplex: HelperDuplex, options: HelperSessionOptions = {}) {
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.highWater = options.channelHighWaterMark ?? DEFAULT_HIGH_WATER
    duplex.onData((bytes) => this.receive(bytes))
    duplex.onClose((error) => this.fail(error ?? new VaultBackendError('unavailable', 'The vault helper exited.')))
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  onEvent(listener: (event: HelperEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  request<M extends HelperMethod>(
    method: M,
    params: HelperRequestMap[M]['params'],
    options: { timeoutMs?: number; onResult?: (result: HelperRequestMap[M]['result']) => void } = {}
  ): Promise<HelperRequestMap[M]['result']> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.timeoutMs
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new VaultBackendError('timeout', `The vault helper did not answer ${method} in time.`))
          }, timeoutMs)
        : null
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        onResult: options.onResult as ((result: unknown) => void) | undefined
      })
      const body = new TextEncoder().encode(JSON.stringify({ id, method, params }))
      void this.trySend(encodeFrame(HelperFrameType.ctl, 0, body)).catch((error: unknown) => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        if (entry.timer) clearTimeout(entry.timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /**
   * `channel.open` for `vaultId`, with the channel registered in the same tick
   * the answer arrives, so data the helper sends right behind it is kept.
   */
  async openChannel(vaultId: string, timeoutMs?: number): Promise<VaultChannel> {
    let channel = -1
    await this.request('channel.open', { vaultId }, {
      timeoutMs,
      onResult: (result) => {
        channel = result.channel
        this.register(channel)
      }
    })
    return this.attach(channel)
  }

  /** Close the session: every pending request and channel fails with `reason`. */
  close(reason = 'The vault session closed.'): void {
    this.fail(new VaultBackendError('unavailable', reason))
  }

  // -- channels ------------------------------------------------------------

  private register(channel: number): ChannelState {
    let state = this.channels.get(channel)
    if (!state) {
      state = { controller: null, early: [], readClosed: false, writeClosed: false, dead: null, congested: false }
      this.channels.set(channel, state)
    }
    return state
  }

  private attach(channel: number): VaultChannel {
    const state = this.register(channel)
    const session = this
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        state.controller = controller
        for (const chunk of state.early) controller.enqueue(chunk)
        state.early = []
        if (state.dead) controller.error(state.dead)
        else if (state.readClosed) controller.close()
        else session.watchCongestion(channel, state)
      },
      pull() {
        session.watchCongestion(channel, state)
      },
      cancel(reason) {
        session.reset(channel, state, typeof reason === 'string' ? reason : 'reader cancelled')
      }
    }, { highWaterMark: this.highWater, size: (chunk) => chunk.byteLength })

    const writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        if (state.dead) throw state.dead
        if (state.writeClosed) throw new VaultBackendError('closed', 'The channel was closed for writing.')
        for (let offset = 0; offset < chunk.byteLength; offset += HELPER_FRAME_MAX_PAYLOAD) {
          await session.send(encodeFrame(HelperFrameType.data, channel, chunk.subarray(offset, offset + HELPER_FRAME_MAX_PAYLOAD)))
          if (state.dead) throw state.dead
        }
      },
      async close() {
        if (state.dead || state.writeClosed) return
        state.writeClosed = true
        await session.send(encodeFrame(HelperFrameType.eof, channel))
        session.forgetIfDone(channel, state)
      },
      abort(reason) {
        session.reset(channel, state, reason instanceof Error ? reason.message : String(reason ?? 'aborted'))
      }
    })

    return {
      readable,
      writable,
      close: (reason?: string) => this.reset(channel, state, reason ?? 'closed')
    }
  }

  /** Pause the helper's output while any channel's reader is behind; resume when none is. */
  private watchCongestion(channel: number, state: ChannelState): void {
    const desired = state.controller?.desiredSize ?? 1
    const congested = !state.dead && !state.readClosed && desired !== null && desired <= 0
    if (congested === state.congested) return
    state.congested = congested
    if (congested) {
      const was = this.congested.size
      this.congested.add(channel)
      if (was === 0) this.duplex.pause?.()
    } else {
      this.uncongest(channel)
    }
  }

  private uncongest(channel: number): void {
    if (!this.congested.delete(channel)) return
    if (this.congested.size === 0) this.duplex.resume?.()
  }

  /** Our side kills the channel both ways and tells the helper. */
  private reset(channel: number, state: ChannelState, reason: string): void {
    if (state.dead) return
    state.dead = new VaultBackendError('reset', reason)
    try {
      state.controller?.error(state.dead)
    } catch {
      // already closed
    }
    this.channels.delete(channel)
    this.uncongest(channel)
    if (!this.closedWith) void this.trySend(encodeFrame(HelperFrameType.rst, channel, new TextEncoder().encode(reason.slice(0, 512)))).catch(() => {})
  }

  private forgetIfDone(channel: number, state: ChannelState): void {
    if (state.readClosed && state.writeClosed) {
      this.channels.delete(channel)
      this.uncongest(channel)
    }
  }

  // -- input ---------------------------------------------------------------

  private receive(bytes: Uint8Array): void {
    if (this.closedWith) return
    let frames: Frame[]
    try {
      frames = this.decoder.push(bytes)
    } catch (error) {
      this.fail(new VaultBackendError('protocol', error instanceof Error ? error.message : String(error)))
      return
    }
    for (const frame of frames) this.dispatch(frame)
  }

  private dispatch(frame: Frame): void {
    if (frame.type === HelperFrameType.ctl) {
      if (frame.channel !== 0) return
      let message: Record<string, unknown>
      try {
        message = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>
      } catch {
        return
      }
      this.control(message)
      return
    }
    const state = this.channels.get(frame.channel)
    if (!state) {
      // Data for a channel we never opened or already reset: tell the helper once.
      if (frame.type === HelperFrameType.data) {
        void this.trySend(encodeFrame(HelperFrameType.rst, frame.channel, new TextEncoder().encode('unknown channel'))).catch(() => {})
      }
      return
    }
    switch (frame.type) {
      case HelperFrameType.data:
        if (state.readClosed || state.dead) return
        if (state.controller) {
          state.controller.enqueue(frame.payload)
          this.watchCongestion(frame.channel, state)
        } else {
          state.early.push(frame.payload)
        }
        return
      case HelperFrameType.eof:
        if (state.readClosed) return
        state.readClosed = true
        try {
          state.controller?.close()
        } catch {
          // reader cancelled
        }
        this.uncongest(frame.channel)
        this.forgetIfDone(frame.channel, state)
        return
      case HelperFrameType.rst: {
        if (state.dead) return
        state.dead = new VaultBackendError('reset', new TextDecoder().decode(frame.payload) || 'The channel was reset.')
        try {
          state.controller?.error(state.dead)
        } catch {
          // already closed
        }
        this.channels.delete(frame.channel)
        this.uncongest(frame.channel)
        return
      }
    }
  }

  private control(message: Record<string, unknown>): void {
    if (typeof message.event === 'string') {
      for (const listener of this.eventListeners) {
        try {
          listener(message as unknown as HelperEvent)
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
    const error = message.error as { code?: unknown; message?: unknown } | undefined
    if (error && typeof error === 'object') {
      entry.reject(new VaultBackendError(typeof error.code === 'string' ? error.code : 'internal',
        typeof error.message === 'string' ? error.message : 'The vault helper refused.'))
      return
    }
    try {
      entry.onResult?.(message.result)
    } catch (err) {
      entry.reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    entry.resolve(message.result)
  }

  private send(bytes: Uint8Array): Promise<void> | void {
    if (this.closedWith) throw this.closedWith
    return this.duplex.write(bytes)
  }

  /** {@link send} with a synchronous throw turned into a rejection. */
  private trySend(bytes: Uint8Array): Promise<void> {
    try {
      return Promise.resolve(this.send(bytes))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private fail(error: Error): void {
    if (this.closedWith) return
    this.closedWith = error
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    for (const [, state] of this.channels) {
      if (state.dead) continue
      state.dead = error
      try {
        state.controller?.error(error)
      } catch {
        // already closed
      }
    }
    this.channels.clear()
    if (this.congested.size > 0) {
      this.congested.clear()
      this.duplex.resume?.()
    }
    for (const listener of this.closeListeners) listener(error)
  }
}
