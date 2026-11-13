import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { OAuthConnectFlow } from '../../../shared/serviceCredentials'
import { credentialResult, oauthFlowKey, useOAuthConnectFlow } from './useServiceCredentials'
import { oauthFlowErrorText } from '../components/settings/credentialPresentation'
import { unwrapIpcError } from '../utils/ipcError'

/**
 * Where one slot's Authorize stands. `idle`: nothing started (or what was started is over); `starting`:
 * main is asking Core for the consent page; `waiting`: this slot's sign-in is open in the browser;
 * `blocked`: another sign-in of the agent is waiting (another slot's, or the Credentials tab's), and
 * starting this one would replace it. `error` is a failed flow's or a refused start's reason, shown
 * under the slot until the next try.
 */
export interface SlotAuthorizeState {
  phase: 'idle' | 'starting' | 'waiting' | 'blocked'
  error: string | null
  /** A failed flow's code (`timeout`, `oauth_not_configured`, …), for a surface that words it shorter; null otherwise. */
  errorCode?: string | null
}

export interface SlotAuthorize {
  stateOf: (slotKey: string) => SlotAuthorizeState
  authorize: (slotKey: string) => void
  /** Open this slot's consent page again (`waiting` only). */
  reopen: (slotKey: string) => void
  /** Stop waiting for this slot's sign-in; the record on Core is kept. */
  cancel: (slotKey: string) => void
}

/**
 * Authorize for the Google OAuth slots of one agent (Finish setup's rows, the composer's credential
 * row): `authorizeSlot` in main, which reads the slot's type and Service URI from its own scan. The
 * flow is main's (one per agent) and read through `useOAuthConnectFlow`; once it attached the record
 * the slot turns Connected through the normal scan, and the flow is dismissed here as the attach
 * modal dismisses its own. The start is owned by this hook's mutation, so its answer lands even if
 * the caller's row has gone.
 */
export function useSlotAuthorize(agentId: string | null): SlotAuthorize {
  const queryClient = useQueryClient()
  const flowQuery = useOAuthConnectFlow(agentId ?? '', agentId !== null)
  const flow: OAuthConnectFlow | null = agentId !== null ? flowQuery.data ?? null : null
  /** A Reopen or Cancel that failed, by slot: shown where a failed flow's reason would be. */
  const [actionError, setActionError] = useState<{ slot: string; message: string } | null>(null)
  const start = useMutation({
    mutationFn: async ({ id, slot }: { id: string; slot: string }) => credentialResult(await window.api.serviceCredentials.authorizeSlot(id, slot)),
    onSuccess: (next, { id }) => queryClient.setQueryData(oauthFlowKey(id), next)
  })

  // A slot's flow that attached its record is done: the scan shows the slot Connected. Dismissed once,
  // here, so a later Authorize or the attach modal never finds it.
  const attachedId = flow?.state === 'attached' && flow.slot !== null ? flow.id : null
  useEffect(() => {
    if (!agentId || !attachedId) return
    void window.api.serviceCredentials.cancelOAuth(agentId, attachedId).catch(() => undefined)
    queryClient.setQueryData(oauthFlowKey(agentId), null)
  }, [agentId, attachedId, queryClient])

  const stateOf = (slotKey: string): SlotAuthorizeState => {
    const starting = start.isPending && start.variables?.id === agentId && start.variables.slot === slotKey
    const startError = !start.isPending && start.isError && start.variables?.id === agentId && start.variables.slot === slotKey ? unwrapIpcError(start.error) : null
    const own = flow?.slot === slotKey
    const error = actionError?.slot === slotKey ? actionError.message
      : startError ?? (own && flow?.state === 'failed' ? oauthFlowErrorText(flow.error) : null)
    const errorCode = error !== null && error === (own && flow?.state === 'failed' ? oauthFlowErrorText(flow.error) : undefined) ? flow?.error?.code ?? null : null
    if (starting) return { phase: 'starting', error: null, errorCode: null }
    if (flow?.state === 'waiting') return { phase: own ? 'waiting' : 'blocked', error: own ? null : error, errorCode: own ? null : errorCode }
    return { phase: 'idle', error, errorCode }
  }
  const run = async (slotKey: string, action: () => Promise<unknown>): Promise<void> => {
    setActionError(null)
    try { await action() } catch (error) { setActionError({ slot: slotKey, message: unwrapIpcError(error) }) }
  }
  const sc = window.api.serviceCredentials
  return {
    stateOf,
    authorize: (slotKey) => {
      if (!agentId || start.isPending) return
      setActionError(null)
      start.mutate({ id: agentId, slot: slotKey })
    },
    reopen: (slotKey) => {
      if (!agentId || flow?.slot !== slotKey || flow.state !== 'waiting') return
      void run(slotKey, async () => credentialResult(await sc.reopenOAuth(agentId, flow.id)))
    },
    cancel: (slotKey) => {
      if (!agentId || flow?.slot !== slotKey) return
      void run(slotKey, async () => {
        credentialResult(await sc.cancelOAuth(agentId, flow.id))
        queryClient.setQueryData(oauthFlowKey(agentId), null)
      })
    }
  }
}
