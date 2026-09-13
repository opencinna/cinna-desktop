import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalDev } from './useLocalDev'
import { useAppSettings } from './useAppSettings'
import { useNewChatFlow } from './useNewChatFlow'
import { useAuthStore } from '../stores/auth.store'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'
import { useLocalDevStore } from '../stores/localDev.store'
import { unwrapIpcError } from '../utils/ipcError'

/** Query and action boundary for the account-bound development workspace. */
export function useDevelopmentWorkspace() {
  const state = useLocalDev()
  const user = useAuthStore((s) => s.currentUser)
  const { data: settings } = useAppSettings()
  const queryClient = useQueryClient()
  const { startNewChat } = useNewChatFlow()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const context = useQuery({
    queryKey: ['local-development-context', user?.id, state, settings?.localAgentsDefaultEngine, settings?.localAgentsDefaultCredentialId, settings?.localDevelopmentEngine, settings?.localDevelopmentCredentialId, settings?.localDevelopmentComplexity],
    queryFn: () => window.api.localDev.sessionContext(),
    enabled: state.phase === 'ready',
    retry: false,
    staleTime: 30_000
  })
  const data = state.phase === 'ready' ? context.data : undefined
  const ready = !!data && !data.blocker && !context.isError

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null)
    setBusy(true)
    try { await action() } catch (err) { setError(unwrapIpcError(err, 'Could not complete this step. Try again.')) }
    finally { if (mounted.current) setBusy(false) }
  }
  const send = async (draft: string): Promise<void> => {
    if (!ready || !data || !draft.trim() || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const { agentId } = await window.api.localDev.prepareSession({ profileId: data.profileId, workspacePath: data.workspacePath, serverUrl: data.serverUrl, runtime: data.runtime, complexity: data.complexity })
      if (!mounted.current || useAuthStore.getState().currentUser?.id !== data.profileId) return
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      if (!mounted.current || useAuthStore.getState().currentUser?.id !== data.profileId) return
      await startNewChat({ isCurrent: () => mounted.current && useAuthStore.getState().currentUser?.id === data.profileId, message: draft.trim(), agentIds: [agentId], mode: null, providerId: null, providers: undefined, allModels: undefined, mcpIds: [] })
      if (!mounted.current || useAuthStore.getState().currentUser?.id !== data.profileId) return
      const sendError = useChatStore.getState().sendError
      if (sendError) { setError(sendError); return }
      useLocalDevStore.getState().setDraft(data.profileId, '')
      useUIStore.getState().setSidebarTab('chats')
      useUIStore.getState().setActiveView('chat')
    } catch (err) { if (mounted.current) setError(unwrapIpcError(err, 'Could not start your build session.')) }
    finally { submitting.current = false; if (mounted.current) setBusy(false) }
  }

  const blocker = data?.blocker ?? (context.error ? unwrapIpcError(context.error, 'Could not check the build workspace.') : null)
  const repairWorkspace = (): Promise<void> => runAction(() => useLocalDevStore.getState().repair())
  const openWorkspace = (): Promise<void> => runAction(async () => {
    const result = await window.api.localDev.openWorkspace()
    if (!result.ok) throw new Error('Could not open the workspace folder.')
  })
  const openInstance = async (): Promise<void> => {
    if (!user?.cinnaServerUrl) return
    try {
      const result = await window.api.system.openExternal(user.cinnaServerUrl)
      if (!result.success) throw new Error(result.error ?? 'Could not open the Cinna server.')
    } catch (err) {
      if (mounted.current) setError(unwrapIpcError(err, 'Could not open the Cinna server.'))
    }
  }
  return { state, user, context, data, ready, blocker, error, busy, send, repairWorkspace, openWorkspace, openInstance }
}
