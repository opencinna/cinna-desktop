import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AppShortcut } from '../../../shared/appShortcuts'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'
import { startAgentChat, unavailableAgentMessage } from '../utils/startAgentChat'
import { useToastStore } from '../stores/toast.store'
import { createLogger } from '../stores/logger.store'
import { useStartNewChat } from './useStartNewChat'
import { AGENT_SHORTCUTS_KEY } from './useAgents'
import {
  agentShortcutLabel,
  resolveShortcutAgent,
  startableAgent
} from '../utils/appShortcuts'

const log = createLogger('app-shortcuts')

type AgentRow = Awaited<ReturnType<typeof window.api.agents.list>>[number]

/**
 * ⌘N, ⇧⌘N and ⌘1–⌘9, sent by the application menu. Mounted once in the signed
 * in, onboarded shell, so the keys do nothing on the login or onboarding
 * screens. Subscribes once; everything it reads is read at key time.
 */
export function useAppShortcuts(): void {
  const queryClient = useQueryClient()
  const startNewChat = useStartNewChat()
  const startNewChatRef = useRef(startNewChat)
  startNewChatRef.current = startNewChat

  useEffect(() => {
    const agentsNow = (): Promise<AgentRow[]> =>
      queryClient.fetchQuery({
        queryKey: ['agents'],
        queryFn: () => window.api.agents.list()
      })

    const handle = async (shortcut: AppShortcut): Promise<void> => {
      // A menu accelerator fires under an open modal too. Leaving the view
      // would unmount the modal and throw away the form the user is editing.
      if (document.querySelector('[aria-modal="true"]')) return
      if (shortcut.kind === 'new-chat') {
        startNewChatRef.current()
        return
      }
      if (shortcut.kind === 'new-chat-same-agent') {
        const ui = useUIStore.getState()
        const chatId = useChatStore.getState().activeChatId
        const chat =
          ui.activeView === 'chat' && chatId
            ? await queryClient.fetchQuery({
                queryKey: ['chat', chatId],
                queryFn: () => window.api.chat.get(chatId)
              })
            : null
        const agentId = resolveShortcutAgent(
          {
            activeView: ui.activeView,
            chat: chat ?? null,
            activeExternalAgentId: ui.activeExternalAgentId,
            activeLocalAgentId: ui.activeLocalAgentId
          },
          await agentsNow()
        )
        if (agentId) startAgentChat(agentId)
        else startNewChatRef.current()
        return
      }
      const bindings = await queryClient.fetchQuery({
        queryKey: AGENT_SHORTCUTS_KEY,
        queryFn: () => window.api.agents.listShortcuts()
      })
      const binding = bindings.find((b) => b.slot === shortcut.slot)
      if (!binding) return
      const agents = await agentsNow()
      const agent = startableAgent(agents, binding.agentId)
      if (agent) {
        startAgentChat(agent.id)
        return
      }
      useToastStore
        .getState()
        .show(
          unavailableAgentMessage(
            agents,
            binding.agentId,
            `The agent for ${agentShortcutLabel(shortcut.slot)} is no longer available`
          )
        )
    }

    return window.api.app.onShortcut((shortcut) => {
      handle(shortcut).catch((err) => log.warn('shortcut failed', { shortcut, err: String(err) }))
    })
  }, [queryClient])
}
