import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useComposerDraftKey } from './useComposerDraft'
import { useChatStore } from '../stores/chat.store'
import { useComposerDraftStore, type ComposerDraft } from '../stores/composerDraft.store'
import type { ChatRouter } from '../../../shared/chatRouting'
import type { ChatModeData } from '../constants/chatModeColors'
import { APP_SETTINGS_KEY } from './useAppSettings'
import { DEFAULT_RUNTIME_KEY } from './useEngine'
import { resolveDefaultModeId } from '../../../shared/chatModeDefaults'
import { isAgentEngine, type AgentEngine } from '../../../shared/engine'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

/** The new-chat draft fields that decide who a chat goes to and how. */
export type ChatDraftRouting = Pick<ComposerDraft, 'modeSelection' | 'pendingAgentIds' | 'pendingMcpIds' | 'coordinate' | 'conductorId' | 'multiAgentRouting'>

/**
 * The new-chat draft that sets a chat up like `chat` — the inverse of what
 * `useNewChatFlow.startNewChat` makes of a draft.
 *
 * - Agents: the chat's root when it is one of the user's agents (not the hidden
 *   runtime a chat makes for itself, `conductor`), then its on-demand agents,
 *   in order; agents no longer listed are dropped. None → null, the screen's
 *   "nothing picked".
 * - MCP servers: the on-demand ones. The baseline set is the mode's own list,
 *   and comes with the mode.
 * - Mode: the chat's mode; none → `'none'`, never `'auto'`. `startNewChat`
 *   stamps no mode on a chat whose agents answer it, nor on one started with
 *   no mode; `'auto'` would bring today's default mode and its MCP servers,
 *   which turn an agent chat into a coordinated one. A runtime chat with no
 *   mode (its hidden runtime is the root) ran on the effective default mode:
 *   it stays `'none'` (that default, prompt and tools included) while the
 *   default still runs the runtime's engine (`defaultEngine`), and otherwise
 *   takes the runtime mode of that engine, so the copy does not move to
 *   another engine; with no such mode listed, `'none'`.
 * - Coordination: `coordinate` from the router; the conductor is the root
 *   when it is a user agent, else null (the default conductor). A `human`
 *   chat keeps `human` routing (`multiAgentRouting`) whatever the Settings
 *   default is; any other router leaves the default.
 */
export function chatDraftRouting(
  chat: { agentId: string | null; router: ChatRouter; modeId: string | null },
  agents: readonly Pick<AgentData, 'id' | 'conductor' | 'conductorEngine'>[],
  onDemandAgentIds: readonly string[],
  onDemandMcpIds: readonly string[],
  { modes = [], defaultEngine }: {
    modes?: readonly Pick<ChatModeData, 'id' | 'builtinEngine' | 'managed'>[]
    /** The engine a chat with no mode would run on today; undefined when not known. */
    defaultEngine?: AgentEngine
  } = {}
): ChatDraftRouting {
  const userAgents = new Set(agents.filter((a) => !a.conductor).map((a) => a.id))
  const root = chat.agentId && userAgents.has(chat.agentId) ? chat.agentId : null
  const agentIds = [...new Set([...(root ? [root] : []), ...onDemandAgentIds.filter((id) => userAgents.has(id))])]
  const coordinate = chat.router === 'coordinator'
  const runtimeEngine = chat.agentId ? agents.find((a) => a.id === chat.agentId && a.conductor)?.conductorEngine : undefined
  const runtimeMode = runtimeEngine && runtimeEngine !== defaultEngine ? modes.find((m) => m.builtinEngine === runtimeEngine && !m.managed) : undefined
  return {
    modeSelection: chat.modeId ? { id: chat.modeId } : runtimeMode ? { id: runtimeMode.id } : 'none',
    pendingAgentIds: agentIds.length > 0 ? agentIds : null,
    pendingMcpIds: [...new Set(onDemandMcpIds)],
    coordinate,
    conductorId: coordinate ? root : null,
    multiAgentRouting: chat.router === 'human' ? 'human' : null
  }
}

/**
 * The engine a chat with no mode runs on today, as main's
 * `chatConductorService.ensure` picks it: the effective default mode's engine,
 * else the Default runtime. Undefined when neither is known.
 */
export function effectiveDefaultEngine(
  modes: readonly (Pick<ChatModeData, 'id' | 'isDefault' | 'managed' | 'enabled'> & { engine?: string | null })[],
  prioritizeAccountDefaults: boolean,
  defaultRuntime: AgentEngine | undefined
): AgentEngine | undefined {
  const id = resolveDefaultModeId(modes, prioritizeAccountDefaults)
  const engine = id ? modes.find((m) => m.id === id)?.engine : undefined
  return isAgentEngine(engine) ? engine : defaultRuntime
}

/**
 * **New chat** from a chat: writes the new-chat draft's routing fields from
 * `chatId` and opens the new-chat screen. Sends nothing. The draft's text,
 * notes, path references and files are left as they are; the old chat is not
 * touched. `agentId` is the agent page the composer is embedded on, whose
 * new-chat draft is its own; that page has no open chat to leave.
 *
 * Reads through the same queries the composer reads (fetched when not cached),
 * so it resolves only after the chat's agents and servers are known. Rejects
 * when they cannot be read; the caller says so.
 */
export function useNewChatLike(chatId: string | null, agentId?: string): () => Promise<void> {
  const queryClient = useQueryClient()
  const draftKey = useComposerDraftKey(null, agentId)
  return useCallback(async () => {
    if (!chatId) return
    const [chat, agents, onDemandAgents, onDemandMcps, modes, settings, defaultRuntime] = await Promise.all([
      queryClient.ensureQueryData({ queryKey: ['chat', chatId], queryFn: () => window.api.chat.get(chatId) }),
      queryClient.ensureQueryData({ queryKey: ['agents'], queryFn: () => window.api.agents.list() }),
      queryClient.ensureQueryData({ queryKey: ['chat-on-demand-agent', chatId], queryFn: () => window.api.chat.listOnDemandAgents(chatId) }),
      queryClient.ensureQueryData({ queryKey: ['chat-on-demand-mcp', chatId], queryFn: () => window.api.chat.listOnDemandMcps(chatId) }),
      queryClient.ensureQueryData({ queryKey: ['chat-modes'], queryFn: () => window.api.chatModes.list() }),
      queryClient.ensureQueryData({ queryKey: APP_SETTINGS_KEY, queryFn: () => window.api.settings.getAll() }),
      queryClient.ensureQueryData({ queryKey: DEFAULT_RUNTIME_KEY, queryFn: () => window.api.engine.defaultRuntime() })
    ])
    if (!chat) throw new Error('This chat is no longer available.')
    const routing = chatDraftRouting(
      chat,
      agents,
      onDemandAgents.map((row) => row.agentId),
      onDemandMcps.map((row) => row.mcpProviderId),
      { modes, defaultEngine: effectiveDefaultEngine(modes, settings?.prioritizeAccountDefaults === true, defaultRuntime?.engine) }
    )
    useComposerDraftStore.getState().update(draftKey, () => routing)
    if (!agentId) useChatStore.getState().setActiveChatId(null)
  }, [chatId, agentId, draftKey, queryClient])
}
