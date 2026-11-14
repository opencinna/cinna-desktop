import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  VaultAvailabilityDto,
  VaultErrorCode,
  VaultMoveOptions,
  VaultResult,
  VaultStateEvent,
  VaultStatusDto
} from '../../../shared/vault/types'
import { LOCAL_AGENTS_KEY, localAgentKey } from './useLocalAgents'

/**
 * Agent Vault, as the renderer sees it. Every call but `availability` answers
 * a `VaultResult` (a code thrown in main does not survive IPC), so the hooks
 * turn a refusal into a {@link VaultError} that keeps its code and the
 * sentence main wrote for the user.
 *
 * `window.api.vault` is read through `vaultApi()`, which is undefined in a
 * renderer test that mocks only the parts it needs: a hook mounted by the app
 * shell must not crash every such test.
 */

export const VAULT_KEY = ['vault'] as const
export const VAULT_AVAILABILITY_KEY = ['vault', 'availability'] as const
export function vaultStatusKey(agentId: string): readonly unknown[] {
  return ['vault', 'status', agentId] as const
}
export function vaultDetailKey(agentId: string, what: string, ...rest: unknown[]): readonly unknown[] {
  return ['vault', what, agentId, ...rest] as const
}

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

type VaultApi = Window['api']['vault']
function vaultApi(): VaultApi | undefined {
  return (window.api as Partial<Window['api']> | undefined)?.vault
}

export function unwrapVault<T>(result: VaultResult<T>): T {
  if (result.ok) return result.data
  throw new VaultError(result.code, result.message)
}

/**
 * The sentence for a failed vault call. `denied` is the user cancelling the
 * helper's own prompt, which is an answer rather than a failure, so it is
 * said as one.
 */
export function vaultErrorText(err: unknown, cancelled = 'Cancelled at the prompt — nothing changed.'): string {
  if (err instanceof VaultError) {
    if (err.code === 'denied') return cancelled
    return err.message || 'The vault did not answer.'
  }
  if (err instanceof Error) return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return 'The vault did not answer.'
}

export function useVaultAvailability() {
  return useQuery<VaultAvailabilityDto>({
    queryKey: VAULT_AVAILABILITY_KEY,
    queryFn: async () => {
      const api = vaultApi()
      if (!api) throw new Error('Agent Vault is not part of this build.')
      return api.availability()
    },
    staleTime: 60_000
  })
}

/** One vault's status; kept live by {@link useVaultWatch}'s state pushes. */
export function useVaultStatus(agentId: string | null) {
  return useQuery<VaultStatusDto>({
    queryKey: vaultStatusKey(agentId ?? ''),
    queryFn: async () => unwrapVault(await vaultApi()!.status(agentId!)),
    enabled: !!agentId && !!vaultApi()
  })
}

/** A state push folded into the cached status, so the tab moves without a round trip. */
export function applyVaultState(queryClient: QueryClient, event: VaultStateEvent): void {
  queryClient.setQueryData<VaultStatusDto>(vaultStatusKey(event.agentId), (prev) =>
    prev ? { ...prev, state: event.state, until: event.until, error: event.error } : prev
  )
}

/**
 * App-wide: every `vault:state` push updates that vault's status and drops the
 * agent lists (the sidebar lock, the readiness row), which carry the state too.
 */
export function useVaultWatch(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    const api = vaultApi()
    if (!api?.onState) return
    return api.onState((event) => {
      applyVaultState(queryClient, event)
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY }, { cancelRefetch: false })
      void queryClient.invalidateQueries({ queryKey: localAgentKey(event.agentId) }, { cancelRefetch: false })
      void queryClient.invalidateQueries({ queryKey: ['agents'] }, { cancelRefetch: false })
    })
  }, [queryClient])
}

function useVaultMutation<TVars, TData>(
  run: (api: VaultApi, vars: TVars) => Promise<VaultResult<TData>>,
  after?: (queryClient: QueryClient, vars: TVars, data: TData) => void
) {
  const queryClient = useQueryClient()
  return useMutation<TData, Error, TVars>({
    mutationFn: async (vars) => {
      const api = vaultApi()
      if (!api) throw new Error('Agent Vault is not part of this build.')
      return unwrapVault(await run(api, vars))
    },
    onSuccess: (data, vars) => after?.(queryClient, vars, data)
  })
}

/** A returned status replaces the cached one. */
function storeStatus(queryClient: QueryClient, _vars: unknown, data: VaultStatusDto): void {
  queryClient.setQueryData(vaultStatusKey(data.agentId), data)
  void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY }, { cancelRefetch: false })
}

function dropAgent(queryClient: QueryClient, agentId: string): void {
  void queryClient.invalidateQueries({ queryKey: VAULT_KEY })
  void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
  void queryClient.invalidateQueries({ queryKey: localAgentKey(agentId) })
  void queryClient.invalidateQueries({ queryKey: ['agents'] })
}

export function useVaultUnlock() {
  return useVaultMutation((api, agentId: string) => api.unlock(agentId), storeStatus)
}
export function useVaultLock() {
  return useVaultMutation((api, agentId: string) => api.lock(agentId), storeStatus)
}
export function useVaultSetSize() {
  return useVaultMutation(
    (api, vars: { agentId: string; sizeBytes: number }) => api.setSize(vars.agentId, vars.sizeBytes),
    storeStatus
  )
}
export function useVaultSetEgress() {
  return useVaultMutation(
    (api, vars: { agentId: string; hosts: string[] }) => api.setEgress(vars.agentId, vars.hosts),
    storeStatus
  )
}
export function useVaultDestroy() {
  return useVaultMutation((api, agentId: string) => api.destroy(agentId), (qc, agentId) => dropAgent(qc, agentId))
}
export function useVaultMoveOut() {
  return useVaultMutation((api, agentId: string) => api.moveOut(agentId), (qc, agentId) => dropAgent(qc, agentId))
}

export function useVaultHostCopy(agentId: string | null) {
  return useQuery({
    queryKey: vaultDetailKey(agentId ?? '', 'host-copy'),
    queryFn: async () => unwrapVault(await vaultApi()!.hostCopy(agentId!)),
    enabled: !!agentId && !!vaultApi()
  })
}
export function useVaultDeleteHostCopy() {
  return useVaultMutation(
    (api, vars: { agentId: string; typedName: string }) => api.deleteHostCopy(vars.agentId, vars.typedName),
    (qc, vars) => {
      void qc.invalidateQueries({ queryKey: vaultDetailKey(vars.agentId, 'host-copy') })
      void qc.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
    }
  )
}

export function useVaultSecrets(agentId: string | null, enabled = true) {
  return useQuery({
    queryKey: vaultDetailKey(agentId ?? '', 'secrets'),
    queryFn: async () => unwrapVault(await vaultApi()!.secrets(agentId!)).names,
    enabled: enabled && !!agentId && !!vaultApi()
  })
}
export function useVaultSetSecret() {
  return useVaultMutation(
    (api, vars: { agentId: string; name: string; value: string }) => api.setSecret(vars.agentId, vars.name, vars.value),
    (qc, vars) => {
      void qc.invalidateQueries({ queryKey: vaultDetailKey(vars.agentId, 'secrets') })
      void qc.invalidateQueries({ queryKey: vaultDetailKey(vars.agentId, 'engine-auth') })
    }
  )
}
export function useVaultDeleteSecret() {
  return useVaultMutation(
    (api, vars: { agentId: string; name: string }) => api.deleteSecret(vars.agentId, vars.name),
    (qc, vars) => {
      void qc.invalidateQueries({ queryKey: vaultDetailKey(vars.agentId, 'secrets') })
      void qc.invalidateQueries({ queryKey: vaultDetailKey(vars.agentId, 'engine-auth') })
    }
  )
}

export function useVaultEngineAuth(agentId: string | null, enabled = true) {
  return useQuery({
    queryKey: vaultDetailKey(agentId ?? '', 'engine-auth'),
    queryFn: async () => unwrapVault(await vaultApi()!.engineAuth(agentId!)),
    enabled: enabled && !!agentId && !!vaultApi()
  })
}

export function useVaultRuntimes(agentId: string | null, enabled = true) {
  return useQuery({
    queryKey: vaultDetailKey(agentId ?? '', 'runtimes'),
    queryFn: async () => unwrapVault(await vaultApi()!.runtimes(agentId!)),
    enabled: enabled && !!agentId && !!vaultApi()
  })
}
export function useVaultUpdateDependencies() {
  return useVaultMutation((api, agentId: string) => api.updateDependencies(agentId))
}

export function useVaultFiles(agentId: string | null, path: string, enabled = true) {
  return useQuery({
    queryKey: vaultDetailKey(agentId ?? '', 'files', path),
    queryFn: async () => unwrapVault(await vaultApi()!.listFiles(agentId!, path)),
    enabled: enabled && !!agentId && !!vaultApi()
  })
}
export function useVaultExportFile() {
  return useVaultMutation((api, vars: { agentId: string; path: string }) => api.exportFile(vars.agentId, vars.path))
}

export function useVaultPrecheck(agentId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: vaultDetailKey(agentId ?? '', 'precheck'),
    queryFn: async () => unwrapVault(await vaultApi()!.precheck(agentId!)),
    enabled: enabled && !!agentId && !!vaultApi(),
    // A pre-check is a snapshot of the folder at the moment the dialog opened.
    staleTime: 0,
    gcTime: 0
  })
}

export async function startVaultMove(agentId: string, options: VaultMoveOptions): Promise<string> {
  const api = vaultApi()
  if (!api) throw new Error('Agent Vault is not part of this build.')
  return unwrapVault(await api.moveIn(agentId, options)).moveId
}

export async function cancelVaultMove(moveId: string): Promise<void> {
  const api = vaultApi()
  if (!api) return
  unwrapVault(await api.cancelMove(moveId))
}

export function onVaultMoveProgress(cb: Parameters<VaultApi['onMoveProgress']>[0]): () => void {
  return vaultApi()?.onMoveProgress?.(cb) ?? (() => {})
}
