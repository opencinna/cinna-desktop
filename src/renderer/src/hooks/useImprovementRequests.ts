import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import { useToastStore } from '../stores/toast.store'
import type { ImprovementRequestInput, ImprovementTarget } from '../../../shared/improvementRequests'

export const IMPROVEMENT_KEY = ['improvement-requests'] as const

/**
 * The chat's agents whose cloud session can be sent as an improvement
 * request; empty hides the action. A session id is written by the first reply,
 * so the list is read again each time a turn in this chat ends.
 */
export function useImprovementTargets(chatId: string | null, isStreaming: boolean): ImprovementTarget[] {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const queryClient = useQueryClient()
  const key = [...IMPROVEMENT_KEY, 'targets', profileId, chatId] as const
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => window.api.improvementRequests.targets(chatId as string),
    enabled: chatId !== null && profileId !== null
  })
  const wasStreaming = useRef(isStreaming)
  useEffect(() => {
    if (wasStreaming.current && !isStreaming && chatId) {
      void queryClient.invalidateQueries({ queryKey: [...IMPROVEMENT_KEY, 'targets'] })
    }
    wasStreaming.current = isStreaming
  }, [isStreaming, chatId, queryClient])
  return chatId === null ? [] : data ?? []
}

export interface ImprovementSubmit {
  input: ImprovementRequestInput
  /** The toast's sentence on success, naming the recipient (core's answer does not). */
  confirmation: string
}

/**
 * Send one. Owned by the composer, not the dialog: the success callback is a
 * hook-level one, which TanStack runs even after the dialog has closed. A
 * refusal comes back as data and is thrown here so it lands on `error`.
 * `onSent` gets the chat that sent: one composer serves every chat, so the
 * caller closes the dialog only if it is still open for that chat.
 */
export function useCreateImprovementRequest(onSent: (chatId: string) => void): UseMutationResult<void, Error, ImprovementSubmit> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ input }: ImprovementSubmit) => {
      const outcome = await window.api.improvementRequests.create(input)
      if (!outcome.ok) throw new Error(outcome.message)
    },
    onSuccess: (_data, { input, confirmation }) => {
      useToastStore.getState().show(confirmation, { kind: 'success', link: null })
      void queryClient.invalidateQueries({ queryKey: [...IMPROVEMENT_KEY, 'context'] })
      onSent(input.chatId)
    }
  })
}
