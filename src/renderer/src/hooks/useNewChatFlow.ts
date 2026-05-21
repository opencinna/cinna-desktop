import { useCallback } from 'react'
import { useCreateChat, useUpdateChat } from './useChat'
import { useChatStore } from '../stores/chat.store'
import { useChatStream } from './useChatStream'
import { useAttachNotesAsFiles } from './useNotes'
import type { ChatModeData } from '../constants/chatModeColors'
import type {
  ComposerAttachment,
  MessageAttachment,
  PendingAttachment
} from '../../../shared/attachments'
import { deriveTitleFromMessage } from '../../../shared/chatTitle'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]
type ProviderData = Awaited<ReturnType<typeof window.api.providers.list>>[number]
type ModelData = Awaited<ReturnType<typeof window.api.providers.listModels>>[number]

export interface NewChatOptions {
  message: string
  agent: AgentData | null
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
  return defaultValid ?? providerModels[0]?.id ?? null
}

export function useNewChatFlow(): {
  startNewChat: (opts: NewChatOptions) => Promise<void>
} {
  const createChat = useCreateChat()
  const updateChat = useUpdateChat()
  const { startLlm, startAgent } = useChatStream()
  const setSendError = useChatStore((s) => s.setSendError)
  const { mutateAsync: attachNotesAsync } = useAttachNotesAsFiles()

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
        agent,
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

      let chatId: string | null = null
      try {
        const chat = await createChat.mutateAsync()
        chatId = chat.id

        // Flush the new-chat MCP buffer before either channel kicks off. The
        // LLM stream loop reads `chat_on_demand_mcps` at setup time, so the
        // rows must exist by the moment `startLlm` fires. For agent-bound
        // chats we still persist (MCPs are LLM-only at send time, but the
        // user may switch to the LLM root later via multi-agent routing).
        const onDemandSnapshot = onDemandMcpIds ? Array.from(onDemandMcpIds) : []
        for (const mcpId of onDemandSnapshot) {
          await window.api.chat.addOnDemandMcp(chat.id, mcpId)
        }

        if (agent) {
          await updateChat.mutateAsync({
            chatId: chat.id,
            updates: { title, agentId: agent.id }
          })
          // Remote and local agents both ingest as Cinna-scoped today —
          // the cinna upload service is the only A2A-friendly backend,
          // and a local-A2A agent has no file path of its own.
          const resolved = await resolvePendingAttachments(chat.id, 'cinna', attachments)
          const noteAttachments = await ingestPendingNotes(chat.id, 'cinna', noteIds)
          useChatStore.getState().setActiveChatId(chat.id)
          startAgent(agent.id, chat.id, message, {
            attachments: [...resolved, ...noteAttachments]
          })
          return
        }

        const resolvedModelId = resolveModel(mode, providerId, providers, allModels)
        const updates: {
          title: string
          providerId?: string
          modelId?: string
          modeId?: string
        } = { title }
        if (providerId && resolvedModelId) {
          updates.providerId = providerId
          updates.modelId = resolvedModelId
        }
        if (mode) updates.modeId = mode.id

        await updateChat.mutateAsync({ chatId: chat.id, updates })

        const mcpSnapshot = Array.from(mcpIds)
        if (mcpSnapshot.length > 0) {
          await window.api.chat.setMcpProviders(chat.id, mcpSnapshot)
        }

        // LLM destination: ingest pending into the local store under the
        // freshly-created chat.
        const resolved = await resolvePendingAttachments(chat.id, 'local', attachments)
        const noteAttachments = await ingestPendingNotes(chat.id, 'local', noteIds)

        useChatStore.getState().setActiveChatId(chat.id)
        startLlm(chat.id, message, { attachments: [...resolved, ...noteAttachments] })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Surface the error so the user knows the send didn't go through
        // — without this, a failed ingest leaves an empty chat row and a
        // cleared composer with no feedback.
        setSendError(msg || 'Could not start new chat')
        // Best-effort cleanup of the orphan chat. The user can retry
        // without dragging accumulated empty rows along.
        if (chatId) {
          try {
            await window.api.chat.delete(chatId)
          } catch {
            // Swallow — the chat row exists in the DB but at worst it's
            // an empty list entry the user can manually delete.
          }
        }
      }
    },
    [
      createChat,
      updateChat,
      startAgent,
      startLlm,
      resolvePendingAttachments,
      ingestPendingNotes,
      setSendError
    ]
  )

  return { startNewChat }
}
