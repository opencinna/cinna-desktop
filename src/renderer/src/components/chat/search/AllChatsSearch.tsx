import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Bot, MessageCircle, MessageSquare } from 'lucide-react'
import type { ChatListSummary } from '../../../../../shared/chatListSummary'
import { CHAT_SEARCH_CHAT_LIMIT, chatSearchFilterOf, type ChatSearchGroup, type ChatSearchResult } from '../../../../../shared/chatSearch'
import { useChatList, useChatSummaries } from '../../../hooks/useChat'
import { useAgents } from '../../../hooks/useAgents'
import { useChatModes } from '../../../hooks/useChatModes'
import { useChatSearchStore } from '../../../stores/chatSearch.store'
import { useChatStore } from '../../../stores/chat.store'
import { useUIStore } from '../../../stores/ui.store'
import { AgentColorsContext, agentInk, useAgentColor, type AgentChipColors } from '../../../utils/agentColors'
import { getPreset } from '../../../constants/chatModeColors'
import { chatWho } from '../chatGroups'
import { ChatSearchBar } from './ChatSearchBar'
import { SearchHitCard } from './SearchHitCard'
import { SearchResultList } from './SearchResultList'
import { useSearchPause } from './useSearchPause'
import { countMatches, findShortcutLabel, searchTimeLabel, snippetMarkdown } from './chatSearchText'

/** The bar's count slot, wide enough for "999 in 50 chats" (and "50+ chats"). */
const COUNT_WIDTH = 104

interface FoundGroup extends ChatSearchGroup {
  key: string
  who: ChatListSummary['with']
}

const NEUTRAL: AgentChipColors = { border: 'var(--color-border)', bg: 'transparent' }

/** A search result with the query it was fetched for: kept data under a newer query still highlights its own. */
interface FetchedSearch extends ChatSearchResult {
  query: string
}

/**
 * All-chats search: over the main area right of a docked sidebar, a scrim
 * and the bar at the bottom. Results grouped by chat, chats newest match
 * nearest the bar; agent chips narrow them to the agents the query found.
 */
export function AllChatsSearch(): React.JSX.Element | null {
  const scope = useChatSearchStore((s) => s.scope)
  if (scope !== 'all') return null
  return <AllChatsOverlay />
}

function AllChatsOverlay(): React.JSX.Element {
  const query = useChatSearchStore((s) => s.query)
  const close = useChatSearchStore((s) => s.close)
  const agentFilter = useChatSearchStore((s) => s.agents)
  const toggleAgent = useChatSearchStore((s) => s.toggleAgent)
  const clearAgents = useChatSearchStore((s) => s.clearAgents)
  const requestJump = useChatSearchStore((s) => s.requestJump)
  const chatAvailable = useChatSearchStore((s) => s.searchableChatId !== null)
  const { applied, pending: typing, flush } = useSearchPause(query)
  const q = applied.trim()
  // Who each chat is with, as the Chats list groups it.
  const { data: chats } = useChatList()
  const { data: summaries } = useChatSummaries()
  const { data: agents } = useAgents()
  const { data: modes } = useChatModes()
  const withWho = useCallback((found: ChatSearchGroup[]): FoundGroup[] => {
    const byId = new Map((chats ?? []).map((chat) => [chat.id, chat]))
    return found.map((group) => {
      const chat = byId.get(group.chatId) ?? { id: group.chatId, updatedAt: new Date(group.latestAt) }
      const { key, who } = chatWho(chat, summaries?.[group.chatId], { agents: agents ?? [], modes: modes ?? [] })
      return { ...group, key, who }
    })
  }, [chats, summaries, agents, modes])

  // Every chat the query finds: the chips and their counts, whatever is pressed.
  const unfiltered = useQuery({
    queryKey: ['chat-search', q],
    queryFn: async (): Promise<FetchedSearch> => ({ ...(await window.api.chat.search(q)), query: q }),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 30_000
  })
  // The results while chips are pressed: main limits the search to those
  // agents, so a pressed agent's chats past the newest 50 are found too.
  const filter = useMemo(() => chatSearchFilterOf(agentFilter), [agentFilter])
  const filterKey = [...agentFilter].sort().join(',')
  const filtered = useQuery({
    queryKey: ['chat-search', q, filterKey],
    queryFn: async (): Promise<FetchedSearch> => ({ ...(await window.api.chat.search(q, filter)), query: q }),
    enabled: q.length > 0 && !!filter,
    // The last filtered results, else what is already here narrowed to the
    // pressed chips — shown as pending, never opened.
    placeholderData: (previous) => {
      if (previous) return previous
      const base = unfiltered.data
      if (!base) return undefined
      const keys = new Set(agentFilter)
      const groups = new Set(withWho(base.groups).filter((group) => keys.has(group.key)).map((group) => group.chatId))
      // Not the base's truncation: these are only its chats, narrowed.
      return { ...base, truncated: false, groups: base.groups.filter((group) => groups.has(group.chatId)) }
    },
    staleTime: 0,
    gcTime: 30_000
  })
  const results = filter ? filtered : unfiltered
  const result = q ? results.data : undefined
  // Results kept from an earlier query (or filter) while the new one is in
  // flight: drawn, but pending — the icon pulses and Enter opens nothing.
  const stale = q.length > 0 && (results.isPlaceholderData || results.isPending)
  const pending = typing || stale
  /** The query the results on screen were found for: what their snippets highlight and a pick jumps to. */
  const resultQuery = result?.query ?? q

  const groups = useMemo((): FoundGroup[] => (result ? withWho(result.groups) : []), [result, withWho])
  const chipGroups = useMemo((): FoundGroup[] => (q && unfiltered.data ? withWho(unfiltered.data.groups) : []), [q, unfiltered.data, withWho])

  // Who each key was when a query last found it: a pressed chip the current
  // query does not find keeps its name and colour.
  const seenWho = useRef(new Map<string, ChatListSummary['with']>())
  for (const group of chipGroups) seenWho.current.set(group.key, group.who)
  // Chips for what the query found, counted whatever is pressed, so a chip
  // says what pressing it would show. A pressed one that found nothing stays,
  // so it can be unpressed.
  const chips = useMemo(() => {
    const found = new Map<string, { who: ChatListSummary['with']; count: number }>()
    for (const group of chipGroups) {
      const entry = found.get(group.key)
      if (entry) entry.count += group.total
      else found.set(group.key, { who: group.who, count: group.total })
    }
    for (const key of agentFilter) {
      if (!found.has(key)) found.set(key, { who: seenWho.current.get(key) ?? whoOfKey(key, agents, modes), count: 0 })
    }
    return [...found.entries()]
      .map(([key, entry]) => ({ key, ...entry }))
      .sort((a, b) => a.who.name.localeCompare(b.who.name))
  }, [chipGroups, agentFilter, agents, modes])
  const showChips = q.length > 0 && !!unfiltered.data && (chips.length >= 2 || agentFilter.length > 0)

  const shown = groups
  // Newest nearest the bar: the newest chat at the bottom, its newest message last.
  const display = useMemo(() => [...shown].reverse().map((group) => ({ ...group, messages: [...group.messages].reverse() })), [shown])
  const listId = useId()
  const optionId = (messageId: string): string => `${listId}-${messageId}`
  const entries = display.flatMap((group) => group.messages.map((message) => ({ id: optionId(message.id), group: group.chatId })))
  const resultsKey = `${resultQuery}|${filterKey}|${entries.map((entry) => entry.id).join(',')}`
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  useEffect(() => {
    setActiveId(entries[entries.length - 1]?.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultsKey])

  const left = useDockedSidebarEdge()

  const closeForPick = useChatSearchStore((s) => s.closeForPick)
  const openChat = (chatId: string, messageId: string | null): void => {
    // Focus goes to the opened chat's composer once it has scrolled there, not back here.
    closeForPick()
    useUIStore.getState().setActiveJobId(null)
    useChatStore.getState().setActiveChatId(chatId)
    useUIStore.getState().setActiveView('chat')
    requestJump({ chatId, messageId, query: resultQuery })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (typing) {
        flush()
        return
      }
      // Results of an earlier query: not what the field says.
      if (stale) return
      for (const group of display) {
        const message = group.messages.find((m) => optionId(m.id) === activeId)
        if (message) openChat(group.chatId, message.id)
      }
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (entries.length === 0) return
      event.preventDefault()
      const ids = entries.map((entry) => entry.id)
      const at = activeId ? ids.indexOf(activeId) : ids.length
      setActiveId(ids[Math.max(0, Math.min(ids.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))])
    }
  }

  const colorOf = useAgentColor()
  const chosen = useContext(AgentColorsContext)
  const chipColors = (who: ChatListSummary['with']): AgentChipColors => {
    if (who.kind === 'agent' && who.agentId) return colorOf(who.agentId)
    if (who.kind === 'mode' && who.color) {
      const preset = getPreset(who.color)
      return { border: preset.border, bg: preset.bg }
    }
    return NEUTRAL
  }
  const tintOf = (who: ChatListSummary['with']): string | null => {
    const hex = who.kind === 'agent' && who.agentId ? chosen.get(who.agentId) : undefined
    return hex ? agentInk(hex) : null
  }

  const total = shown.reduce((n, group) => n + group.total, 0)
  const count = !q || !result
    ? ''
    : shown.length === 0
      ? 'No matches'
      : result.truncated
        ? `${CHAT_SEARCH_CHAT_LIMIT}+ chats`
        : `${total} in ${shown.length} chat${shown.length === 1 ? '' : 's'}`
  // Beside the bar, so it shows without scrolling to the far end of the list.
  const notice = !q || !result
    ? null
    : result.truncated
      ? `Showing the ${CHAT_SEARCH_CHAT_LIMIT} chats with the newest matches. Refine the search to see older ones.`
      : filter && unfiltered.data?.truncated
        ? `Agents are counted in the ${CHAT_SEARCH_CHAT_LIMIT} chats with the newest matches.`
        : null
  const now = new Date()

  return (
    <div className="chat-search-root" data-fixed data-chat-search="all" data-pending={pending || undefined} style={{ left }}>
      <div className="chat-search-scrim" onMouseDown={close} />
      <div className="chat-search-column" style={{ top: 56, bottom: 28 }}>
        {!q ? (
          <div className="chat-search-empty chat-search-glass">
            Search messages across every chat. {findShortcutLabel()} inside a chat searches just that chat.
          </div>
        ) : !result ? null : display.length === 0 ? (
          <div className="chat-search-empty chat-search-glass">
            No matches for “{resultQuery}”{agentFilter.length > 0 ? ' with these agents' : ''}
          </div>
        ) : (
          <SearchResultList
            id={listId}
            label="Search results"
            entries={entries}
            resultsKey={resultsKey}
            activeId={activeId}
            onActivate={setActiveId}
          >
            {display.map((group) => {
              const tint = tintOf(group.who)
              const more = group.total - group.messages.length
              const agentName = group.who.kind === 'agent' ? group.who.name : 'Assistant'
              return (
                <section
                  key={group.chatId}
                  className="chat-search-group"
                  aria-label={group.title}
                  data-tinted={tint ? '' : undefined}
                  style={tint ? { ['--chat-search-agent' as string]: tint } : undefined}
                >
                  <div className="chat-search-group-head">
                    <MessageCircle size={13} className="chat-search-icon" aria-hidden="true" />
                    <span className="chat-search-group-title">{group.title}</span>
                    <WhoChip
                      who={group.who}
                      colors={chipColors(group.who)}
                      pressed={agentFilter.includes(group.key)}
                      onToggle={() => toggleAgent(group.key)}
                    />
                    <span className="chat-search-group-n">
                      {group.total} message{group.total === 1 ? '' : 's'}
                    </span>
                  </div>
                  {group.messages.map((message) => (
                    <SearchHitCard
                      key={message.id}
                      id={optionId(message.id)}
                      role={message.role}
                      who={message.role === 'user' ? 'You' : agentName}
                      when={searchTimeLabel(new Date(message.createdAt), now)}
                      count={countMatches(snippetMarkdown(message.role, message.content), resultQuery)}
                      content={message.content}
                      query={resultQuery}
                      active={activeId === optionId(message.id)}
                      onPick={() => openChat(group.chatId, message.id)}
                    />
                  ))}
                  {more > 0 && (
                    <button type="button" className="chat-search-more" onClick={() => openChat(group.chatId, null)}>
                      {more} older in this chat
                    </button>
                  )}
                </section>
              )
            })}
          </SearchResultList>
        )}
        {showChips && (
          <div className="chat-search-agents" role="group" aria-label="Limit to agents">
            <button
              type="button"
              className="chat-search-allchip"
              aria-pressed={agentFilter.length === 0}
              onClick={clearAgents}
            >
              All agents
            </button>
            {chips.map((chip) => (
              <WhoChip
                key={chip.key}
                who={chip.who}
                colors={chipColors(chip.who)}
                count={chip.count}
                pressed={agentFilter.includes(chip.key)}
                onToggle={() => toggleAgent(chip.key)}
              />
            ))}
          </div>
        )}
        {notice && (
          <div className="chat-search-notice chat-search-glass" role="status" data-chat-search-notice>
            {notice}
          </div>
        )}
        <ChatSearchBar
          scope="all"
          chatAvailable={chatAvailable}
          count={count}
          countWidth={COUNT_WIDTH}
          listId={listId}
          activeId={display.length > 0 ? activeId : undefined}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}

/**
 * An agent (or chat mode) as the composer's AgentChip draws it: icon, name in
 * its colour, a 10 % tint. A toggle of the results filter, in the chip row and
 * in each chat's heading alike.
 */
function WhoChip({ who, colors, count, pressed, onToggle }: {
  who: ChatListSummary['with']
  colors: AgentChipColors
  count?: number
  pressed: boolean
  onToggle: () => void
}): React.JSX.Element {
  const Icon = who.kind === 'agent' ? Bot : MessageSquare
  const ink = colors === NEUTRAL ? 'var(--color-text-secondary)' : colors.border
  return (
    <button
      type="button"
      className="chat-search-chip"
      aria-pressed={pressed}
      data-who-chip={who.name}
      title={pressed ? `Stop limiting results to ${who.name}` : `Limit results to ${who.name}`}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      style={{ color: ink, borderColor: colors.border, backgroundColor: colors.bg, ['--chip-border' as string]: colors.border }}
    >
      <Icon size={12} className="shrink-0" aria-hidden="true" />
      {who.name}
      {count !== undefined && (
        <>
          {' '}
          <span className="chat-search-chip-n">{count}</span>
        </>
      )}
    </button>
  )
}

/** A pressed chip whose agent the query no longer finds: named from the renderer's own lists. */
function whoOfKey(
  key: string,
  agents: readonly { id: string; name: string }[] | undefined,
  modes: readonly { id: string; name: string; colorPreset: string }[] | undefined
): ChatListSummary['with'] {
  if (key.startsWith('agent:')) {
    const id = key.slice('agent:'.length)
    return { kind: 'agent', name: agents?.find((a) => a.id === id)?.name ?? 'Agent', color: null, agentId: id }
  }
  if (key.startsWith('mode:')) {
    const id = key.slice('mode:'.length)
    const mode = modes?.find((m) => m.id === id)
    return { kind: 'mode', name: mode?.name ?? id, color: mode?.colorPreset ?? null, modeId: id }
  }
  return { kind: 'none', name: 'Chat', color: null }
}

/**
 * Where the main area starts: right of the sidebar while it is docked open,
 * else the window's edge. Read from the sidebar's box, as it is drawn.
 */
function useDockedSidebarEdge(): number {
  const docking = useUIStore((s) => s.sidebarDocking)
  const open = useUIStore((s) => s.sidebarOpen)
  const [left, setLeft] = useState(0)
  useEffect(() => {
    const measure = (): void => {
      const wrap = document.querySelector<HTMLElement>('.app-sidebar-wrap')
      if (!wrap || wrap.classList.contains('is-floating') || wrap.classList.contains('is-collapsed')) {
        setLeft(0)
        return
      }
      const box = wrap.getBoundingClientRect()
      setLeft(box.width > 0 ? box.right + 4 : 0)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [docking, open])
  return left
}
