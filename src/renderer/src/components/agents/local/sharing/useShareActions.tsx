import { useEffect, useState, type ReactNode } from 'react'
import type { AgentShareResult, AgentShareStatus } from '../../../../../../shared/agentSharing'
import { unwrapLocalAgentOutcome } from '../../../../../../shared/localAgents'
import { useShareChanges, useUpdateShared, useUseTeamVersion } from '../../../../hooks/useSharing'
import { unwrapIpcError } from '../../../../utils/ipcError'
import { SHARE_UI_TEXT, shareRefusalSentence } from '../../../../utils/shareText'
import { ShareChangesDialog, ShareConflictDialog } from './ShareDialogs'

/** Update is offered when the team moved and the two sides can still combine cleanly. */
export function canUpdate(status: AgentShareStatus): boolean {
  if (status.state === 'removed' || status.state === 'other_account') return false
  return status.behind !== 0 && status.state !== 'diverged'
}

/**
 * Share changes is offered when there is something of this machine's to send,
 * and the caller may change the team's version. An `external` remote has no
 * listing to say, so it is always offered and the server answers.
 */
export function canShareChanges(status: AgentShareStatus): boolean {
  if (status.state === 'removed' || status.state === 'other_account') return false
  if (!status.unshared && status.state !== 'diverged') return false
  return status.remote.kind === 'external' || status.remote.access !== 'read'
}

export interface ShareActions {
  /** Run Update; a refusal goes to `onError`, a collision opens the two-button dialog. */
  update: () => void
  updatePending: boolean
  /** Open the Share changes dialog. */
  openShareChanges: () => void
  /** The dialogs, to be rendered by the caller wherever it likes (they portal). */
  dialogs: ReactNode
}

/**
 * Update and Share changes, with the dialogs they open. **One instance, on
 * the agent page**, serving both the badge in the chat header and the Sharing
 * tab: clicking the badge switches to settings mode and unmounts it, and a
 * result arriving then (a `diverged_conflict` from Update) must still open
 * the conflict dialog. The page renders `dialogs` in both modes.
 *
 * The mutations live in the component that calls this, which outlives the
 * dialogs: Share changes closes on success and hands a `diverged_conflict` to
 * the conflict dialog, which is opened here (ux_rules rule 5). Their results
 * arrive through hook-level callbacks, which run even if the dialog is gone.
 */
export function useShareActions(
  agentId: string,
  {
    onError,
    onNote
  }: {
    /** One line for an action's refusal; null clears it. */
    onError: (message: string | null) => void
    /** The page's quiet note slot — where the kept copy's name is mentioned. */
    onNote?: (message: string | null) => void
  }
): ShareActions {
  const [dialog, setDialog] = useState<'share' | 'conflict' | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)

  // One instance serves the page across agents: a dialog belongs to the
  // agent it was opened for.
  useEffect(() => {
    setDialog(null)
    setShareError(null)
    setConflictError(null)
  }, [agentId])

  const openConflict = (): void => {
    setConflictError(null)
    setDialog('conflict')
  }

  const update = useUpdateShared({
    onResult: (result) => {
      if (result.done) return
      if (result.refusal === 'diverged_conflict') openConflict()
      else if (result.refusal) onError(shareRefusalSentence(result.refusal, result.detail))
    }
  })
  const share = useShareChanges({
    onResult: (result) => {
      if (result.done) {
        setDialog(null)
        return
      }
      if (result.refusal === 'diverged_conflict') openConflict()
      else setShareError(refusalOf(result))
    }
  })
  const teamVersion = useUseTeamVersion({
    onResult: (result) => {
      if (!result.done) {
        setConflictError(refusalOf(result))
        return
      }
      setDialog(null)
      void announceCopy(result.agentId, result.detail, onNote)
    }
  })

  const dialogs = (
    <>
      {dialog === 'share' && (
        <ShareChangesDialog
          agentId={agentId}
          pending={share.isPending}
          error={shareError}
          onShare={(message) => {
            setShareError(null)
            share.mutate({ agentId, message }, { onError: (err) => setShareError(unwrapIpcError(err)) })
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'conflict' && (
        <ShareConflictDialog
          pending={teamVersion.isPending}
          error={conflictError}
          onUseTeamVersion={() => {
            setConflictError(null)
            teamVersion.mutate(agentId, { onError: (err) => setConflictError(unwrapIpcError(err)) })
          }}
          onKeepMine={() => setDialog(null)}
        />
      )}
    </>
  )

  return {
    update: () => {
      onError(null)
      update.mutate(agentId, { onError: (err) => onError(unwrapIpcError(err)) })
    },
    updatePending: update.isPending,
    openShareChanges: () => {
      onError(null)
      setShareError(null)
      setDialog('share')
    },
    dialogs
  }
}

function refusalOf(result: AgentShareResult): string {
  return shareRefusalSentence(result.refusal ?? 'failed', result.detail)
}

/** Name the copy Use the team's version kept, in the page's quiet note slot. */
async function announceCopy(
  copyId: string | null,
  notCarried: string | null,
  onNote: ((message: string | null) => void) | undefined
): Promise<void> {
  if (!onNote) return
  // Files that did not reach the team version (a credential, say) are named
  // after the copy: the agent may not run until the user restores them.
  const tail = notCarried ? ` ${SHARE_UI_TEXT.notCarried(notCarried)}` : ''
  if (!copyId) {
    onNote(SHARE_UI_TEXT.keptCopyUnnamed + tail)
    return
  }
  try {
    const copy = unwrapLocalAgentOutcome(await window.api.localAgents.get(copyId))
    onNote(SHARE_UI_TEXT.keptCopy(copy.name) + tail)
  } catch {
    onNote(SHARE_UI_TEXT.keptCopyUnnamed + tail)
  }
}
