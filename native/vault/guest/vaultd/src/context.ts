/** What every handler receives. Kept free of the server so handlers stay testable on their own. */
import type { ChildProcess } from 'node:child_process'
import type { VaultdNotification } from '../../../../../src/shared/vault/protocol'
import type { Layout, VaultdConfig } from './config'
import type { HelperEvents } from './helperControl'
import type { Streams } from './streams'
import type { TokenVerifier } from './tokens'

export interface Conn {
  /** Sends a notification on the control connection that made the call; dropped once it is closed. */
  notify<M extends VaultdNotification>(method: M['method'], params: M['params']): void
}

export interface Ctx {
  config: VaultdConfig
  layout: Layout
  tokens: TokenVerifier
  streams: Streams
  /** Pushes to the helper's subscribed control connections (exec-end, D37). */
  helperEvents: HelperEvents
  /** Running engines by stream id, for `engine.kill`. */
  engines: Map<string, ChildProcess>
  /** Serializes writers of one file (kv, transcripts, the runtime index). */
  serial<T>(key: string, fn: () => Promise<T>): Promise<T>
}

export type Params = Record<string, unknown>
export type Handler = (ctx: Ctx, params: Params, conn: Conn) => Promise<unknown>
