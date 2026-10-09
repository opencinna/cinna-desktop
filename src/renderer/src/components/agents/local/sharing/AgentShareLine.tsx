import { useState } from 'react'
import { Loader2, Users } from 'lucide-react'
import type { AgentShareResult, AgentShareStatus } from '../../../../../../shared/agentSharing'
import { unwrapLocalAgentOutcome } from '../../../../../../shared/localAgents'
import {
  useListedShareStatus,
  useShareChanges,
  useShareStatus,
  useUpdateShared,
  useUseTeamVersion
} from '../../../../hooks/useSharing'
import { unwrapIpcError } from '../../../../utils/ipcError'
import {
  SHARE_UI_TEXT,
  shareRefusalSentence,
  shareStatusSentence
} from '../../../../utils/shareText'
import { ShareChangesDialog, ShareConflictDialog } from './ShareDialogs'

const ACTION =
  'inline-flex h-5 min-w-[4.5rem] items-center justify-center gap-1 rounded border border-[var(--color-border)] px-2 ' +
  'text-[10px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

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

/**
 * A shared agent's one quiet status line, under the page header.
 *
 * **The slot is decided at first paint.** Whether the agent is shared comes
 * from the statuses list the sidebar has already loaded, not from this agent's
 * own status, so the line is present (or absent) from the first frame and the
 * per-agent read only changes the words in it (ux_rules rules 1 and 2). It is
 * one fixed-height line whatever it says: a state, a failed read's refusal, or
 * the refusal of the last action taken from it.
 *
 * It owns the mutations its buttons and dialogs run, because it outlives the
 * dialogs: Share changes closes on success and hands a `diverged_conflict` to
 * the conflict dialog, which is opened here (ux_rules rule 5).
 */
export function AgentShareLine({
  agentId,
  onNote
}: {
  agentId: string
  /** The page's quiet note slot — where the kept copy's name is mentioned. */
  onNote?: (message: string | null) => void
}): React.JSX.Element | null {
  const listed = useListedShareStatus(agentId)
  const own = useShareStatus(listed ? agentId : null, listed ? listed.remote.kind : null)
  const status = own.data === undefined ? listed : own.data
  const [dialog, setDialog] = useState<'share' | 'conflict' | null>(null)
  const [lineError, setLineError] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)

  const openConflict = (): void => {
    setConflictError(null)
    setDialog('conflict')
  }

  const update = useUpdateShared({
    onResult: (result) => {
      if (result.done) return
      if (result.refusal === 'diverged_conflict') openConflict()
      else if (result.refusal) setLineError(shareRefusalSentence(result.refusal, result.detail))
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

  // Not shared, or not known yet: no slot. The list is loaded before any
  // agent page can open (the sidebar reads it), so "not known yet" is the
  // instant of a cold start, not a state that later grows a line.
  if (!listed) return null

  const pendingUpdate = update.isPending
  const sentence = lineError ?? (status ? shareStatusSentence(status) : '')
  const warn = lineError !== null || status?.refusal != null

  return (
    <>
      <div className="flex h-6 items-center gap-2" data-share-line>
        <Users size={11} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
        <span
          role={warn ? 'alert' : 'status'}
          title={sentence}
          className={`min-w-0 flex-1 truncate text-[10px] leading-4 ${
            warn ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-secondary)]'
          }`}
        >
          {sentence}
        </span>
        {/* A fixed-width slot, right-aligned, so the sentence truncates at the
            same point whichever buttons the state offers. */}
        <span className="flex w-[11rem] shrink-0 items-center justify-end gap-1.5">
          {status && canUpdate(status) && (
            <button
              type="button"
              className={ACTION}
              disabled={pendingUpdate}
              aria-busy={pendingUpdate}
              onClick={() => {
                setLineError(null)
                update.mutate(agentId, {
                  onError: (err) => setLineError(unwrapIpcError(err))
                })
              }}
            >
              {pendingUpdate && <Loader2 size={10} className="animate-spin" aria-hidden="true" />}
              {pendingUpdate ? SHARE_UI_TEXT.updating : SHARE_UI_TEXT.update}
            </button>
          )}
          {status && canShareChanges(status) && (
            <button
              type="button"
              className={ACTION}
              disabled={pendingUpdate}
              onClick={() => {
                setLineError(null)
                setShareError(null)
                setDialog('share')
              }}
            >
              {SHARE_UI_TEXT.shareChanges}
            </button>
          )}
        </span>
      </div>
      {dialog === 'share' && (
        <ShareChangesDialog
          agentId={agentId}
          pending={share.isPending}
          error={shareError}
          onShare={(message) => {
            setShareError(null)
            share.mutate(
              { agentId, message },
              { onError: (err) => setShareError(unwrapIpcError(err)) }
            )
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
