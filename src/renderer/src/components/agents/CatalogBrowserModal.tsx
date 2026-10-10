import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw, Search, X } from 'lucide-react'
import { useCatalogItems, useRefreshCatalogState } from '../../hooks/useCatalog'
import { useAgents } from '../../hooks/useAgents'
import { useLocalAgents } from '../../hooks/useLocalAgents'
import { useCinnaReauth } from '../../hooks/useAuth'
import { useShareStatuses, useTeamLibrary } from '../../hooks/useSharing'
import { useSettleGuard } from '../../hooks/useSettleGuard'
import { unwrapIpcError } from '../../utils/ipcError'
import type { CatalogInstallError } from '../../hooks/useCatalogInstall'
import type { CatalogItem } from '../../../../shared/catalogItems'
import type { LibraryAgentDto } from '../../../../shared/agentSharing'
import {
  CATALOG_FILTER_TEXT,
  CATALOG_TEXT,
  catalogCredentialSpecs,
  catalogItemKind,
  catalogItemName,
  catalogItemPeople,
  catalogVersionLabel,
  cloudInstallOf,
  inCatalogFilter,
  matchesCatalogQuery,
  skillHostManifestIds,
  type CatalogFilter
} from '../../utils/catalogItems'
import {
  CatalogItemAction,
  CatalogItemDetailView,
  CatalogItemTile,
  hasCatalogAction,
  PRIMARY,
  SECONDARY,
  type CatalogEntryView,
  type CloudUpdateActions,
  type DesktopAgentActions
} from './CatalogItemViews'
import { CATALOG_POPOVER_ATTR, type CatalogSkillTarget } from './CatalogSkillAddMenu'

export type { CloudUpdateActions, DesktopAgentActions } from './CatalogItemViews'

interface CatalogBrowserModalProps {
  onClose: () => void
  /** Cloud agent whose install (Get) is in flight. The owner runs the install, not this modal. */
  installingBundleId: string | null
  installError: CatalogInstallError | null
  onInstall: (bundleId: string) => void
  /** Open the agent a cloud install synced into. */
  onOpen: (agentId: string) => void
  /** Update of an installed cloud agent, run by the parent. Without it, an installed one only says so. */
  cloudUpdate?: CloudUpdateActions
  /** Get and Update of desktop agents, run by the parent. Without it, a desktop agent has no action. */
  desktop?: DesktopAgentActions
}

const FILTERS: CatalogFilter[] = ['all', 'agents', 'skills']

/**
 * The filter last chosen, kept for the session: the next open shows the same
 * kind of item. Module state, not disk — a restart starts from All.
 */
let sessionFilter: CatalogFilter = 'all'

/** Tests only: the next open starts from All. */
export function _resetCatalogFilter(): void {
  sessionFilter = 'all'
}

/**
 * The catalog: every item the active Cinna profile may use — agents that run
 * in Cinna, agents that run on this computer, and skills — as one grid of
 * tiles with a detail behind each, filtered by All / Agents / Skills and a
 * search. It reads main's one cached listing (`catalog:items`), which opening
 * the dialog refreshes.
 *
 * The dialog has a **fixed height**, so switching the filter, searching,
 * opening a detail and an error appearing never resize it (ux_rules rule 1);
 * the body scrolls instead. It owns no action: Get, Update and the cloud
 * install run in the parent, so closing the dialog mid-action loses nothing,
 * and the parent lands the user on the agent when it finishes.
 */
export function CatalogBrowserModal({
  onClose,
  installingBundleId,
  installError,
  onInstall,
  onOpen,
  cloudUpdate,
  desktop
}: CatalogBrowserModalProps): React.JSX.Element {
  const queryClient = useQueryClient()
  // Opening the dialog is when the user wants the catalog as it is now.
  const catalog = useCatalogItems({ refresh: true })
  // This computer's copies of desktop agents, from the same cached listing.
  const teamLibrary = useTeamLibrary()
  const { data: agents } = useAgents()
  const { data: localAgents } = useLocalAgents()
  // Which of this computer's agents are shared with the user to use only (Add to agent…).
  const { data: shareStatuses } = useShareStatuses()
  const refresh = useRefreshCatalogState()
  const cinnaReauth = useCinnaReauth()
  const cardRef = useRef<HTMLDivElement>(null)
  const [filter, setFilterState] = useState<CatalogFilter>(() => sessionFilter)
  const setFilter = (next: CatalogFilter): void => {
    sessionFilter = next
    setFilterState(next)
  }
  const [query, setQuery] = useState('')
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null)
  const [reauthError, setReauthError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // The detail's actions open under the pointer that clicked the tile.
  const detailSettled = useSettleGuard(selectedUuid)

  // Escape steps back one level: from a detail to the grid (filter and
  // search kept), from the grid out of the dialog.
  const selectedRef = useRef(selectedUuid)
  selectedRef.current = selectedUuid
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (selectedRef.current !== null) setSelectedUuid(null)
      else onClose()
    }
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Node
      // A menu the dialog portaled out (Add to agent…) is still the dialog.
      if (target instanceof Element && target.closest(`[${CATALOG_POPOVER_ATTR}]`)) return
      if (cardRef.current && !cardRef.current.contains(target)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [onClose])

  // Versions are kept while the dialog is open; the next visit reads them afresh.
  useEffect(() => () => queryClient.removeQueries({ queryKey: ['catalog', 'item'] }), [queryClient])

  const views = useMemo((): CatalogEntryView[] => {
    const items = catalog.data?.items ?? []
    const libraryByUuid = new Map<string, LibraryAgentDto>(
      (teamLibrary.data?.agents ?? []).map((agent) => [agent.uuid, agent])
    )
    const agentByInstall = new Map<string, NonNullable<typeof agents>[number]>()
    for (const agent of agents ?? []) if (agent.remoteTargetId) agentByInstall.set(agent.remoteTargetId, agent)
    const localByManifest = new Map<string, { id: string; name: string }>()
    for (const agent of localAgents?.agents ?? []) {
      if (agent.manifestId) localByManifest.set(agent.manifestId.toLowerCase(), { id: agent.id, name: agent.name })
    }
    // As main's `changeableFromLink`: a Cinna team agent counts only with
    // edit or maintain; access the listing does not know is not a yes.
    const readOnly = new Set(
      (shareStatuses ?? [])
        .filter((status) => status.remote.kind === 'cinna' && status.remote.access !== 'edit' && status.remote.access !== 'maintain')
        .map((status) => status.agentId)
    )
    // Kit agents only: a bare folder has no cinna-agent.json to pin a skill in,
    // and its DTO carries no `skills`.
    const kitAgents = (localAgents?.agents ?? []).filter((agent) => agent.skills !== undefined)
    const pinsPackage = (agent: (typeof kitAgents)[number], uuid: string): boolean =>
      (agent.skills ?? []).some(
        (skill) => skill.source === 'catalog' && (skill.packageUuid ?? '').toLowerCase() === uuid.toLowerCase()
      )
    /**
     * The agents that pin a skill. An agent on this computer counts by its
     * own pins alone — they move the moment an add or a Remove lands, before
     * the report reaches core. The server's local installs count only for a
     * manifest id no agent here has (another device's copy is not listed;
     * one of ours that core still holds after a Remove is not either).
     */
    const usedByOf = (item: CatalogItem): string[] => {
      const byId = new Map<string, string>()
      for (const id of skillHostManifestIds(item)) {
        const agent = localByManifest.get(id)
        if (agent && !kitAgents.some((kit) => kit.id === agent.id)) byId.set(agent.id, agent.name)
      }
      for (const agent of kitAgents) if (pinsPackage(agent, item.uuid)) byId.set(agent.id, agent.name)
      return [...byId.values()]
    }
    const targetsOf = (item: CatalogItem): CatalogSkillTarget[] =>
      kitAgents
        .map((agent): CatalogSkillTarget => ({
          agentId: agent.id,
          name: agent.name,
          blocked: pinsPackage(agent, item.uuid)
            ? 'added'
            : shareStatuses === undefined
              ? 'checking'
              : readOnly.has(agent.id)
                ? 'read_only'
                : null
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    return items.map((item: CatalogItem): CatalogEntryView => {
      const kind = catalogItemKind(item)
      const latest = item.latest
      let cloud: CatalogEntryView['cloud'] = null
      if (kind === 'cloud_agent') {
        const install = cloudInstallOf(item, (installId) => agentByInstall.has(installId))
        const installId = install?.install_id ?? null
        const row = installId ? agentByInstall.get(installId) : undefined
        // The server's own answer, once the agent has synced; the listing's numbers before that.
        const bundleVersion = row?.remoteMetadata?.bundle_version
        const updateAvailable = bundleVersion
          ? Boolean(bundleVersion.update_available)
          : !!latest && install?.revision_number != null && install.revision_number < latest.revision_number
        cloud = { installId, agentId: row?.id ?? null, updateAvailable: installId !== null && updateAvailable }
      }
      return {
        item,
        kind,
        name: catalogItemName(item),
        people: catalogItemPeople(item),
        version: latest ? catalogVersionLabel(latest.revision_number, latest.version) : null,
        specs: catalogCredentialSpecs(item),
        cloud,
        desktop: kind === 'desktop_agent' ? (libraryByUuid.get(item.uuid) ?? null) : null,
        usedBy: kind === 'skill' ? usedByOf(item) : [],
        skillTargets: kind === 'skill' ? targetsOf(item) : []
      }
    })
  }, [catalog.data, teamLibrary.data, agents, localAgents, shareStatuses])

  const needle = query.trim().toLowerCase()
  const shown = useMemo(
    () => views.filter((view) => inCatalogFilter(view.kind, filter) && matchesCatalogQuery(view.item, needle)),
    [views, filter, needle]
  )
  const inFilter = useMemo(() => views.filter((view) => inCatalogFilter(view.kind, filter)), [views, filter])
  // A refresh can drop the item being viewed; fall back to the grid then.
  const selected = selectedUuid ? (views.find((view) => view.item.uuid === selectedUuid) ?? null) : null

  const errorCode = (catalog.error as { code?: string } | null)?.code
  // A read is on its way: whatever the last one failed with is not the answer
  // any more, so it shows as loading (with nothing on screen) or as the
  // Refresh spinner (over tiles), never as an error beside a disabled Retry.
  const hasList = catalog.data !== undefined
  const failed = catalog.error !== null && !catalog.isFetching

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

  const install = { installingBundleId, onInstall, onOpen }
  const actionFor = (view: CatalogEntryView, settled = true): React.JSX.Element | null => (
    <CatalogItemAction view={view} install={install} cloudUpdate={cloudUpdate} desktop={desktop} settled={settled} />
  )
  const errorFor = (view: CatalogEntryView): string | null => {
    if (view.kind === 'cloud_agent') {
      if (installError?.bundleId === view.item.id) return installError.message
      const installId = view.cloud?.installId
      if (installId && cloudUpdate?.error?.installId === installId) return cloudUpdate.error.message
      return null
    }
    if (view.kind === 'desktop_agent' && view.desktop && desktop?.error?.repoId === view.desktop.repoId) {
      return desktop.error.message
    }
    return null
  }

  // Nothing to show: the failure takes the body, with its Retry.
  const errorPanel = failed && !hasList ? (
    <div className="flex items-start gap-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)]">
      <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
      <div className="min-w-0 flex-1">
        <div>{errorCode === 'reauth_required' ? CATALOG_TEXT.reauth : CATALOG_TEXT.loadFailed}</div>
        {errorCode === 'reauth_required' ? (
          <button
            type="button"
            onClick={() => void handleReauth()}
            disabled={cinnaReauth.isPending}
            className={`${PRIMARY} mt-1.5`}
          >
            <RefreshCw size={10} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
            {CATALOG_TEXT.reauthenticate}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void catalog.refetch()}
            disabled={catalog.isFetching}
            className={`${SECONDARY} mt-1.5`}
          >
            {CATALOG_TEXT.retry}
          </button>
        )}
        {reauthError && <div className="mt-1.5 text-[10px] text-[var(--color-danger)]">{reauthError}</div>}
      </div>
    </div>
  ) : null

  // Tiles on screen: a failed refresh is one line beside the Refresh button,
  // in space the header always has — nothing below it moves (rule 1).
  const refreshFailure =
    failed && hasList ? (
      <span role="alert" className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-danger)]">
        <AlertTriangle size={11} className="shrink-0" aria-hidden="true" />
        <span className="truncate" title={reauthError ?? unwrapIpcError(catalog.error, CATALOG_TEXT.loadFailed)}>
          {errorCode === 'reauth_required' ? (reauthError ?? CATALOG_TEXT.refreshReauth) : CATALOG_TEXT.refreshFailed}
        </span>
        {errorCode === 'reauth_required' && (
          <button
            type="button"
            onClick={() => void handleReauth()}
            disabled={cinnaReauth.isPending}
            className="shrink-0 font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {CATALOG_TEXT.reauthenticate}
          </button>
        )}
      </span>
    ) : null

  const body = errorPanel ? (
    errorPanel
  ) : !hasList && (catalog.isFetching || catalog.isLoading) ? (
    <EmptyState text={CATALOG_TEXT.loading} />
  ) : catalog.data && !catalog.data.available ? (
    <EmptyState text={CATALOG_TEXT.unavailable} />
  ) : inFilter.length === 0 ? (
    <EmptyState text={CATALOG_TEXT.empty[filter]} />
  ) : shown.length === 0 ? (
    <EmptyState text={CATALOG_TEXT.noMatch} />
  ) : (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {shown.map((view) => (
        <CatalogItemTile
          key={view.item.uuid}
          view={view}
          action={hasCatalogAction(view, desktop) ? actionFor(view) : null}
          error={errorFor(view)}
          onSelect={() => setSelectedUuid(view.item.uuid)}
        />
      ))}
    </div>
  )

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
      <div
        ref={cardRef}
        role="dialog"
        aria-label={CATALOG_TEXT.title}
        className="flex h-[36rem] max-h-[90vh] w-full max-w-[48rem] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg"
      >
        <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-3">
          <div className="shrink-0 text-sm font-semibold text-[var(--color-text)]">{CATALOG_TEXT.title}</div>
          <div className="flex min-w-0 items-center gap-2">
            {refreshFailure}
            <button
              type="button"
              onClick={() => {
                refresh()
                void teamLibrary.refetch()
              }}
              disabled={catalog.isFetching}
              aria-busy={catalog.isFetching}
              className={`${SECONDARY} shrink-0`}
            >
              <RefreshCw size={11} className={catalog.isFetching ? 'animate-spin' : ''} aria-hidden="true" />
              {CATALOG_TEXT.refresh}
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

        {/* The grid stays mounted (and keeps its scroll position, search and
            filter) under a detail, which is a layer over it; hidden from
            pointer and screen reader while it is covered. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            aria-hidden={selected ? true : undefined}
            inert={selected ? true : undefined}
            className={`flex min-h-0 flex-1 flex-col ${selected ? 'invisible' : ''}`}
          >
            <div className="flex items-center gap-2 px-5 pb-3">
              <div className="relative min-w-0 flex-1">
                <Search
                  size={13}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                />
                <input
                  ref={searchRef}
                  type="text"
                  aria-label={CATALOG_TEXT.searchLabel}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={CATALOG_TEXT.searchPlaceholder}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-7 pr-2.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
                />
              </div>
              <div
                role="radiogroup"
                aria-label={CATALOG_TEXT.filterLabel}
                className="flex shrink-0 gap-0.5 rounded-md bg-[var(--color-bg)] p-0.5"
              >
                {FILTERS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={filter === id}
                    onClick={() => setFilter(id)}
                    className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      filter === id
                        ? 'bg-[var(--color-bg-secondary)] text-[var(--color-text)] shadow-sm'
                        : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                    }`}
                  >
                    {CATALOG_FILTER_TEXT[id]}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{body}</div>
          </div>
          {selected && (
            <CatalogItemDetailView
              view={selected}
              action={hasCatalogAction(selected, desktop) ? actionFor(selected, detailSettled) : null}
              error={errorFor(selected)}
              onBack={() => setSelectedUuid(null)}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return <div className="flex h-40 items-center justify-center text-xs text-[var(--color-text-muted)]">{text}</div>
}
