import { useMemo, useState, type ReactNode, type RefObject } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw, Search } from 'lucide-react'
import { useCinnaReauth } from '../../hooks/useAuth'
import { unwrapIpcError } from '../../utils/ipcError'
import {
  CATALOG_FILTER_TEXT,
  CATALOG_TEXT,
  inCatalogFilter,
  matchesCatalogQuery,
  type CatalogFilter
} from '../../utils/catalogItems'
import type { CatalogItemsListing } from '../../../../shared/catalogItems'
import {
  CatalogItemAction,
  CatalogItemTile,
  hasCatalogAction,
  PRIMARY,
  SECONDARY,
  type CatalogEntryView,
  type CloudInstallActions,
  type CloudUpdateActions,
  type DesktopAgentActions
} from './CatalogItemViews'
import { sizedButton, useCatalogType } from './catalogSurface'

/**
 * The pieces the catalog dialog and Settings → Catalog are both built from:
 * the search and filter row, the states the list can be in, and the grid of
 * tiles. Each surface arranges them in its own frame.
 */

export const CATALOG_FILTERS: CatalogFilter[] = ['all', 'agents', 'skills']

type CatalogQuery = UseQueryResult<CatalogItemsListing | null>

/**
 * The items the filter and the search leave, the ones the filter alone
 * leaves (to tell an empty filter from a search matching nothing), and the
 * item whose detail is open — null once a refresh has dropped it, which
 * falls back to the grid.
 */
export function useFilteredCatalog(
  views: CatalogEntryView[],
  filter: CatalogFilter,
  query: string,
  selectedUuid: string | null
): { shown: CatalogEntryView[]; inFilter: CatalogEntryView[]; selected: CatalogEntryView | null } {
  const needle = query.trim().toLowerCase()
  const inFilter = useMemo(() => views.filter((view) => inCatalogFilter(view.kind, filter)), [views, filter])
  const shown = useMemo(() => inFilter.filter((view) => matchesCatalogQuery(view.item, needle)), [inFilter, needle])
  const selected = selectedUuid ? (views.find((view) => view.item.uuid === selectedUuid) ?? null) : null
  return { shown, inFilter, selected }
}

export interface CatalogReauth {
  run: () => Promise<void>
  pending: boolean
  error: string | null
}

/** Re-authenticate an expired Cinna session, then read the catalog again. */
export function useCatalogReauth(catalog: CatalogQuery): CatalogReauth {
  const cinnaReauth = useCinnaReauth()
  const [error, setError] = useState<string | null>(null)
  const run = async (): Promise<void> => {
    setError(null)
    try {
      const result = await cinnaReauth.mutateAsync()
      if (!result.success) {
        setError(result.error ?? 'Re-authentication failed.')
        return
      }
      void catalog.refetch()
    } catch (err) {
      setError(unwrapIpcError(err, 'Re-authentication failed.'))
    }
  }
  return { run, pending: cinnaReauth.isPending, error }
}

/** The search box and the All / Agents / Skills choice. */
export function CatalogSearchRow({
  query,
  onQuery,
  filter,
  onFilter,
  searchRef,
  className = ''
}: {
  query: string
  onQuery: (query: string) => void
  filter: CatalogFilter
  onFilter: (filter: CatalogFilter) => void
  searchRef?: RefObject<HTMLInputElement | null>
  className?: string
}): React.JSX.Element {
  const type = useCatalogType()
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="relative min-w-0 flex-1">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <input
          ref={searchRef}
          type="text"
          aria-label={CATALOG_TEXT.searchLabel}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={CATALOG_TEXT.searchPlaceholder}
          className={`w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-7 pr-2.5 ${type.text} text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none`}
        />
      </div>
      <div
        role="radiogroup"
        aria-label={CATALOG_TEXT.filterLabel}
        className="flex shrink-0 gap-0.5 rounded-md bg-[var(--color-bg)] p-0.5"
      >
        {CATALOG_FILTERS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={filter === id}
            onClick={() => onFilter(id)}
            className={`rounded px-2.5 py-1 ${type.body} font-medium transition-colors ${
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
  )
}

/**
 * Whether a read is on its way or the last one failed. While one is on its
 * way, whatever the last one failed with is not the answer any more, so it
 * shows as loading (with nothing on screen) or as the Refresh spinner (over
 * tiles), never as an error beside a disabled Retry.
 */
function loadState(catalog: CatalogQuery): { hasList: boolean; failed: boolean; errorCode: string | undefined } {
  return {
    hasList: catalog.data !== undefined,
    failed: catalog.error !== null && !catalog.isFetching,
    errorCode: (catalog.error as { code?: string } | null)?.code
  }
}

/**
 * The list's body: the failure with its Retry or Re-authenticate when there
 * is nothing to show, loading, a server without a catalog, an empty filter,
 * a search matching nothing — or `children`, the grid.
 */
export function CatalogListBody({
  catalog,
  reauth,
  filter,
  inFilterCount,
  shownCount,
  children
}: {
  catalog: CatalogQuery
  reauth: CatalogReauth
  filter: CatalogFilter
  inFilterCount: number
  shownCount: number
  children: ReactNode
}): React.JSX.Element {
  const type = useCatalogType()
  const { hasList, failed, errorCode } = loadState(catalog)
  if (failed && !hasList) {
    return (
      <div className={`flex items-start gap-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2.5 py-2 ${type.body} text-[var(--color-text-secondary)]`}>
        <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0 flex-1">
          <div>{errorCode === 'reauth_required' ? CATALOG_TEXT.reauth : CATALOG_TEXT.loadFailed}</div>
          {errorCode === 'reauth_required' ? (
            <button
              type="button"
              onClick={() => void reauth.run()}
              disabled={reauth.pending}
              className={`${sizedButton(PRIMARY, type)} mt-1.5`}
            >
              <RefreshCw size={10} className={reauth.pending ? 'animate-spin' : ''} />
              {CATALOG_TEXT.reauthenticate}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void catalog.refetch()}
              disabled={catalog.isFetching}
              className={`${sizedButton(SECONDARY, type)} mt-1.5`}
            >
              {CATALOG_TEXT.retry}
            </button>
          )}
          {reauth.error && <div className={`mt-1.5 ${type.meta} text-[var(--color-danger)]`}>{reauth.error}</div>}
        </div>
      </div>
    )
  }
  if (!hasList && (catalog.isFetching || catalog.isLoading)) return <EmptyState text={CATALOG_TEXT.loading} />
  if (catalog.data && !catalog.data.available) return <EmptyState text={CATALOG_TEXT.unavailable} />
  if (inFilterCount === 0) return <EmptyState text={CATALOG_TEXT.empty[filter]} />
  if (shownCount === 0) return <EmptyState text={CATALOG_TEXT.noMatch} />
  return <>{children}</>
}

/**
 * Tiles on screen and a refresh failed: one line beside the Refresh button,
 * in space the header always has — nothing below it moves (rule 1).
 */
export function CatalogRefreshFailure({
  catalog,
  reauth
}: {
  catalog: CatalogQuery
  reauth: CatalogReauth
}): React.JSX.Element | null {
  const type = useCatalogType()
  const { hasList, failed, errorCode } = loadState(catalog)
  if (!failed || !hasList) return null
  // The reason is on screen, not only in a tooltip; a long one truncates in
  // the header's one line, and the alert reads it whole.
  const reason = unwrapIpcError(catalog.error, '')
  const text =
    errorCode === 'reauth_required'
      ? (reauth.error ?? CATALOG_TEXT.refreshReauth)
      : reason
        ? `${CATALOG_TEXT.refreshFailed} ${reason}`
        : CATALOG_TEXT.refreshFailed
  return (
    <span role="alert" className={`flex min-w-0 items-center gap-1.5 ${type.body} text-[var(--color-danger)]`}>
      <AlertTriangle size={11} className="shrink-0" aria-hidden="true" />
      <span className="truncate" title={text}>
        {text}
      </span>
      {errorCode === 'reauth_required' && (
        <button
          type="button"
          onClick={() => void reauth.run()}
          disabled={reauth.pending}
          className="shrink-0 font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)] disabled:opacity-50"
        >
          {CATALOG_TEXT.reauthenticate}
        </button>
      )}
    </span>
  )
}

/** The actions a surface hands its tiles and detail. */
export interface CatalogItemHandlers {
  install: CloudInstallActions
  cloudUpdate: CloudUpdateActions | undefined
  desktop: DesktopAgentActions | undefined
}

/** One item's action, or null when its tile has none. */
export function catalogActionFor(
  view: CatalogEntryView,
  { install, cloudUpdate, desktop }: CatalogItemHandlers,
  settled = true
): React.JSX.Element | null {
  return hasCatalogAction(view, desktop) ? (
    <CatalogItemAction view={view} install={install} cloudUpdate={cloudUpdate} desktop={desktop} settled={settled} />
  ) : null
}

/** The grid of tiles. */
export function CatalogTileGrid({
  views,
  handlers,
  errorFor,
  onSelect,
  className
}: {
  views: CatalogEntryView[]
  handlers: CatalogItemHandlers
  errorFor: (view: CatalogEntryView) => string | null
  onSelect: (uuid: string) => void
  className: string
}): React.JSX.Element {
  return (
    <div className={className}>
      {views.map((view) => (
        <CatalogItemTile
          key={view.item.uuid}
          view={view}
          action={catalogActionFor(view, handlers)}
          error={errorFor(view)}
          onSelect={() => onSelect(view.item.uuid)}
        />
      ))}
    </div>
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  const type = useCatalogType()
  return <div className={`flex h-40 items-center justify-center ${type.text} text-[var(--color-text-muted)]`}>{text}</div>
}
