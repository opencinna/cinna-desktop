import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalDev } from './useLocalDev'
import { useCinnaReauth } from './useAuth'
import { useAppSettings } from './useAppSettings'
import { useNewChatFlow } from './useNewChatFlow'
import { useAuthStore } from '../stores/auth.store'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'
import { useLocalDevStore } from '../stores/localDev.store'
import { unwrapIpcError } from '../utils/ipcError'
import { describeOpenExternalFailure } from './useSystem'

/**
 * Which action is running, not merely *that* one is.
 *
 * The attention notice can offer three buttons at once, and a single `busy`
 * flag makes all three announce themselves — "Retrying…", "Reconnecting…" and
 * "Opening browser…" side by side, for one click. Everything is still disabled
 * while any of them runs; only the label belongs to the one that was pressed.
 */
export type DevelopmentAction = 'send' | 'repair' | 'reconnect' | 'reauth' | 'check' | 'open'

/** Query and action boundary for the account-bound development workspace. */
export function useDevelopmentWorkspace() {
  const state = useLocalDev()
  const user = useAuthStore((s) => s.currentUser)
  const { data: settings } = useAppSettings()
  const queryClient = useQueryClient()
  const { startNewChat } = useNewChatFlow()
  const cinnaReauth = useCinnaReauth()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<DevelopmentAction | null>(null)
  const busy = pending !== null
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

  const runAction = async (which: DevelopmentAction, action: () => Promise<unknown>): Promise<void> => {
    setError(null)
    setPending(which)
    try { await action() } catch (err) { setError(unwrapIpcError(err, 'Could not complete this step. Try again.')) }
    // Only if it is still ours. A browser round trip can be interrupted by a
    // second action, and the one that finishes first must not take the
    // spinner off the one still running.
    finally { if (mounted.current) setPending((current) => (current === which ? null : current)) }
  }
  const send = async (draft: string): Promise<void> => {
    if (!ready || !data || !draft.trim() || submitting.current) return
    submitting.current = true
    setPending('send')
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
    finally { submitting.current = false; if (mounted.current) setPending(null) }
  }

  const blocker = data?.blocker ?? (context.error ? unwrapIpcError(context.error, 'Could not check the build workspace.') : null)
  const repairWorkspace = (): Promise<void> => runAction('repair', () => useLocalDevStore.getState().repair())
  /**
   * The exit from `account_mismatch`: main renames the workspace that belongs
   * to the other account and sets a fresh one up. Repair cannot do this, and
   * pressing it here only fails the same way again.
   */
  const reconnectWorkspace = (): Promise<void> => runAction('reconnect', () => useLocalDevStore.getState().reconnectWorkspace())
  /**
   * Re-run the OAuth round trip for this profile without leaving the page.
   *
   * `mutateAsync` rather than `mutate` with callbacks, so a failure lands in
   * this page's error line rather than nowhere. The mutation's own `onSuccess`
   * lives in `useCinnaReauth` and survives an unmount; main reconciles local
   * development after a successful re-auth, so the notice moves on by itself.
   */
  const reauthenticate = (): Promise<void> => runAction('reauth', async () => {
    const result = await cinnaReauth.mutateAsync()
    if (!result.success) throw new Error(result.error ?? 'Re-authentication failed. Try again.')
  })
  const checkWorkspace = (): Promise<void> => runAction('check', async () => {
    await window.api.localDev.sessionContext(true)
    await queryClient.invalidateQueries({ queryKey: ['local-development-context'] })
  })
  const openWorkspace = (): Promise<void> => runAction('open', async () => {
    const result = await window.api.localDev.openWorkspace()
    if (!result.ok) throw new Error('Could not open the workspace folder.')
  })
  const openInstance = async (): Promise<void> => {
    if (!user?.cinnaServerUrl) return
    try {
      const result = await window.api.system.openExternal(user.cinnaServerUrl)
      if (!result.success) throw new Error(describeOpenExternalFailure(result.error))
    } catch (err) {
      if (mounted.current) setError(unwrapIpcError(err, 'Could not open the Cinna server.'))
    }
  }
  return { state, user, context, data, ready, blocker, error, busy, pending, send, repairWorkspace, reconnectWorkspace, reauthenticate, checkWorkspace, openWorkspace, openInstance }
}
