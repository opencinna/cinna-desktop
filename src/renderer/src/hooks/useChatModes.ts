import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { resolveDefaultModeId } from '../../../shared/chatModeDefaults'
import { useAppSettings } from './useAppSettings'

export function useChatModes() {
  const queryClient = useQueryClient()

  // Account-config sync materializes/refreshes managed chat modes in the main
  // process; refetch on its broadcast so they appear without a manual reload.
  useEffect(() => {
    return window.api.providers.onAccountConfigSynced(() => {
      queryClient.invalidateQueries({ queryKey: ['chat-modes'] })
    })
  }, [queryClient])

  return useQuery({
    queryKey: ['chat-modes'],
    queryFn: () => window.api.chatModes.list()
  })
}

export function useSetManagedChatModeEnabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: string; enabled: boolean }) =>
      window.api.chatModes.setManagedEnabled(data.id, data.enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-modes'] })
    }
  })
}

export function useSetManagedChatModeModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { id: string; modelId: string | null }) =>
      window.api.chatModes.setManagedModel(data.id, data.modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-modes'] })
    }
  })
}

export function useUpsertChatMode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      id?: string
      name: string
      providerId?: string | null
      modelId?: string | null
      mcpProviderIds?: string[]
      colorPreset?: string
      isDefault?: boolean
    }) => window.api.chatModes.upsert(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-modes'] })
    }
  })
}

export function useDefaultChatMode() {
  const query = useChatModes()
  const { data: settings } = useAppSettings()
  const prioritizeAccount = settings?.prioritizeAccountDefaults === true
  const modes = query.data ?? []
  const id = resolveDefaultModeId(modes, prioritizeAccount)
  const mode = id ? modes.find((m) => m.id === id) ?? null : null
  return { ...query, data: mode }
}

export function useDeleteChatMode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.api.chatModes.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-modes'] })
    }
  })
}
