import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AddTileInput, DashboardsErrorCode, DashboardsOutcome, UpdateTileInput } from '../../../shared/dashboards'

/**
 * Dashboards in the renderer: queries over `window.api.dashboards`, and the
 * mutations that change them. Every IPC answer is data; a refusal is thrown
 * here as an `Error` with its sentence, so a mutation's `error` carries it to
 * the surface that asked (ux rule 6).
 */

export const DASHBOARDS_KEY = ['dashboards'] as const
export const dashboardListKey = ['dashboards', 'list'] as const
export const dashboardTilesKey = (dashboardId: string | null) => ['dashboards', 'tiles', dashboardId] as const
export const tileResultKey = (tileId: string) => ['dashboards', 'result', tileId] as const
export const componentsKey = (agentId: string | null) => ['dashboards', 'components', agentId] as const
export const placementsKey = (agentId: string) => ['dashboards', 'placements', agentId] as const
/** A cloud agent's components and their placements (D6): under placements, so adding or removing a tile re-reads it. */
export const cloudComponentsKey = (agentId: string | null) => ['dashboards', 'placements', 'cloud', agentId] as const
/** Every resolved component reference: placements and components change under them. */
export const REFERENCES_KEY = ['dashboards', 'reference'] as const
export const referenceKey = (reference: string, chatAgentId: string | null) => ['dashboards', 'reference', reference, chatAgentId] as const

/** The last dashboard something was added to: the Add dialog's default (ux rule 4). */
const LAST_DASHBOARD_KEY = 'cinna.dashboards.lastUsed'
export function readLastDashboardId(): string | null {
  try {
    return localStorage.getItem(LAST_DASHBOARD_KEY)
  } catch {
    return null
  }
}
export function rememberLastDashboardId(id: string): void {
  try {
    localStorage.setItem(LAST_DASHBOARD_KEY, id)
  } catch {
    // Private storage refused: the dialog falls back to the first dashboard.
  }
}

/** A refusal from main, thrown with its code so a surface can add the action that fits it (D6.10). */
export class DashboardsRefusal extends Error {
  constructor(readonly code: DashboardsErrorCode, message: string) {
    super(message)
    this.name = 'DashboardsRefusal'
  }
}

/** The refusal's code, when the error is one; null for an IPC failure or anything else. */
export function refusalCode(error: unknown): DashboardsErrorCode | null {
  return error instanceof DashboardsRefusal ? error.code : null
}

export function unwrap<T>(outcome: DashboardsOutcome<T>): { ok: true } & T {
  if (!outcome.ok) throw new DashboardsRefusal(outcome.code, outcome.message)
  return outcome
}

export function useDashboardList(enabled = true) {
  return useQuery({ queryKey: dashboardListKey, queryFn: () => window.api.dashboards.list(), enabled })
}

/** A dashboard's name by id, or null when there is none (deleted, or no id). Shares the list's cache. */
export function useDashboardName(dashboardId: string | null | undefined): string | null {
  const list = useDashboardList(!!dashboardId)
  if (!dashboardId) return null
  return list.data?.find((d) => d.id === dashboardId)?.name ?? null
}

export function useDashboardTiles(dashboardId: string | null) {
  return useQuery({
    queryKey: dashboardTilesKey(dashboardId),
    queryFn: async () => unwrap(await window.api.dashboards.tiles(dashboardId!)),
    enabled: !!dashboardId,
    retry: false
  })
}

export function useTileResult(tileId: string | null) {
  return useQuery({
    queryKey: tileResultKey(tileId ?? ''),
    queryFn: async () => unwrap(await window.api.dashboards.tileResult(tileId!)).result,
    enabled: !!tileId,
    retry: false
  })
}

export function useComponents(agentId: string | null) {
  return useQuery({
    queryKey: componentsKey(agentId),
    queryFn: () => window.api.dashboards.components(agentId ?? undefined),
    enabled: !!agentId
  })
}

/**
 * What a reference in a chat names (README §5.5), read from the spec and the
 * placements only: resolving runs nothing (D8). A miss is data, never thrown.
 */
export function useComponentReference(reference: string, chatAgentId: string | null) {
  return useQuery({
    queryKey: referenceKey(reference, chatAgentId),
    queryFn: async () => unwrap(await window.api.dashboards.resolveReference({ reference, chatAgentId })).resolution,
    retry: false
  })
}

/**
 * A cloud agent's components from its Cinna server (D6.8), with this
 * profile's tiles of them. A refusal (`unreachable`, `reauth_required`,
 * `not_owner`, `not_found`) is data, so the tab can say which and offer the
 * way out; only an IPC failure is thrown.
 */
export function useCloudComponents(agentId: string | null) {
  return useQuery({
    queryKey: cloudComponentsKey(agentId),
    queryFn: () => window.api.dashboards.cloudComponents(agentId!),
    enabled: !!agentId,
    retry: false
  })
}

export function usePlacements(agentId: string) {
  return useQuery({ queryKey: placementsKey(agentId), queryFn: () => window.api.dashboards.placements(agentId) })
}

/**
 * Main's pushes, for the app's lifetime: a tile's data or refresh state
 * changed, or an agent's folder changed (components follow it).
 */
export function useDashboardsWatch(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    const offTile = window.api.dashboards.onTileChanged(({ tileId }) => {
      void queryClient.invalidateQueries({ queryKey: tileResultKey(tileId) })
      // Params set from main (an agent's dashboards_update_tile) reach the tile's filters and page.
      void queryClient.invalidateQueries({ queryKey: ['dashboards', 'tiles'] })
    })
    const offFolder = window.api.localAgents.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: ['dashboards', 'components'] })
      void queryClient.invalidateQueries({ queryKey: ['dashboards', 'tiles'] })
      void queryClient.invalidateQueries({ queryKey: REFERENCES_KEY })
    })
    return () => {
      offTile()
      offFolder()
    }
  }, [queryClient])
}

/** Every dashboard query: lists, tiles, placements, resolved references. Results refetch through their own pushes. */
function invalidateStructure(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: dashboardListKey })
  void queryClient.invalidateQueries({ queryKey: ['dashboards', 'tiles'] })
  void queryClient.invalidateQueries({ queryKey: ['dashboards', 'placements'] })
  void queryClient.invalidateQueries({ queryKey: REFERENCES_KEY })
}

export function useCreateDashboard() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) => unwrap(await window.api.dashboards.create(name)).dashboard,
    onSuccess: () => invalidateStructure(queryClient)
  })
}

export function useRenameDashboard() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { dashboardId: string; name: string }) => unwrap(await window.api.dashboards.rename(input.dashboardId, input.name)).dashboard,
    onSuccess: () => invalidateStructure(queryClient)
  })
}

export function useDeleteDashboard() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (dashboardId: string) => {
      unwrap(await window.api.dashboards.delete(dashboardId))
      return dashboardId
    },
    onSuccess: () => invalidateStructure(queryClient)
  })
}

export function useAddTile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: AddTileInput) => unwrap(await window.api.dashboards.addTile(input)),
    // Hook-level, so it runs even when the dialog that asked has closed.
    onSuccess: (added) => {
      rememberLastDashboardId(added.dashboard.id)
      invalidateStructure(queryClient)
    }
  })
}

export function useUpdateTile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: UpdateTileInput) => unwrap(await window.api.dashboards.updateTile(input)).tile,
    onSuccess: (tile) => {
      invalidateStructure(queryClient)
      void queryClient.invalidateQueries({ queryKey: tileResultKey(tile.id) })
    }
  })
}

export function useMoveTile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { tileId: string; toIndex: number }) => unwrap(await window.api.dashboards.moveTile(input.tileId, input.toIndex)),
    onSettled: () => invalidateStructure(queryClient)
  })
}

export function useRemoveTile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (tileId: string) => unwrap(await window.api.dashboards.removeTile(tileId)),
    onSuccess: () => invalidateStructure(queryClient)
  })
}
