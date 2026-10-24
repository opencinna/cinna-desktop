import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ArrowLeft, Loader2, Plus, RefreshCw, Search, Terminal, X } from 'lucide-react'
import {
  DEFAULT_ADDON_POLICY,
  addonRefKey,
  sameAddonRef,
  type AddonKind,
  type AddonRef,
  type AgentDirectoryEntry
} from '../../../../../shared/addons/directory'
import type { AgentEngine } from '../../../../../shared/engine'
import {
  useAddAddon,
  useAddonAdds,
  useAddonDirectory,
  useAddonSearch,
  useRefreshAddonDirectory,
  useRemoveAddon,
  settledAddonAdds,
  type AddonAddRun
} from '../../../hooks/useAddonDirectory'
import { useQueryClient } from '@tanstack/react-query'
import { unwrapIpcError } from '../../../utils/ipcError'
import { CATALOG_TEXT } from '../../../utils/catalogItems'
import { useCatalogReauth } from '../CatalogBrowserParts'
import { unsupportedSentence } from '../../../utils/marketplaceSkills'
import { AddCustomMcpForm } from '../../settings/AddCustomMcpForm'
import { AddLocalMcpForm } from '../../settings/AddLocalMcpForm'
import { ADDON_KIND, AddonKindLabel } from './AddonRow'
import { AddonPickerDetail, PICKER_SECONDARY, PICKER_TEXT, type AddFlow } from './AddonPickerDetail'

/** The registry is asked this long after the last keystroke. */
export const REGISTRY_DEBOUNCE_MS = 300
/** …and only for a query at least this long. */
export const REGISTRY_MIN_QUERY = 2

/** Kinds the chips offer, in this order; a kind with no entry is not offered. */
const KINDS: AddonKind[] = ['skill', 'plugin', 'mcp']

/** Whether an entry matches the search: its title, name, summary, source, publisher or tags. */
export function addonMatches(entry: AgentDirectoryEntry, needle: string): boolean {
  if (!needle) return true
  return [entry.title, entry.name, entry.summary, entry.origin.label, entry.publisher?.name ?? '', ...entry.tags].some((text) =>
    text.toLowerCase().includes(needle)
  )
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return debounced
}

const TOOL_INPUT =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px] text-[var(--color-text)] ' +
  'focus:border-[var(--color-accent)] focus:outline-none'

/** One entry in the picker's grid: kind, title, one line of summary, where it is from, and where it stands. */
function AddonTile({ entry, stateLine, onSelect }: { entry: AgentDirectoryEntry; stateLine: string | null; onSelect: () => void }): React.JSX.Element {
  const describedBy = useId()
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={entry.title}
      aria-describedby={describedBy}
      data-addon-tile={addonRefKey(entry.ref).replace('\u0000', ':')}
      data-addon-state={entry.state}
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 text-left transition-colors hover:border-[var(--color-accent)]/40"
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <AddonKindLabel kind={entry.kind} />
        <span title={entry.title} className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--color-text)]">
          {entry.title}
        </span>
      </span>
      <span id={describedBy} className="flex w-full min-w-0 flex-col gap-1">
        {entry.summary && (
          <span title={entry.summary} className="block w-full truncate text-[13px] text-[var(--color-text-secondary)]">
            {entry.summary}
          </span>
        )}
        <span title={entry.origin.label} className="block w-full truncate text-[12px] text-[var(--color-text-muted)]">
          {entry.origin.label}
          {entry.version ? ` · ${entry.version}` : ''}
        </span>
        {stateLine && (
          <span data-addon-state-line className="block w-full truncate text-[12px] text-[var(--color-text-muted)]" title={stateLine}>
            {stateLine}
          </span>
        )}
      </span>
    </button>
  )
}

type CustomPanel = 'choose' | 'remote' | 'local'

/** How long a refused add from an earlier opening of the picker still shows on its entry. */
export const EARLIER_REFUSAL_MS = 5 * 60_000

/**
 * Where one entry's add stands in this picker, from the add itself (kept in
 * the mutation cache by agent and entry, so closing the picker loses
 * nothing): running is always shown; how it ended for an add that had not
 * ended when this opening began. Of an older one only a refusal shows — for
 * {@link EARLIER_REFUSAL_MS} from when it was asked, or until the entry's
 * next Add replaces it — since nothing else says it failed (one that ran on
 * after the picker closed was never seen). An older success is the
 * directory's state now (an added connector still needing a step offers it).
 */
export function addFlowOf(run: AddonAddRun | undefined, settledAtOpen: ReadonlySet<number>, now: number = Date.now()): AddFlow | null {
  if (!run || run.status === 'idle') return null
  if (run.status === 'pending') return { phase: 'adding' }
  const refusal = run.status === 'error' ? unwrapIpcError(run.error) : run.result && !run.result.ok ? run.result.message : null
  if (settledAtOpen.has(run.mutationId)) return refusal !== null && now - run.submittedAt < EARLIER_REFUSAL_MS ? { phase: 'idle', error: refusal } : null
  if (refusal !== null) return { phase: 'idle', error: refusal }
  const result = run.result
  if (!result || !result.ok) return null
  if (result.next && result.mcpProviderId) {
    return { phase: 'setup', next: result.next, mcpProviderId: result.mcpProviderId, ...(result.message ? { message: result.message } : {}) }
  }
  // A plugin's add names no connector: its status says which of its connectors needs the step.
  if (result.next) return { phase: 'pluginSetup', next: result.next }
  return { phase: 'ready' }
}

/**
 * One Add over every source this computer and the signed-in account may use
 * (the addon directory): Cinna's catalog and marketplace skills, the
 * connectors already on this computer, the MCP registries — and, below the
 * results, the public MCP registry's search. Replaces the separate skill and
 * connector pickers (unified addons D3).
 *
 * A fixed-size glass modal: nothing in it changes size while the user types,
 * switches a filter or opens an entry (ux_rules rule 1). The list is filtered
 * locally per keystroke; the registry is asked after a debounce. An entry's
 * detail opens over the list, which stays laid out underneath, so Back finds
 * the search, the filters and the scroll where they were. After an Add the
 * modal stays and shows the next step in place; a refusal closes nothing
 * (rule 6). A source that failed says so once, quietly, in the footer.
 *
 * "Custom connector…" opens the forms Settings → MCP uses; the connector
 * created there is attached through `onAttachCreated`, which the tab owns so
 * it outlives the modal. While one of those forms (or a key / settings step)
 * holds input, Escape and a click outside close nothing.
 */
export function AddonPicker({
  agent,
  skillBlock = null,
  initial,
  onClose,
  onAttachCreated
}: {
  /** `engine`: what the agent runs on, which a plugin's "Works with" lists first. */
  agent: { id: string; name: string; kit: boolean; engine?: AgentEngine | null }
  /** Why no skill can be added to this agent now (a team agent shared to use only), or null. */
  skillBlock?: string | null
  /**
   * Open straight at this entry's detail once the directory is read (a
   * manifest connector that needs setup); when the directory does not list
   * it, the search starts with `query` instead. `custom`: a manifest
   * connector no directory lists — the picker opens at Custom connector…,
   * on the form for its transport, with its name filled in.
   */
  initial?: { ref: AddonRef | null; query: string; custom?: { name: string; transport: 'stdio' | 'http' | 'sse' } }
  onClose: () => void
  /** Attach a connector created from Custom connector…; rejects with the reason. */
  onAttachCreated: (mcpProviderId: string) => Promise<void>
}): React.ReactPortal {
  // One fresh read per opening, past the sources' caches: an earlier opening's answer shows meanwhile.
  const directory = useAddonDirectory(agent.id, { refreshOnMount: true })
  const refreshDirectory = useRefreshAddonDirectory(agent.id)
  const reauth = useCatalogReauth({ refetch: refreshDirectory })
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<AddonKind | 'all'>('all')
  const [source, setSource] = useState('')
  const [selected, setSelected] = useState<AgentDirectoryEntry | null>(null)
  // The adds live in the mutation cache (closing the picker forgets none); removes and finished setups are this opening's.
  const queryClient = useQueryClient()
  const [settledAtOpen] = useState(() => settledAddonAdds(queryClient, agent.id))
  const adds = useAddonAdds(agent.id)
  const [localFlows, setLocalFlows] = useState<Record<string, AddFlow>>({})
  const [panel, setPanel] = useState<CustomPanel | null>(() =>
    initial?.custom ? (initial.custom.transport === 'stdio' ? 'local' : 'remote') : null
  )
  const [stepDirty, setStepDirty] = useState(false)
  const [createError, setCreateError] = useState('')
  const add = useAddAddon()
  const remove = useRemoveAddon()
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])

  const policy = directory.data?.policy ?? DEFAULT_ADDON_POLICY
  const entries = useMemo(() => directory.data?.entries ?? [], [directory.data])
  const sources = directory.data?.sources ?? []
  const needle = query.trim().toLowerCase()
  const debounced = useDebounced(query.trim(), REGISTRY_DEBOUNCE_MS)
  const registryOn = policy.externalDirectories && needle.length >= REGISTRY_MIN_QUERY
  const registry = useAddonSearch(registryOn && debounced.length >= REGISTRY_MIN_QUERY ? agent.id : null, debounced)

  // The entry this opening was asked to show, once: found, its detail opens; not listed, the search starts with its name.
  const initialDone = useRef(!initial || !!initial.custom)
  useEffect(() => {
    if (initialDone.current || directory.data === undefined || !initial) return
    initialDone.current = true
    const found = initial.ref ? entries.find((entry) => sameAddonRef(entry.ref, initial.ref)) : undefined
    if (found) setSelected(found)
    else setQuery(initial.query)
  }, [directory.data, entries, initial])

  // A custom manifest connector opened its form at once; a policy that turns custom (or local) connectors off sends it to the search instead.
  const customChecked = useRef(!initial?.custom)
  useEffect(() => {
    if (customChecked.current || directory.data === undefined || !initial?.custom) return
    customChecked.current = true
    const allowed = directory.data.policy
    if (!allowed.customMcp || (initial.custom.transport === 'stdio' && !allowed.stdioMcp)) {
      setPanel(null)
      setQuery(initial.query)
    }
  }, [directory.data, initial])

  const keyOf = (entry: AgentDirectoryEntry): string => addonRefKey(entry.ref)
  const listed = useMemo(() => new Set(entries.map((entry) => addonRefKey(entry.ref))), [entries])
  const passes = useCallback(
    (entry: AgentDirectoryEntry): boolean =>
      (kind === 'all' || entry.kind === kind) && (!source || entry.provider === source) && addonMatches(entry, needle),
    [kind, source, needle]
  )
  const shown = useMemo(() => entries.filter(passes), [entries, passes])
  // The registry's own search is already the match; only the chips and the source narrow it.
  const more = useMemo(
    () =>
      (registry.data?.entries ?? []).filter(
        (entry) => !listed.has(addonRefKey(entry.ref)) && (kind === 'all' || entry.kind === kind) && (!source || entry.provider === source)
      ),
    [registry.data, listed, kind, source]
  )
  const kinds = KINDS.filter((k) => entries.some((entry) => entry.kind === k) || (k === 'mcp' && policy.externalDirectories))
  const showRegistry = registryOn && (!source || source === 'mcp-registries') && (kind === 'all' || kind === 'mcp')

  /** The picker's own gate: a skill on an agent whose pins are not the user's to change. */
  const gated = (entry: AgentDirectoryEntry): { state: AgentDirectoryEntry['state']; reason: string | null } => {
    if (skillBlock && entry.kind !== 'mcp' && (entry.state === 'addable' || entry.state === 'addable_with_setup' || entry.state === 'partly_compatible')) {
      return { state: 'blocked', reason: skillBlock }
    }
    // Core sends why it could not prepare a marketplace skill as a code; the sentence is ours.
    if (entry.state === 'blocked' && entry.status === 'unsupported' && entry.unsupportedReason && entry.ref.source === 'core-marketplace') {
      return { state: entry.state, reason: unsupportedSentence(entry.unsupportedReason) }
    }
    return { state: entry.state, reason: entry.stateReason }
  }
  const stateLine = (entry: AgentDirectoryEntry): string | null => {
    const { state, reason } = gated(entry)
    // An added connector that still needs a step says which ("Added — needs you to sign in").
    return state === 'added' && !entry.setupStep ? PICKER_TEXT.added : reason
  }

  // The detail follows the entry through re-reads; one made into a local connector by its add is found by that id.
  // An add in flight (or one this opening made) wins over a remove or a finished setup only while it is running.
  const flowOf = (key: string): AddFlow => {
    const fromAdd = addFlowOf(adds.get(key), settledAtOpen)
    const local = localFlows[key]
    if (fromAdd?.phase === 'adding') return fromAdd
    return local && (!fromAdd || (local.at ?? 0) >= (adds.get(key)?.submittedAt ?? 0)) ? local : (fromAdd ?? { phase: 'idle' })
  }
  const setFlow = (key: string, flow: AddFlow): void => setLocalFlows((all) => ({ ...all, [key]: { ...flow, at: Date.now() } }))
  const selectedKey = selected ? keyOf(selected) : null
  const selectedFlow = selectedKey ? flowOf(selectedKey) : null
  const current = useMemo(() => {
    if (!selected) return null
    const key = addonRefKey(selected.ref)
    const all = [...entries, ...(registry.data?.entries ?? [])]
    // After its setup was put off the flow no longer names the connector; the add that made it still does.
    const made = adds.get(key)?.result
    const providerId =
      selectedFlow?.phase === 'setup' ? selectedFlow.mcpProviderId : (selected.mcpProviderId ?? (made?.ok ? made.mcpProviderId : undefined))
    return all.find((entry) => addonRefKey(entry.ref) === key) ?? (providerId ? all.find((entry) => entry.mcpProviderId === providerId) : undefined) ?? selected
  }, [selected, entries, registry.data, selectedFlow, adds])

  // Its outcome is read back from the mutation cache (`adds`), not from this promise: it outlives the picker.
  const runAdd = (entry: AgentDirectoryEntry): void => {
    void add.run({ agentId: agent.id, ref: entry.ref }).catch(() => undefined)
  }
  const runRemove = (entry: AgentDirectoryEntry): void => {
    const key = keyOf(entry)
    setFlow(key, { phase: 'removing' })
    remove
      .mutateAsync({ agentId: agent.id, ref: entry.ref })
      .then((result) => setFlow(key, result.ok ? { phase: 'idle' } : { phase: 'idle', error: result.message }))
      .catch((err) => setFlow(key, { phase: 'idle', error: unwrapIpcError(err) }))
  }

  // A form holding input: the custom connector forms, or a key / settings step with something typed in it
  // (an empty one holds nothing: a user with no token at hand can still leave).
  const holdsInput = panel === 'remote' || panel === 'local' || (panel === null && selected !== null && stepDirty)
  // Read inside the window listeners, which are bound once.
  const live = useRef({ holdsInput, panel, selected: selected !== null, onClose })
  live.current = { holdsInput, panel, selected: selected !== null, onClose }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const { holdsInput: held, panel: open, selected: detail, onClose: close } = live.current
      // A form holding input is left only through its own controls (ux_rules rule 13).
      if (held) return
      e.preventDefault()
      if (open) setPanel(null)
      else if (detail) setSelected(null)
      else close()
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (live.current.holdsInput) return
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) live.current.onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [])

  const created = (id: string): void => {
    setPanel(null)
    setCreateError('')
    onAttachCreated(id).then(onClose, (error) => setCreateError(unwrapIpcError(error)))
  }

  const failedSources = sources.filter((s) => s.error)
  const readError = directory.error && directory.data !== undefined ? unwrapIpcError(directory.error) : null
  const quietError = [
    ...failedSources.map((s) => `${s.label}: ${s.error}`),
    ...(readError ? [readError] : []),
    ...(reauth.error ? [reauth.error] : [])
  ].join(' ')
  // An expired Cinna session: the fix is a sign-in, offered beside the sentence (as the catalog does).
  const reauthNeeded = failedSources.some((s) => s.errorCode === 'reauth')

  let body: React.JSX.Element
  if (directory.data === undefined) {
    body = directory.error ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-[var(--color-text-muted)]">
        <p role="alert" className="text-[var(--color-danger)]">{unwrapIpcError(directory.error)}</p>
        <button type="button" onClick={() => void directory.refetch()} className={PICKER_SECONDARY}>
          Try again
        </button>
      </div>
    ) : (
      <div className="flex h-full items-center justify-center text-[var(--color-text-muted)]">
        <Loader2 size={16} className="animate-spin" aria-label="Loading addons" />
      </div>
    )
  } else {
    body = (
      <>
        {shown.length > 0 ? (
          <div className="grid grid-cols-2 gap-2" data-addon-results>
            {shown.map((entry) => (
              <AddonTile key={keyOf(entry)} entry={entry} stateLine={stateLine(entry)} onSelect={() => setSelected(entry)} />
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-[13px] text-[var(--color-text-muted)]">
            {entries.length === 0 ? 'Nothing to add yet.' : needle ? `Nothing here matches “${query.trim()}”.` : 'Nothing of this kind here.'}
          </p>
        )}
        {showRegistry && (
          <section aria-label="More from the public MCP registry" className="mt-5" data-addon-registry>
            <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              More from the public MCP registry
            </h3>
            {/* The last answer stays, dimmed, while the next is asked; with none yet, two tile rows of room hold the space. */}
            {registry.data === undefined && (registry.isFetching || debounced !== query.trim()) ? (
              <div className="grid grid-cols-2 gap-2" aria-busy="true" aria-label="Searching the public MCP registry">
                {[0, 1].map((i) => (
                  <div key={i} className="h-[5.5rem] animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60" />
                ))}
              </div>
            ) : registry.error ? (
              <p className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                <AlertTriangle size={13} aria-hidden className="shrink-0 text-[var(--color-warning)]" />
                {unwrapIpcError(registry.error)}
              </p>
            ) : more.length > 0 ? (
              <div
                className={`grid grid-cols-2 gap-2 transition-opacity ${registry.isFetching || debounced !== query.trim() ? 'opacity-50' : ''}`}
                aria-busy={registry.isFetching || debounced !== query.trim()}
              >
                {more.map((entry) => (
                  <AddonTile key={keyOf(entry)} entry={entry} stateLine={stateLine(entry)} onSelect={() => setSelected(entry)} />
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-[var(--color-text-muted)]">
                {registry.data?.sources.find((s) => s.error)?.error ?? 'Nothing more there.'}
              </p>
            )}
          </section>
        )}
      </>
    )
  }

  // Not "Add to …": that is the detail's primary button, and the two must not read the same (rule 10).
  const title = `Addons for ${agent.name}`
  const detailOpen = current !== null && panel === null
  const covered = detailOpen || panel !== null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div aria-hidden className="app-modal-scrim absolute inset-0" />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="app-modal-panel relative flex h-[36rem] max-h-[calc(100vh-2rem)] w-full max-w-[46rem] flex-col overflow-hidden rounded-xl border"
      >
        <div className="flex items-center gap-2 px-5 pb-2 pt-4">
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--color-text)]">{title}</h2>
          {/* With a form open this is the form's way back to the list, never past it to close what holds the input. */}
          {/* Disabled while a form holds input: only the form's own controls leave it (rule 13), as with Escape. */}
          <button
            type="button"
            onClick={panel ? () => setPanel(null) : onClose}
            disabled={holdsInput}
            title={holdsInput ? 'Save or cancel first' : panel ? 'Back to addons' : 'Close'}
            aria-label={panel ? 'Back to addons' : 'Close'}
            className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {panel ? <ArrowLeft size={14} /> : <X size={14} />}
          </button>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* Hidden, not unmounted, under a detail or a form: the search, filters and scroll are kept for Back. */}
          <div className={`flex min-h-0 flex-1 flex-col ${covered ? 'invisible' : ''}`}>
            <div className="flex items-center gap-2 px-5 pb-3">
              <div className="relative min-w-0 flex-1">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search addons"
                  placeholder={agent.kit ? 'Search skills, plugins and connectors…' : 'Search connectors…'}
                  className={`${TOOL_INPUT} w-full py-1.5 pl-8 pr-2.5 placeholder:text-[var(--color-text-muted)]`}
                />
              </div>
              {/* Always drawn, so the row never changes shape as the answer arrives. */}
              <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source" className={`${TOOL_INPUT} w-44 shrink-0 truncate px-2 py-1.5`}>
                <option value="">All sources</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div role="group" aria-label="Kind" className="flex min-h-[26px] flex-wrap items-center gap-1.5 px-5 pb-3">
              {(['all', ...kinds] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium transition-colors ${
                    kind === k
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {k === 'all' ? 'All' : ADDON_KIND[k].plural}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4" data-addon-list>
              {body}
            </div>
          </div>

          {detailOpen && current && selectedKey && (
            <AddonPickerDetail
              key={selectedKey}
              entry={current}
              agentId={agent.id}
              agentName={agent.name}
              agentKit={agent.kit}
              agentEngine={agent.engine ?? null}
              {...gated(current)}
              flow={flowOf(selectedKey)}
              holdsInput={holdsInput}
              onBack={() => {
                setSelected(null)
                window.setTimeout(() => inputRef.current?.focus(), 0)
              }}
              onAdd={() => runAdd(current)}
              onRemove={() => runRemove(current)}
              onSetupDone={() => setFlow(selectedKey, { phase: 'ready' })}
              onSetupLater={() => setFlow(selectedKey, { phase: 'idle' })}
              onStepDirty={setStepDirty}
              onClose={onClose}
            />
          )}

          {panel && (
            <div className="absolute inset-0 overflow-y-auto px-5 pb-5" data-addon-custom>
              {panel === 'choose' ? (
                <div className="space-y-2">
                  <p className="text-[13px] text-[var(--color-text-secondary)]">A connector of your own, set up on this computer and attached to {agent.name}.</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setPanel('remote')} className={`${PICKER_SECONDARY} flex-1 border-dashed py-3`}>
                      <Plus size={14} aria-hidden />
                      Remote server (URL)
                    </button>
                    {policy.stdioMcp && (
                      <button type="button" onClick={() => setPanel('local')} className={`${PICKER_SECONDARY} flex-1 border-dashed py-3`}>
                        <Terminal size={14} aria-hidden />
                        Local command
                      </button>
                    )}
                  </div>
                </div>
              ) : panel === 'remote' ? (
                <AddCustomMcpForm onClose={() => setPanel(null)} onCreated={created} initialName={initial?.custom?.name} />
              ) : (
                <AddLocalMcpForm onClose={() => setPanel(null)} onCreated={created} initialName={initial?.custom?.name} />
              )}
            </div>
          )}
        </div>

        {(policy.customMcp || quietError || createError || reauthNeeded) && (
          <div className="flex min-h-[2.75rem] items-center gap-3 border-t border-[var(--color-border)] px-5 py-2 text-[12px]">
            <div className="min-w-0 flex-1">
              {createError ? (
                <p role="alert" className="truncate text-[var(--color-danger)]" title={createError}>
                  The connector was added to Settings → MCP but not attached: {createError}
                </p>
              ) : (
                quietError && (
                  <p className="flex min-w-0 items-center gap-1.5 text-[var(--color-text-muted)]" title={quietError} data-addon-source-error>
                    <AlertTriangle size={12} aria-hidden className="shrink-0 text-[var(--color-warning)]" />
                    <span className="truncate">{quietError}</span>
                  </p>
                )
              )}
            </div>
            {reauthNeeded && (
              <button
                type="button"
                onClick={() => void reauth.run()}
                disabled={reauth.pending}
                className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] disabled:opacity-50"
              >
                <RefreshCw size={12} aria-hidden className={reauth.pending ? 'animate-spin' : ''} />
                {CATALOG_TEXT.reauthenticate}
              </button>
            )}
            {policy.customMcp && panel === null && (
              <button
                type="button"
                disabled={holdsInput}
                title={holdsInput ? 'Save or cancel first' : undefined}
                onClick={() => {
                  setSelected(null)
                  setPanel('choose')
                }}
                className="shrink-0 text-[13px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Custom connector…
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
