import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentShareResult, AgentShareStatus } from '../../../../../../shared/agentSharing'
import { unwrapLocalAgentOutcome } from '../../../../../../shared/localAgents'
import { useNewChatFlow } from '../../../../hooks/useNewChatFlow'
import {
  useBeginAdoption,
  useDiscardAdoption,
  useDismissTeamChanges,
  useFinishAdoption,
  useShareChanges,
  useUpdateShared,
  useUseTeamVersion
} from '../../../../hooks/useSharing'
import { useChatStore } from '../../../../stores/chat.store'
import { useUIStore } from '../../../../stores/ui.store'
import { unwrapIpcError } from '../../../../utils/ipcError'
import { SHARE_UI_TEXT, shareRefusalSentence } from '../../../../utils/shareText'
import { DiscardAdoptionDialog, ShareChangesDialog, ShareConflictDialog } from './ShareDialogs'
import { useAgentShareStatus } from './useAgentShareStatus'

/** A session is bringing the team's changes together; only Finish or Discard leave it. */
export function isAdopting(status: AgentShareStatus): boolean {
  return status.state === 'adopting'
}

/** Update is offered when the team moved and the two sides can still combine cleanly. */
export function canUpdate(status: AgentShareStatus): boolean {
  if (status.state === 'removed' || status.state === 'other_account' || isAdopting(status)) return false
  return status.behind !== 0 && status.state !== 'diverged'
}

/**
 * Share changes is offered when there is something of this machine's to send,
 * and the caller may change the team's version. An `external` remote has no
 * listing to say, so it is always offered and the server answers. In
 * `diverged` its dialog opens on the Bring together step.
 */
export function canShareChanges(status: AgentShareStatus): boolean {
  if (status.state === 'removed' || status.state === 'other_account' || isAdopting(status)) return false
  if (!status.unshared && status.state !== 'diverged') return false
  return status.remote.kind === 'external' || status.remote.access !== 'use'
}

export interface ShareActions {
  /** Run Update; a refusal goes to `onError`, a collision opens the two-button dialog. */
  update: () => void
  updatePending: boolean
  /** Open the Share changes dialog — on its Bring together step when both sides moved. */
  openShareChanges: () => void
  /**
   * Bring together: begin the session, then open a chat with the agent and
   * send it the brief. A collision opens the two-button dialog.
   */
  bringTogether: () => void
  bringTogetherPending: boolean
  /** Finish the session; on success the Share changes dialog opens with the agent's summary. */
  finish: () => void
  finishPending: boolean
  /** Open the Discard confirm. */
  discard: () => void
  discardPending: boolean
  /** Not now: the chat banner waits for the team's next move. */
  notNow: () => void
  /** The dialogs, to be rendered by the caller wherever it likes (they portal). */
  dialogs: ReactNode
}

/**
 * Update, Share changes and the adoption session's Bring together, Finish,
 * Discard and Not now, with the dialogs they open. **One instance, on the
 * agent page**, serving the badge in the chat header, the chat banner and the
 * Sharing tab: clicking the badge switches to settings mode and unmounts it,
 * and a result arriving then (a `diverged_conflict` from Update) must still
 * open the conflict dialog. The page renders `dialogs` in both modes.
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
    onNote,
    agentName = ''
  }: {
    /** One line for an action's refusal; null clears it. */
    onError: (message: string | null) => void
    /** The page's quiet note slot — where the kept copy's name is mentioned. */
    onNote?: (message: string | null) => void
    /** Named in the Discard confirm. */
    agentName?: string
  }
): ShareActions {
  const [dialog, setDialog] = useState<'share' | 'conflict' | 'discard' | null>(null)
  /** Share changes opens on Bring together when both sides moved, else on the field. */
  const [shareStep, setShareStep] = useState<'combine' | 'message'>('message')
  /** The field's starting text after Finish: the session's own summary. */
  const [shareInitialMessage, setShareInitialMessage] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [discardError, setDiscardError] = useState<string | null>(null)
  // Read at settle time by the hook-level callbacks, which run after a render
  // that may have closed the dialog.
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  const status = useAgentShareStatus(agentId)
  const { startNewChat } = useNewChatFlow()

  // One instance serves the page across agents: a dialog belongs to the
  // agent it was opened for.
  useEffect(() => {
    setDialog(null)
    setShareError(null)
    setConflictError(null)
    setDiscardError(null)
  }, [agentId])

  const openConflict = (): void => {
    setConflictError(null)
    setDialog('conflict')
  }

  const openShare = (step: 'combine' | 'message', initialMessage: string | null): void => {
    setShareError(null)
    setShareStep(step)
    setShareInitialMessage(initialMessage)
    setDialog('share')
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
      // The team moved onto the same files while sending: the step's own
      // sentence says what to do, so no error line under it.
      else if (result.refusal === 'team_changed_again') openShare('combine', null)
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

  /**
   * The folder now holds both sides; the chat is where the agent reconciles
   * them. Its id is recorded for the "Open the session" link; a failure to
   * record it loses only that link, so it is logged and not shown.
   */
  const startSession = async (id: string, brief: string | null): Promise<void> => {
    if (!brief) {
      onError(SHARE_UI_TEXT.sessionNotStarted)
      return
    }
    const started = await startNewChat({
      message: brief,
      agentIds: [id],
      title: SHARE_UI_TEXT.adoptionChatTitle,
      mode: null,
      providerId: null,
      providers: undefined,
      allModels: undefined,
      mcpIds: []
    })
    if (!started) {
      onError(SHARE_UI_TEXT.sessionNotStarted)
      return
    }
    const chatId = useChatStore.getState().activeChatId
    if (chatId) {
      try {
        const outcome = await window.api.sharing.setAdoptionChat(id, chatId)
        if (!outcome.success) console.warn('[sharing] the session’s chat could not be recorded:', outcome.message)
      } catch (err) {
        console.warn('[sharing] the session’s chat could not be recorded:', unwrapIpcError(err))
      }
    }
    // As the embedded composer does after a send: the chat takes the screen.
    useUIStore.getState().setActiveView('chat')
    useUIStore.getState().setSidebarTab('chats')
  }

  const begin = useBeginAdoption({
    onResult: (result, id) => {
      if (result.done) {
        setDialog(null)
        void startSession(id, result.brief)
        return
      }
      if (result.refusal === 'diverged_conflict') {
        openConflict()
        return
      }
      const sentence = refusalOf(result)
      if (dialogRef.current === 'share') setShareError(sentence)
      else onError(sentence)
    }
  })
  const finish = useFinishAdoption({
    onResult: (result) => {
      if (result.done) openShare('message', result.summary)
      else onError(refusalOf(result))
    }
  })
  const discard = useDiscardAdoption({
    onResult: (result) => {
      if (result.done) setDialog(null)
      else setDiscardError(refusalOf(result))
    }
  })
  const dismiss = useDismissTeamChanges({
    onResult: (result) => {
      if (!result.done) onError(refusalOf(result))
    }
  })

  const bringTogether = (): void => {
    onError(null)
    begin.mutate(agentId, {
      onError: (err) => {
        const sentence = unwrapIpcError(err)
        if (dialogRef.current === 'share') setShareError(sentence)
        else onError(sentence)
      }
    })
  }

  const dialogs = (
    <>
      {dialog === 'share' && (
        <ShareChangesDialog
          agentId={agentId}
          pending={share.isPending}
          error={shareError}
          combineFirst={shareStep === 'combine'}
          onBringTogether={bringTogether}
          bringTogetherPending={begin.isPending}
          initialMessage={shareInitialMessage}
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
      {dialog === 'discard' && (
        <DiscardAdoptionDialog
          name={agentName || 'this agent'}
          pending={discard.isPending}
          error={discardError}
          onDiscard={() => {
            setDiscardError(null)
            discard.mutate(agentId, { onError: (err) => setDiscardError(unwrapIpcError(err)) })
          }}
          onCancel={() => setDialog(null)}
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
      openShare(status?.state === 'diverged' ? 'combine' : 'message', null)
    },
    bringTogether,
    bringTogetherPending: begin.isPending,
    finish: () => {
      onError(null)
      finish.mutate(agentId, { onError: (err) => onError(unwrapIpcError(err)) })
    },
    finishPending: finish.isPending,
    discard: () => {
      onError(null)
      setDiscardError(null)
      setDialog('discard')
    },
    discardPending: discard.isPending,
    notNow: () => {
      onError(null)
      dismiss.mutate(agentId, { onError: (err) => onError(unwrapIpcError(err)) })
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
