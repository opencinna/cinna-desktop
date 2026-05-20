import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatDetail } from './useChat'
import { useAgents } from './useAgents'
import {
  useSetActiveAgent,
  useRewriteMessage,
  useBuildCatchup,
  useDisableSmartAssist
} from './useMultiAgent'
import { useChatStream } from './useChatStream'
import { useChatModes } from './useChatModes'
import { findAgentMention } from '../utils/agentSlug'
import type { MessageAttachment } from '../../../shared/attachments'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]
type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>
type CachedAgents = Awaited<ReturnType<typeof window.api.agents.list>>

export interface PendingRewrite {
  targetAgentId: string
  targetAgentName: string
  originalText: string
  /** Attachments captured at submit time — replayed when the rewrite is confirmed or sent raw. */
  attachments?: MessageAttachment[]
}

export type RewriteErrorCode =
  | 'no_rewrite_provider'
  | 'rewrite_empty'
  | 'rewrite_failed'
  | 'unknown'

export type SubmitResult =
  | { kind: 'noop' }
  | { kind: 'sent' }
  | { kind: 'rewrite-pending'; rewrittenText: string; pending: PendingRewrite }
  | {
      kind: 'rewrite-failed'
      code: RewriteErrorCode
      detail: string
      pending: PendingRewrite
    }

export interface ComposerView {
  /** The agent currently in the routing chip ("Talking to <X>"). Null = LLM root. */
  activeAgent: AgentData | null
  /** The chat's bound root agent (null = LLM chat). */
  rootAgent: AgentData | null
  /** Display label for "Switch back to <X>". */
  rootLabel: string
}

/**
 * Single source of truth for chat-composer routing. ChatInput calls
 * `submit()` (and its peers) and the hook decides everything: parse
 * mentions, resolve the target agent, switch active agent if needed, build
 * catch-up packet, run Smart Rewrite, dispatch on the right channel.
 *
 * Critically, every decision reads state *fresh* from the React Query cache
 * at the moment of submission — there is no prop-derived closure that could
 * go stale between a popup-select and the user hitting Enter.
 */
export function useChatComposer(chatId: string | null): ComposerView & {
  switchActiveAgent: (agentId: string | null) => Promise<void>
  submit: (input: string, attachments?: MessageAttachment[]) => Promise<SubmitResult>
  confirmRewrite: (text: string, pending: PendingRewrite) => Promise<void>
  sendRaw: (pending: PendingRewrite) => Promise<void>
  disableSmartAssist: () => Promise<void>
} {
  const queryClient = useQueryClient()
  const setActiveAgentMutation = useSetActiveAgent()
  const rewriteMutation = useRewriteMessage()
  const buildCatchupMutation = useBuildCatchup()
  const disableSmartAssistMutation = useDisableSmartAssist()
  const { startLlm, startAgent } = useChatStream()
  const { data: chatModes } = useChatModes()

  // Reactive subscriptions for the chip / switch-back label — these
  // re-render the composer when the cache changes.
  const { data: chat } = useChatDetail(chatId)
  const { data: agents } = useAgents()

  type ChatSnapshot = NonNullable<CachedChat>

  // Fetch a fresh snapshot at action time. `getQueryData` is synchronous and
  // hits the cache directly — guaranteed to reflect any optimistic update
  // applied during this tick.
  const readSnapshot = useCallback((): {
    chat: ChatSnapshot
    agents: AgentData[]
  } | null => {
    if (!chatId) return null
    const c = queryClient.getQueryData<CachedChat>(['chat', chatId])
    if (!c) return null
    const a = queryClient.getQueryData<CachedAgents>(['agents']) ?? []
    return { chat: c, agents: a }
  }, [chatId, queryClient])

  const resolveActive = useCallback(
    (
      c: ChatSnapshot,
      a: AgentData[]
    ): { activeAgent: AgentData | null; rootAgent: AgentData | null } => {
      const rootAgent = c.agentId ? a.find((x) => x.id === c.agentId) ?? null : null
      const activeAgent = c.activeAgentId
        ? a.find((x) => x.id === c.activeAgentId) ?? null
        : rootAgent
      return { activeAgent, rootAgent }
    },
    []
  )

  const computeNeedsRewrite = useCallback(
    (c: ChatSnapshot, targetAgentId: string, rootAgent: AgentData | null): boolean => {
      if (c.smartAssistDisabled) return false
      const hasPriorHistory =
        c.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length > 0
      if (!hasPriorHistory) return false
      const participating = new Set<string>()
      if (rootAgent) participating.add(rootAgent.id)
      for (const msg of c.messages) {
        if (msg.addressedAgentId) participating.add(msg.addressedAgentId)
        if (msg.sourceAgentId) participating.add(msg.sourceAgentId)
      }
      return !participating.has(targetAgentId)
    },
    []
  )

  /** Send a message to a specific agent, building catch-up + flipping active first. */
  const dispatchToAgent = useCallback(
    async (
      agentId: string,
      text: string,
      rewrittenText: string | null,
      originalText: string | null,
      attachments?: MessageAttachment[]
    ): Promise<void> => {
      if (!chatId) return
      let catchupPacket = ''
      try {
        const result = await buildCatchupMutation.mutateAsync({
          chatId,
          targetAgentId: agentId
        })
        catchupPacket = result.packet
      } catch {
        catchupPacket = ''
      }
      // Re-read snapshot post-await — the cache may have moved.
      const snap = readSnapshot()
      if (snap && snap.chat.activeAgentId !== agentId) {
        await setActiveAgentMutation.mutateAsync({ chatId, agentId })
      }
      startAgent(agentId, chatId, text, {
        rewrittenText,
        originalText,
        catchupPacket,
        attachments
      })
    },
    [chatId, buildCatchupMutation, readSnapshot, setActiveAgentMutation, startAgent]
  )

  /** Send a message via the chat's root channel (bound agent or LLM mode). */
  const dispatchToRoot = useCallback(
    async (text: string, attachments?: MessageAttachment[]): Promise<void> => {
      if (!chatId) return
      const snap = readSnapshot()
      if (!snap) return
      const { rootAgent } = resolveActive(snap.chat, snap.agents)
      if (rootAgent) {
        await dispatchToAgent(rootAgent.id, text, null, null, attachments)
        return
      }
      // LLM root — flip active to null and start the LLM channel. Attachments
      // forward through so the adapter can translate them into provider-native
      // media blocks; the streaming service drops anything the active model
      // doesn't declare support for.
      if (snap.chat.activeAgentId !== null) {
        await setActiveAgentMutation.mutateAsync({ chatId, agentId: null })
      }
      startLlm(chatId, text, { attachments })
    },
    [chatId, readSnapshot, resolveActive, dispatchToAgent, setActiveAgentMutation, startLlm]
  )

  const switchActiveAgent = useCallback(
    async (agentId: string | null): Promise<void> => {
      if (!chatId) return
      await setActiveAgentMutation.mutateAsync({ chatId, agentId })
    },
    [chatId, setActiveAgentMutation]
  )

  /** The composer's single entry point. ChatInput calls this on Enter. */
  const submit = useCallback(
    async (input: string, attachments?: MessageAttachment[]): Promise<SubmitResult> => {
      const trimmed = input.trim()
      if (!trimmed) return { kind: 'noop' }
      const snap = readSnapshot()
      if (!snap) return { kind: 'noop' }
      const { activeAgent, rootAgent } = resolveActive(snap.chat, snap.agents)

      // Optional power-user routing: `@slug` at message start overrides the
      // active agent for this single send.
      const mention = findAgentMention(trimmed, snap.agents)
      const targetAgent = mention?.agent ?? activeAgent
      const payload = mention ? mention.remainder.trim() || trimmed : trimmed

      // Routes to the root channel when no target or target is the root agent.
      if (!targetAgent || (rootAgent && targetAgent.id === rootAgent.id)) {
        await dispatchToRoot(payload, attachments)
        return { kind: 'sent' }
      }

      const needsRewrite = computeNeedsRewrite(snap.chat, targetAgent.id, rootAgent)
      if (!needsRewrite) {
        await dispatchToAgent(targetAgent.id, payload, null, null, attachments)
        return { kind: 'sent' }
      }

      const pending: PendingRewrite = {
        targetAgentId: targetAgent.id,
        targetAgentName: targetAgent.name,
        originalText: payload,
        attachments
      }

      // Rewrite path — return so ChatInput can show the confirm UI.
      try {
        const { rewrittenText } = await rewriteMutation.mutateAsync({
          chatId: snap.chat.id,
          targetAgentId: targetAgent.id,
          userText: payload
        })
        // `null` = the rewrite LLM judged the message already self-contained
        // (it emitted the KEEP_ORIGINAL sentinel). Dispatch the original text
        // straight through, skipping the double-send confirmation.
        if (rewrittenText === null) {
          await dispatchToAgent(targetAgent.id, payload, null, null, attachments)
          return { kind: 'sent' }
        }
        return { kind: 'rewrite-pending', rewrittenText, pending }
      } catch (err) {
        // Domain errors crossing IPC carry their `code` as an own property.
        const e = err as Error & { code?: string }
        const knownCodes: RewriteErrorCode[] = [
          'no_rewrite_provider',
          'rewrite_empty',
          'rewrite_failed'
        ]
        const code: RewriteErrorCode = knownCodes.includes(
          e.code as RewriteErrorCode
        )
          ? (e.code as RewriteErrorCode)
          : 'unknown'
        // Strip IPC plumbing prefix from the raw message — used as the
        // "technical details" line under the friendly copy.
        const rawDetail = e?.message ?? 'Smart Rewrite failed'
        const detail = rawDetail
          .replace(/^Error invoking remote method '[^']+':\s*/, '')
          .replace(/^[A-Z][A-Za-z]*Error:\s*/, '')
        return { kind: 'rewrite-failed', code, detail, pending }
      }
    },
    [
      readSnapshot,
      resolveActive,
      computeNeedsRewrite,
      dispatchToRoot,
      dispatchToAgent,
      rewriteMutation
    ]
  )

  /** After the user confirms the rewritten text (second Enter). */
  const confirmRewrite = useCallback(
    async (text: string, pending: PendingRewrite): Promise<void> => {
      await dispatchToAgent(
        pending.targetAgentId,
        text,
        text,
        pending.originalText,
        pending.attachments
      )
    },
    [dispatchToAgent]
  )

  /** Send the user's original text as-is, skipping the failed rewrite. */
  const sendRaw = useCallback(
    async (pending: PendingRewrite): Promise<void> => {
      await dispatchToAgent(
        pending.targetAgentId,
        pending.originalText,
        null,
        null,
        pending.attachments
      )
    },
    [dispatchToAgent]
  )

  const disableSmartAssist = useCallback(async (): Promise<void> => {
    if (!chatId) return
    await disableSmartAssistMutation.mutateAsync(chatId)
  }, [chatId, disableSmartAssistMutation])

  const view: ComposerView = useMemo(() => {
    if (!chat) {
      return { activeAgent: null, rootAgent: null, rootLabel: 'model' }
    }
    const agentList = agents ?? []
    const { activeAgent, rootAgent } = resolveActive(chat, agentList)
    const activeChatMode = chat.modeId
      ? (chatModes ?? []).find((m) => m.id === chat.modeId) ?? null
      : null
    const rootLabel = rootAgent?.name ?? activeChatMode?.name ?? 'model'
    return { activeAgent, rootAgent, rootLabel }
  }, [chat, agents, chatModes, resolveActive])

  return {
    ...view,
    switchActiveAgent,
    submit,
    confirmRewrite,
    sendRaw,
    disableSmartAssist
  }
}
