import { useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createLogger } from '../stores/logger.store'
import { useSetChatRouter } from './useChat'
import { useChatStore } from '../stores/chat.store'
import { unwrapIpcError } from '../utils/ipcError'
import { useAppSettings } from './useAppSettings'
import { routerOf } from '../../../shared/chatRouting'

const onDemandLog = createLogger('on-demand-agent')

type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>

export type RemoteSyncStatus = { error?: 'reauth_required' | 'sync_failed' }

export const REMOTE_SYNC_STATUS_KEY = ['agents', 'remote-sync-status'] as const

export function useAgents() {
  const queryClient = useQueryClient()

  // Invalidate agents query when main process completes a remote sync, and
  // mirror any error code into the shared sync-status cache so the UI can
  // surface a re-auth banner without threading state through props.
  useEffect(() => {
    return window.api.agents.onRemoteSyncComplete((payload) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.setQueryData<RemoteSyncStatus>(REMOTE_SYNC_STATUS_KEY, {
        error: payload.error
      })
    })
  }, [queryClient])

  // An agent's readiness changed in main (a background check, or one the user
  // asked for). The list carries it, so re-read the list — once. Every mounted
  // `useAgents` hears the same push, and a plain invalidate cancels the fetch
  // the previous listener just started and starts its own: one push, one
  // `agent:list` per mounted hook. `cancelRefetch: false` joins the fetch
  // already running instead.
  useEffect(() => {
    return window.api.agents.onReadinessChanged(() => {
      queryClient.invalidateQueries({ queryKey: ['agents'] }, { cancelRefetch: false })
    })
  }, [queryClient])

  return useQuery({
    queryKey: ['agents'],
    queryFn: () => window.api.agents.list()
  })
}

/**
 * Ask one agent's driver again whether it can take a turn — "Check again" in
 * the composer, and the Settings card's Test.
 *
 * Re-reads the list when it settles, whatever the answer: the push fires only
 * when an answer *changed*, and a check the user asked for should visibly
 * settle even when it did not.
 */
export function useCheckAgentReadiness() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentId: string) => window.api.agents.checkReadiness(agentId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}

export function useRemoteSyncStatus(): RemoteSyncStatus {
  return (
    useQuery<RemoteSyncStatus>({
      queryKey: REMOTE_SYNC_STATUS_KEY,
      queryFn: () => ({}),
      staleTime: Infinity
    }).data ?? {}
  )
}

export function useUpsertAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      id?: string
      name: string
      description?: string
      protocol: string
      cardUrl?: string
      endpointUrl?: string
      protocolInterfaceUrl?: string
      protocolInterfaceVersion?: string
      accessToken?: string
      cardData?: Record<string, unknown>
      skills?: Array<{ id: string; name: string; description?: string }>
      enabled?: boolean
    }) => window.api.agents.upsert(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}

type AgentRow = Awaited<ReturnType<typeof window.api.agents.list>>[number]

export function useSetAgentEnabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ agentId, enabled }: { agentId: string; enabled: boolean }) => {
      const res = await window.api.agents.setEnabled(agentId, enabled)
      if (!res.success) throw new Error(res.error ?? 'Failed to update agent')
      return res
    },
    // Optimistically flip the cached agent so the toggle moves immediately;
    // roll back if the IPC fails.
    onMutate: async ({ agentId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['agents'] })
      const previous = queryClient.getQueryData<AgentRow[]>(['agents'])
      if (previous) {
        queryClient.setQueryData<AgentRow[]>(
          ['agents'],
          previous.map((a) => (a.id === agentId ? { ...a, enabled } : a))
        )
      }
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['agents'], context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}

export function useDeleteAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (agentId: string) => {
      const result = await window.api.agents.delete(agentId)
      if (!result.success) throw new Error(result.error ?? 'Could not delete agent.')
      return result
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}

export function useDeleteRemoteAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentId: string) => window.api.agents.deleteRemote(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['catalog'] })
    }
  })
}

export function useFetchAgentCard() {
  return useMutation({
    mutationFn: (data: { cardUrl: string; accessToken?: string }) =>
      window.api.agents.fetchCard(data)
  })
}

export function useTestAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentId: string) => window.api.agents.test(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}

/**
 * On-demand agents the user has `@-mentioned` into the current chat — the
 * orchestrated-mode tool set. Mirrors [[useChatOnDemandMcps]]; lives in its
 * own cache key because its lifecycle differs from the bound/active agent.
 */
export function useChatOnDemandAgents(chatId: string | null) {
  return useQuery({
    queryKey: ['chat-on-demand-agent', chatId],
    queryFn: () =>
      chatId ? window.api.chat.listOnDemandAgents(chatId) : Promise.resolve([]),
    enabled: !!chatId
  })
}

export function useAddOnDemandAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ chatId, agentId }: { chatId: string; agentId: string }) =>
      window.api.chat.addOnDemandAgent(chatId, agentId),
    onSuccess: (_data, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: ['chat-on-demand-agent', chatId] })
    },
    onError: (error, { chatId, agentId }) => {
      onDemandLog.error('add failed', {
        chatId,
        agentId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

/**
 * The in-chat `@`-agent gesture: bring another agent into the chat.
 *
 * What that means depends on who is already in it, and the difference is the
 * point of phase 4:
 *
 *  - **Re-picking the sole bound agent of a `direct` chat** is a no-op. It is
 *    already the conversation partner.
 *  - **A `direct` chat with an agent** becomes `human`: two agents, and the
 *    user addresses one per message. **No model is involved**, so a user with
 *    no LLM provider configured can do this — which is exactly what the old
 *    one-way promotion to orchestrated could not offer.
 *  - **A `direct` chat with no agent** — a plain LLM chat — becomes
 *    `coordinator`: the model is the counterparty the user has been talking to,
 *    and an agent arriving is a tool it can call, not a replacement for it.
 *    This is the one path that can still be refused for lack of a model, and
 *    that refusal is now about the model that is already answering.
 *  - **A chat already on `human` or `coordinator`** just gains the agent.
 *
 * The switch is optimistic (see `useSetChatRouter`), so a fast pick-then-Enter
 * cannot route the send to the old root. Any failure surfaces via the chat
 * send-error banner.
 */
export function useAttachAgentToChat(chatId: string | null): (agentId: string) => Promise<void> {
  const queryClient = useQueryClient()
  const setRouter = useSetChatRouter()
  const { data: settings } = useAppSettings()
  const addAgent = useAddOnDemandAgent()
  const setSendError = useChatStore((s) => s.setSendError)
  return useCallback(
    async (agentId: string): Promise<void> => {
      if (!chatId) return
      const chat = queryClient.getQueryData<CachedChat>(['chat', chatId])
      const router = chat ? routerOf(chat) : 'direct'
      if (router === 'direct' && chat?.agentId === agentId) return
      try {
        if (router === 'direct') {
          await setRouter.mutateAsync({
            chatId,
            router: chat?.agentId ? (settings?.defaultMultiAgentRouting ?? 'human') : 'coordinator'
          })
        }
        await addAgent.mutateAsync({ chatId, agentId })
      } catch (err) {
        setSendError(unwrapIpcError(err, 'Could not add agent'))
      }
    },
    [chatId, queryClient, setRouter, addAgent, setSendError, settings?.defaultMultiAgentRouting]
  )
}

export function useRemoveOnDemandAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ chatId, agentId }: { chatId: string; agentId: string }) =>
      window.api.chat.removeOnDemandAgent(chatId, agentId),
    onSuccess: (_data, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: ['chat-on-demand-agent', chatId] })
    },
    onError: (error, { chatId, agentId }) => {
      onDemandLog.error('remove failed', {
        chatId,
        agentId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

/**
 * Apply the latest bundle revision to an installed agent — the in-app update
 * action shared by the Catalog card and the Agents list. Hits
 * `POST /external/agents/{installId}/apply-update` via `agents.applyBundleUpdate`
 * (installId = the catalog entry's `userInstallId` or a synced agent's
 * `remoteTargetId`). Rejects with a `code`-tagged Error so the caller can
 * branch on `reauth_required`.
 *
 * On success: re-fetch `['catalog']` (so the install's `pendingUpdate` flips)
 * and kick a remote sync to pull the fresh `bundle_version`. We deliberately do
 * NOT invalidate `['agents']` here — the sync's `agents:remote-sync-complete`
 * broadcast invalidates it once the new metadata has actually landed (see
 * [[useAgents]] / `useRefreshCatalogState`). Invalidating it directly would
 * refetch the local table *before* the sync writes, briefly re-showing the
 * stale "Update available" state until the broadcast corrects it.
 */
export function useApplyBundleUpdate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (installId: string) => {
      const res = await window.api.agents.applyBundleUpdate(installId)
      if (!res.success) {
        const err = new Error(res.error ?? 'Update failed') as Error & { code?: string }
        err.code = res.code
        throw err
      }
      return res
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog'] })
      void window.api.agents.syncRemote()
    }
  })
}

export function useSyncRemoteAgents() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.agents.syncRemote(),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      if (result.success) {
        queryClient.setQueryData<RemoteSyncStatus>(REMOTE_SYNC_STATUS_KEY, {})
        return
      }
      const error =
        result.code === 'reauth_required' ? 'reauth_required' : 'sync_failed'
      queryClient.setQueryData<RemoteSyncStatus>(REMOTE_SYNC_STATUS_KEY, { error })
    }
  })
}
