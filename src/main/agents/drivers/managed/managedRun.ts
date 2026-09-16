import type Anthropic from '@anthropic-ai/sdk'
import { APIConnectionError, APIError, AuthenticationError, PermissionDeniedError } from '@anthropic-ai/sdk'
import type { BetaManagedAgentsUserToolConfirmationEvent } from '@anthropic-ai/sdk/resources/beta/sessions/events'
import { nanoid } from 'nanoid'
import type { ManagedAgentConfig } from '../../../../shared/managedAgents'
import { PERMISSION_TOOL_NAME, type RequestResolution } from '../../../../shared/localAgentRequests'
import type { MessagePart } from '../../../../shared/messageParts'
import type { RunInput, RunResult } from '../driver'
import type { pendingRequests } from '../pendingRequests'
import { createLogger } from '../../../logger/logger'
import { ManagedEvents, type ManagedEffect, type ManagedEvent, type ManagedPermissionTool } from './managedEvents'

const logger = createLogger('managed-run')

export type ManagedSessionState = 'ready' | 'inflight' | 'uncertain' | 'budget'
export interface ManagedSessionCheckpoint {
  sessionId: string
  state: ManagedSessionState
  /** The running turn's acknowledged `user.message` id; stored only with `inflight`. */
  kickoffEventId?: string | null
  /** The chat's user row that turn answers (`RunInput.messageId`); stored only with a kickoff. */
  kickoffMessageId?: string | null
}
export interface ManagedRunBinding {
  client: Anthropic
  config: ManagedAgentConfig
  /** Rechecks profile, row, credential and config identity; never changes destination. */
  validate(): void
  checkpoint: ManagedSessionCheckpoint | null
  save(checkpoint: ManagedSessionCheckpoint): void
}
export interface ManagedRunDeps {
  registerRequest: typeof pendingRequests.register
  requestTimeoutMs?: number
  stopTimeoutMs?: number
}
export type ManagedRunResult = RunResult & {
  stopReason?: 'end_turn' | 'budget' | 'canceled'
  /**
   * Set only by a follow that could not reach the session (`network`) or was
   * refused its credential (`auth`). The follow then left the session and its
   * checkpoint alone: the turn may still be running there.
   */
  unreachable?: ManagedUnreachable
}
export type ManagedUnreachable = 'network' | 'auth'
/** A follow's input: a turn's, minus the message it does not send. */
export type ManagedFollowInput = Omit<RunInput, 'wireContent'>
/** The turn a follow reads: its session, and the acknowledged id of its `user.message`. */
export interface ManagedFollowTarget { sessionId: string; kickoffEventId: string }
export interface ManagedFollowHooks {
  /**
   * Called once, when the whole history has been read and the turn has not
   * ended: the follow is about to wait on the live stream. A turn parked on a
   * permission reaches this only after the answer is delivered.
   */
  onStillRunning?(): void
}

/**
 * One SDK session turn: start it (create or retrieve the session, check it is
 * ready, save `inflight`, send the message, save its acknowledged id), then
 * follow it. The caller owns the captured credential and session binding.
 */
export function runManagedSession(
  binding: ManagedRunBinding,
  agentId: string,
  input: RunInput,
  deps: ManagedRunDeps
): Promise<ManagedRunResult> {
  return managedSession(binding, agentId, input, deps, { kind: 'turn', wireContent: input.wireContent })
}

/**
 * Follow a turn already on the session, from its acknowledged kickoff, until
 * it ends — relaunch recovery of a turn the app was closed under. Sends no
 * message and creates nothing: it attaches, reads the whole history (so a
 * turn that ended meanwhile returns at once), then streams. Everything else is
 * a live turn's: deltas and permission asks through `input.onEvent`, answers
 * through the registered park, Stop through `input.signal` (a remote
 * interrupt), and the same checkpoint on the way out.
 */
export function followManagedSession(
  binding: ManagedRunBinding,
  agentId: string,
  input: ManagedFollowInput,
  deps: ManagedRunDeps,
  target: ManagedFollowTarget,
  hooks: ManagedFollowHooks = {}
): Promise<ManagedRunResult> {
  return managedSession(binding, agentId, input, deps, { kind: 'follow', ...target, hooks })
}

type SessionMode = { kind: 'turn'; wireContent: string } | ({ kind: 'follow'; hooks: ManagedFollowHooks } & ManagedFollowTarget)

/** Thrown when a followed turn's kickoff is not in the session's history. */
class UnknownKickoff extends Error {}
/** The session's stream kept failing or closing: a transport failure, not an answer. */
class StreamLost extends Error {}

/**
 * Whether `error` says the session could not be reached (`network`: no
 * connection, a timeout, a lost stream, a 5xx, 408 or 429) or refused the
 * credential (`auth`: 401, 403), rather than answering about the turn. Null for
 * anything else — a 404, a failed turn, a changed binding.
 */
export function unreachableReason(error: unknown): ManagedUnreachable | null {
  if (error instanceof StreamLost || error instanceof APIConnectionError) return 'network'
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) return 'auth'
  if (error instanceof APIError) {
    const status = error.status
    if (status === undefined || status >= 500 || status === 408 || status === 429) return 'network'
  }
  return null
}

async function managedSession(
  binding: ManagedRunBinding,
  agentId: string,
  input: ManagedFollowInput,
  deps: ManagedRunDeps,
  mode: SessionMode
): Promise<ManagedRunResult> {
  const { client, config } = binding
  const params = config.workspaceId ? { workspace_id: config.workspaceId } : {}
  const requestMs = deps.requestTimeoutMs ?? 30_000
  const following = mode.kind === 'follow'
  // A followed turn may have sent a confirmation just before the kill; a
  // queued one is an answer already given, not an ask to offer again.
  const reducer = new ManagedEvents(undefined, { queuedConfirmationsAnswer: following })
  const io = new AbortController()
  const streamLife = new AbortController()
  const parts: MessagePart[] = []
  const parks = new Map<string, { cancel(): void; answered: Promise<RequestResolution> }>()
  const permissionBarriers = new Map<string, Promise<void>>()
  let sessionId = following ? mode.sessionId : binding.checkpoint?.sessionId ?? null
  const streamState: { iterator: AsyncIterator<ManagedEvent> | null; controller?: AbortController } = { iterator: null }
  let text = ''
  // A followed turn is remote work from the first line: Stop interrupts it.
  let workMayExist = following
  let closed = false
  let stopPromise: Promise<void> | null = null
  let stopHistory: ManagedEvent[] = []
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  let budget = false
  const options = () => ({ signal: io.signal, timeout: requestMs, maxRetries: 0 })
  const save = (state: ManagedSessionState, kickoff?: { eventId: string; messageId: string | null }): void => {
    binding.validate()
    if (!sessionId) return
    binding.save(kickoff
      ? { sessionId, state, kickoffEventId: kickoff.eventId, kickoffMessageId: kickoff.messageId }
      : { sessionId, state })
  }
  if (following) reducer.start(mode.kickoffEventId)
  // What the turn has streamed so far, for the quit flush. `parts` only grows,
  // which the flush's cursor relies on. The session itself is already saved
  // `inflight` before the message goes out.
  input.registerSnapshot?.(() => ({ parts: parts.slice(), notices: [] }))
  const emitPart = (part: MessagePart): void => {
    if (closed || stopping) return
    parts.push(part)
    input.onEvent?.({ type: 'delta', ...part })
  }
  const interrupt = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopping = true
    for (const park of parks.values()) park.cancel()
    stopTimer = setTimeout(() => streamLife.abort(), deps.stopTimeoutMs ?? 30_000)
    stopTimer.unref?.()
    stopPromise = (async () => {
      reducer.stop(null)
      if (!sessionId || !workMayExist) return
      try {
        binding.validate()
        const response = await client.beta.sessions.events.send(sessionId, {
          ...params, events: [{ type: 'user.interrupt' }]
        }, { signal: streamLife.signal, timeout: requestMs, maxRetries: 0 })
        const event = response.data?.find((item) => item.type === 'user.interrupt')
        reducer.stop(event?.id || null)
        if (event?.id) {
          await attach()
          stopHistory = await readHistory(streamLife.signal)
          reducer.reconcile(stopHistory)
        }
      } catch { /* The bounded drain reports an unconfirmed remote stop. */ }
    })()
    return stopPromise
  }
  const abort = (): void => { io.abort(); void interrupt() }
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()

  const result = (reason: 'end_turn' | 'budget' | 'canceled', stopConfirmed = true): ManagedRunResult => {
    if (reason === 'budget' || reducer.budgetPaused) budget = true
    if (workMayExist) save(budget ? 'budget' : stopConfirmed ? 'ready' : 'uncertain')
    if (!stopConfirmed) {
      // A canceled result's error is intentionally suppressed by the common
      // turn wrapper. A saved notice keeps this material limitation visible.
      return { text, parts, notices: [{ partKey: `managed-stop-${nanoid()}`, text: 'Stopped waiting locally. The Managed session’s remote stop was not confirmed; review it in Claude before continuing.' }], contextId: sessionId ?? undefined, taskState: 'canceled', stopReason: 'canceled' }
    }
    return { text, parts, notices: [], contextId: sessionId ?? undefined, taskState: reason === 'canceled' ? 'canceled' : 'completed', stopReason: reason }
  }

  const permission = (tool: ManagedPermissionTool): Promise<void> => {
    const existing = permissionBarriers.get(tool.id)
    if (existing) return existing
    const requestId = `per_${nanoid()}`
    const request = { action: tool.name, resources: [JSON.stringify(tool.input)], savable: [], callId: tool.id, allowRemember: false }
    const park = deps.registerRequest({
      requestId, chatId: input.chatId, agentId, kind: 'permission', request,
      delivery: {
        validate() { binding.validate(); if (closed || stopping) throw new Error('This Managed turn is no longer waiting.') },
        normalize(resolution) {
          return resolution.kind === 'permission' && resolution.reply === 'always'
            ? { resolution: { kind: 'permission', reply: 'once', remembered: false }, remembered: false }
            : { resolution }
        },
        async respondAsync(_ask, resolution, context) {
          try {
            binding.validate()
            context.signal.throwIfAborted()
            if (closed || stopping || !sessionId) throw new Error('This Managed turn is no longer waiting.')
          } catch (error) { return { status: 'not_sent', reason: error instanceof Error ? error.message : 'The Managed session changed.' } }
          if (resolution.kind !== 'permission') return { status: 'not_sent', reason: 'This action requires a permission decision.' }
          // The public response type documents thread routing; SDK0.125's
          // input type omits this field but sends structurally compatible values.
          const confirmation: Pick<BetaManagedAgentsUserToolConfirmationEvent, 'type' | 'result' | 'tool_use_id' | 'session_thread_id'> = {
            type: 'user.tool_confirmation', result: resolution.reply === 'reject' ? 'deny' : 'allow',
            tool_use_id: tool.id, ...(tool.session_thread_id ? { session_thread_id: tool.session_thread_id } : {})
          }
          try {
            const response = await client.beta.sessions.events.send(sessionId!, { ...params, events: [confirmation] }, {
              signal: context.signal, timeout: requestMs, maxRetries: 0
            })
            const acknowledgment = response.data?.find((event) => event.type === 'user.tool_confirmation' &&
              event.tool_use_id === tool.id && event.result === confirmation.result &&
              (event.session_thread_id ?? null) === (tool.session_thread_id ?? null))
            if (!acknowledgment?.id) return { status: 'uncertain', reason: 'The Managed answer acknowledgment was incomplete. Do not submit it again.' }
            return { status: 'accepted' }
          } catch { return { status: 'uncertain', reason: 'The Managed answer may have been accepted, but its acknowledgment was lost. Do not submit it again.' } }
        }
      }
    })
    parks.set(requestId, park)
    emitPart({ kind: 'tool', text: '', toolName: PERMISSION_TOOL_NAME, toolId: requestId, toolInput: request })
    input.onEvent?.({ type: 'needs_input', requestId, request: { kind: 'permission', action: request.action, resources: request.resources, callId: tool.id, allowRemember: false }, resume: 'reply' })
    const barrier = park.answered.then((resolution) => {
      parks.delete(requestId)
      if (closed || stopping) return
      input.onEvent?.({ type: 'input_resolved', requestId, resolution })
      if (resolution.kind !== 'permission') throw new Error('The Managed permission expired. The remote action was not answered.')
      emitPart({ kind: 'tool_result', text: resolution.reply === 'reject' ? 'Denied.' : 'Allowed once.', toolId: requestId })
    })
    // All siblings are registered in the same stack before Promise.all waits.
    permissionBarriers.set(tool.id, barrier)
    return barrier
  }
  const apply = async (effects: ManagedEffect[]): Promise<ManagedRunResult | null> => {
    for (const effect of effects) {
      switch (effect.type) {
        case 'text': {
          if (closed || stopping) break
          const delta = (text ? '\n\n' : '') + effect.text
          text += delta
          emitPart({ kind: 'text', text: delta })
          break
        }
        case 'progress': input.onEvent?.({ type: 'status', state: 'working', contextId: sessionId ?? undefined }); break
        case 'tool': emitPart({ kind: 'tool', text: '', toolId: effect.tool.id, toolName: effect.tool.name, toolInput: effect.tool.input }); break
        case 'tool_result': emitPart({ kind: 'tool_result', text: JSON.stringify(effect.content ?? []), toolId: effect.id, ...(effect.failed ? { toolStream: 'stderr' } : {}) }); break
        case 'permissions': await Promise.all(effect.tools.map(permission)); break
        case 'terminal': return result(effect.reason)
      }
    }
    return null
  }
  const attach = async (): Promise<void> => {
    binding.validate()
    const stream = await client.beta.sessions.events.stream(sessionId!, params, { signal: streamLife.signal, timeout: requestMs, maxRetries: 0 })
    streamState.controller?.abort()
    streamState.controller = stream.controller
    streamState.iterator = stream[Symbol.asyncIterator]()
    binding.validate()
  }
  const readHistory = async (signal: AbortSignal): Promise<ManagedEvent[]> => {
    const events: ManagedEvent[] = []
    for await (const event of client.beta.sessions.events.list(sessionId!, { ...params, order: 'asc', limit: 1000 }, { signal, timeout: requestMs, maxRetries: 0 })) {
      binding.validate()
      if (events.length >= 50_000) throw new Error('This Managed session exceeds the safe history limit. Start a new chat.')
      events.push(event)
    }
    return events
  }
  const history = async (baseline: boolean): Promise<ManagedRunResult | null> => {
    const events = await readHistory(io.signal)
    reducer.reconcile(events)
    for (const event of events) {
      if (baseline) reducer.baseline(event)
      else { const terminal = await apply(reducer.accept(event)); if (terminal) return terminal }
    }
    return null
  }
  const drain = async (): Promise<ManagedRunResult> => {
    await interrupt()
    if (!workMayExist) return result('canceled')
    for (const event of stopHistory.splice(0)) {
      const terminal = await apply(reducer.accept(event))
      if (terminal) return terminal
    }
    if (streamState.iterator) {
      try {
        while (!streamLife.signal.aborted) {
          const next = await streamState.iterator.next()
          if (next.done) break
          const terminal = await apply(reducer.accept(next.value))
          if (terminal) return terminal
        }
      } catch { /* bounded/closed stream: uncertainty remains */ }
    }
    return result('canceled', false)
  }

  /** Admission and kickoff of a new turn. Every failure before the send sends nothing. */
  const begin = async (wireContent: string): Promise<void> => {
    io.signal.throwIfAborted()
    binding.validate()
    // An earlier turn's kickoff goes first, before any request: a turn that
    // was settled without being followed left it, and a relaunch must never
    // follow that turn for this one. The state is kept, so admission is not.
    const previous = binding.checkpoint
    if (sessionId && previous?.kickoffEventId) save(previous.state)
    // Durable checkpoints record uncertainty, not permanent admission locks.
    // Retrieve and reconcile remote history before allowing another message.
    const newlyCreated = !sessionId
    const session = sessionId
      ? await client.beta.sessions.retrieve(sessionId, params, options())
      : await client.beta.sessions.create({ ...params, agent: config.version ? { type: 'agent', id: config.agentId, version: config.version } : config.agentId, environment_id: config.environmentId }, options())
    sessionId = session.id
    if (!sessionId) throw new Error('The Managed session acknowledgment did not contain a session ID.')
    binding.validate()
    io.signal.throwIfAborted()
    if (newlyCreated) save('ready')
    await attach()
    await history(true)
    reducer.assertReady(session.status, newlyCreated)
    binding.validate()
    io.signal.throwIfAborted()
    save('inflight')
    workMayExist = true
    const sent = await client.beta.sessions.events.send(sessionId, {
      ...params, events: [{ type: 'user.message', content: [{ type: 'text', text: wireContent }] }]
    }, options())
    binding.validate()
    const kickoffId = sent.data?.find((event) => event.type === 'user.message')?.id ?? ''
    reducer.start(kickoffId)
    // From here a relaunch can follow this turn instead of losing it. The
    // turn is running: a write that fails costs only that, so it is logged.
    try {
      save('inflight', { eventId: kickoffId, messageId: input.messageId ?? null })
    } catch (error) {
      logger.error('could not save a Managed turn’s kickoff; it cannot be followed after a restart', {
        chatId: input.chatId, error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  /** Attach, read the whole history, then stream until the turn ends. */
  const follow = async (): Promise<ManagedRunResult> => {
    // Discard the old stream's pre-kickoff buffer. Attach anew before reading
    // complete history, which establishes the processed kickoff in order and
    // recovers all events in the gap without resending the message.
    await attach()
    const caughtUp = await history(false)
    if (caughtUp) return caughtUp
    if (following && !reducer.seen(mode.kickoffEventId)) {
      throw new UnknownKickoff('This Managed session has no record of the interrupted message.')
    }
    if (following && !input.signal.aborted) mode.hooks.onStillRunning?.()
    let reconnects = 0
    while (streamState.iterator) {
      if (input.signal.aborted) return await drain()
      let next: IteratorResult<ManagedEvent>
      try { next = await streamState.iterator.next() }
      catch (error) {
        if (input.signal.aborted) return await drain()
        if (++reconnects > 2) throw unreachableReason(error) ? error : new StreamLost(error instanceof Error ? error.message : 'The Managed stream failed.')
        await attach()
        const terminal = await history(false)
        if (terminal) return terminal
        continue
      }
      if (input.signal.aborted) {
        // The interrupt path rotates and reconciles its stream, so this old
        // pending read must not overtake that history's processed marker.
        return await drain()
      }
      if (next.done) {
        if (++reconnects > 2) throw new StreamLost('The Managed stream closed before the turn completed.')
        await attach()
        const terminal = await history(false)
        if (terminal) return terminal
        continue
      }
      binding.validate()
      const terminal = await apply(reducer.accept(next.value))
      if (terminal) return terminal
    }
    throw new StreamLost('The Managed stream could not be attached.')
  }

  try {
    if (mode.kind === 'turn') await begin(mode.wireContent)
    else {
      io.signal.throwIfAborted()
      binding.validate()
    }
    return await follow()
  } catch (error) {
    if (input.signal.aborted) {
      try { return await drain() } catch { return { text, parts, notices: [], taskState: 'canceled', stopReason: 'canceled' } }
    }
    const message = error instanceof Error ? error.message : 'The Managed session failed.'
    const unreachable = following ? unreachableReason(error) : null
    if (unreachable) {
      // The turn may still be running there, and a later pass can follow it
      // again from the same kickoff: interrupt nothing, save nothing.
      return { text, parts, notices: [], contextId: sessionId ?? undefined, error: { message, raw: message }, unreachable }
    }
    if (following && !reducer.seen(mode.kickoffEventId)) {
      // Nothing read yet proves the session's work is this turn's: interrupt
      // nothing. The session answered, and this turn will not be followed again.
      try { save('uncertain') } catch { /* changed owner cannot be written */ }
    } else if (workMayExist) {
      // A followed turn whose kickoff was read fails as a live one does.
      await interrupt()
      try { save(budget ? 'budget' : 'uncertain') } catch { /* changed owner cannot be written */ }
    }
    return { text, parts, notices: [], contextId: sessionId ?? undefined, error: { message, raw: message } }
  } finally {
    closed = true
    input.signal.removeEventListener('abort', abort)
    if (stopTimer) clearTimeout(stopTimer)
    for (const park of parks.values()) park.cancel()
    io.abort()
    streamLife.abort()
    void streamState.iterator?.return?.().catch(() => {})
  }
}
