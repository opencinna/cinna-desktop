import type { RequestResolution } from '../../../shared/localAgentRequests'
import type { ParkedAsk } from './driver'

/** Remote acceptance is distinct from releasing the local parked continuation. */
export type AsyncRespondOutcome =
  | { status: 'accepted' }
  | { status: 'not_sent'; reason: string }
  | { status: 'uncertain'; reason: string }

export interface AsyncRespondContext {
  signal: AbortSignal
}

/** Captured by the registering run. Never reconstructed from a renderer payload. */
export interface AsyncReplyBinding {
  validate(): void
  respondAsync(ask: ParkedAsk, resolution: RequestResolution, context: AsyncRespondContext): Promise<AsyncRespondOutcome>
  normalize?(resolution: RequestResolution): { resolution: RequestResolution; remembered?: boolean }
}

/** Main-only registration handle; owner()/listForChat() never expose it. */
export interface ReplyRegistration {
  token: object
  /** Captured synchronous runtime admission; checked before legacy orphan fallback too. */
  validate?(): void
  signal: AbortSignal
  origin: 'acp' | 'async'
  binding?: AsyncReplyBinding
  isCurrent(): boolean
  release(resolution: RequestResolution): boolean
}
