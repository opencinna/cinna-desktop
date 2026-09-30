import type { ChatListSummary } from '../../../../shared/chatListSummary'
import type { ChatRunResult } from '../../../../shared/chatRunResult'
import { unreadResultIndicator } from '../ui/runResultIndicators'

/**
 * How the Chats list groups its rows: by who each chat is with, by the day of
 * its last message, both (days inside each "who"), or neither. Pure, so the
 * sidebar only renders what this returns.
 */

export type DateBucket = 'today' | 'yesterday' | 'last-week' | 'previous'

/** Fixed display order, newest first. */
export const DATE_BUCKETS: readonly { bucket: DateBucket; label: string }[] = [
  { bucket: 'today', label: 'Today' },
  { bucket: 'yesterday', label: 'Yesterday' },
  { bucket: 'last-week', label: 'Last Week' },
  { bucket: 'previous', label: 'Previous chats' }
]

const DAY_MS = 86_400_000

/**
 * Local calendar days, not 24-hour spans: a chat at 23:50 is "Yesterday" at
 * 00:10. Rounded, so a daylight-saving day of 23 or 25 hours still counts as
 * one. A date after `now` (a clock moved back) is today.
 */
export function dateBucket(date: Date, now: Date): DateBucket {
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(now) - midnight(date)) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days <= 7) return 'last-week'
  return 'previous'
}

export interface GroupableChat {
  id: string
  agentId?: string | null
  modeId?: string | null
  updatedAt: Date
  /** Place in the Pinned block, higher first; null or absent when not pinned. */
  pinnedRank?: number | null
  /** A place the user dragged the chat to; null or absent when never dragged. */
  sortKey?: number | null
}

/**
 * What a row whose summary has not loaded yet (a chat just created) is grouped
 * by: the renderer's own agent and mode lists.
 */
export interface ChatGroupFallback {
  agents: readonly {
    id: string
    name: string
    source: string
    driver?: string | null
    protocol?: string
    acpTransport?: 'stdio' | 'websocket'
    /** A chat's hidden runtime: the chat is a plain one, grouped by its mode. */
    conductor?: boolean
  }[]
  modes: readonly { id: string; name: string; colorPreset: string }[]
}

export interface ChatGroupOptions {
  byAgent: boolean
  byDate: boolean
}

export interface DateGroup<T> {
  /** `${parentKey}|${bucket}`: collapsed state is per parent. */
  key: string
  bucket: DateBucket
  label: string
  chats: T[]
}

export interface WhoGroup<T> {
  /** `agent:<id>`, `mode:<id>` or `none`. */
  key: string
  /** Drives the header's icon and name; `name` is "Chat" for the `none` group. */
  who: ChatListSummary['with']
  chats: T[]
  /** Days inside this group when grouping by date too, else null. */
  dates: DateGroup<T>[] | null
}

export type ChatGrouping<T> =
  | { kind: 'flat'; chats: T[] }
  | { kind: 'who'; groups: WhoGroup<T>[] }
  | { kind: 'date'; groups: DateGroup<T>[] }

/** The key of the top-level day groups when there is no "who" level. */
export const DATE_ONLY_PARENT = 'all'

const NO_ONE: ChatListSummary['with'] = { kind: 'none', name: 'Chat', color: null }

/** Who a chat is with: its summary, else the renderer's lists, else nobody. */
export function chatWho(
  chat: GroupableChat,
  summary: ChatListSummary | undefined,
  fallback: ChatGroupFallback
): { key: string; who: ChatListSummary['with'] } {
  if (summary) {
    const { with: who } = summary
    if (who.kind === 'agent' && who.agentId) return { key: `agent:${who.agentId}`, who }
    if (who.kind === 'mode') return { key: `mode:${who.modeId ?? who.name}`, who }
    return { key: 'none', who: NO_ONE }
  }
  const agent = chat.agentId ? fallback.agents.find((a) => a.id === chat.agentId && !a.conductor) : undefined
  if (agent) {
    return {
      key: `agent:${agent.id}`,
      who: {
        kind: 'agent', name: agent.name, color: null, agentId: agent.id,
        source: agent.source, driver: agent.driver ?? null, protocol: agent.protocol,
        ...(agent.acpTransport ? { acpTransport: agent.acpTransport } : {})
      }
    }
  }
  const mode = chat.modeId ? fallback.modes.find((m) => m.id === chat.modeId) : undefined
  if (mode) return { key: `mode:${mode.id}`, who: { kind: 'mode', name: mode.name, color: mode.colorPreset, modeId: mode.id } }
  return { key: 'none', who: NO_ONE }
}

/** The last message's time, or the row's own when it has none yet. */
export function chatDate(chat: GroupableChat, summary: ChatListSummary | undefined): Date {
  return summary?.lastMessageAt ? new Date(summary.lastMessageAt) : new Date(chat.updatedAt)
}

/**
 * Where a chat sits in the flat list and in a "who" group: the place the user
 * dragged it to, else its recency. Both are on one scale (ms), so a dragged
 * chat holds its place while the chats around it keep sorting by activity.
 */
export function listRank(chat: GroupableChat): number {
  return chat.sortKey ?? new Date(chat.updatedAt).getTime() + tieBreak(chat.id)
}

/** Where a chat sits inside a day group: dragged place, else the date that put it in the day. */
export function dayRank(chat: GroupableChat, summary: ChatListSummary | undefined): number {
  return chat.sortKey ?? chatDate(chat, summary).getTime() + tieBreak(chat.id)
}

/**
 * A fixed fraction of a millisecond per chat, in [0, 0.5). The times are
 * stored in whole seconds, so chats made in the same second tie, and a drop
 * between two tied neighbours would get their own rank as its midpoint and
 * stay where it was. Under a millisecond, it never reorders two different
 * times; it only orders ties, the same way on every poll.
 */
export function tieBreak(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193)
  return ((hash >>> 0) / 0x1_0000_0000) * 0.5
}

/** Where a chat sits inside Pinned. */
export function pinnedRank(chat: GroupableChat): number {
  return chat.pinnedRank ?? 0
}

/** Highest rank first; `sort` is stable, so a tie keeps the list's order. */
function byRank<T>(chats: T[], rank: (chat: T) => number): T[] {
  return chats
    .map((chat) => ({ chat, rank: rank(chat) }))
    .sort((a, b) => b.rank - a.rank)
    .map(({ chat }) => chat)
}

const isPinned = (chat: GroupableChat): boolean => chat.pinnedRank !== null && chat.pinnedRank !== undefined

/** The Pinned block: pinned chats only, flat, by rank. Grouping never applies. */
export function pinnedChats<T extends GroupableChat>(chats: T[]): T[] {
  return byRank(chats.filter(isPinned), pinnedRank)
}

function byDay<T extends GroupableChat>(
  chats: T[],
  parentKey: string,
  summaries: Record<string, ChatListSummary> | undefined,
  now: Date
): DateGroup<T>[] {
  // The bucket is the chat's date, never its dragged place: a drag reorders
  // inside a day and cannot move a chat to another.
  const dated = byRank(chats, (chat) => dayRank(chat, summaries?.[chat.id]))
    .map((chat) => ({ chat, bucket: dateBucket(chatDate(chat, summaries?.[chat.id]), now) }))
  return DATE_BUCKETS.map(({ bucket, label }) => ({
    key: `${parentKey}|${bucket}`,
    bucket,
    label,
    chats: dated.filter((entry) => entry.bucket === bucket).map(({ chat }) => chat)
  })).filter((group) => group.chats.length > 0)
}

/**
 * Every chat that is not pinned — Pinned is its own block, see
 * {@link pinnedChats} — sorted by {@link listRank}. "Who" groups are ordered
 * by their most recent chat's activity, never by a dragged place: a drag
 * reorders inside a group and must not move the group under the pointer.
 * Days are in fixed order, each sorted by {@link dayRank}.
 */
export function groupChats<T extends GroupableChat>(
  all: T[],
  summaries: Record<string, ChatListSummary> | undefined,
  fallback: ChatGroupFallback,
  options: ChatGroupOptions,
  now: Date
): ChatGrouping<T> {
  const chats = byRank(all.filter((chat) => !isPinned(chat)), listRank)
  if (!options.byAgent && !options.byDate) return { kind: 'flat', chats }
  if (!options.byAgent) return { kind: 'date', groups: byDay(chats, DATE_ONLY_PARENT, summaries, now) }
  const groups = new Map<string, WhoGroup<T>>()
  for (const chat of chats) {
    const { key, who } = chatWho(chat, summaries?.[chat.id], fallback)
    const group = groups.get(key)
    if (group) group.chats.push(chat)
    else groups.set(key, { key, who, chats: [chat], dates: null })
  }
  // `sort` is stable: groups of equal recency keep their first-seen order.
  const recency = (group: WhoGroup<T>): number =>
    Math.max(...group.chats.map((chat) => new Date(chat.updatedAt).getTime() + tieBreak(chat.id)))
  const out = [...groups.values()]
    .map((group) => ({ group, at: recency(group) }))
    .sort((a, b) => b.at - a.at)
    .map(({ group }) => group)
  if (options.byDate) for (const group of out) group.dates = byDay(group.chats, group.key, summaries, now)
  return { kind: 'who', groups: out }
}

/** The groups a chat sits in, outermost first — what must be open to show it. */
export function groupKeysOf<T extends GroupableChat>(grouping: ChatGrouping<T>, chatId: string): string[] {
  const has = (chats: T[]): boolean => chats.some((chat) => chat.id === chatId)
  if (grouping.kind === 'date') return grouping.groups.filter((g) => has(g.chats)).map((g) => g.key)
  if (grouping.kind === 'who') {
    const group = grouping.groups.find((g) => has(g.chats))
    if (!group) return []
    return [group.key, ...(group.dates ?? []).filter((d) => has(d.chats)).map((d) => d.key)]
  }
  return []
}

/** The collapse key of the Pinned block, beside the group keys. */
export const PINNED_GROUP = 'pinned'

/**
 * The drag rank that puts `draggedId` next to `targetId` in `chats` (a group
 * as displayed, highest rank first): above the target for `before`, below it
 * for `after`. Between two neighbours it is their midpoint; at the top, the
 * top neighbour's rank + 1; at the bottom, the bottom one's − 1.
 * `unchanged` when the drop leaves the chat where it was; `no-room` when no
 * number lies strictly between the neighbours (the gap was halved until the
 * float ran out), in which case nothing may be written.
 */
export function dropRank<T extends { id: string }>(
  chats: readonly T[],
  rank: (chat: T) => number,
  draggedId: string,
  targetId: string,
  place: 'before' | 'after'
): number | 'unchanged' | 'no-room' {
  const from = chats.findIndex((chat) => chat.id === draggedId)
  const rest = chats.filter((chat) => chat.id !== draggedId)
  const target = rest.findIndex((chat) => chat.id === targetId)
  if (from < 0 || target < 0) return 'unchanged'
  const at = target + (place === 'after' ? 1 : 0)
  if (at === from) return 'unchanged'
  const above = at > 0 ? rank(rest[at - 1]) : undefined
  const below = at < rest.length ? rank(rest[at]) : undefined
  return rankBetween(above, below) ?? 'no-room'
}

/**
 * The rank between the row above and the row below, either of which may be
 * absent. Null when there is none: no neighbours, or a midpoint that is not
 * strictly between them.
 */
export function rankBetween(above: number | undefined, below: number | undefined): number | null {
  if (above !== undefined && below !== undefined) {
    const mid = (above + below) / 2
    return below < mid && mid < above ? mid : null
  }
  if (below !== undefined) return below + 1
  if (above !== undefined) return above - 1
  return null
}

/**
 * Whether a group's start-chat button may show: the rule of the Agents list's
 * chat shortcut. The agent must be listed (a folder listed but never indexed
 * is not in `agents` at all) and enabled, and a folder agent's manifest must
 * not be invalid. A folder row is always enabled, and only folder agents are
 * in `folderAgents`, so neither test needs to ask the agent's `source` — which
 * the kind-branch ratchet forbids. A chat mode or a plain chat can always start.
 */
export function canStartChat(
  who: ChatListSummary['with'],
  agents: readonly { id: string; enabled: boolean; conductor?: boolean }[] | undefined,
  folderAgents: readonly { id: string; readiness: string }[] | undefined
): boolean {
  if (who.kind !== 'agent') return true
  const agent = agents?.find((a) => a.id === who.agentId && !a.conductor)
  if (!agent) return false
  return agent.enabled && folderAgents?.find((a) => a.id === agent.id)?.readiness !== 'invalid'
}

/**
 * Whether a group starts closed before the user has opened or closed it.
 * "Previous chats" beside other days does: the older history stays out of the
 * way. Alone, it is everything there is to see, and starts open.
 */
export function chatGroupCollapsedByDefault(group: { key: string; bucket?: DateBucket }, siblings: number): boolean {
  return group.bucket === 'previous' && siblings > 1
}

/** What puts a chat in the Active block: a run going, or a result not read yet. */
export interface ActivityChat extends GroupableChat {
  activeRunId?: string | null
  lastRunResult?: ChatRunResult | null
}

/**
 * Running, or holding a result the row marks unread — the same test as the
 * row's own icon (`unreadResultIndicator`), so the block and the icon agree.
 * `streamingChatId` is the open chat while its turn streams, before the list
 * has polled its run.
 */
export function isActiveChat(chat: ActivityChat, streamingChatId: string | null): boolean {
  const running = !!chat.activeRunId || chat.id === streamingChatId
  return running || !!unreadResultIndicator(chat.lastRunResult, running)
}

/**
 * The Active block's next rows, as ids: the ones still active keep their
 * places, so a run ending never reorders the block, and newcomers go on top
 * in list order.
 */
export function settleActiveIds<T extends ActivityChat>(shown: readonly string[], active: T[]): string[] {
  const now = new Set(active.map((chat) => chat.id))
  const kept = shown.filter((id) => now.has(id))
  const had = new Set(kept)
  const added = byRank(active.filter((chat) => !had.has(chat.id)), listRank).map((chat) => chat.id)
  return [...added, ...kept]
}
