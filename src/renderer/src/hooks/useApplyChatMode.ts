import { useCallback } from 'react'
import { useUpdateChat } from './useChat'
import { useProviders } from './useProviders'
import { useModels } from './useModels'
import { useSetChatMcpProviders } from './useMcp'
import { resolveModel } from './useNewChatFlow'
import type { ChatModeData } from '../constants/chatModeColors'

/**
 * Apply a chat mode to an **existing** chat — the active-chat mirror of
 * {@link useNewChatFlow.startNewChat}, which owns the same rules for a chat
 * that doesn't exist yet. Lives in a hook (not the composer/view) so the
 * mode-application rules sit in one layer and stay testable.
 *
 * Passing `null` deselects the mode: `modeId` is cleared and the chat falls
 * back to the manual `ChatControls` (model picker + MCP toggles). The baseline
 * MCP set is left alone in that case — the user's existing tools shouldn't
 * vanish just because the preset was detached.
 */
export function useApplyChatMode(): (
  chatId: string,
  mode: ChatModeData | null
) => Promise<void> {
  const updateChat = useUpdateChat()
  const setChatMcp = useSetChatMcpProviders()
  const { data: providers } = useProviders()
  const { data: allModels } = useModels()

  return useCallback(
    async (chatId: string, mode: ChatModeData | null): Promise<void> => {
      if (!mode) {
        await updateChat.mutateAsync({ chatId, updates: { modeId: null } })
        return
      }

      const resolvedProviderId = mode.providerId ?? null
      const resolvedModelId = resolveModel(mode, resolvedProviderId, providers, allModels)

      const updates: { modeId: string; providerId?: string; modelId?: string } = {
        modeId: mode.id
      }
      if (resolvedProviderId && resolvedModelId) {
        updates.providerId = resolvedProviderId
        updates.modelId = resolvedModelId
      }
      await updateChat.mutateAsync({ chatId, updates })

      // The mode's list replaces the chat's baseline verbatim — an empty list
      // clears it rather than re-attaching every enabled server. On-demand
      // engagements live in their own table and survive the switch.
      // Fire-and-forget on purpose: the menu's select handlers don't await
      // this, so a rejected `mutateAsync` would surface as an unhandled
      // rejection. The mutation's `onError` logs the failure instead.
      setChatMcp.mutate({ chatId, mcpProviderIds: mode.mcpProviderIds ?? [] })
    },
    [updateChat, setChatMcp, providers, allModels]
  )
}
