import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'
import { useEffect } from 'react'
import { type ChatRouter } from '../../../shared/chatRouting'

export function useChatList() {
  const queryClient = useQueryClient()

  // Subscribe to main-process background chat-title autogen completions so
  // the sidebar and the active chat header pick up the new title instantly,
  // without waiting for the next manual refetch.
  useEffect(() => {
    return window.api.chat.onTitleUpdated(({ chatId }) => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
    })
  }, [queryClient])

  return useQuery({
    queryKey: ['chats'],
    queryFn: () => window.api.chat.list(),
    // Main owns runs even when their chat is not selected (or they start in
    // the background). Keep every sidebar row's interrupt action current.
    refetchInterval: 1_000
  })
}

/**
 * The sidebar tooltips' data, keyed by chat id. Under the `['chats']` prefix so
 * every invalidation of the list refreshes it too, and deliberately without a
 * `refetchInterval`: main scans the messages table to build it.
 */
export function useChatSummaries() {
  return useQuery({
    queryKey: ['chats', 'summaries'],
    queryFn: () => window.api.chat.listSummaries()
  })
}

export function useChatDetail(chatId: string | null) {
  const hasAttachedStream = useChatStore((state) =>
    state.activeChatId === chatId && state.isStreaming)
  return useQuery({
    queryKey: ['chat', chatId],
    queryFn: () => (chatId ? window.api.chat.get(chatId) : null),
    enabled: !!chatId,
    // A detached or replay-overflow view reads saved output until main closes
    // the run. A full live projection arrives through useLiveRunWatch.
    refetchInterval: (query) => !hasAttachedStream && query.state.data?.activeRunId ? 1_000 : false
  })
}

export function useCreateChat() {
  const queryClient = useQueryClient()
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)

  return useMutation({
    mutationFn: (_options?: { select?: boolean }) => window.api.chat.create(),
    onSuccess: (chat, options) => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      // Guarded entry flows select only after their asynchronous preparation
      // has finished and the originating page/account is still current.
      if (options?.select !== false) setActiveChatId(chat.id)
    }
  })
}

export function useDeleteChat() {
  const queryClient = useQueryClient()
  const { activeChatId, setActiveChatId } = useChatStore()

  return useMutation({
    mutationFn: (chatId: string) => window.api.chat.delete(chatId),
    onSuccess: (_data, chatId) => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      queryClient.invalidateQueries({ queryKey: ['trash'] })
      if (activeChatId === chatId) {
        setActiveChatId(null)
      }
    }
  })
}

export function useInterruptChat(chatId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.run.cancelChat(chatId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['chats'] })
      void queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
    }
  })
}

export function useTrashList() {
  return useQuery({
    queryKey: ['trash'],
    queryFn: () => window.api.chat.trashList()
  })
}

/**
 * Promote a hidden (job-spawned) chat into the main Chats sidebar list.
 * Invalidates `['chats']` so the chat appears immediately, and `['jobs']` so
 * any run row showing the "Move to Chats" button updates to reflect the new
 * `chatHidden = false` state.
 *
 * A failure withdraws a pending reveal of that chat here, at hook level: the
 * row that would consume `revealChatId` never appears for a chat still hidden,
 * and a `mutate`-level callback is dropped once the caller unmounted — which
 * would leave the reveal armed for whenever the chat next shows up.
 */
export function useShowChatInList() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (chatId: string) => window.api.chat.showInList(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (_err, chatId) => {
      const ui = useUIStore.getState()
      if (ui.revealChatId === chatId) ui.setRevealChatId(null)
    }
  })
}

export function useRestoreChat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (chatId: string) => window.api.chat.restore(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      queryClient.invalidateQueries({ queryKey: ['trash'] })
    }
  })
}

export function usePermanentDeleteChat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (chatId: string) => window.api.chat.permanentDelete(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] })
    }
  })
}

export function useEmptyTrash() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.chat.emptyTrash(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] })
    }
  })
}

export function useUpdateChat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      chatId,
      updates
    }: {
      chatId: string
      updates: { title?: string; modelId?: string; providerId?: string; agentId?: string | null; modeId?: string | null; router?: ChatRouter }
    }) => window.api.chat.update(chatId, updates),
    onSuccess: (_data, { chatId, updates }) => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      if ('agentId' in updates || 'router' in updates || 'modeId' in updates) {
        // Main may create or reconfigure a chat-owned runtime during this update.
        queryClient.invalidateQueries({ queryKey: ['agents'] })
      }
    }
  })
}

type ChatListRows = Awaited<ReturnType<typeof window.api.chat.list>>

/**
 * Write one row of the polled list ahead of main, so the sidebar shows the
 * result at once rather than after the next poll. An in-flight poll is
 * cancelled first: it would bring the old row back.
 */
async function patchListedChat(
  queryClient: ReturnType<typeof useQueryClient>,
  chatId: string,
  patch: Partial<ChatListRows[number]>
): Promise<{ prev: ChatListRows | undefined }> {
  await queryClient.cancelQueries({ queryKey: ['chats'], exact: true })
  const prev = queryClient.getQueryData<ChatListRows>(['chats'])
  if (prev) queryClient.setQueryData<ChatListRows>(['chats'], prev.map((row) => (row.id === chatId ? { ...row, ...patch } : row)))
  return { prev }
}

/**
 * Rename from the sidebar. Main writes the title only, so the chat keeps its
 * place; the row shows the new title at once.
 */
export function useRenameChat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) => window.api.chat.rename(chatId, title),
    onMutate: ({ chatId, title }) => patchListedChat(queryClient, chatId, { title: title.trim() }),
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['chats'], ctx.prev)
    },
    onSettled: (_data, _err, { chatId }) => {
      void queryClient.invalidateQueries({ queryKey: ['chats'], exact: true })
      void queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
    }
  })
}

/** Pin a chat to the top of the Pinned block, or take it out. Main computes the rank. */
export function useSetChatPinned() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ chatId, pinned }: { chatId: string; pinned: boolean }) => window.api.chat.setPinned(chatId, pinned),
    onSuccess: ({ pinnedRank }, { chatId }) => {
      const rows = queryClient.getQueryData<ChatListRows>(['chats'])
      if (rows) queryClient.setQueryData<ChatListRows>(['chats'], rows.map((row) => (row.id === chatId ? { ...row, pinnedRank } : row)))
      void queryClient.invalidateQueries({ queryKey: ['chats'], exact: true })
    }
  })
}

/**
 * A drop in the sidebar, at the rank the list computed from the new
 * neighbours. Optimistic: the dropped row stays where it was put instead of
 * snapping back until the next poll.
 */
export function useMoveChat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ chatId, list, rank }: { chatId: string; list: 'pinned' | 'chats'; rank: number }) =>
      window.api.chat.move(chatId, { list, rank }),
    onMutate: ({ chatId, list, rank }) =>
      patchListedChat(queryClient, chatId, list === 'pinned' ? { pinnedRank: rank } : { sortKey: rank }),
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['chats'], ctx.prev)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['chats'], exact: true })
    }
  })
}

/**
 * Move a chat onto a router — who answers a message here.
 *
 * Replaced `usePromoteToOrchestrated`, which went one way to one value. The
 * in-chat `@`-agent gesture uses it (see `useAttachAgentToChat`), and so will
 * the composer's coordinate toggle. Invalidates the chat detail (the router,
 * and the root agent it detaches or binds), its on-demand agent set, and the
 * chat list.
 */
export function useSetChatRouter() {
  const queryClient = useQueryClient()
  type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>
  return useMutation({
    mutationFn: ({ chatId, router }: { chatId: string; router: ChatRouter }) =>
      window.api.chat.setRouter(chatId, router),
    // Optimistically move the cached chat before the round-trip resolves.
    // Without this, picking an agent then immediately pressing Enter races the
    // refetch — the composer would read the pre-switch snapshot and send to the
    // old root agent rather than to the one the user just addressed.
    onMutate: async ({ chatId, router }) => {
      await queryClient.cancelQueries({ queryKey: ['chat', chatId] })
      const prev = queryClient.getQueryData<CachedChat>(['chat', chatId])
      if (prev) {
        queryClient.setQueryData<CachedChat>(['chat', chatId], {
          ...prev,
          router,
          // Human routing detaches its root. Coordination keeps the current
          // root until main returns the eligible or synthetic conductor.
          agentId: router === 'human' ? null : prev.agentId
        })
      }
      return { prev }
    },
    onError: (_err, { chatId }, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['chat', chatId], ctx.prev)
    },
    onSettled: (_data, _err, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      queryClient.invalidateQueries({ queryKey: ['chat-on-demand-agent', chatId] })
      queryClient.invalidateQueries({ queryKey: ['chats'] })
    }
  })
}
