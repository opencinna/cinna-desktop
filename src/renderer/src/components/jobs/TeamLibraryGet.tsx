import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Download, Loader2 } from 'lucide-react'
import { useGetFromLibrary, useTeamLibrary } from '../../hooks/useSharing'
import { unwrapIpcError } from '../../utils/ipcError'
import { SHARE_UI_TEXT, shareRefusalSentence } from '../../utils/shareText'

/**
 * "Get *X* from the team library" on a blocked job's unavailable folder
 * dependency — offered only when the Team library lists an agent with the
 * dependency's manifest id that this machine does not have yet.
 *
 * Mounted only for a row that has a manifest id, so a job with nothing to get
 * never reads the library. Renders nothing while the library loads or when it
 * has no match: the row then reads exactly as it did before. A refusal shows
 * beside the button, in the row, with the whole sentence as its tooltip.
 */
export function TeamLibraryGet({
  jobId,
  manifestId
}: {
  jobId: string
  manifestId: string
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const library = useTeamLibrary()
  const [error, setError] = useState<string | null>(null)
  const get = useGetFromLibrary({
    onResult: (result) => {
      if (result.done) {
        // The dependency resolves against the new folder; re-read it and the
        // job, whose blocked state is derived from the same resolution.
        void queryClient.invalidateQueries({ queryKey: ['jobs', jobId] })
      } else {
        setError(shareRefusalSentence(result.refusal ?? 'failed', result.detail))
      }
    }
  })
  const match = library.data?.agents.find(
    (agent) => agent.manifestId === manifestId && agent.localAgentId === null
  )
  if (!match) return null

  const pending = get.isPending
  return (
    <span className="ml-auto flex min-w-0 items-center gap-1.5">
      {error && (
        <span role="alert" title={error} className="min-w-0 truncate text-[10px] text-[var(--color-danger)]">
          {error}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        aria-busy={pending}
        onClick={() => {
          setError(null)
          get.mutate(match.repoId, { onError: (err) => setError(unwrapIpcError(err)) })
        }}
        className="inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded
          text-[10px] font-medium text-[var(--color-accent)]
          hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-60"
      >
        {pending ? (
          <Loader2 size={10} className="animate-spin" aria-hidden="true" />
        ) : (
          <Download size={10} aria-hidden="true" />
        )}
        {pending ? SHARE_UI_TEXT.getting : SHARE_UI_TEXT.getFromLibrary(match.name)}
      </button>
    </span>
  )
}
