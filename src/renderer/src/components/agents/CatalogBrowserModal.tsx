import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw, X } from 'lucide-react'
import { useRefreshCatalogState } from '../../hooks/useCatalog'
import { useCatalogEntries } from '../../hooks/useCatalogEntries'
import { catalogErrorFor } from '../../hooks/useCatalogActions'
import { useSettleGuard } from '../../hooks/useSettleGuard'
import type { CatalogInstallError } from '../../hooks/useCatalogInstall'
import { CATALOG_TEXT, type CatalogFilter } from '../../utils/catalogItems'
import {
  CatalogItemDetailView,
  SECONDARY,
  type CatalogEntryView,
  type CloudUninstallActions,
  type CloudUpdateActions,
  type DesktopAgentActions
} from './CatalogItemViews'
import {
  CatalogListBody,
  CatalogRefreshFailure,
  CatalogSearchRow,
  CatalogTileGrid,
  catalogActionFor,
  useCatalogReauth,
  useFilteredCatalog
} from './CatalogBrowserParts'
import { CATALOG_POPOVER_ATTR } from './CatalogSkillAddMenu'

export type { CloudUninstallActions, CloudUpdateActions, DesktopAgentActions } from './CatalogItemViews'

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
  /** Uninstall of an installed cloud agent, run by the parent. Without it, the detail offers none. */
  uninstall?: CloudUninstallActions
}

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
  desktop,
  uninstall
}: CatalogBrowserModalProps): React.JSX.Element {
  const queryClient = useQueryClient()
  // Opening the dialog is when the user wants the catalog as it is now.
  const { catalog, teamLibrary, views } = useCatalogEntries({ refresh: true })
  const refresh = useRefreshCatalogState()
  const reauth = useCatalogReauth(catalog)
  const cardRef = useRef<HTMLDivElement>(null)
  const [filter, setFilterState] = useState<CatalogFilter>(() => sessionFilter)
  const setFilter = (next: CatalogFilter): void => {
    sessionFilter = next
    setFilterState(next)
  }
  const [query, setQuery] = useState('')
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null)
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

  const { shown, inFilter, selected } = useFilteredCatalog(views, filter, query, selectedUuid)

  // The grid stays mounted behind a detail, so focus has to come back to it
  // by hand — on mount too, in place of `autoFocus`.
  useEffect(() => {
    if (selected === null) searchRef.current?.focus()
  }, [selected])

  const handlers = { install: { installingBundleId, onInstall, onOpen }, cloudUpdate, desktop }
  const errorFor = (view: CatalogEntryView): string | null => catalogErrorFor(view, installError, cloudUpdate, desktop)

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
            <CatalogRefreshFailure catalog={catalog} reauth={reauth} />
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
            <CatalogSearchRow
              query={query}
              onQuery={setQuery}
              filter={filter}
              onFilter={setFilter}
              searchRef={searchRef}
              className="px-5 pb-3"
            />
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
              <CatalogListBody
                catalog={catalog}
                reauth={reauth}
                filter={filter}
                inFilterCount={inFilter.length}
                shownCount={shown.length}
              >
                <CatalogTileGrid
                  views={shown}
                  handlers={handlers}
                  errorFor={errorFor}
                  onSelect={setSelectedUuid}
                  className="grid grid-cols-2 gap-3 lg:grid-cols-3"
                />
              </CatalogListBody>
            </div>
          </div>
          {selected && (
            <CatalogItemDetailView
              view={selected}
              action={catalogActionFor(selected, handlers, detailSettled)}
              error={errorFor(selected)}
              onBack={() => setSelectedUuid(null)}
              settled={detailSettled}
              uninstall={uninstall}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
