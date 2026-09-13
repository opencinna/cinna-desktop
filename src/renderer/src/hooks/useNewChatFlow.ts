import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useCreateChat, useUpdateChat } from './useChat'
import { useChatStore } from '../stores/chat.store'
import { useAuthStore } from '../stores/auth.store'
import { useChatStream } from './useChatStream'
import { useAttachNotesAsFiles } from './useNotes'
import { useAddOnDemandMcp, useSetChatMcpProviders } from './useMcp'
import { useAddOnDemandAgent } from './useAgents'
import type { ChatModeData } from '../constants/chatModeColors'
import type {
  ComposerAttachment,
  MessageAttachment,
  PendingAttachment
} from '../../../shared/attachments'
import { deriveTitleFromMessage } from '../../../shared/chatTitle'
import { newChatRouter, routingOf, type ChatRouter } from '../../../shared/chatRouting'
import { pickDefaultModelId } from '../../../shared/modelDefaults'
import { unwrapIpcError } from '../utils/ipcError'

type ProviderData = Awaited<ReturnType<typeof window.api.providers.list>>[number]
type ModelData = Awaited<ReturnType<typeof window.api.providers.listModels>>[number]

export interface NewChatOptions {
  /** Optional entry-page lifetime/account guard, checked across asynchronous preparation. */
  isCurrent?: () => boolean
  message: string
  /**
   * The new-chat agent pick list (`pendingAgentIds`) — populated by the `[+]`
   * capability picker and the `@` popup. Feeds `newChatRouter` together with
   * the on-demand MCP picks: one agent alone is the chat's root (`direct`),
   * several agents are a chat the user routes by hand (`human`), and agents
   * mixed with MCP servers need the local model to conduct (`coordinator`).
   */
  agentIds: string[]
  mode: ChatModeData | null
  providerId: string | null
  providers: ProviderData[] | undefined
  allModels: ModelData[] | undefined
  mcpIds: Iterable<string>
  /**
   * On-demand MCPs the user `@-mentioned` on the new-chat screen before the
   * chat row existed. Flushed onto the freshly-created chat *before* the
   * first send so the stream loop's announce prefix picks them up.
   */
  onDemandMcpIds?: Iterable<string>
  /**
   * Attachments collected in the composer. May be a mix of already-uploaded
   * Cinna files (legacy / drag-and-drop into an active chat path) and
   * `pending` entries (paths held on disk). Pending entries are converted
   * to real {@link MessageAttachment}s post-chat-creation by
   * `resolvePendingAttachments`.
   */
  attachments?: ComposerAttachment[]
  /**
   * Notes selected via the composer's `?` mention popup. Materialized into
   * real `.md` attachments post-chat-creation under the destination's
   * scope, then merged with `attachments` before the first send.
   */
  noteIds?: string[]
}

export function resolveModel(
  mode: ChatModeData | null,
  providerId: string | null,
  providers: ProviderData[] | undefined,
  allModels: ModelData[] | undefined
): string | null {
  if (!providerId) return null
  const providerData = (providers ?? []).find((p) => p.id === providerId)
  const providerModels = (allModels ?? []).filter((m) => m.providerId === providerId)

  const modeModelValid =
    mode?.modelId && providerModels.some((m) => m.id === mode.modelId) ? mode.modelId : null
  if (modeModelValid) return modeModelValid

  const defaultValid =
    providerData?.defaultModelId && providerModels.some((m) => m.id === providerData.defaultModelId)
      ? providerData.defaultModelId
      : null
  // No explicit model: auto-pick a generally-available one. Skips Anthropic's
  // access-gated tiers (Fable/Mythos) that `models.list()` returns first but the
  // account may not be able to call — picking the raw newest would 404 at stream
  // time. The gated models remain selectable explicitly in the picker.
  return defaultValid ?? pickDefaultModelId(providerModels.map((m) => m.id))
}

export function useNewChatFlow(): {
  startNewChat: (opts: NewChatOptions) => Promise<void>
} {
  const queryClient = useQueryClient()
  const createChat = useCreateChat()
  const updateChat = useUpdateChat()
  const { startRun } = useChatStream()
  const setSendError = useChatStore((s) => s.setSendError)
  const { mutateAsync: attachNotesAsync } = useAttachNotesAsFiles()
  // Go through the mutations rather than `window.api.chat.*` directly: they
  // own the cache invalidation for the chips' query keys and the failure
  // logging, so the composer strip can't render a stale set.
  const { mutateAsync: setChatMcpAsync } = useSetChatMcpProviders()
  const { mutateAsync: addOnDemandMcpAsync } = useAddOnDemandMcp()
  const { mutateAsync: addOnDemandAgentAsync } = useAddOnDemandAgent()

  /**
   * Ingest every `pending` attachment now that the chat row exists and
   * the destination is known. `id` on a pending attachment carries the
   * absolute path; we hand the list to `files.ingestPaths` with the
   * right scope and stitch the returned real attachments back into the
   * original ordering. Throws on ingest failure so the caller can clean
   * up the chat row instead of leaving an orphan with no message.
   */
  const resolvePendingAttachments = useCallback(
    async (
      chatId: string,
      scope: 'cinna' | 'local',
      attachments: ComposerAttachment[] | undefined
    ): Promise<MessageAttachment[]> => {
      if (!attachments || attachments.length === 0) return []
      const pending = attachments.filter(
        (a): a is PendingAttachment => a.source === 'pending'
      )
      const persisted = attachments.filter(
        (a): a is MessageAttachment => a.source !== 'pending'
      )
      if (pending.length === 0) return persisted
      const result = await window.api.files.ingestPaths({
        scope,
        chatId,
        paths: pending.map((a) => a.id)
      })
      if (!result.success) {
        throw new Error(result.error || 'File ingest failed')
      }
      const ingestedByPath = new Map<string, MessageAttachment>()
      pending.forEach((p, i) => {
        const ingested = result.files[i]
        if (ingested) ingestedByPath.set(p.id, ingested)
      })
      // Preserve the user's drop order. `pending` entries get swapped
      // for their real counterparts; `persisted` entries pass through.
      const out: MessageAttachment[] = []
      for (const a of attachments) {
        if (a.source === 'pending') {
          const ing = ingestedByPath.get(a.id)
          if (ing) out.push(ing)
        } else {
          out.push(a)
        }
      }
      return out
    },
    []
  )

  /**
   * Materialize the new-chat composer's selected notes into real `.md`
   * {@link MessageAttachment}s by routing them through the shared attach
   * mutation under the destination's scope. Returns an empty list when no
   * notes were staged so callers can unconditionally concat.
   */
  const ingestPendingNotes = useCallback(
    async (
      chatId: string,
      scope: 'cinna' | 'local',
      noteIds: string[] | undefined
    ): Promise<MessageAttachment[]> => {
      if (!noteIds || noteIds.length === 0) return []
      return attachNotesAsync({ chatId, scope, noteIds })
    },
    [attachNotesAsync]
  )

  const startNewChat = useCallback(
    async (opts: NewChatOptions): Promise<void> => {
      const {
        message,
        agentIds,
        mode,
        providerId,
        providers,
        allModels,
        mcpIds,
        onDemandMcpIds,
        attachments,
        noteIds
      } = opts
      const title = deriveTitleFromMessage(message)
      const onDemandMcpSnapshot = onDemandMcpIds ? Array.from(onDemandMcpIds) : []
      const agentSnapshot = agentIds ?? []
      // The one decision, taken once, in the shared helper both processes read.
      const router = newChatRouter({
        agentIds: agentSnapshot,
        mcpIds: onDemandMcpSnapshot
      })
      // A `direct` chat with an agent is the only shape that binds a root; a
      // `human` chat's agents are all attached, none of them the root.
      const rootAgentId = router === 'direct' ? (agentSnapshot[0] ?? null) : null
      // Asked of the helper, not re-derived: `router !== 'coordinator'` is not
      // the same question. A chat with **no agent at all** is `direct` — to the
      // local model — and its files belong in the local store, which is where
      // they have always gone. Sending them to the Cinna backend instead
      // breaks every attachment in the commonest chat in the app, and breaks it
      // by deleting the chat row on the way out.
      const scope = routingOf({ router, agentId: rootAgentId }).attachmentTarget

      const originatingUserId = useAuthStore.getState().currentUser?.id
      const isSameAccount = (): boolean => useAuthStore.getState().currentUser?.id === originatingUserId
      const assertCurrent = (): void => {
        if (opts.isCurrent && (!isSameAccount() || !opts.isCurrent())) {
          throw new Error('The build session or account changed before sending.')
        }
      }
      let chatId: string | null = null
      try {
        assertCurrent()
        const chat = await createChat.mutateAsync(opts.isCurrent ? { select: false } : undefined)
        chatId = chat.id
        assertCurrent()

        // Flush the on-demand buffers before the first send so the stream loop
        // reads both at setup time (and emits the one-shot announce prefix).
        // The MCP buffer is flushed for every router — empty in the `direct`
        // and `human` cases, and kept for symmetry with the moment the user
        // later hands the chat to the model.
        for (const mcpId of onDemandMcpSnapshot) {
          await addOnDemandMcpAsync({ chatId: chat.id, mcpProviderId: mcpId })
          assertCurrent()
        }
        for (const agentId of agentSnapshot) {
          if (agentId !== rootAgentId) {
            await addOnDemandAgentAsync({ chatId: chat.id, agentId })
            assertCurrent()
          }
        }

        const updates: {
          title: string
          providerId?: string
          modelId?: string
          modeId?: string
          agentId?: string
          router: ChatRouter
        } = { title, router }
        if (rootAgentId) updates.agentId = rootAgentId
        // Only a chat the model answers needs one resolved. A `direct` chat
        // with an agent, and every `human` chat, talk straight to their agents
        // — that is what makes a `human` chat work with no LLM configured.
        if (router === 'coordinator' || !rootAgentId) {
          const resolvedModelId = resolveModel(mode, providerId, providers, allModels)
          if (providerId && resolvedModelId) {
            updates.providerId = providerId
            updates.modelId = resolvedModelId
          }
        }
        if (mode) updates.modeId = mode.id

        await updateChat.mutateAsync({ chatId: chat.id, updates })
        assertCurrent()

        // Baseline MCPs = the chat mode's list, verbatim. Empty means the
        // chat starts with no baseline servers (the row has none yet, so
        // there's nothing to clear) — on-demand picks above are separate.
        const mcpSnapshot = Array.from(mcpIds)
        if (mcpSnapshot.length > 0) {
          await setChatMcpAsync({ chatId: chat.id, mcpProviderIds: mcpSnapshot })
          assertCurrent()
        }

        // Remote and local agents both ingest as Cinna-scoped: the cinna upload
        // service is the only A2A-friendly backend, and an agent that runs in a
        // folder has no file path of its own. Only the model's own chat reads
        // from the local store.
        const resolved = await resolvePendingAttachments(chat.id, scope, attachments)
        assertCurrent()
        const noteAttachments = await ingestPendingNotes(chat.id, scope, noteIds)
        assertCurrent()

        useChatStore.getState().setActiveChatId(chat.id)
        // A `human` chat's first message goes to the first agent the user
        // picked — the order they picked them in is the only signal there is,
        // and main applies the same rule if this one is ever absent.
        const target =
          router === 'coordinator'
            ? ({ kind: 'model' } as const)
            : agentSnapshot[0]
              ? ({ kind: 'agent', agentId: agentSnapshot[0] } as const)
              : ({ kind: 'model' } as const)
        startRun(chat.id, message, {
          attachments: [...resolved, ...noteAttachments],
          target
        })
      } catch (err) {
        // Surface the error so the user knows the send didn't go through
        // — without this, a failed ingest leaves an empty chat row and a
        // cleared composer with no feedback.
        if (isSameAccount() && (!opts.isCurrent || opts.isCurrent())) {
          setSendError(unwrapIpcError(err, 'Could not start new chat'))
        }
        // Best-effort cleanup of the orphan chat. The user can retry
        // without dragging accumulated empty rows along.
        // Leaving the entry page cancels the send, but its new, empty chat
        // still needs cleanup. The delete IPC is scoped to the active account,
        // so account identity must be checked separately from page lifetime.
        if (chatId && isSameAccount()) {
          try {
            const deleted = await window.api.chat.delete(chatId)
            // Creation may already have refreshed the sidebar with this empty
            // row. Delete is a soft delete, so both lists need a fresh read.
            // A late completion must not invalidate the next account's cache.
            if (deleted.success && isSameAccount()) {
              void queryClient.invalidateQueries({ queryKey: ['chats'] })
              void queryClient.invalidateQueries({ queryKey: ['trash'] })
            }
          } catch {
            // Swallow — the chat row exists in the DB but at worst it's
            // an empty list entry the user can manually delete.
          }
        }
      }
    },
    [
      queryClient,
      createChat,
      updateChat,
      startRun,
      resolvePendingAttachments,
      ingestPendingNotes,
      setSendError,
      setChatMcpAsync,
      addOnDemandMcpAsync,
      addOnDemandAgentAsync
    ]
  )

  return { startNewChat }
}
