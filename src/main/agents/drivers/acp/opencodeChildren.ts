/**
 * OpenCode subagents: the child sessions an OpenCode `subagent` call opens,
 * read off the `opencode/session/child_update` extension and written back
 * into the root session's stream.
 *
 * ## What OpenCode 2.0.27 sends
 *
 * A `subagent` tool call (ACP `name: "subagent"`, `kind: "think"`, input
 * `{agent, description, prompt, background?, sessionID?}`) opens a child
 * session titled with the call's `description`; a child may spawn its own.
 * The client that declares `clientCapabilities._meta["opencode/child-session-updates"]`
 * ({@link opencodeClientMeta}) gets every child's traffic, at any depth, as
 * `opencode/session/child_update` {rootSessionId, childSessionId,
 * parentSessionId, depth, title} plus either `type: "status"` with
 * `status: created | running | completed | interrupted | failed` (and
 * `error?`), or `type: "update"` with a `session/update` body whose tool call
 * ids are already `<childSessionId>:<call>`. Without the capability the same
 * bodies are flattened onto the root session with no start or end at all.
 *
 * - **The link from a child to its call is the title.** While a child runs,
 *   nothing names the call that spawned it but its `title` == the call's
 *   `rawInput.description`; only the call's final update names the child
 *   (`rawOutput.metadata.sessionID`). Two children of one fan-out can start
 *   in either order, so a child is matched by title among its parent's
 *   unclaimed calls, never by order, and the completion confirms it.
 * - **A background call completes at once** (`rawOutput.metadata.status:
 *   "running"`): its item follows the child's own statuses, not the call.
 * - **The stream is cut by the next prompt on the root**: a child still open
 *   then is never heard of again (see the driver's safety net), and a
 *   resumed child streams nothing at all (upstream).
 * - **A cancel ends the tree in one go**: every level `interrupted`.
 *
 * Statuses become a frame of a Cinna-internal kind
 * ({@link OPENCODE_CHILD_STATUS}) that `translateActivity` turns into the
 * hub's items; updates become root-session frames whose lane is the
 * spawning call (`_meta.cinna.parentToolCallId`, read by `acpMessages.ts`
 * as it reads Claude's `parentToolUseId`).
 *
 * **A child's update never goes out without a lane**: one with none would be
 * folded into the root's own reply. Until the child is matched to its call
 * (its status can precede the call's `description`, which the first
 * `tool_call` sends as `rawInput: {}`; a title can differ from it), its
 * updates — and its descendants', which sit inside its lane — are held, in
 * order, and go out once it is matched, by title or by the completion naming
 * it. A child no call can name any more — it ended and its parent has no
 * unclaimed call left, or its parent ended, or the prompt ended with its
 * parent the root or ended ({@link OpencodeChildren.drain}), or it held {@link HELD_LIMIT} frames —
 * goes out under a lane of its own (`subagent:<childSessionId>`, drawn as a
 * "Subagent" group), with a warn.
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { SessionActivityChange, SessionActivityTerminalState } from '../../../../shared/sessionActivity'
import { createLogger } from '../../../logger/logger'
import type { AcpActivityState, ActivityScope, SessionActivity, SessionActivityRegistry } from './acpActivity'
import { CINNA_FRAME_META, type AcpConnection } from './types'

const logger = createLogger('acp-opencode-children')

/** The capability a client declares to get child traffic as {@link OPENCODE_CHILD_UPDATE_METHOD}. */
export const OPENCODE_CHILD_UPDATES = 'opencode/child-session-updates'
export const OPENCODE_CHILD_UPDATE_METHOD = 'opencode/session/child_update'
/** The internal `sessionUpdate` kind a child's status becomes; never on the wire. */
export const OPENCODE_CHILD_STATUS = 'cinna_opencode_child_status'
const SUBAGENT_TOOL = 'subagent'
/** The updates one unmatched child (with its descendants) may hold before it goes out under its own lane. */
export const HELD_LIMIT = 500

/** `clientCapabilities._meta` for OpenCode. */
export function opencodeClientMeta(): Record<string, unknown> {
  return { [OPENCODE_CHILD_UPDATES]: true }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** One `opencode/session/child_update`, read. */
export interface OpencodeChildUpdate {
  rootSessionId: string
  childSessionId: string
  parentSessionId?: string
  title?: string
  status?: string
  error?: string
  update?: Record<string, unknown>
}

export function childUpdateOf(method: string, params: Record<string, unknown>): OpencodeChildUpdate | undefined {
  if (method !== OPENCODE_CHILD_UPDATE_METHOD) return undefined
  const rootSessionId = str(params.rootSessionId)
  const childSessionId = str(params.childSessionId)
  if (!rootSessionId || !childSessionId) return undefined
  const base = {
    rootSessionId,
    childSessionId,
    ...(str(params.parentSessionId) ? { parentSessionId: str(params.parentSessionId) } : {}),
    ...(str(params.title) ? { title: str(params.title) } : {})
  }
  if (params.type === 'status') {
    const status = str(params.status)
    if (!status) return undefined
    const error = str(params.error) ?? str(record(params.error)?.message)
    return { ...base, status, ...(error ? { error } : {}) }
  }
  if (params.type === 'update') {
    const update = record(params.update)
    return update && typeof update.sessionUpdate === 'string' ? { ...base, update } : undefined
  }
  return undefined
}

interface SpawnCall {
  /** The session the call runs in: the root, or the child that spawned from it. */
  owner: string
  /** It ended (`completed`/`failed`) without naming a child: it can name none now. */
  closed?: boolean
  agent?: string
  description?: string
  /** The child session it opened, once matched. */
  child?: string
}

interface Child {
  parent: string
  title?: string
  call?: string
  /** A status was heard: the child has an item. */
  started: boolean
  ended: boolean
  /** No call can name it any more: its frames go out under {@link orphanLane}. */
  orphan?: boolean
  /** Updates held until its lane is known: its own and its descendants', in arrival order. */
  held: HeldUpdate[]
}

interface HeldUpdate {
  child: string
  body: Record<string, unknown>
}

/** The lane of a child no call names: its own, never the root's. */
function orphanLane(childId: string): string {
  return `subagent:${childId}`
}

/** The internal frame of a child's status: what `translateActivity` reads. */
export interface OpencodeChildStatusUpdate {
  sessionUpdate: typeof OPENCODE_CHILD_STATUS
  childSessionId: string
  status: string
  /** The spawning call's agent, else the child's title. */
  name: string
  detail: string | null
  error?: string
}

/**
 * One root session's children: the `subagent` calls seen on it and its
 * children, and which child runs under which. Kept per session rather than
 * per turn: a background child reports after its turn's prompt answered.
 */
export class OpencodeChildren {
  private readonly calls = new Map<string, SpawnCall>()
  private readonly children = new Map<string, Child>()

  constructor(readonly rootSessionId: string) {}

  /**
   * Note a frame of the root session (its `subagent` calls). Frames this class
   * rebuilt are skipped. Returns the held child frames it releases, to be
   * folded after it (the call they sit under first).
   */
  observe(notification: SessionNotification): SessionNotification[] {
    const update = record(notification.update)
    if (!update || record(record(update._meta)?.[CINNA_FRAME_META])?.childSessionId !== undefined) return []
    this.note(this.rootSessionId, update)
    return this.settle()
  }

  /** The frames one child update becomes, all on the root session. */
  expand(child: OpencodeChildUpdate): SessionNotification[] {
    const id = child.childSessionId
    let info = this.children.get(id)
    if (!info) {
      info = { parent: child.parentSessionId ?? this.rootSessionId, started: false, ended: false, held: [] }
      this.children.set(id, info)
    }
    if (child.title) info.title = child.title
    if (child.parentSessionId) info.parent = child.parentSessionId

    if (child.status) {
      info.started = true
      if (child.status === 'completed' || child.status === 'interrupted' || child.status === 'failed') info.ended = true
      const call = this.callOf(id)
      const spawn = call ? this.calls.get(call) : undefined
      const status: OpencodeChildStatusUpdate = {
        sessionUpdate: OPENCODE_CHILD_STATUS,
        childSessionId: id,
        status: child.status,
        name: spawn?.agent ?? info.title ?? 'Subagent',
        detail: spawn?.description ?? info.title ?? null,
        ...(child.error ? { error: child.error } : {})
      }
      return [{ sessionId: this.rootSessionId, update: status } as unknown as SessionNotification, ...this.settle()]
    }

    const body = child.update
    if (!body) return []
    // What its title matched before this frame goes out first; what this
    // frame's own calls match, after it.
    const out = this.settle()
    this.note(id, body)
    out.push(...this.route({ child: id, body }), ...this.settle())
    return out
  }

  /**
   * The prompt ended: no call of the root's names a child any more. Every
   * child still unmatched goes out under its own lane, with what it held.
   *
   * `answered`: the prompt answered, and a background child may still run and
   * report — its own calls may yet name its children. So only a child whose
   * parent is the root, or has ended, goes out now; one inside a child still
   * running stays held for the next drain (a follow-up's end, the next
   * prompt's), not split across two lanes. Without it (a failure, a cancel
   * never acknowledged, a follow-up's end) every unmatched child goes out.
   */
  drain(answered = false): SessionNotification[] {
    for (const [id, child] of this.children) {
      if (child.orphan || this.callOf(id)) continue
      if (answered && child.parent !== this.rootSessionId && this.children.get(child.parent)?.ended === false) continue
      this.orphan(id, answered ? 'the prompt answered' : 'the prompt ended')
    }
    return this.release()
  }

  /** The children that have started and not ended. */
  running(): string[] {
    return [...this.children].filter(([, child]) => child.started && !child.ended).map(([id]) => id)
  }

  /** Mark children ended without a status (the safety net wrote them off). */
  forget(ids: readonly string[]): void {
    for (const id of ids) {
      const child = this.children.get(id)
      if (!child) continue
      child.ended = true
      if (child.held.length > 0) {
        logger.warn('an OpenCode subagent written off still held updates no call named; dropped', { childSessionId: id, count: child.held.length })
        child.held = []
      }
    }
  }

  /** One update out, or held by the nearest unmatched child it runs inside. */
  private route(entry: HeldUpdate): SessionNotification[] {
    const holder = this.holderOf(entry.child)
    if (holder) {
      const info = this.children.get(holder)!
      info.held.push(entry)
      if (info.held.length < HELD_LIMIT) return []
      this.orphan(holder, 'it held too many updates')
      return this.release()
    }
    const lane = this.callOf(entry.child) ?? orphanLane(entry.child)
    const meta = record(entry.body._meta) ?? {}
    return [{
      sessionId: this.rootSessionId,
      update: { ...entry.body, _meta: { ...meta, [CINNA_FRAME_META]: { childSessionId: entry.child, parentToolCallId: lane } } }
    } as unknown as SessionNotification]
  }

  /** The nearest child, `childId` or one it runs inside, with no lane yet. */
  private holderOf(childId: string): string | undefined {
    const seen = new Set<string>()
    let current: string | undefined = childId
    while (current && current !== this.rootSessionId && !seen.has(current)) {
      seen.add(current)
      const info = this.children.get(current)
      if (!info) return undefined
      if (!info.orphan && !this.callOf(current)) return current
      current = info.parent
    }
    return undefined
  }

  /** Orphan the ended children no call can name any more, then release what has a lane now. */
  private settle(): SessionNotification[] {
    for (const [id, child] of this.children) {
      if (!child.ended || child.orphan || this.callOf(id)) continue
      const parent = child.parent === this.rootSessionId ? undefined : this.children.get(child.parent)
      const parentEnded = child.parent !== this.rootSessionId && (!parent || parent.ended)
      if (parentEnded || !this.hasUnclaimedCall(child.parent)) this.orphan(id, parentEnded ? 'its parent ended' : 'no call of its parent is left to name it')
    }
    return this.release()
  }

  /** The held updates of every child that has a lane now, routed again in order. */
  private release(): SessionNotification[] {
    const out: SessionNotification[] = []
    for (const [id, child] of this.children) {
      if (child.held.length === 0 || this.holderOf(id) === id) continue
      const held = child.held
      child.held = []
      for (const entry of held) out.push(...this.route(entry))
    }
    return out
  }

  private orphan(childId: string, why: string): void {
    const child = this.children.get(childId)
    if (!child || child.orphan) return
    child.orphan = true
    logger.warn('an OpenCode subagent was never matched to its call; its work is shown under a lane of its own', { childSessionId: childId, why })
  }

  private hasUnclaimedCall(owner: string): boolean {
    for (const call of this.calls.values()) if (call.owner === owner && !call.child && !call.closed) return true
    return false
  }

  /** Record a `subagent` call of `owner`'s, and the child its final update names. */
  private note(owner: string, update: Record<string, unknown>): void {
    const kind = update.sessionUpdate
    const toolCallId = str(update.toolCallId)
    if ((kind !== 'tool_call' && kind !== 'tool_call_update') || !toolCallId) return
    let call = this.calls.get(toolCallId)
    if (!call) {
      if (str(update.name) !== SUBAGENT_TOOL && str(update.title) !== SUBAGENT_TOOL) return
      call = { owner }
      this.calls.set(toolCallId, call)
    }
    const input = record(update.rawInput)
    if (str(input?.agent)) call.agent = str(input?.agent)
    if (str(input?.description)) call.description = str(input?.description)
    const named = str(record(record(update.rawOutput)?.metadata)?.sessionID)
    if (named) this.link(named, toolCallId)
    else if (!call.child && (update.status === 'completed' || update.status === 'failed')) call.closed = true
  }

  /** The completion named the child: it is the truth, whatever the title matched. */
  private link(childId: string, toolCallId: string): void {
    const call = this.calls.get(toolCallId)
    if (!call) return
    let child = this.children.get(childId)
    if (!child) {
      // Known by its call alone so far (a resumed child reports nothing).
      child = { parent: call.owner, started: false, ended: false, held: [] }
      this.children.set(childId, child)
    }
    if (child.call === toolCallId && call.child === childId) return
    if (child.call && child.call !== toolCallId) {
      logger.debug('an OpenCode subagent matched by title named another call on completion', { childSessionId: childId })
      const previous = this.calls.get(child.call)
      if (previous?.child === childId) delete previous.child
    }
    if (call.child && call.child !== childId) {
      const other = this.children.get(call.child)
      if (other?.call === toolCallId) delete other.call
    }
    child.call = toolCallId
    call.child = childId
  }

  /** The call `childId` runs under: matched once, by its title among its parent's unclaimed calls. */
  private callOf(childId: string): string | undefined {
    const child = this.children.get(childId)
    if (!child) return undefined
    if (child.call) return child.call
    if (!child.title) return undefined
    for (const [toolCallId, call] of this.calls) {
      if (call.child || call.closed || call.owner !== child.parent || call.description !== child.title) continue
      call.child = childId
      child.call = toolCallId
      return toolCallId
    }
    return undefined
  }
}

const trackers = new WeakMap<SessionActivity, OpencodeChildren>()

/** The children of the root session `sessionId` belongs to (its own feed, or the feed that owns it). */
export function opencodeChildrenFor(
  registry: SessionActivityRegistry,
  connection: AcpConnection,
  sessionId: string,
  scope: ActivityScope
): OpencodeChildren {
  const feed = registry.lookup(connection, sessionId) ?? registry.session(connection, sessionId, scope)
  let found = trackers.get(feed)
  if (!found) {
    found = new OpencodeChildren(feed.sessionId)
    trackers.set(feed, found)
  }
  return found
}

/** The children of a session, when anything was ever tracked for it. */
export function trackedOpencodeChildren(registry: SessionActivityRegistry, connection: AcpConnection, sessionId: string): OpencodeChildren | undefined {
  const feed = registry.lookup(connection, sessionId)
  return feed ? trackers.get(feed) : undefined
}

/** A child's status, in the hub's words; `null` while it runs. */
function childState(status: string): SessionActivityTerminalState | null {
  switch (status) {
    case 'created':
    case 'running':
      return null
    case 'completed':
      return 'completed'
    case 'interrupted':
      return 'stopped'
    case 'failed':
      return 'failed'
    default:
      logger.warn('an OpenCode subagent reported a status this build does not know; shown as lost', { status })
      return 'lost'
  }
}

/** The activity of one {@link OPENCODE_CHILD_STATUS} frame: one item per child session. */
export function opencodeChildActivity(
  update: Record<string, unknown>,
  state: AcpActivityState,
  id: (wire: string) => string
): SessionActivityChange[] {
  const childId = str(update.childSessionId)
  const status = str(update.status)
  if (!childId || !status) return []
  const ended = childState(status)
  if (ended === null) {
    state.subagents.add(childId)
    return [{ type: 'upsert', id: id(childId), kind: 'subagent', title: str(update.name) ?? 'Subagent', detail: str(update.detail) ?? null }]
  }
  if (!state.subagents.has(childId)) return []
  const error = str(update.error)
  return [{ type: 'end', id: id(childId), state: ended, ...(error ? { summary: error } : {}) }]
}
