import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ChevronLeft, Download, Loader2, RefreshCw, Search, Store, X } from 'lucide-react'
import { useCatalog, useRefreshCatalogState } from '../../hooks/useCatalog'
import { useAgents } from '../../hooks/useAgents'
import { useCinnaReauth } from '../../hooks/useAuth'
import { unwrapIpcError } from '../../utils/ipcError'
import { isUnsettledClick, useSettleGuard } from '../../hooks/useSettleGuard'
import type { CatalogInstallError } from '../../hooks/useCatalogInstall'
import type { CatalogEntryDto } from '../../../../shared/catalog'
import { CatalogCardCredentials } from '../settings/CatalogCardCredentials'

interface CatalogBrowserModalProps {
  onClose: () => void
  /** Bundle whose install is in flight. The owner runs the install, not this modal. */
  installingBundleId: string | null
  installError: CatalogInstallError | null
  onInstall: (bundleId: string) => void
  /** Open the local agent an installed bundle became. */
  onOpen: (agentId: string) => void
}

const PRIMARY =
  'inline-flex min-w-[5.5rem] items-center justify-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium ' +
  'bg-[var(--color-accent)] text-white transition-colors hover:bg-[var(--color-accent-hover)] ' +
  'disabled:cursor-not-allowed disabled:opacity-40'
const SECONDARY =
  'inline-flex items-center justify-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-1 ' +
  'text-[11px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50'
const CHIP =
  'shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-px text-[10px] text-[var(--color-text-muted)]'
const ANOTHER_INSTALLING = 'Another agent is installing'

function versionLabel(entry: CatalogEntryDto): string | null {
  if (entry.latestVersion) return `v${entry.latestVersion}`
  if (entry.latestRevisionNumber !== null) return `rev ${entry.latestRevisionNumber}`
  return null
}

function installsLabel(count: number): string {
  return `${count} ${count === 1 ? 'install' : 'installs'}`
}

function publisherOf(entry: CatalogEntryDto): string | null {
  return entry.publisherName ?? entry.publisherHandle ?? null
}

function matches(entry: CatalogEntryDto, query: string): boolean {
  if (query === '') return true
  return [
    entry.displayName,
    entry.description,
    entry.publisherName,
    entry.publisherHandle,
    entry.bundleId
  ].some((value) => value?.toLowerCase().includes(query))
}

/**
 * The Agent Catalog: every bundle published to the user's Cinna account, as a
 * grid of tiles with a detail view behind each.
 *
 * The dialog has a **fixed height**, so switching between the grid and a
 * detail, filtering, and an install error appearing never resize it
 * (ux_rules rule 1); the body scrolls instead. It owns no install: the parent
 * runs it, so closing the dialog mid-install loses nothing, and the parent
 * lands the user on the new agent when it finishes.
 */
export function CatalogBrowserModal({
  onClose,
  installingBundleId,
  installError,
  onInstall,
  onOpen
}: CatalogBrowserModalProps): React.JSX.Element {
  const catalog = useCatalog()
  const { data: agents } = useAgents()
  const refresh = useRefreshCatalogState()
  const cinnaReauth = useCinnaReauth()
  const cardRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reauthError, setReauthError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // The detail's Install / Open opens under the pointer that clicked the tile.
  const detailSettled = useSettleGuard(selectedId)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onClick = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [onClose])

  /** Installed bundle → the local agent it synced into. */
  const agentIdByInstall = useMemo(() => {
    const map = new Map<string, string>()
    for (const agent of agents ?? []) {
      if (agent.remoteTargetId) map.set(agent.remoteTargetId, agent.id)
    }
    return map
  }, [agents])

  const entries = useMemo(() => catalog.data ?? [], [catalog.data])
  const needle = query.trim().toLowerCase()
  const filtered = useMemo(() => entries.filter((e) => matches(e, needle)), [entries, needle])
  // A refresh can drop the bundle being viewed; fall back to the grid then.
  const selected = selectedId ? (entries.find((e) => e.bundleId === selectedId) ?? null) : null

  const errorCode = (catalog.error as { code?: string } | null)?.code

  // The grid stays mounted behind a detail, so focus has to come back to it
  // by hand — on mount too, in place of `autoFocus`.
  useEffect(() => {
    if (selected === null) searchRef.current?.focus()
  }, [selected])

  const handleReauth = async (): Promise<void> => {
    setReauthError(null)
    try {
      const result = await cinnaReauth.mutateAsync()
      if (!result.success) {
        setReauthError(result.error ?? 'Re-authentication failed.')
        return
      }
      void catalog.refetch()
    } catch (err) {
      setReauthError(unwrapIpcError(err, 'Re-authentication failed.'))
    }
  }

  const actionFor = (entry: CatalogEntryDto, settled = true): React.JSX.Element => (
    <EntryAction
      entry={entry}
      agentId={entry.userInstallId ? (agentIdByInstall.get(entry.userInstallId) ?? null) : null}
      installing={installingBundleId === entry.bundleId}
      anyInstalling={installingBundleId !== null}
      settled={settled}
      onInstall={onInstall}
      onOpen={onOpen}
    />
  )
  const errorFor = (entry: CatalogEntryDto): string | null =>
    installError?.bundleId === entry.bundleId ? installError.message : null

  const errorPanel = catalog.error ? (
    <div className="flex items-start gap-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)]">
      <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
      <div className="min-w-0 flex-1">
        <div>
          {errorCode === 'reauth_required'
            ? 'Cinna session expired. Re-authenticate to load the catalog.'
            : 'Could not load the catalog.'}
        </div>
        {errorCode === 'reauth_required' ? (
          <button
            type="button"
            onClick={() => void handleReauth()}
            disabled={cinnaReauth.isPending}
            className={`${PRIMARY} mt-1.5`}
          >
            <RefreshCw size={10} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
            Re-authenticate
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void catalog.refetch()}
            disabled={catalog.isFetching}
            className={`${SECONDARY} mt-1.5`}
          >
            Retry
          </button>
        )}
        {reauthError && (
          <div className="mt-1.5 text-[10px] text-[var(--color-danger)]">{reauthError}</div>
        )}
      </div>
    </div>
  ) : null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
      <div
        ref={cardRef}
        role="dialog"
        aria-label="Agent catalog"
        className="flex h-[36rem] max-h-[90vh] w-full max-w-[48rem] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg"
      >
        <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-3">
          <div className="text-sm font-semibold text-[var(--color-text)]">Agent catalog</div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={refresh}
              disabled={catalog.isFetching}
              className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
              title="Refresh catalog"
              aria-label="Refresh catalog"
            >
              <RefreshCw size={12} className={catalog.isFetching ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              title="Close"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* The grid stays mounted (and keeps its scroll position) under a
            detail, which is a layer over it; hidden from pointer and screen
            reader while it is covered. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            aria-hidden={selected ? true : undefined}
            inert={selected ? true : undefined}
            className={`flex min-h-0 flex-1 flex-col ${selected ? 'invisible' : ''}`}
          >
            <div className="px-5 pb-3">
              <div className="relative">
                <Search
                  size={13}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                />
                <input
                  ref={searchRef}
                  type="text"
                  aria-label="Search the catalog"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search agents…"
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-7 pr-2.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5">
              {errorPanel}
              {catalog.isLoading ? (
                <EmptyState text="Loading catalog…" />
              ) : catalog.error && entries.length === 0 ? null : entries.length === 0 ? (
                <EmptyState text="No agents are published to your account yet." />
              ) : filtered.length === 0 ? (
                <EmptyState text="No agents match your search." />
              ) : (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                  {filtered.map((entry) => (
                    <CatalogTile
                      key={entry.bundleId}
                      entry={entry}
                      action={actionFor(entry)}
                      error={errorFor(entry)}
                      onSelect={() => setSelectedId(entry.bundleId)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          {selected && (
            <div className="absolute inset-0 space-y-3 overflow-y-auto bg-[var(--color-bg-secondary)] px-5 pb-5">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  autoFocus
                  onClick={() => setSelectedId(null)}
                  aria-label="Back to catalog"
                  title="Back to catalog"
                  className="-ml-1.5 mt-1.5 shrink-0 rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
                >
                  <ChevronLeft size={16} />
                </button>
                <div className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
                  <Store size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="text-sm font-semibold text-[var(--color-text)]">
                      {selected.displayName}
                    </h3>
                    {versionLabel(selected) && <span className={CHIP}>{versionLabel(selected)}</span>}
                    {selected.isInstalled && <InstalledPill />}
                  </div>
                  {publisherOf(selected) && (
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      by {publisherOf(selected)}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">{actionFor(selected, detailSettled)}</div>
              </div>
              {errorFor(selected) && (
                <div role="alert" className="text-[10px] text-[var(--color-danger)]">
                  {errorFor(selected)}
                </div>
              )}
              {selected.description && (
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-text-secondary)]">
                  {selected.description}
                </p>
              )}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
                {publisherOf(selected) && (
                  <>
                    <dt className="text-[var(--color-text-muted)]">Publisher</dt>
                    <dd className="min-w-0 break-words text-[var(--color-text)]">
                      {publisherOf(selected)}
                      {selected.publisherEmail && (
                        <span className="text-[var(--color-text-muted)]">
                          {' '}
                          &lt;{selected.publisherEmail}&gt;
                        </span>
                      )}
                    </dd>
                  </>
                )}
                {selected.latestPublishedAt && (
                  <>
                    <dt className="text-[var(--color-text-muted)]">Published</dt>
                    <dd className="text-[var(--color-text)]">
                      {new Date(selected.latestPublishedAt).toLocaleDateString()}
                    </dd>
                  </>
                )}
                <dt className="text-[var(--color-text-muted)]">Installs</dt>
                <dd className="text-[var(--color-text)]">{selected.installCount}</dd>
                <dt className="text-[var(--color-text-muted)]">Bundle</dt>
                <dd className="min-w-0">
                  <span className="inline-block max-w-full truncate rounded bg-[var(--color-bg)] px-1.5 py-0.5 align-middle font-mono text-[10px] text-[var(--color-text-secondary)]">
                    {selected.bundleId}
                  </span>
                </dd>
              </dl>
              <div className="space-y-2">
                <CatalogCardCredentials entry={selected} enabled={!selected.isInstalled} compact />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex h-40 items-center justify-center text-xs text-[var(--color-text-muted)]">
      {text}
    </div>
  )
}

function InstalledPill(): React.JSX.Element {
  return (
    <span className="shrink-0 rounded bg-[var(--color-success)]/12 px-1.5 py-px text-[10px] font-medium text-[var(--color-success)]">
      Installed
    </span>
  )
}

interface EntryActionProps {
  entry: CatalogEntryDto
  agentId: string | null
  installing: boolean
  anyInstalling: boolean
  /** False right after the detail opened: a pointer click is then ignored. */
  settled: boolean
  onInstall: (bundleId: string) => void
  onOpen: (agentId: string) => void
}

/** Install for a bundle not yet installed; Installed (and Open, once synced) otherwise. */
function EntryAction({
  entry,
  agentId,
  installing,
  anyInstalling,
  settled,
  onInstall,
  onOpen
}: EntryActionProps): React.JSX.Element {
  if (entry.isInstalled) {
    return (
      <>
        <InstalledPill />
        {agentId && (
          <button
            type="button"
            onClick={(event) => {
              if (!isUnsettledClick(settled, event)) onOpen(agentId)
            }}
            className={SECONDARY}
          >
            Open
          </button>
        )}
      </>
    )
  }
  return (
    <button
      type="button"
      disabled={anyInstalling}
      title={anyInstalling && !installing ? ANOTHER_INSTALLING : undefined}
      onClick={(event) => {
        if (!isUnsettledClick(settled, event)) onInstall(entry.bundleId)
      }}
      className={PRIMARY}
    >
      {installing ? (
        <>
          <Loader2 size={11} className="animate-spin" />
          Installing…
        </>
      ) : (
        <>
          <Download size={11} />
          Install
        </>
      )}
    </button>
  )
}

interface CatalogTileProps {
  entry: CatalogEntryDto
  action: React.JSX.Element
  error: string | null
  onSelect: () => void
}

/**
 * One bundle in the grid. The body and the action are siblings, not a button
 * inside a button; the body is named by the agent's name alone and opens the
 * detail. An install error renders last in the tile, so it never moves the
 * button that caused it (ux_rules rules 1 and 6).
 */
function CatalogTile({ entry, action, error, onSelect }: CatalogTileProps): React.JSX.Element {
  const nameId = useId()
  const descriptionId = useId()
  const version = versionLabel(entry)
  const publisher = publisherOf(entry)
  return (
    <div
      role="group"
      aria-label={entry.displayName}
      className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 transition-colors hover:border-[var(--color-accent)]/30"
    >
      <button
        type="button"
        onClick={onSelect}
        aria-labelledby={nameId}
        aria-describedby={entry.description ? descriptionId : undefined}
        className="flex flex-1 flex-col gap-1 rounded-t-lg p-3 text-left"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
            <Store size={14} />
          </span>
          <span id={nameId} className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">
            {entry.displayName}
          </span>
          {version && <span className={CHIP}>{version}</span>}
        </span>
        {publisher && (
          <span className="block truncate text-[10px] text-[var(--color-text-muted)]">
            by {publisher}
          </span>
        )}
        {entry.description && (
          <span
            id={descriptionId}
            className="line-clamp-3 text-[11px] leading-relaxed text-[var(--color-text-secondary)]"
          >
            {entry.description}
          </span>
        )}
      </button>
      <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-3 py-2">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {installsLabel(entry.installCount)}
        </span>
        <span className="flex items-center gap-1.5">{action}</span>
      </div>
      {error && (
        <div role="alert" className="px-3 pb-2 text-[10px] text-[var(--color-danger)]">
          {error}
        </div>
      )}
    </div>
  )
}
