import { useCallback, useMemo, useState } from 'react'
import { useCatalogEntries } from './useCatalogEntries'
import { useCatalogInstall } from './useCatalogInstall'
import { useGetFromLibrary } from './useSharing'
import { shareRefusalSentence } from '../utils/shareText'
import { unwrapIpcError } from '../utils/ipcError'
import type { CatalogPickerItem } from '../components/agents/AgentPickerModal'
import { needsLine, type CatalogEntryView } from '../components/agents/CatalogItemViews'

export interface CatalogPicker {
  /** Catalog agents not on this computer yet, for the picker's Catalog section. */
  catalogItems: CatalogPickerItem[]
  /** Catalog item (uuid) whose Get is in flight (spinner). */
  installingId: string | null
  /** A Get is running — a cloud install from any surface, or this picker's desktop Get: every Get waits. */
  busy: boolean
  /** Get an item, then select the resulting agent. */
  install: (id: string) => void
  /** The last Get's failure, when this picker started it. */
  error: string | null
}

/**
 * The picker's Catalog section: the catalog's agents the user does not have on
 * this computer yet — a cloud agent with no install of the user's, a desktop
 * agent no local agent holds — never skills, which are added to an agent, not
 * to a chat. Each is tiled with its kind badge (Runs in Cinna / Runs on your
 * computer), as the catalog dialog labels them.
 */
export function catalogPickerItems(views: CatalogEntryView[]): CatalogPickerItem[] {
  return views.flatMap((view): CatalogPickerItem[] => {
    if (view.kind === 'cloud_agent' && view.cloud?.installId === null) {
      return [pickerItem(view, 'cloud_agent')]
    }
    // A desktop agent is got through its team entry; without one there is nothing to Get.
    if (view.kind === 'desktop_agent' && view.desktop !== null && view.desktop.localAgentId === null) {
      return [pickerItem(view, 'desktop_agent')]
    }
    return []
  })
}

/** What the picker's catalog card shows of an item: a tile's lines, without its detail. */
function pickerItem(view: CatalogEntryView, kind: CatalogPickerItem['kind']): CatalogPickerItem {
  return {
    id: view.item.uuid,
    kind,
    name: view.name,
    description: view.item.description,
    meta: view.people,
    version: view.version,
    // The picker's Get skips the setup check: say up front what it will ask for.
    needs: needsLine(view.specs)
  }
}

/**
 * Backs the picker's "Catalog" section and runs a Get from the new-chat /
 * add-agents modal, then hands the new agent's id to `onInstalled` so the
 * owner selects it — the tile flips from a Catalog card to a selected
 * capability.
 *
 * - A cloud agent: {@link useCatalogInstall} (quick install → awaited remote
 *   sync → find the synced agent).
 * - A desktop agent: the team library's Get, whose result names the local
 *   agent it made (`result.agentId`, a folder agent id).
 *
 * Both completions are component-bound: if the picker is gone when the Get
 * lands, there is nothing to select the agent in, and dropping the selection
 * is right. The cloud install's own landing callback is mount-guarded; the
 * desktop Get's selection is a `mutate`-level callback, which TanStack drops
 * on unmount, while its hook-level effects (re-reads, Finish setup) still run.
 * Both capture `onInstalled` at the click: ChatInput switches chats without
 * remounting, and the agent belongs to the chat the user clicked in.
 *
 * We deliberately skip the `setup-status` check the catalog's own landing
 * does: if credentials are incomplete the agent says so on the first message,
 * so the in-chat flow stays a single click.
 */
export function useCatalogPicker(onInstalled: (agentId: string) => void): CatalogPicker {
  const { views } = useCatalogEntries()
  const { installingBundleId, install: startInstall, error: installError } = useCatalogInstall({
    onInstalled: (agentId) => onInstalled(agentId)
  })
  const getFromLibrary = useGetFromLibrary()
  const [getError, setGetError] = useState<{ id: string; message: string } | null>(null)
  // The install error is app-wide; this picker shows only the one for the
  // install it started, not a failure left behind by the sidebar catalog.
  const [startedId, setStartedId] = useState<string | null>(null)

  const catalogItems = useMemo(() => catalogPickerItems(views), [views])
  const viewById = useMemo(() => new Map(views.map((view) => [view.item.uuid, view])), [views])

  const getting = getFromLibrary.isPending ? (getFromLibrary.variables ?? null) : null
  const busy = installingBundleId !== null || getting !== null
  const install = useCallback(
    (id: string): void => {
      const view = viewById.get(id)
      if (!view || busy) return
      setStartedId(id)
      setGetError(null)
      if (view.kind === 'cloud_agent') {
        startInstall(view.item.id)
        return
      }
      if (view.kind !== 'desktop_agent' || !view.desktop) return
      const select = onInstalled
      getFromLibrary.mutate(view.desktop.repoId, {
        onSuccess: (result) => {
          if (result.done && result.agentId) select(result.agentId)
          else if (!result.done) {
            setGetError({ id, message: shareRefusalSentence(result.refusal ?? 'failed', result.detail) })
          }
        },
        onError: (err) => setGetError({ id, message: unwrapIpcError(err) })
      })
    },
    [viewById, busy, startInstall, getFromLibrary, onInstalled]
  )

  // The spinner: a cloud install from any surface (by bundle id), or this picker's desktop Get (by repo).
  const installingId = useMemo(() => {
    for (const view of views) {
      if (view.kind === 'cloud_agent' && installingBundleId !== null && view.item.id === installingBundleId) return view.item.uuid
      if (view.kind === 'desktop_agent' && getting !== null && view.desktop?.repoId === getting) return view.item.uuid
    }
    return null
  }, [views, installingBundleId, getting])

  const startedView = startedId ? viewById.get(startedId) : undefined
  const error =
    getError !== null && getError.id === startedId
      ? getError.message
      : installError !== null && startedView?.kind === 'cloud_agent' && installError.bundleId === startedView.item.id
        ? installError.message
        : null

  return { catalogItems, installingId, busy, install, error }
}
