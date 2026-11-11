import { useMutation, useQuery, useQueryClient, type MutationOptions, type QueryClient } from '@tanstack/react-query'
import type {
  AgentFileActionResult,
  PinnedAgentFile,
  SetPinnedAgentFileResult
} from '../../../shared/agentFiles'

/** One cache entry per agent; a profile switch resets every query. */
export const pinnedFilesKey = (agentId: string | null): readonly unknown[] => ['agent-pinned-files', agentId]

/**
 * The active profile's pinned files for a folder agent, in rank order. Pass
 * null for no agent, or for an agent that is not a folder agent: nothing is
 * asked then. Main only stats; the list is refetched on mount, after a pin
 * change, when a preview finds a pinned file gone and when a turn ends (the
 * app turns off refetch on window focus). A failure (the agent left its
 * folder) reads as no pins.
 */
export function usePinnedFiles(agentId: string | null) {
  return useQuery({
    queryKey: pinnedFilesKey(agentId),
    queryFn: async (): Promise<PinnedAgentFile[]> => {
      const result = await window.api.agentFiles.listPins({ agentId: agentId! })
      return result.success ? result.pins : []
    },
    enabled: agentId !== null
  })
}

/**
 * Whether `path` is pinned for the agent, or undefined until the list has
 * loaded. Compared on the absolute path main resolves and the transcript's
 * references carry, both canonical realpaths.
 */
export function useIsFilePinned(agentId: string | null, path: string | null): boolean | undefined {
  const { data } = usePinnedFiles(agentId)
  if (!data || path === null) return undefined
  return data.some((pin) => pin.path === path)
}

export interface TogglePinnedFileInput {
  agentId: string
  path: string
  /**
   * What the user asked for: true to pin, false to unpin. Sent as is, so a
   * file named in another spelling than the stored pin is never unpinned by
   * a click on Pin file.
   */
  pinned: boolean
  /** For the optimistic row a new pin shows as until main answers. */
  displayPath: string
  inside: boolean
}

type PinsSnapshot = { prev: PinnedAgentFile[] | undefined }

async function patchPins(
  queryClient: QueryClient,
  agentId: string,
  patch: (pins: PinnedAgentFile[]) => PinnedAgentFile[]
): Promise<PinsSnapshot> {
  await queryClient.cancelQueries({ queryKey: pinnedFilesKey(agentId) })
  const prev = queryClient.getQueryData<PinnedAgentFile[]>(pinnedFilesKey(agentId))
  if (prev) queryClient.setQueryData<PinnedAgentFile[]>(pinnedFilesKey(agentId), patch(prev))
  return { prev }
}

/**
 * Pin or unpin a file, as `pinned` asks. Optimistic: the list changes at
 * once, following the intent rather than what it holds, and is invalidated
 * once main answers. A refusal comes back as data (`{ success: false }`) and
 * undoes the optimistic change.
 *
 * Every callback is on the mutation's own options, never `mutate`-level: the
 * menus offering it unmount on the click, and a `mutate`-level callback of an
 * unmounted caller never runs.
 */
function togglePinnedFileOptions(
  queryClient: QueryClient
): MutationOptions<SetPinnedAgentFileResult, Error, TogglePinnedFileInput, PinsSnapshot> {
  return {
    mutationFn: ({ agentId, path, pinned }) => window.api.agentFiles.setPin({ agentId, path, pinned }),
    onMutate: ({ agentId, path, displayPath, inside, pinned }) =>
      patchPins(queryClient, agentId, (pins) =>
        !pinned
          ? pins.filter((pin) => pin.path !== path)
          : pins.some((pin) => pin.path === path)
            ? pins
            : [
                ...pins,
                { path, displayPath, inside, exists: true, rank: Math.max(0, ...pins.map((pin) => pin.rank)) + 1 }
              ]
      ),
    onSuccess: (result, { agentId }, ctx) => {
      if (!result.success && ctx?.prev) queryClient.setQueryData(pinnedFilesKey(agentId), ctx.prev)
    },
    onError: (_err, { agentId }, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(pinnedFilesKey(agentId), ctx.prev)
    },
    onSettled: (_data, _err, { agentId }) => {
      void queryClient.invalidateQueries({ queryKey: pinnedFilesKey(agentId) })
    }
  }
}

/** {@link togglePinnedFileOptions} as a hook, for a surface that stays mounted while it runs. */
export function useTogglePinnedFile() {
  const queryClient = useQueryClient()
  return useMutation(togglePinnedFileOptions(queryClient))
}

/**
 * The same mutation run once, outside any component: built in the client's
 * mutation cache (so its callbacks and the app's cache-wide ones run as for
 * {@link useTogglePinnedFile}), owned by nothing that can unmount. Resolves to
 * main's answer; rejects only when the call itself threw.
 */
export function togglePinnedFile(queryClient: QueryClient, input: TogglePinnedFileInput): Promise<SetPinnedAgentFileResult> {
  return queryClient.getMutationCache().build(queryClient, togglePinnedFileOptions(queryClient)).execute(input)
}

/**
 * A drop in the Pinned files card, at the rank the card computed from the new
 * neighbours. Optimistic, as `useMoveChat` is: the row stays where it was put.
 */
export function useMovePinnedFile() {
  const queryClient = useQueryClient()
  return useMutation<AgentFileActionResult, Error, { agentId: string; path: string; rank: number }, PinsSnapshot>({
    mutationFn: ({ agentId, path, rank }) => window.api.agentFiles.movePin({ agentId, path, rank }),
    onMutate: ({ agentId, path, rank }) =>
      patchPins(queryClient, agentId, (pins) =>
        pins
          .map((pin) => (pin.path === path ? { ...pin, rank } : pin))
          .sort((a, b) => a.rank - b.rank)
      ),
    onSuccess: (result, { agentId }, ctx) => {
      if (!result.success && ctx?.prev) queryClient.setQueryData(pinnedFilesKey(agentId), ctx.prev)
    },
    onError: (_err, { agentId }, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(pinnedFilesKey(agentId), ctx.prev)
    },
    onSettled: (_data, _err, { agentId }) => {
      void queryClient.invalidateQueries({ queryKey: pinnedFilesKey(agentId) })
    }
  })
}
