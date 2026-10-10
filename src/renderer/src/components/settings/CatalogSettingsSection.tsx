/**
 * Settings → Profile → Catalog: the catalog dialog's list on a settings page —
 * every agent and skill the active Cinna profile may use, with the same
 * filter, search, tiles, detail and actions (Get / Update / Open / Add to
 * agent… / Uninstall), built from the same hooks and components and set at
 * the Settings type scale (ux_rules rules 12 and 13).
 *
 * The detail takes the grid's place rather than covering it; the filter and
 * the search are kept behind it. An action that ends on an agent lands the
 * user on its page, as it does from the dialog.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useRefreshCatalogState } from '../../hooks/useCatalog'
import { useCatalogActions } from '../../hooks/useCatalogActions'
import { useCatalogEntries } from '../../hooks/useCatalogEntries'
import { useSettleGuard } from '../../hooks/useSettleGuard'
import { useAuthStore } from '../../stores/auth.store'
import { CATALOG_TEXT, type CatalogFilter } from '../../utils/catalogItems'
import { CatalogItemDetailView } from '../agents/CatalogItemViews'
import {
  CatalogListBody,
  CatalogRefreshFailure,
  CatalogSearchRow,
  CatalogTileGrid,
  catalogActionFor,
  useCatalogReauth,
  useFilteredCatalog
} from '../agents/CatalogBrowserParts'
import { CatalogSurfaceProvider } from '../agents/catalogSurface'
import { SettingsButton, SettingsSection } from './SettingsLayout'

export function CatalogSettingsSection(): React.JSX.Element {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  if (!isCinnaUser) {
    return <p className="text-[13px] text-[var(--color-text-muted)]">{CATALOG_TEXT.signedOut}</p>
  }
  return (
    <CatalogSurfaceProvider value="settings">
      <CatalogSettingsList />
    </CatalogSurfaceProvider>
  )
}

function CatalogSettingsList(): React.JSX.Element {
  const queryClient = useQueryClient()
  // Opening the tab is when the user wants the catalog as it is now.
  const { catalog, teamLibrary, views } = useCatalogEntries({ refresh: true })
  const refresh = useRefreshCatalogState()
  const reauth = useCatalogReauth(catalog)
  // Landing on an agent leaves Settings; there is nothing here to close.
  const actions = useCatalogActions({ onLanded: () => undefined })
  const [filter, setFilter] = useState<CatalogFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null)
  // The detail's actions open under the pointer that clicked the tile.
  const detailSettled = useSettleGuard(selectedUuid)
  const { shown, inFilter, selected } = useFilteredCatalog(views, filter, query, selectedUuid)

  // A failure left by another visit (or by the dialog) is not this one's.
  const { clearErrors } = actions
  useEffect(() => {
    clearErrors()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Versions are kept while the tab is open; the next visit reads them afresh.
  useEffect(() => () => queryClient.removeQueries({ queryKey: ['catalog', 'item'] }), [queryClient])

  const handlers = { install: actions.install, cloudUpdate: actions.cloudUpdate, desktop: actions.desktop }

  /**
   * Back to the catalog returns to the place in the grid: the detail replaces
   * the grid, so the settings page's scroll is saved on opening a tile and
   * put back, with focus on that tile, when the grid returns (rule 1).
   */
  const bodyRef = useRef<HTMLDivElement>(null)
  const returnTo = useRef<{ uuid: string; scrollTop: number } | null>(null)
  const scroller = (): HTMLElement | null => bodyRef.current?.closest<HTMLElement>('[data-settings-scroller]') ?? null
  const openItem = (uuid: string): void => {
    returnTo.current = { uuid, scrollTop: scroller()?.scrollTop ?? 0 }
    setSelectedUuid(uuid)
  }
  const showingDetail = selected !== null
  useLayoutEffect(() => {
    if (showingDetail || returnTo.current === null) return
    const { uuid, scrollTop } = returnTo.current
    returnTo.current = null
    const page = scroller()
    if (page) page.scrollTop = scrollTop
    bodyRef.current
      ?.querySelector<HTMLElement>(`[data-catalog-item="${CSS.escape(uuid)}"] button`)
      ?.focus({ preventScroll: true })
  }, [showingDetail])

  return (
    <SettingsSection
      title={CATALOG_TEXT.sectionTitle}
      action={
        <div className="flex min-w-0 items-center gap-2">
          <CatalogRefreshFailure catalog={catalog} reauth={reauth} />
          <SettingsButton
            onClick={() => {
              refresh()
              void teamLibrary.refetch()
            }}
            disabled={catalog.isFetching}
            aria-busy={catalog.isFetching}
          >
            <RefreshCw size={12} className={catalog.isFetching ? 'animate-spin' : ''} aria-hidden="true" />
            {CATALOG_TEXT.refresh}
          </SettingsButton>
        </div>
      }
    >
      <div ref={bodyRef}>
        {selected ? (
          <CatalogItemDetailView
            view={selected}
            action={catalogActionFor(selected, handlers, detailSettled)}
            error={actions.errorFor(selected)}
            onBack={() => setSelectedUuid(null)}
            settled={detailSettled}
            uninstall={actions.uninstall}
          />
        ) : (
          <div className="space-y-3">
            <CatalogSearchRow query={query} onQuery={setQuery} filter={filter} onFilter={setFilter} />
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
                errorFor={actions.errorFor}
                onSelect={openItem}
                className="grid grid-cols-2 gap-3"
              />
            </CatalogListBody>
          </div>
        )}
      </div>
    </SettingsSection>
  )
}
