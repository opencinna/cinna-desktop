/**
 * Byte streams created by a control call and attached by a second
 * connection (`{"type":"attach","stream":"<id>"}`). Ids are random, each
 * stream attaches once, and an unattached stream expires after 30 s.
 */
import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import { log } from './util'

export const STREAM_ATTACH_TIMEOUT_MS = 30_000

interface Pending {
  onAttach: (socket: Socket) => void
  onExpire: () => void
  timer: NodeJS.Timeout
}

export class Streams {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly attachTimeoutMs = STREAM_ATTACH_TIMEOUT_MS) {}

  create(onAttach: (socket: Socket) => void, onExpire: () => void = () => {}): string {
    const id = randomBytes(16).toString('hex')
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return
      log('info', 'stream expired unattached', { stream: id })
      onExpire()
    }, this.attachTimeoutMs)
    timer.unref()
    this.pending.set(id, { onAttach, onExpire, timer })
    return id
  }

  /** Hands the socket to the stream's owner; false (and nothing else happens) for an unknown, spent or expired id. */
  attach(id: unknown, socket: Socket): boolean {
    if (typeof id !== 'string') return false
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.onAttach(socket)
    return true
  }

  closeAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.onExpire()
    }
  }
}
