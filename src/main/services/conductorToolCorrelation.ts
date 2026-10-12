import type { SessionNotification } from '@agentclientprotocol/sdk'
import { cinnaToolName, codeModeCinnaTools, isCodeModeCall } from '../agents/drivers/acp/conductorToolPolicy'

/**
 * How long a call that reached the MCP server before the engine's own ACP
 * `tool_call` waits for it. The two travel on separate channels; measured under
 * OpenCode, the notice trailed by ~30 ms. An engine that never sends one costs
 * at most this, once per call.
 */
export const CONDUCTOR_SIGHTING_WAIT_MS = 1_000

/** Claude carries its id in MCP metadata; other engines correlate by tool name and arrival order. */
export class ConductorToolCorrelation {
  private calls = new Map<string, { name: string; claimed: boolean }>()
  private early = new Map<string, string[]>()
  /** Claimed ids whose ACP `tool_call` has not arrived yet, with whoever waits for it. */
  private unseen = new Map<string, Set<() => void>>()
  /**
   * OpenCode 2 Code Mode calls (`isCodeModeCall`) still running this turn. An
   * MCP call made inside one has no ACP `tool_call` of its own to wait for.
   * Emptied at the turn's end ({@link endTurn}): a call that never finished,
   * or one the driver closed itself (a refused call it fails, which never
   * passes here), must not keep a later turn's calls from waiting.
   */
  private codeMode = new Set<string>()

  /**
   * `offers`: whether Cinna's server served a bare tool name this session —
   * what lets an engine that names MCP calls bare (Antigravity) be correlated
   * without claiming another server's tool of the same name.
   */
  /**
   * `options.ownsCodeMode`: a finished Code Mode call that ran Cinna's tools
   * alone is the conductor's, hidden behind its own blocks for those calls —
   * for a chat runtime only, whose transcript defers drawing such a call until
   * it ends (`AcpMessageStream.deferCodeModeCalls`). A folder agent's `execute`
   * is drawn while it runs, and a part already drawn cannot be taken back.
   */
  constructor(private readonly offers?: (name: string) => boolean, private readonly options: { ownsCodeMode?: boolean } = {}) {}

  observe(notification: SessionNotification): boolean {
    const update = notification.update
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return false
    if (this.calls.has(update.toolCallId)) {
      this.see(update.toolCallId)
      return true
    }
    if (this.codeMode.has(update.toolCallId) || (update.sessionUpdate === 'tool_call' && isCodeModeCall(update as { name?: unknown; title?: unknown; kind?: unknown }))) {
      if (update.status !== 'completed' && update.status !== 'failed') {
        this.codeMode.add(update.toolCallId)
        return false
      }
      this.codeMode.delete(update.toolCallId)
      // One that ran Cinna's tools alone is a chat runtime's conductor's, like
      // a direct call: its blocks stand for those calls, so the engine's is hidden.
      if (!this.options.ownsCodeMode || !codeModeCinnaTools(update.rawOutput)) return false
      this.calls.set(update.toolCallId, { name: 'execute', claimed: true })
      if (this.calls.size > 4096) this.calls.delete(this.calls.keys().next().value!)
      return true
    }
    const meta = update._meta as {claudeCode?: {toolName?: string}} | undefined
    const name = cinnaToolName(meta?.claudeCode?.toolName ?? update.title, update.rawInput,
      this.offers ? { offers: this.offers, kind: update.kind } : undefined, update._meta)
    if (!name) return false
    const earlyId = this.early.get(name)?.shift()
    this.calls.set(update.toolCallId, { name, claimed: !!earlyId })
    if (this.calls.size > 4096) this.calls.delete(this.calls.keys().next().value!)
    if (earlyId) this.see(earlyId)
    return true
  }

  owns(id: string): boolean { return this.calls.has(id) }

  /** The turn ended: no Code Mode call of it is still running (see {@link codeMode}). */
  endTurn(): void { this.codeMode.clear() }

  claim(name: string, fallbackId: string, explicit = false): string {
    if (explicit) {
      const call = this.calls.get(fallbackId)
      if (call) call.claimed = true
      else {
        this.calls.set(fallbackId, {name, claimed:true})
        this.unseen.set(fallbackId, new Set())
      }
      return fallbackId
    }
    for (const [id, call] of this.calls) if (call.name === name && !call.claimed) {
      call.claimed = true
      return id
    }
    // Inside a running Code Mode call the engine announces no call of its own:
    // waiting for one would hold every Cinna call a second.
    if (this.codeMode.size > 0) return fallbackId
    const pending = this.early.get(name) ?? []
    pending.push(fallbackId)
    this.early.set(name, pending)
    this.unseen.set(fallbackId, new Set())
    return fallbackId
  }

  /**
   * Resolves once the engine's ACP `tool_call` for a claimed id has been
   * observed, or after `maxMs`, or on abort. Everything the engine streamed
   * before that notice has been delivered by then, so a block published after
   * this lands after the text that preceded the call, not inside it.
   */
  sighted(id: string, maxMs = CONDUCTOR_SIGHTING_WAIT_MS, signal?: AbortSignal): Promise<void> {
    const waiters = this.unseen.get(id)
    if (!waiters) return Promise.resolve()
    if (signal?.aborted) {
      this.forget(id)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', giveUp)
        waiters.delete(done)
        resolve()
      }
      // Given up on (or no longer wanted): forget it, so its notice arriving
      // late does not release — and delay — the next call of the same name.
      const giveUp = (): void => {
        this.forget(id)
        done()
      }
      const timer = setTimeout(giveUp, maxMs)
      waiters.add(done)
      signal?.addEventListener('abort', giveUp, { once: true })
    })
  }

  private forget(id: string): void {
    this.unseen.delete(id)
    for (const [name, ids] of this.early) {
      const at = ids.indexOf(id)
      if (at < 0) continue
      ids.splice(at, 1)
      if (!ids.length) this.early.delete(name)
    }
  }

  private see(id: string): void {
    const waiters = this.unseen.get(id)
    if (!waiters) return
    this.unseen.delete(id)
    for (const done of [...waiters]) done()
  }
}
