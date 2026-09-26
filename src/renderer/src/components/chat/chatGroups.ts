import type { ChatListSummary } from '../../../../shared/chatListSummary'

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

function byDay<T extends GroupableChat>(
  chats: T[],
  parentKey: string,
  summaries: Record<string, ChatListSummary> | undefined,
  now: Date
): DateGroup<T>[] {
  const dated = chats
    .map((chat) => ({ chat, at: chatDate(chat, summaries?.[chat.id]).getTime() }))
    .sort((a, b) => b.at - a.at)
  return DATE_BUCKETS.map(({ bucket, label }) => ({
    key: `${parentKey}|${bucket}`,
    bucket,
    label,
    chats: dated.filter(({ at }) => dateBucket(new Date(at), now) === bucket).map(({ chat }) => chat)
  })).filter((group) => group.chats.length > 0)
}

/**
 * `chats` in the list's order (most recently updated first). "Who" groups
 * follow the first chat of each, so the most recent conversation leads; days
 * are in fixed order, each sorted by the date that placed it there.
 */
export function groupChats<T extends GroupableChat>(
  chats: T[],
  summaries: Record<string, ChatListSummary> | undefined,
  fallback: ChatGroupFallback,
  options: ChatGroupOptions,
  now: Date
): ChatGrouping<T> {
  if (!options.byAgent && !options.byDate) return { kind: 'flat', chats }
  if (!options.byAgent) return { kind: 'date', groups: byDay(chats, DATE_ONLY_PARENT, summaries, now) }
  const groups = new Map<string, WhoGroup<T>>()
  for (const chat of chats) {
    const { key, who } = chatWho(chat, summaries?.[chat.id], fallback)
    const group = groups.get(key)
    if (group) group.chats.push(chat)
    else groups.set(key, { key, who, chats: [chat], dates: null })
  }
  const out = [...groups.values()]
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
