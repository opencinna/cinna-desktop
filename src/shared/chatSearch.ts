/**
 * All-chats search (`chat:search`). Main searches the chats the Chats list
 * shows, in the user's and the assistant's words only — never a tool block, a
 * tool result, an attachment or an error row.
 */

/** Messages returned per chat: its newest matches. The rest is counted in `total`. */
export const CHAT_SEARCH_PER_CHAT = 3

/** Chats returned at most, newest match first. */
export const CHAT_SEARCH_CHAT_LIMIT = 50

/** Longer queries are cut to this many characters before searching. */
export const CHAT_SEARCH_MAX_QUERY = 200

export interface ChatSearchMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
}

export interface ChatSearchGroup {
  chatId: string
  title: string
  /** Every matching message of the chat, not only those in `messages`. */
  total: number
  /** The newest match's time: what the groups are ordered by. */
  latestAt: Date
  /** Up to {@link CHAT_SEARCH_PER_CHAT}, newest first. */
  messages: ChatSearchMessage[]
}

export interface ChatSearchResult {
  /** Newest match first. */
  groups: ChatSearchGroup[]
  /** More chats matched than {@link CHAT_SEARCH_CHAT_LIMIT}. */
  truncated: boolean
}

/**
 * Who the results are limited to, as the Chats list groups a chat by who it
 * is with (`chatWho`): its agent, else its chat mode, else nobody (`none`).
 * A chat matches when any given part names it; no part, or all empty, is no
 * filter at all.
 */
export interface ChatSearchFilter {
  agentIds?: string[]
  modeIds?: string[]
  /** Chats with neither an agent nor a mode: the Chats list's `none` group. */
  none?: boolean
}

/** The filter for the renderer's who-keys (`agent:<id>`, `mode:<id>`, `none`); undefined for none pressed. */
export function chatSearchFilterOf(keys: readonly string[]): ChatSearchFilter | undefined {
  if (keys.length === 0) return undefined
  const filter: ChatSearchFilter = {}
  for (const key of keys) {
    if (key.startsWith('agent:')) (filter.agentIds ??= []).push(key.slice('agent:'.length))
    else if (key.startsWith('mode:')) (filter.modeIds ??= []).push(key.slice('mode:'.length))
    else if (key === 'none') filter.none = true
  }
  return filter
}

/** A `LIKE` pattern matching `query` anywhere, with `%`, `_` and `\` taken literally (`ESCAPE '\'`). */
export function likeContains(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}
