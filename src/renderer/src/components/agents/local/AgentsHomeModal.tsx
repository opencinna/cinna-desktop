import { useEffect, useRef } from 'react'
import { FolderPlus, Loader2 } from 'lucide-react'
import {
  useAgentsHome,
  useChooseAgentsHome,
  useGrantAgentsHome
} from '../../../hooks/useLocalAgents'
import { useAgentsHomeStore } from '../../../stores/agentsHome.store'
import { useDialogChrome } from '../../settings/SettingsLayout'
import { unwrapIpcError } from '../../../utils/ipcError'

const btnDismissClass =
  'px-4 py-2 text-sm rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors disabled:opacity-50'

/**
 * The accent-filled action, at a width both branches share.
 *
 * The min-width is the fix for a specific hazard, not decoration: `Create
 * folder` and `Choose folder…` are different verbs that occupy the rightmost
 * slot one click apart, and at their natural widths the second sat 18px to the
 * left of the first — under the pointer that had just pressed it, so a stray
 * double-click on "create" opened the OS directory picker (ux_rules rule 1).
 */
const btnPrimaryClass =
  'px-5 py-2 min-w-[152px] text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50'

/**
 * Reserved height of the dialog body, footer included.
 *
 * The two questions are not the same length, and the shell is centred in the
 * viewport, so without this the footer rose 8px when the explainer became the
 * "where instead?" question — moving the primary button under a pointer that
 * had just clicked there. Sized for the taller branch (the explainer, with a
 * path long enough to wrap and the message slot reserved); the shorter one pads
 * out below its content (ux_rules rule 1). Measured in the built app, not
 * guessed — the guess was 24px short and the footer still moved.
 */
const BODY_MIN_HEIGHT = 'min-h-[368px]'

/**
 * "Where your agents will live" — the folder question, asked before macOS asks
 * its own.
 *
 * On a Mac the agents home is `~/Documents/CinnaAgents`, and creating it raises
 * the system's *"would like to access files in your Documents folder"* prompt.
 * That dialog explains nothing about agents, and until this existed it arrived
 * at whatever moment some screen happened to want the path — including in the
 * middle of signing in. This says what the folder is first, so the system
 * prompt that follows is the answer to a question the user has just read.
 *
 * **It is raised by demand, never by launch.** `useAgentsHomeStore` is set by
 * the surfaces that actually need the folder; see the note there.
 *
 * Two questions, one dialog. If the system refuses, the follow-up is not an
 * error to acknowledge — it is the next question ("then where?"), answered by
 * another folder or by the switch in System Settings. Keeping both in one shell
 * of one size is what stops the refusal reading as a dead end, and what keeps
 * the footer still across the change.
 */
export function AgentsHomeModal(): React.JSX.Element | null {
  const ask = useAgentsHomeStore((s) => s.ask)
  // The dialog is a separate component so that it **mounts with the question**.
  // `useDialogChrome` takes its initial focus and its focus-return on mount and
  // unmount; from a component that is always mounted and merely renders `null`,
  // both would happen once at app start and never again — no focus on open, and
  // the caller's focus never restored on close. Unmounting is also what forgets
  // the last attempt's error, so a message from a folder pick cannot follow the
  // dialog into the next time it is opened (ux_rules rule 6).
  if (ask === null) return null
  return <AgentsHomeDialog denied={ask === 'denied'} />
}

function AgentsHomeDialog({ denied }: { denied: boolean }): React.JSX.Element {
  const dismiss = useAgentsHomeStore((s) => s.dismiss)
  const { data: home } = useAgentsHome()
  const grant = useGrantAgentsHome()
  const choose = useChooseAgentsHome()
  const modalRef = useRef<HTMLDivElement>(null)
  const dismissRef = useRef<HTMLButtonElement>(null)

  const busy = grant.isPending || choose.isPending
  const grantReset = grant.reset
  const chooseReset = choose.reset

  // A refusal turns the explainer into the folder question without unmounting
  // anything, so this branch change has to forget the message itself: what the
  // last attempt said belongs to the question it has just replaced, and in this
  // branch it would explain a button that is no longer on screen.
  useEffect(() => {
    grantReset()
    chooseReset()
  }, [denied, grantReset, chooseReset])

  // Focus trap, initial focus on the recoverable choice, focus returned on
  // close, and Escape / outside-click ignored while a call is in flight. The
  // shared hook rather than a fourth hand-rolled version of the same four rules.
  useDialogChrome({ modalRef, initialFocusRef: dismissRef, pending: busy, onDismiss: dismiss })

  const path = home?.path ?? ''
  const guarded = home?.guarded ?? false
  const failure = choose.error ?? grant.error

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={denied ? 'Where should your agents live?' : 'Where your agents will live'}
        className="w-[440px] max-w-[92vw] rounded-lg border border-[var(--color-border)]
          bg-[var(--color-bg-secondary)] shadow-2xl p-6"
      >
        <div className={`flex flex-col ${BODY_MIN_HEIGHT}`}>
          <div className="flex-1 space-y-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[var(--color-accent)]/10">
                <FolderPlus size={24} className="text-[var(--color-accent)]" />
              </div>
              <div className="text-sm font-semibold text-[var(--color-text)]">
                {denied ? 'Where should your agents live?' : 'Where your agents will live'}
              </div>
              {/* `guarded` is the platform test, not `denied`. A refused write
                  happens on every platform — a read-only mount, a root-owned
                  `~/Documents` — and blaming macOS there names a cause the user
                  does not have and a remedy their machine does not offer. */}
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {!denied
                  ? 'Each agent is a folder you own — open it in your editor, keep it in Git, and it is still there after you reinstall Cinna.'
                  : guarded
                    ? 'macOS did not let Cinna use that folder. Pick another one and your agents go there instead.'
                    : 'Cinna could not write to that folder. Pick another one and your agents go there instead.'}
              </div>
            </div>

            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                {denied ? 'Refused' : 'Folder'}
              </div>
              <div className="text-[11px] text-[var(--color-text-secondary)] break-all font-mono">
                {path}
              </div>
            </div>

            {/* The sentence that makes the system prompt legible, and the only
                reason this dialog exists. Off macOS there is no prompt to
                explain, and claiming one would be a lie about the next click. */}
            <div className="text-[11px] text-[var(--color-text-muted)]">
              {denied ? (
                <>
                  {guarded
                    ? 'You can also allow it under System Settings → Privacy & Security → Files and Folders, then '
                    : 'You can also fix the folder’s permissions and '}
                  {/* Here rather than in the footer, where it was a third verb
                      beside two folder buttons. This is the end of the sentence
                      that tells you when to press it — and it takes the accent
                      so it does not read as more of the same prose (ux_rules
                      rule 11). */}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => grant.mutate()}
                    className="font-medium text-[var(--color-accent)] hover:underline disabled:opacity-50"
                  >
                    {grant.isPending ? 'trying again…' : 'try again'}
                  </button>
                  .
                </>
              ) : guarded ? (
                <>
                  macOS will now ask whether Cinna may use your Documents folder. That is this one.
                </>
              ) : (
                <>Cinna creates the folder and adds a short README. Nothing else is touched.</>
              )}
            </div>

            {/* Always present, and two lines deep because these messages reach
                two lines, so a failed pick never pushes the buttons down under
                the pointer about to press them (ux_rules rule 1). `2lh` is the
                slot written as a multiple of its own leading rather than as a
                measured pixel count. */}
            <div className="min-h-[2lh] text-[11px] text-[var(--color-danger)] break-words">
              {failure ? unwrapIpcError(failure) : ''}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <button
              ref={dismissRef}
              type="button"
              onClick={dismiss}
              disabled={busy}
              className={btnDismissClass}
            >
              Not now
            </button>
            {denied ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => choose.mutate()}
                className={btnPrimaryClass}
              >
                {choose.isPending ? (
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <Loader2 size={13} className="animate-spin" />
                    Choosing…
                  </span>
                ) : (
                  'Choose folder…'
                )}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => grant.mutate()}
                className={btnPrimaryClass}
              >
                {grant.isPending ? (
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <Loader2 size={13} className="animate-spin" />
                    Creating…
                  </span>
                ) : (
                  'Create folder'
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
