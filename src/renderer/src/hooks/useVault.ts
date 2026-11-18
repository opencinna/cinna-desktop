import { useEffect, useRef, useState } from 'react'
import { useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  VAULT_SWITCH_STEPS,
  formatVaultCountdown,
  vaultChatFilesSweptText,
  vaultImageDownloadText,
  type VaultAvailabilityDto,
  type VaultChatFilesSweptEvent,
  type VaultErrorCode,
  type VaultMoveOptions,
  type VaultMoveProgressEvent,
  type VaultSwitchEngineOptions,
  type VaultResult,
  type VaultStateEvent,
  type VaultStatusDto,
  type LocalAgentVaultInfo,
  type VaultAgentDetailsDto
} from '../../../shared/vault/types'
import { composerDraftSurface, useComposerDraftStore } from '../stores/composerDraft.store'
import { useFilePreviewStore } from '../stores/filePreview.store'
import {
  LOCAL_AGENTS_KEY,
  localAgentKey,
  useForgetAgentGrants,
  useLocalAgentGrants,
  type LocalAgentsSnapshot
} from './useLocalAgents'
import type { StoredPermissionGrant } from '../../../shared/localAgentRequests'
import { agentFileRefsKey } from './useAgentFileRefs'

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

export { formatVaultCountdown }

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
    prev
      ? {
          ...prev, state: event.state, until: event.until, error: event.error,
          // An older main that sends none keeps what the status said.
          lockAfterMs: event.lockAfterMs ?? prev.lockAfterMs
        }
      : prev
  )
}

/**
 * A lock deleted the copies of these not-yet-sent attachments (D23): each
 * chat's composer draft drops their chips and says why in its file error, in
 * the store, so a composer that is not mounted shows it when it comes back.
 * Typed text and everything else in the draft stay.
 */
export function applyVaultChatFilesSwept(event: VaultChatFilesSweptEvent): void {
  const store = useComposerDraftStore.getState()
  for (const { chatId, attachmentIds } of event.chats) {
    const gone = new Set(attachmentIds)
    for (const key of Object.keys(store.drafts)) {
      if (composerDraftSurface(key) !== `chat:${chatId}`) continue
      store.update(key, (draft) => {
        const kept = draft.files.attachments.filter((attachment) => !gone.has(attachment.id))
        const lost = draft.files.attachments.length - kept.length
        if (lost === 0) return {}
        return { files: { ...draft.files, attachments: kept, error: vaultChatFilesSweptText(lost) } }
      })
    }
  }
}

/** The ids of the agents a local-agents snapshot lists as in a vault. */
function vaultAgentIds(snapshot: LocalAgentsSnapshot | undefined): Set<string> | null {
  if (!snapshot?.agents) return null
  return new Set(snapshot.agents.filter((agent) => agent.vault !== undefined).map((agent) => agent.id))
}

/**
 * App-wide: every `vault:state` push updates that vault's status and drops the
 * agent lists (the readiness row and the agent page's Unlock / Lock now), which carry the state too;
 * a lock's attachment sweep reaches the composer drafts.
 *
 * Where an agent's files can be reached changes with it: a state push, or the
 * agent list showing an agent moved into or out of a vault, drops that
 * agent's resolved file references (refs resolved by the old source offered
 * the old actions), and an open preview of one of its files checks again.
 */
export function useVaultWatch(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    const api = vaultApi()
    if (!api?.onState) return
    // Whether each agent's vault was open at its last push: file refs and an open
    // preview only care when that changes, not on every window restart a
    // keystroke's touch or a turn's hold sends.
    const open = new Map<string, boolean>()
    const offState = api.onState((event) => {
      applyVaultState(queryClient, event)
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY }, { cancelRefetch: false })
      void queryClient.invalidateQueries({ queryKey: localAgentKey(event.agentId) }, { cancelRefetch: false })
      void queryClient.invalidateQueries({ queryKey: ['agents'] }, { cancelRefetch: false })
      const nowOpen = event.state === 'unlocked'
      if (open.get(event.agentId) === nowOpen) return
      open.set(event.agentId, nowOpen)
      void queryClient.invalidateQueries({ queryKey: agentFileRefsKey(event.agentId) })
      void useFilePreviewStore.getState().recheckAgentFile(event.agentId)
    })
    const offSwept = api.onChatFilesSwept?.(applyVaultChatFilesSwept)
    // Moved in or out: the agent list is where that shows.
    let inVault = vaultAgentIds(queryClient.getQueryData<LocalAgentsSnapshot>(LOCAL_AGENTS_KEY))
    const offList = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.queryKey[0] !== LOCAL_AGENTS_KEY[0] || event.query.queryKey.length !== 1) return
      const now = vaultAgentIds(event.query.state.data as LocalAgentsSnapshot | undefined)
      if (now === null) return
      // The first list seen is the baseline, not a move.
      const before = inVault
      inVault = now
      if (before === null) return
      for (const id of new Set([...before, ...now])) {
        if (before.has(id) !== now.has(id)) void queryClient.invalidateQueries({ queryKey: agentFileRefsKey(id) })
      }
    })
    return () => {
      offState()
      offSwept?.()
      offList()
    }
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

/**
 * While an unlock of `agentId` first downloads the guest image this version
 * pins (the first unlock after an update): "Downloading vault image… 40%",
 * for the label that already says the unlock is pending; null otherwise.
 * Callers show it only while their unlock is pending.
 */
export function useVaultUnlockProgress(agentId: string | null): string | null {
  const percent = useVaultUnlockPercent(agentId)
  return percent === null ? null : vaultImageDownloadText(percent)
}

/** The percent of the guest image an unlock of `agentId` is downloading, or null when none is. */
export function useVaultUnlockPercent(agentId: string | null): number | null {
  const [progress, setProgress] = useState<{ agentId: string; percent: number } | null>(null)
  useEffect(() => {
    setProgress(null)
    const api = vaultApi()
    if (!agentId || !api?.onUnlockProgress) return
    return api.onUnlockProgress((event) => {
      if (event.agentId !== agentId) return
      setProgress(event.percent === null ? null : { agentId, percent: event.percent })
    })
  }, [agentId])
  return progress && progress.agentId === agentId ? progress.percent : null
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
export function useVaultSetLockTimeout() {
  return useVaultMutation(
    (api, vars: { agentId: string; lockAfterMs: number }) => api.setLockTimeout(vars.agentId, vars.lockAfterMs),
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

/**
 * A vault agent's *Always allow* grants, read from the vault. Kept under its
 * own vault key, never a folder agent's, and, like the secrets, only asked
 * while the vault is open: a lock disables the query (the page shows the
 * locked phrase rather than the rows it last read). A vault refusal is an
 * answer, never retried; anything else once.
 */
export function useVaultGrants(agentId: string | null, enabled = true) {
  return useQuery<StoredPermissionGrant[]>({
    queryKey: vaultDetailKey(agentId ?? '', 'grants'),
    queryFn: async () => unwrapVault(await vaultApi()!.grants(agentId!)),
    enabled: enabled && !!agentId && !!vaultApi(),
    retry: (failures, error) => !(error instanceof VaultError) && failures < 1
  })
}
/** Revoke one grant (`key`) or all; the list left is written straight into the cache. */
export function useVaultForgetGrants() {
  return useVaultMutation(
    (api, vars: { agentId: string; key?: string }) => api.forgetGrant(vars.agentId, vars.key ?? null),
    (qc, vars, grants) => {
      qc.setQueryData(vaultDetailKey(vars.agentId, 'grants'), grants)
    }
  )
}

/**
 * A vault agent's manifest, status, prompts, credential names and launch
 * settings, read from inside its vault (the folder agent's DTO carries these
 * from the folder; a vault agent's has none). Asked only while the vault is
 * `open`: a lock disables the query and keeps what it last read, so an
 * unlock shows it at once while it reads again. A vault refusal (`locked`,
 * `not_vault_agent`, …) is an answer, never retried; anything else once.
 */
export function useVaultAgentDetails(agentId: string | null, open: boolean) {
  return useQuery<VaultAgentDetailsDto>({
    queryKey: vaultDetailKey(agentId ?? '', 'agent-details'),
    queryFn: async () => unwrapVault(await vaultApi()!.agentDetails(agentId!)),
    enabled: open && !!agentId && !!vaultApi(),
    retry: (failures, error) => !(error instanceof VaultError) && failures < 1
  })
}

/** Whether a vault agent's vault is open now: the live status, else the DTO's copy. False for any other agent. */
export function useVaultOpen(agent: { id: string; vault?: LocalAgentVaultInfo | null } | null | undefined): boolean {
  const vault = agent?.vault ?? null
  const status = useVaultStatus(vault ? agent!.id : null)
  return vault !== null && (status.data?.state ?? vault.state) === 'unlocked'
}

/**
 * An agent's *Always allow* grants and how to revoke them, from wherever they
 * are kept: the folder's state file, or the vault. `locked` is a vault agent
 * whose vault is shut, so nothing can be read: the page shows no rows then, even
 * though the last ones read stay in `data`.
 */
export function useAgentGrants(agent: { id: string; vault?: LocalAgentVaultInfo | null } | null | undefined) {
  const inVault = !!agent?.vault
  const open = useVaultOpen(agent)
  const local = useLocalAgentGrants(agent && !inVault ? agent.id : null)
  const vault = useVaultGrants(agent && inVault ? agent.id : null, open)
  const forgetLocal = useForgetAgentGrants()
  const forgetVault = useVaultForgetGrants()
  return {
    query: inVault ? vault : local,
    forget: inVault ? forgetVault : forgetLocal,
    locked: inVault && !open
  }
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
/** Every vault engine, set up in this vault or not; only while it is unlocked. */
export function useVaultEngines(agentId: string | null, enabled = true) {
  return useQuery({
    queryKey: vaultDetailKey(agentId ?? '', 'engines'),
    queryFn: async () => unwrapVault(await vaultApi()!.engines(agentId!)),
    enabled: enabled && !!agentId && !!vaultApi()
  })
}

function switchEngineKey(agentId: string): readonly unknown[] {
  return ['vault', 'switch-engine', agentId] as const
}

/** A switch of engine whose final event said it failed: the step's sentence, and which step. */
export class VaultSwitchFailed extends Error {
  constructor(readonly step: VaultMoveProgressEvent['step'], message: string) {
    super(message)
    this.name = 'VaultSwitchFailed'
  }
}

function isSwitchStep(step: string): boolean {
  return (VAULT_SWITCH_STEPS as readonly string[]).includes(step)
}

export interface VaultSwitchVars {
  options: VaultSwitchEngineOptions
  /** Each progress event of this switch (its steps), for a dialog that lists them. */
  onEvent?: (event: VaultMoveProgressEvent) => void
}

/**
 * Change a vault agent's engine. Pending for the whole switch, not just the
 * call that starts it: it resolves with main's last sentence when the switch's
 * final event says done, and fails with a {@link VaultSwitchFailed} (or the
 * refusal that kept it from starting). However it ends, the agent, its vault
 * status, engines, runtimes and engine login are read again; that lives on
 * the mutation, so it happens even when the caller has gone.
 */
export function useVaultSwitchEngine(agentId: string) {
  const queryClient = useQueryClient()
  return useMutation<string, Error, VaultSwitchVars>({
    mutationKey: switchEngineKey(agentId),
    mutationFn: async ({ options, onEvent }) => {
      const api = vaultApi()
      if (!api) throw new Error('Agent Vault is not part of this build.')
      let moveId: string | null = null
      let off: () => void = () => {}
      // Listening before the call: its first events can arrive before its answer.
      const finished = new Promise<string>((resolve, reject) => {
        off = api.onMoveProgress((event) => {
          if (event.agentId !== agentId || !isSwitchStep(event.step)) return
          if (moveId && event.moveId !== moveId) return
          onEvent?.(event)
          if (event.status === 'failed') reject(new VaultSwitchFailed(event.step, event.message ?? 'The engine could not be changed.'))
          else if (event.step === 'engine' && event.status === 'done') resolve(event.message ?? '')
        })
      })
      finished.catch(() => {})
      try {
        moveId = unwrapVault(await api.switchEngine(agentId, options)).moveId
        return await finished
      } finally {
        off()
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: localAgentKey(agentId) })
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: vaultStatusKey(agentId) })
      for (const what of ['engines', 'runtimes', 'engine-auth', 'secrets']) {
        void queryClient.invalidateQueries({ queryKey: vaultDetailKey(agentId, what) })
      }
    }
  })
}

/** The engine a switch on `agentId` is moving to while one runs (from any component), else null. */
export function useVaultSwitchingTo(agentId: string): VaultSwitchEngineOptions['engine'] | null {
  const pending = useMutationState({
    filters: { mutationKey: switchEngineKey(agentId), status: 'pending' },
    select: (mutation) => (mutation.state.variables as VaultSwitchVars | undefined)?.options.engine ?? null
  })
  return pending.at(-1) ?? null
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

/** At most one touch per agent this often: typing keeps the vault open without a call per keystroke. */
export const VAULT_TOUCH_THROTTLE_MS = 5_000

/**
 * A throttled `vault.touch` for the composer: `touch(agentId)` restarts the
 * agent's unlocked vault's idle window, at most once per
 * {@link VAULT_TOUCH_THROTTLE_MS} per agent. Changes nothing on screen.
 */
export function useVaultTouch(now: () => number = Date.now): (agentId: string) => void {
  const last = useRef<{ agentId: string; at: number } | null>(null)
  const [touch] = useState(() => (agentId: string) => {
    const at = now()
    const prev = last.current
    if (prev && prev.agentId === agentId && at - prev.at < VAULT_TOUCH_THROTTLE_MS) return
    last.current = { agentId, at }
    vaultApi()?.touch?.(agentId)
  })
  return touch
}

/** Under this many ms left, the router badge shows its countdown pill. */
export const VAULT_COUNTDOWN_PILL_MS = 15_000
/** Within this many ms of the deadline the countdown ticks every second (and always while `watch`). */
const VAULT_COUNTDOWN_TICK_MS = 20_000

export type VaultCountdown =
  | { kind: 'none' }
  | { kind: 'locked' }
  | { kind: 'held' }
  | { kind: 'no-timer' }
  | { kind: 'counting'; remainingMs: number; until: number }

/** What a vault's lock timer is doing, from its status at `now`. */
export function vaultCountdown(status: Pick<VaultStatusDto, 'state' | 'until' | 'lockAfterMs'> | null | undefined, now: number): VaultCountdown {
  if (!status) return { kind: 'none' }
  if (status.state !== 'unlocked') return status.state === 'booting' ? { kind: 'none' } : { kind: 'locked' }
  if (status.lockAfterMs === 0) return { kind: 'no-timer' }
  if (status.until === null) return { kind: 'held' }
  return { kind: 'counting', remainingMs: Math.max(0, status.until - now), until: status.until }
}

/**
 * A vault agent's lock countdown, kept live by the state pushes. It re-renders
 * once a second only while the deadline is near (within 20 s) or `watch` is on
 * (a popover showing it); otherwise one timer wakes it when the deadline
 * comes within reach, so the composer is not re-rendered every second.
 */
export function useVaultCountdown(agentId: string | null, watch = false): VaultCountdown {
  const { data: status } = useVaultStatus(agentId)
  const [now, setNow] = useState(() => Date.now())
  const until = status?.state === 'unlocked' && status.lockAfterMs !== 0 ? status.until ?? null : null
  useEffect(() => {
    setNow(Date.now())
    if (until === null) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let interval: ReturnType<typeof setInterval> | null = null
    const startTicking = (): void => {
      setNow(Date.now())
      interval = setInterval(() => {
        const t = Date.now()
        setNow(t)
        if (t >= until && interval) {
          clearInterval(interval)
          interval = null
        }
      }, 1000)
    }
    const away = until - Date.now()
    if (watch || away <= VAULT_COUNTDOWN_TICK_MS) startTicking()
    else timer = setTimeout(startTicking, away - VAULT_COUNTDOWN_TICK_MS)
    return () => {
      if (timer) clearTimeout(timer)
      if (interval) clearInterval(interval)
    }
  }, [until, watch])
  return vaultCountdown(status, now)
}
