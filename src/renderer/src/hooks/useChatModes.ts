import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { resolveDefaultModeId } from '../../../shared/chatModeDefaults'
import { useAppSettings } from './useAppSettings'
import { AGENT_CREDENTIAL_BINDINGS_KEY } from './useLocalAgents'

export function useChatModes() {
  const queryClient = useQueryClient()

  // Account-config sync materializes/refreshes managed chat modes in the main
  // process; refetch on its broadcast so they appear without a manual reload.
  useEffect(() => {
    return window.api.providers.onAccountConfigSynced(() => {
      queryClient.invalidateQueries({ queryKey: ['chat-modes'] })
      // A sync can materialise or retire the managed mode that *is* the
      // effective default, which moves the credential every agent on the
      // Default runtime resolves to — on a background timer, with nothing on
      // screen having been clicked.
      queryClient.invalidateQueries({ queryKey: AGENT_CREDENTIAL_BINDINGS_KEY })
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
      // Disabling the managed mode that is currently the effective default
      // hands the default back to the local one, which is a different
      // credential — so every agent on the Default runtime rebinds. Its sibling
      // `useSetManagedChatModeModel` deliberately does *not* do this: only the
      // model moves there, never the credential.
      queryClient.invalidateQueries({ queryKey: AGENT_CREDENTIAL_BINDINGS_KEY })
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
      // The *default* chat mode is the last rung of an agent's runtime chain,
      // so editing, deleting or re-defaulting a mode can change which credential
      // an agent resolves to — and whether the sidebar should call it inactive.
      queryClient.invalidateQueries({ queryKey: AGENT_CREDENTIAL_BINDINGS_KEY })
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
      // The *default* chat mode is the last rung of an agent's runtime chain,
      // so editing, deleting or re-defaulting a mode can change which credential
      // an agent resolves to — and whether the sidebar should call it inactive.
      queryClient.invalidateQueries({ queryKey: AGENT_CREDENTIAL_BINDINGS_KEY })
    }
  })
}
