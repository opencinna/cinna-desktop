import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AddAgentFolderInput,
  AddAgentFolderResult,
  AgentCredentialBinding,
  AgentRootDto,
  CreateLocalAgentInput,
  DeleteLocalAgentInput,
  DeleteLocalAgentResult,
  PickAgentFolderResult,
  DraftLocalAgentResult,
  FileStamp,
  LocalAgentDocDto,
  LocalAgentDto,
  LocalAgentDocKind,
  LocalAgentFieldUpdate,
  UpdateLocalAgentFieldInput
} from '../../../shared/localAgents'
import type { LocalAgentRuntimeInput } from '../../../shared/engine'
import type { GitDetail, GitStatus, GitUpdateResult } from '../../../shared/agentGit'
import type { StoredPermissionGrant } from '../../../shared/localAgentRequests'
import {
  isBlockedWriteError,
  isStaleWriteError,
  unwrapLocalAgentOutcome
} from '../../../shared/localAgents'
import {
  editFileText,
  receiveFileSnapshot,
  reloadFileEditor,
  saveBlocked,
  saveRefused,
  saveRequest,
  saveSucceeded,
  seedFileEditor,
  type FileEditorState
} from '../utils/localAgents'

/**
 * Folder agents, for the Agents tab and the agent page.
 *
 * The folders on disk are the truth, so this file holds no derived state of its
 * own: every query re-reads the folder through main, and every mutation returns
 * the freshly-scanned agent, which is written straight into the cache. When a
 * folder changes outside the app — an assistant editing it in a terminal, the
 * agent writing its own `STATUS.md` — main pushes `local-agent:changed` and
 * {@link useLocalAgentWatch} invalidates. Nothing polls.
 */

export const LOCAL_AGENTS_KEY = ['local-agents'] as const
export const LOCAL_AGENT_ROOTS_KEY = ['local-agent-roots'] as const
/**
 * Which credential each agent's runtime resolves to.
 *
 * Its own key rather than a field on {@link LOCAL_AGENTS_KEY}, because it goes
 * stale on a different event: the agent list moves when a *folder* changes, this
 * moves when the *credential* list does. `useUpsertProvider` and
 * `useDeleteProvider` drop it, and so does a folder change — a new agent has a
 * binding and a deleted one must lose it.
 */
export const AGENT_CREDENTIAL_BINDINGS_KEY = ['agent-credential-bindings'] as const
/**
 * `useAgents`' key — the list behind the composer `@` popup, the `[+]` picker
 * and the Jobs agent picker. A folder agent is a row in that list too, so a
 * create, a re-key or a delete has to refresh it, or the pickers keep offering
 * an agent whose runner will answer `not_found`. Otherwise that list is only
 * refreshed by a remote sync completing.
 */
const AGENTS_KEY = ['agents'] as const

export function localAgentKey(agentId: string): readonly unknown[] {
  return ['local-agent', agentId] as const
}

/** Cache key of one prompt document. Prefixed so a watcher push can drop them all. */
export function localAgentDocKey(
  agentId: string,
  prompt: LocalAgentDocKind
): readonly unknown[] {
  return ['local-agent-doc', agentId, prompt] as const
}

/** Cache key of one agent's standing permission grants. */
export function localAgentGrantsKey(agentId: string): readonly unknown[] {
  return ['local-agent-grants', agentId] as const
}

/** How long the page waits after the last keystroke before saving. */
const AUTOSAVE_DEBOUNCE_MS = 700

/**
 * How long to wait before retrying a save the agent's turn lock refused.
 *
 * Longer than the keystroke debounce because a turn runs for minutes, not
 * milliseconds — retrying at typing speed would be a busy-wait against a lock
 * nobody is about to release. This is the interim shape: the right one is a
 * `local-agent:unlocked` push from `turnLock.whenFree`, which would let the
 * editor sleep until the run actually ends instead of asking.
 */
const BLOCKED_RETRY_MS = 3000

export interface LocalAgentsSnapshot {
  roots: AgentRootDto[]
  agents: LocalAgentDto[]
}

/** Every root and every folder agent in them. Scans on each fetch. */
export function useLocalAgents() {
  return useQuery<LocalAgentsSnapshot>({
    queryKey: LOCAL_AGENTS_KEY,
    queryFn: () => window.api.localAgents.list()
  })
}

/**
 * Which AI credential each folder agent would run on.
 *
 * Read whenever a surface has to answer a question about an agent's credential
 * without opening the agent — the sidebar's status dot, and the confirm dialog
 * behind a credential's off switch. The judgement stays here: main returns the
 * binding, the caller joins it against the provider list it already has, so
 * "disabled" is decided in one place against one copy of `enabled`.
 */
export function useAgentCredentialBindings() {
  return useQuery<AgentCredentialBinding[]>({
    queryKey: AGENT_CREDENTIAL_BINDINGS_KEY,
    queryFn: () => window.api.localAgents.credentialBindings()
  })
}

/** One agent, re-read from its folder. Seeded from the list where possible. */
export function useLocalAgent(agentId: string | null) {
  return useQuery<LocalAgentDto>({
    queryKey: localAgentKey(agentId ?? ''),
    // Unwrapped here rather than in preload: `contextBridge` clones a rejection
    // into this world as a fresh `Error`, so a `code` attached on the other
    // side of it never arrives. Thrown here, it stays.
    queryFn: async () =>
      unwrapLocalAgentOutcome(await window.api.localAgents.get(agentId as string)),
    enabled: agentId !== null
  })
}

/**
 * One prompt document. Text and stamp arrive together, from a single read in
 * main, which is what makes the editor's save guard meaningful.
 */
export function useLocalAgentDoc(agentId: string | null, prompt: LocalAgentDocKind) {
  return useQuery<LocalAgentDocDto>({
    queryKey: localAgentDocKey(agentId ?? '', prompt),
    queryFn: () => window.api.localAgents.readDoc({ agentId: agentId as string, prompt }),
    enabled: agentId !== null
  })
}

/** The registered roots on their own — what Settings → Local Agents lists. */
export function useAgentRoots() {
  return useQuery<AgentRootDto[]>({
    queryKey: LOCAL_AGENT_ROOTS_KEY,
    queryFn: () => window.api.localAgents.rootsList()
  })
}

/**
 * Subscribe to main's folder-watch pushes for the app's lifetime. Mount once,
 * high in the tree — a second mount is harmless but redundant.
 */
export function useLocalAgentWatch(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    return window.api.localAgents.onChanged((payload) => {
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: AGENT_CREDENTIAL_BINDINGS_KEY })
      // The prompt documents live in their own cache entries — the DTO carries
      // their stamps but not their text — so a folder edit has to drop those
      // too, or an assistant's rewrite would never appear.
      if (payload.agentId) {
        void queryClient.invalidateQueries({ queryKey: localAgentKey(payload.agentId) })
        void queryClient.invalidateQueries({ queryKey: ['local-agent-doc', payload.agentId] })
      } else {
        // A whole-root push names no agent, and an edit to a **bare** agent's
        // own files is always one of these: `classifyExternalEvent` returns
        // `root` for an `AGENT.md` or a `README.md` basename, so the rescan
        // broadcasts `agentId: null`. Keyed invalidation therefore missed the
        // exact case the watcher exists for — the user rewrites the README in
        // their editor, comes back, and the card still shows the old one, with
        // `refetchOnWindowFocus` off and nothing else to correct it. The
        // prefixes are what the open page holds, so this refetches one agent
        // and its one visible document, not the list.
        void queryClient.invalidateQueries({ queryKey: ['local-agent'] })
        void queryClient.invalidateQueries({ queryKey: ['local-agent-doc'] })
      }
    })
  }, [queryClient])
}

/** Scaffold a new agent folder. Resolves once the folder exists on disk. */
export function useCreateLocalAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateLocalAgentInput) => window.api.localAgents.create(input),
    onSuccess: (agent) => {
      queryClient.setQueryData(localAgentKey(agent.id), agent)
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
    }
  })
}

/**
 * Save one field back to the folder.
 *
 * `expectedStamp` must be the stamp the editor read — `agent.stamps[<path>]`.
 * A save over a file that changed underneath is refused by main, and that
 * rejection is the reload prompt's trigger, so it must be surfaced rather than
 * retried.
 */
export function useUpdateLocalAgentField() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: UpdateLocalAgentFieldInput) =>
      unwrapLocalAgentOutcome(await window.api.localAgents.updateField(input)),
    onSuccess: (agent) => {
      queryClient.setQueryData(localAgentKey(agent.id), agent)
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
    }
  })
}

/**
 * What this agent may do without asking again.
 *
 * Not part of `useLocalAgent`: grants live in `app-data/desktop.json`, which
 * the scanner deliberately does not fold into the agent DTO — that file churns
 * on every turn, and a DTO that moved with it would re-render the whole page
 * mid-answer. A separate query also means the permissions card refetches only
 * when it is on screen.
 */
export function useLocalAgentGrants(agentId: string | null) {
  return useQuery<StoredPermissionGrant[]>({
    queryKey: localAgentGrantsKey(agentId ?? ''),
    queryFn: () => window.api.localAgents.grantsList(agentId as string),
    enabled: agentId !== null
  })
}

/**
 * Revoke a grant — one, or all of them.
 *
 * Both handlers answer with the list they leave, which is written straight into
 * the cache: revoking is the only action on that card, and a refetch would keep
 * the removed row on screen until it landed.
 *
 * The mutation is owned by the card, which outlives its own rows — the dialog
 * lesson from `ux_rules.md` §5 applies to a row that unmounts on success just
 * as it does to a dialog that closes on it.
 */
export function useForgetAgentGrants() {
  const queryClient = useQueryClient()
  return useMutation<StoredPermissionGrant[], Error, { agentId: string; key?: string }>({
    mutationFn: ({ agentId, key }) =>
      key === undefined
        ? window.api.localAgents.grantsClear(agentId)
        : window.api.localAgents.grantForget(agentId, key),
    onSuccess: (grants, { agentId }) => {
      queryClient.setQueryData(localAgentGrantsKey(agentId), grants)
    }
  })
}

/**
 * Give a legacy folder a durable identity.
 *
 * The same `update-field` write as every other card, guarded by the manifest
 * stamp the page read — this is a deliberate edit to the user's manifest, not a
 * repair the app performs on its own. The UUID is minted in main.
 *
 * Re-keying is the point and the catch: the agent's row id changes from the
 * positional `folder:legacy:…` to `folder:<uuid>`, so the caller has to follow
 * the selection to the returned agent or the page is left pointing at an id
 * that no longer exists.
 */
export function useStampAgentIdentity() {
  const queryClient = useQueryClient()
  return useMutation<LocalAgentDto, Error, { agentId: string; expectedStamp: FileStamp }>({
    mutationFn: async ({ agentId, expectedStamp }) =>
      unwrapLocalAgentOutcome(
        await window.api.localAgents.updateField({
          agentId,
          update: { field: 'stamp_identity' },
          expectedStamp
        })
      ),
    onSuccess: (agent) => {
      queryClient.setQueryData(localAgentKey(agent.id), agent)
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
    }
  })
}

/**
 * Save which credential and model this agent runs on.
 *
 * The same stamped `update-field` write as every other card — `expectedStamp`
 * is the manifest's stamp from `agent.stamps['cinna-agent.json']` — so an
 * assistant editing `cinna-agent.json` while the picker is open cannot be
 * clobbered, and a refusal arrives with the code that tells a reload prompt
 * apart from a retry.
 */
export function useSetLocalAgentRuntime() {
  const queryClient = useQueryClient()
  return useMutation<
    LocalAgentDto,
    Error,
    { agentId: string; expectedStamp: FileStamp; runtime: LocalAgentRuntimeInput }
  >({
    mutationFn: async ({ agentId, expectedStamp, runtime }) =>
      unwrapLocalAgentOutcome(
        await window.api.localAgents.updateField({
          agentId,
          update: { field: 'runtime', value: runtime },
          expectedStamp
        })
      ),
    onSuccess: (agent) => {
      queryClient.setQueryData(localAgentKey(agent.id), agent)
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
    }
  })
}

/**
 * Save which credential and model a **bare** agent runs on.
 *
 * The same choice as {@link useSetLocalAgentRuntime} and a different place to
 * put it: a bare folder has no `cinna-agent.json`, so there is no stamp to
 * guard the write with and nothing in the user's folder is touched — the value
 * lands in that agent's own state under `userData`. Which means no stale-write
 * refusal is possible here, and the panel's reload prompt has nothing to say.
 */
export function useSetBareAgentRuntime() {
  const queryClient = useQueryClient()
  return useMutation<LocalAgentDto, Error, { agentId: string; runtime: LocalAgentRuntimeInput }>({
    mutationFn: async ({ agentId, runtime }) =>
      unwrapLocalAgentOutcome(await window.api.localAgents.setRuntime(agentId, runtime)),
    onSuccess: (agent) => {
      queryClient.setQueryData(localAgentKey(agent.id), agent)
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
    }
  })
}

/**
 * Move the agent's folder to the Trash and forget it.
 *
 * Only the list is invalidated. The page's own entry is deliberately left
 * alone: removing it while the page still observes it would make react-query
 * refetch a row that no longer exists, and the caller clears the selection —
 * which unmounts that observer — in its own `onSuccess`, right after this
 * one. The stale entry is garbage-collected with nothing watching it.
 * `turn_in_progress` arrives with its code intact (an outcome, unwrapped here
 * like `get`), so the dialog can say the agent is busy rather than that
 * something failed.
 */
export function useDeleteLocalAgent(options?: {
  /**
   * Runs at hook level, so it survives the unmount of whatever called
   * `mutate` — the place to clear a selection the row no longer backs.
   */
  onSuccess?: (result: DeleteLocalAgentResult) => void
}) {
  const queryClient = useQueryClient()
  return useMutation<DeleteLocalAgentResult, Error, DeleteLocalAgentInput>({
    mutationFn: async (input: DeleteLocalAgentInput) =>
      unwrapLocalAgentOutcome(await window.api.localAgents.delete(input)),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
      options?.onSuccess?.(result)
    }
  })
}

/** Force a rescan — the Settings refresh, and the recovery path after an error. */
export function useRescanLocalAgents() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (rootId?: string) => window.api.localAgents.rescan(rootId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENT_ROOTS_KEY })
    }
  })
}

/** Adopt a folder as an extra root. Main opens the OS picker. */
export function useAddAgentRoot() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.localAgents.rootAdd(),
    onSuccess: (result) => {
      if (result.cancelled) return
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENT_ROOTS_KEY })
    }
  })
}

/** Forget an extra root. The folder on disk is untouched. */
export function useRemoveAgentRoot(options?: {
  /**
   * Runs at hook level, so it survives the unmount of whatever called
   * `mutate` — the place to close the confirm dialog the click came from,
   * which is itself unmounted by the close.
   */
  onSuccess?: () => void
}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (rootId: string) => window.api.localAgents.rootRemove(rootId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENT_ROOTS_KEY })
      options?.onSuccess?.()
    }
  })
}

/** Reveal a file inside an agent folder in Finder / Explorer. */
export function useOpenAgentPath() {
  return useMutation({
    mutationFn: (input: { agentId: string; relPath?: string }) =>
      window.api.localAgents.openPath(input)
  })
}

/**
 * Open the agent's `credentials/.env` for editing, created on the spot when it
 * is not there yet. The "Add them in credentials/.env" affordance leads here
 * rather than to {@link useOpenAgentPath}: the label promises a file, and a
 * reveal of the folder leaves the user to find (or create) it themselves.
 */
export function useOpenAgentCredentials() {
  return useMutation({
    mutationFn: (agentId: string) => window.api.localAgents.openCredentials(agentId)
  })
}

/**
 * Copy the agent's init prompt to the clipboard.
 *
 * The prompt is built in main — it is the only side that knows which entry
 * document the folder has — and written to the clipboard here, in the renderer,
 * where every other copy in the app happens. Both halves are inside the
 * mutation so a clipboard the browser refuses is a failed mutation the caller
 * reports, not a silent no-op: the menu item would otherwise say "Copied" over
 * an empty clipboard.
 */
export function useCopyAgentInitPrompt() {
  return useMutation({
    mutationFn: async (agentId: string): Promise<string> => {
      const prompt = await window.api.localAgents.initPrompt(agentId)
      try {
        await navigator.clipboard.writeText(prompt)
      } catch {
        // A `DOMException` *is* an `Error`, so `unwrapIpcError` would take its
        // message verbatim and show the user Chromium's own words — "Document
        // is not focused." is what a notification stealing focus mid-copy
        // produces. Say it in ours instead.
        throw new Error('Could not copy the prompt to the clipboard.')
      }
      return prompt
    }
  })
}

/** Run the kit validator over one folder on demand. */
export function useValidateLocalAgent() {
  return useMutation({
    mutationFn: (agentId: string) => window.api.localAgents.validate(agentId)
  })
}

/**
 * Draft the prompts of a freshly created agent with one AI call.
 *
 * Resolves rather than rejects when there is no AI credential — `status` says
 * `skipped` and `reason` says what to add — so the create flow never depends on
 * a configured model.
 */
export function useDraftLocalAgent() {
  const queryClient = useQueryClient()
  return useMutation<DraftLocalAgentResult, Error, string>({
    mutationFn: (agentId: string) => window.api.localAgents.draft(agentId),
    onSuccess: (result) => {
      queryClient.setQueryData(localAgentKey(result.agent.id), result.agent)
      void queryClient.invalidateQueries({ queryKey: ['local-agent-doc', result.agent.id] })
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
    }
  })
}

/** What one in-place editor on the agent page exposes to its card. */
export interface AgentFileEditor {
  text: string
  setText: (text: string) => void
  /** Save now rather than at the end of the debounce — call it on blur. */
  flushNow: () => void
  /** False when the file is missing, so the card can render read-only. */
  canSave: boolean
  isSaving: boolean
  /** Set when the folder moved underneath — the card shows a reload prompt. */
  conflict: FileEditorState['conflict']
  /**
   * True while a save is waiting for the agent's turn to finish. Not an error
   * and not a conflict: the text is intact and the save is still coming.
   */
  blocked: boolean
  /** What the file says now, for the reload prompt's preview. */
  diskText: string | null
  /** Take what is on disk, dropping the unsaved edits. */
  reload: () => void
  /** A refusal that was *not* a conflict — a value main would not accept. */
  error: string | null
}

/**
 * An in-place editor over one file in an agent folder, with autosave.
 *
 * The rule this exists to hold is Invariant 3: the save hands back the stamp
 * the rendered text was read with, never a fresher one. The state machine
 * itself is pure and lives in `utils/localAgents` — this hook is the React
 * glue: debounce, mutation, and the cache write that keeps a refetch from
 * racing the save that just landed.
 *
 * A refused save is **never retried**. It sets `conflict`, the card shows a
 * reload prompt, and only the user's choice clears it. Retrying with a fresh
 * stamp is exactly the overwrite the refusal prevented.
 */
export function useAgentFileEditor(input: {
  agentId: string | null
  /** Agent-relative path — the key into `LocalAgentDto.stamps`. */
  relPath: string
  /** Text and stamp from one read of the folder. `undefined` while loading. */
  snapshot: { text: string; stamp: FileStamp | null } | undefined
  /** The update this editor sends. */
  toUpdate: (text: string) => LocalAgentFieldUpdate
  /**
   * What the folder now holds, read back from the agent the save returned.
   * Defaults to the text that was sent — right for the prompt documents, which
   * main writes verbatim; the manifest cards pass their normalised value.
   */
  readBack?: (agent: LocalAgentDto, sent: string) => string
  /**
   * Set for a prompt document: its text lives in its own cache entry rather
   * than in the agent DTO, so the save has to reseed that entry too. A prompt
   * kind rather than a key, so the hook's memoised callbacks depend on a
   * string instead of a freshly-built array.
   */
  docPrompt?: LocalAgentDocKind
  /**
   * Reject the text before it is sent, returning the message to show. Lets a
   * card say *which line* is wrong — main can only answer "one of these is too
   * long", which against a ten-line textarea is not something a user can act on.
   */
  validate?: (text: string) => string | null
}): AgentFileEditor {
  const { agentId, relPath, snapshot, toUpdate, readBack, docPrompt, validate } = input
  const queryClient = useQueryClient()
  const { mutate: saveField, isPending } = useUpdateLocalAgentField()
  // Callbacks the card rebuilds every render. Held in refs so `persist` stays
  // stable: a `persist` that changed identity on an unrelated parent render
  // would restart the autosave timer, and a user typing steadily in a busy
  // window would never reach the end of one.
  const toUpdateRef = useRef(toUpdate)
  toUpdateRef.current = toUpdate
  const readBackRef = useRef(readBack)
  readBackRef.current = readBack
  const validateRef = useRef(validate)
  validateRef.current = validate
  const [state, setState] = useState<FileEditorState>(() =>
    seedFileEditor(relPath, snapshot?.text ?? '', snapshot?.stamp ?? null)
  )
  const [error, setError] = useState<string | null>(null)
  // The editor is keyed by (agent, file); a change to either is a new document,
  // not an outside edit, so it reseeds rather than raising a conflict.
  const identityRef = useRef<string>(`${agentId ?? ''}|${relPath}`)
  const stateRef = useRef(state)
  stateRef.current = state
  /** The armed debounce timer, so `persist` can cancel the one it supersedes. */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** True between sending a save and its settling. Guards a second send. */
  const inFlightRef = useRef(false)

  useEffect(() => {
    const identity = `${agentId ?? ''}|${relPath}`
    if (identityRef.current === identity) return
    identityRef.current = identity
    setError(null)
    setState(seedFileEditor(relPath, snapshot?.text ?? '', snapshot?.stamp ?? null))
  }, [agentId, relPath, snapshot])

  // A newly-read snapshot: adopted while the editor is clean, held back as a
  // conflict while it is not.
  useEffect(() => {
    if (!snapshot) return
    setState((current) => receiveFileSnapshot(current, snapshot.text, snapshot.stamp))
  }, [snapshot?.text, snapshot?.stamp?.hash])

  const persist = useCallback(() => {
    // Whatever brought us here — the timer firing or a blur — the armed timer
    // is now spent, so drop it.
    //
    // Narrower than it looks, and the narrowness is the point: this block is
    // **not** what stops the duplicate save. Delete it and both halves of the
    // in-flight race still hold, because every path that sends puts a fresh
    // object into `state`, which re-runs the debounce effect and lets its
    // cleanup tear the old timer down. That race is the `inFlightRef` guard's,
    // below — see the two "autosave race" tests in
    // `useLocalAgents.autosave.test.tsx`, which pass with this block removed.
    //
    // What it does hold is the one path that returns having sent *nothing* and
    // changed *nothing*: a flush the `validate` call below rejects. `state` is
    // untouched there, so the effect never re-runs and nothing else would clear
    // the superseded timer — it would fire and re-validate on its own. Clearing
    // it here is what keeps a rejected edit sitting still until the user types
    // again. Pinned by "leaves no timer armed behind it" in that same file.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // One save at a time. This is the guard that closes the W1 race, and it is
    // the only one that does: a second request built from the pre-save stamp is
    // guaranteed to be refused, because main re-reads the file at write time
    // and the first save has already spent that stamp. `flushNow` at t=200 used
    // to leave the t=700 timer armed, and that second save went out with the
    // *same* stamp while the first was still in flight. The first landed, the
    // second was refused as `manifest_modified`, and the user was told their
    // file had changed on disk — for a save that had just succeeded, with
    // Reload (which discards their text) the only way out.
    //
    // Work typed while this one is in flight is not lost — the settle handler
    // changes `state`, which re-runs the effect below and arms a fresh timer
    // for it, built from the stamp the save returned.
    if (inFlightRef.current) return
    const current = stateRef.current
    const request = saveRequest(current)
    if (!request || agentId === null) return
    const sent = request.text
    const problem = validateRef.current?.(sent) ?? null
    if (problem !== null) {
      // Not sent at all. `state` is untouched, so no new timer is armed and this
      // does not spin — the next keystroke is what tries again.
      setError(problem)
      return
    }
    inFlightRef.current = true
    saveField(
      { agentId, update: toUpdateRef.current(sent), expectedStamp: request.expectedStamp },
      {
        onSuccess: (agent) => {
          inFlightRef.current = false
          const savedText = readBackRef.current ? readBackRef.current(agent, sent) : sent
          const stamp = agent.stamps[relPath] ?? null
          setError(null)
          setState((prev) => saveSucceeded(prev, savedText, stamp))
          if (docPrompt && agentId) {
            // Two things at once: drop an in-flight read that would resolve
            // with the pre-save bytes, and seed the cache with what was just
            // written so the next mount does not flash the old text.
            const docKey = localAgentDocKey(agentId, docPrompt)
            void queryClient.cancelQueries({ queryKey: docKey })
            queryClient.setQueryData<LocalAgentDocDto>(docKey, { relPath, text: savedText, stamp })
          }
        },
        onError: (err) => {
          inFlightRef.current = false
          if (isStaleWriteError(err)) {
            setState((prev) => saveRefused(prev, null))
            if (docPrompt && agentId) {
              void queryClient.invalidateQueries({ queryKey: localAgentDocKey(agentId, docPrompt) })
            }
            if (agentId) void queryClient.invalidateQueries({ queryKey: localAgentKey(agentId) })
            return
          }
          if (isBlockedWriteError(err)) {
            // A turn holds the agent. Nothing was written and nothing changed
            // underneath, so this is a "not yet", not a refusal: keep the text,
            // say so quietly, and let the effect below re-arm. Reporting it as
            // an error left the edit with no timer and no path back — the user
            // lost it the moment they navigated away.
            setError(null)
            setState((prev) => saveBlocked(prev))
            return
          }
          setError(err instanceof Error ? err.message : 'Could not save that.')
        }
      }
    )
  }, [agentId, relPath, docPrompt, saveField, queryClient])

  // Debounced autosave. A conflict stops it at `saveRequest`, so the timer can
  // keep running harmlessly rather than being torn down conditionally. A
  // *blocked* save is different — it is waiting on a lock held for the length
  // of a turn, so it backs off rather than asking at typing speed.
  useEffect(() => {
    if (saveRequest(state) === null) return
    const handle = setTimeout(persist, state.blocked ? BLOCKED_RETRY_MS : AUTOSAVE_DEBOUNCE_MS)
    timerRef.current = handle
    return () => {
      clearTimeout(handle)
      if (timerRef.current === handle) timerRef.current = null
    }
  }, [state, persist])

  return {
    text: state.text,
    setText: (text: string) => setState((current) => editFileText(current, text)),
    flushNow: persist,
    canSave: state.stamp !== null,
    isSaving: isPending,
    conflict: state.conflict,
    blocked: state.blocked,
    diskText: state.diskText,
    reload: () => {
      setError(null)
      setState((current) =>
        reloadFileEditor(current, snapshot?.text ?? current.text, snapshot?.stamp ?? null)
      )
    },
    error
  }
}

/**
 * Ask for a folder and preview the agents in it.
 *
 * A mutation rather than a query: it opens a native dialog, so it must run only
 * when the user asks, and it has no cache key that would mean anything.
 */
export function usePickAgentFolder() {
  return useMutation<PickAgentFolderResult, Error, void>({
    mutationFn: () => window.api.localAgents.folderPick()
  })
}

/** Adopt the folder just previewed, with the agents the user ticked. */
export function useAddAgentFolder() {
  const queryClient = useQueryClient()
  return useMutation<AddAgentFolderResult, Error, AddAgentFolderInput>({
    mutationFn: async (input) =>
      unwrapLocalAgentOutcome(await window.api.localAgents.folderAdd(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENT_ROOTS_KEY })
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
      // Every open agent page too, by key prefix. A re-selection edits agents
      // that already exist — one of them may be the page behind this dialog —
      // and the list keys above do not reach `localAgentKey(id)`, so that page
      // would keep rendering the row as it was before the save.
      void queryClient.invalidateQueries({ queryKey: ['local-agent'] })
    }
  })
}

/** Rename a bare agent. Kit agents rename through `useUpdateLocalAgentField`. */
export function useRenameLocalAgent() {
  const queryClient = useQueryClient()
  return useMutation<LocalAgentDto, Error, { agentId: string; name: string | null }>({
    mutationFn: async ({ agentId, name }) =>
      unwrapLocalAgentOutcome(await window.api.localAgents.rename(agentId, name)),
    onSuccess: (agent) => {
      queryClient.setQueryData(localAgentKey(agent.id), agent)
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
    }
  })
}


/** Cache key of one root's repository detail. */
export function gitDetailKey(rootId: string): readonly unknown[] {
  return ['local-agent-git-detail', rootId] as const
}

/**
 * Remotes, branches and the head commit — the Repository dialog's read.
 *
 * `enabled` is the dialog being open: this runs three extra git commands, and
 * the settings list renders one row per root. Nothing here reaches the network
 * — the counts it shows come from the `gitStatus` this extends, which fetches
 * only when the user presses Check.
 */
export function useGitDetail(rootId: string, enabled: boolean) {
  return useQuery<GitDetail>({
    queryKey: gitDetailKey(rootId),
    queryFn: () => window.api.localAgents.gitDetail(rootId, false),
    enabled: enabled && rootId !== '',
    staleTime: 30_000
  })
}

/**
 * The agent list of a root already registered, for Manage agents.
 *
 * A mutation rather than a query: main records the folder as the pending pick
 * as a side effect, which is what lets the existing `folderAdd` accept the new
 * selection. A query would re-run that side effect on every refocus.
 */
export function useManageRootAgents() {
  return useMutation<PickAgentFolderResult, Error, string>({
    mutationFn: (rootId: string) => window.api.localAgents.rootManage(rootId)
  })
}

/**
 * Fetch from the remote and report what is now available. The explicit check.
 *
 * The fetch's whole point is the *counts* it moves, and the surface showing
 * them reads {@link gitDetailKey} — so this invalidates that, rather than
 * writing the `GitStatus` it gets back into a key of its own. It cannot write
 * the detail directly: what comes back is the status half, and a `setQueryData`
 * of it would drop the remotes, branches and head commit the dialog is also
 * rendering.
 *
 * Without this the button was inert on screen: main really fetched, `behind`
 * really moved, and the dialog went on saying "Up to date as of the last check"
 * with no Update button, because nothing it read had changed.
 */
export function useCheckForUpdates() {
  const queryClient = useQueryClient()
  return useMutation<GitStatus, Error, string>({
    mutationFn: (rootId: string) => window.api.localAgents.gitStatus(rootId, true),
    onSuccess: (_status, rootId) => {
      void queryClient.invalidateQueries({ queryKey: gitDetailKey(rootId) })
    }
  })
}

/**
 * Fast-forward a root, and refresh everything the pull can have changed.
 *
 * A pull can add an agent folder, remove one and rewrite an `AGENT.md`, so the
 * agents list, the roots and the merged agents list are all invalidated — not
 * only the git panel that triggered it.
 */
export function useUpdateFromGit() {
  const queryClient = useQueryClient()
  return useMutation<GitUpdateResult, Error, string>({
    mutationFn: (rootId: string) => window.api.localAgents.gitUpdate(rootId),
    onSuccess: (result, rootId) => {
      // Same reason as the check: the dialog reads the detail, and after a pull
      // `behind` is zero and the head commit has moved, so both halves of what
      // it renders are stale.
      void queryClient.invalidateQueries({ queryKey: gitDetailKey(rootId) })
      if (!result.updated) return
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENT_ROOTS_KEY })
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
    }
  })
}
