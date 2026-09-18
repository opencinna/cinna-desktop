/**
 * A Claude folder agent's subagent work, pulled out of the flat part list and
 * nested under the Agent call that launched it.
 *
 * The main process files a subagent's parts in the same message as the
 * agent's own, marked with `parentToolId` = the Agent call's id (the ACP
 * translator's "subagent lanes"). Drawn flat, the child's tool calls and its
 * report read as the agent's own words. This groups them: each group is shown
 * as an `AgentToolSubThread` where the Agent call sits.
 *
 * Pure. Every Agent/Task call becomes a group, whatever the agent, so a row
 * written before `parentToolId` existed shows its Agent call as a sub-thread
 * too; its subagent's work, which carries no lane, still draws flat after it.
 */
import type { ToolStream } from '../../../../shared/messageParts'

/** The tool names a Claude subagent is launched by. */
const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task'])

export interface NestablePart {
  kind: string
  text?: string
  toolName?: string
  toolId?: string
  toolInput?: Record<string, unknown>
  toolStream?: ToolStream
  parentToolId?: string
}

export interface SubagentGroup<T> {
  /** The Agent call the group runs under. */
  parentToolId: string
  /** The Agent call's own part, when this list has it. */
  tool?: T
  /** The subagent's parts, in arrival order. */
  parts: T[]
  status: 'pending' | 'done' | 'error'
  /** The Agent call's failed result, when it failed. */
  errorText?: string
  /** `toolInput.description`, or "Subagent". */
  agentName: string
  /** `toolInput.prompt` — the task the agent gave its subagent. */
  askMessage?: string
}

export interface NestedParts<T> {
  /** What the flat render walks: subagent parts and the Agent call's result removed. */
  items: T[]
  /** `items[i]` is `input[origin[i]]`. */
  origin: number[]
  /** Index in `items` → the group drawn there instead of that item. */
  groups: Map<number, SubagentGroup<T>>
}

function stringField(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * Nest every part with a `parentToolId` under its Agent call.
 *
 * - Every Agent/Task call of the agent's own is a group, live and saved, with
 *   or without subagent parts: the spot shows one control from the call's
 *   first frame to the saved row (UX rule 1), and a subagent that failed
 *   before it said anything keeps its error marker instead of collapsing into
 *   a plain tool row at turn end. A subagent's own Agent call (a nested
 *   subagent) stays inside its parent's group, with its work.
 * - The Agent call's own result (same id, main lane) is consumed: `stderr`
 *   makes the group an error with that text; any other result makes it done;
 *   no result is pending while `live`, else done. A group with no subagent
 *   parts shows a done result as its content: with no lane to repeat it (an
 *   old row, an agent whose subagent frames never reach the desktop) the
 *   report is the only record of what the subagent did.
 * - Parts whose Agent call is not in this list — a background subagent
 *   announced in an earlier turn, or its work after a steer — form a group
 *   named "Subagent" at the position of their first part.
 * - A `user` block (a message steered into the running turn, live only) ends a
 *   segment, and each segment is nested on its own, exactly as the saved turn
 *   is split into rows there (`saveTurnRows`): lane parts after the steer form
 *   their own "Subagent" group, and an Agent call's result is consumed only
 *   within its own segment. Only the last segment is `live`; the ones above a
 *   steer are nested as the saved rows they will become.
 */
export function nestSubagentParts<T extends NestablePart>(
  input: readonly T[],
  opts: { live?: boolean } = {}
): NestedParts<T> {
  const items: T[] = []
  const origin: number[] = []
  const groups = new Map<number, SubagentGroup<T>>()
  let start = 0
  const flush = (end: number): void => {
    const segment = nestSegment(input.slice(start, end), !!opts.live && end === input.length)
    segment.items.forEach((item, i) => {
      const group = segment.groups.get(i)
      if (group) groups.set(items.length, group)
      items.push(item)
      origin.push(start + segment.origin[i])
    })
  }
  input.forEach((part, i) => {
    if (part.kind !== 'user') return
    flush(i)
    items.push(part)
    origin.push(i)
    start = i + 1
  })
  flush(input.length)
  return { items, origin, groups }
}

/** One segment of {@link nestSubagentParts}: a list with no steer inside it. */
function nestSegment<T extends NestablePart>(input: readonly T[], live: boolean): NestedParts<T> {
  const isAgentCall = (part: T): boolean =>
    part.kind === 'tool' && !!part.toolId && SUBAGENT_TOOL_NAMES.has(part.toolName ?? '')
  const ownCalls = input.filter((part) => isAgentCall(part) && !part.parentToolId)
  if (!ownCalls.length && !input.some((part) => part.parentToolId)) {
    return { items: [...input], origin: input.map((_, i) => i), groups: new Map() }
  }
  const agentAt = new Map<string, number>()
  input.forEach((part, i) => {
    if (isAgentCall(part) && !agentAt.has(part.toolId!)) agentAt.set(part.toolId!, i)
  })
  // The outermost Agent call a lane runs under, as far as this list knows.
  const rootOf = (lane: string): string => {
    const seen = new Set<string>()
    let current = lane
    while (!seen.has(current)) {
      seen.add(current)
      const at = agentAt.get(current)
      const parent = at === undefined ? undefined : input[at].parentToolId
      if (!parent) break
      current = parent
    }
    return current
  }

  const children = new Map<string, number[]>()
  input.forEach((part, i) => {
    if (!part.parentToolId) return
    const root = rootOf(part.parentToolId)
    const list = children.get(root) ?? []
    list.push(i)
    children.set(root, list)
  })
  // A group for a call whose subagent has not spoken (yet, or ever).
  for (const call of ownCalls) if (!children.has(call.toolId!)) children.set(call.toolId!, [])

  const skipped = new Set<number>()
  const anchors = new Map<number, SubagentGroup<T>>()
  for (const [root, indices] of children) {
    indices.forEach((i) => skipped.add(i))
    const toolAt = agentAt.get(root)
    const tool = toolAt !== undefined && !input[toolAt].parentToolId ? input[toolAt] : undefined
    const results: T[] = []
    input.forEach((part, i) => {
      if (part.kind === 'tool_result' && part.toolId === root && !part.parentToolId) {
        results.push(part)
        skipped.add(i)
      }
    })
    const failed = results.filter((result) => result.toolStream === 'stderr')
    const status = failed.length > 0 ? 'error' : results.length > 0 || !live ? 'done' : 'pending'
    const errorText = failed.map((result) => result.text ?? '').filter(Boolean).join('\n') || undefined
    const anchor = tool ? (toolAt as number) : indices[0]
    skipped.delete(anchor)
    anchors.set(anchor, {
      parentToolId: root,
      ...(tool ? { tool } : {}),
      parts: indices.length > 0 ? indices.map((i) => input[i]) : results.filter((result) => result.toolStream !== 'stderr'),
      status,
      ...(errorText ? { errorText } : {}),
      agentName: stringField(tool?.toolInput, 'description') ?? 'Subagent',
      ...(stringField(tool?.toolInput, 'prompt') ? { askMessage: stringField(tool?.toolInput, 'prompt') } : {})
    })
  }

  const items: T[] = []
  const origin: number[] = []
  const groups = new Map<number, SubagentGroup<T>>()
  input.forEach((part, i) => {
    if (skipped.has(i)) return
    const group = anchors.get(i)
    if (group) groups.set(items.length, group)
    items.push(part)
    origin.push(i)
  })
  return { items, origin, groups }
}
