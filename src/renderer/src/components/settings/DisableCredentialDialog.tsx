import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import { useDialogChrome } from './SettingsLayout'

interface DisableCredentialDialogProps {
  credentialName: string
  /** Chat modes pinned to this credential, by name. */
  chatModes: string[]
  /** Folder agents whose runtime resolves to it, by name. */
  agents: string[]
  /**
   * The write is running. The **card** owns the mutation, because it outlives
   * this dialog: a `mutate`-level `onSuccess` is dropped when its caller
   * unmounts, and closing the dialog *is* the unmount (ux_rules rule 5).
   */
  pending: boolean
  /** A refused write, in the user's words. The dialog stays open and says it. */
  errorMessage: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** `a`, `a and b`, `a, b and c` — a list a sentence can contain. */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** `n thing`/`n things`, with the noun agreed. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * "2 chat modes and 1 agent are" — the subject of the sentence the credential
 * card leaves standing while the switch is off.
 *
 * Here rather than in the card because it is the same fact the dialog names,
 * counted instead of listed: the dialog interrupts and can afford the names,
 * the card is a resting surface and can only afford the number. Both must agree
 * about what a dependent *is*, which is the whole reason they share a file.
 *
 * Subject and verb come back separately because the card writes two sentences
 * from them — a full one in its body and a fragment in its header — and only
 * one of those wants the verb.
 */
export function describeDependents(
  chatModes: string[],
  agents: string[]
): { subject: string; verb: string } {
  const parts = [
    chatModes.length > 0 ? count(chatModes.length, 'chat mode') : null,
    agents.length > 0 ? count(agents.length, 'agent') : null
  ].filter((part): part is string => part !== null)
  return {
    subject: parts.join(' and '),
    // Agreed with the **total**, not with either list: "1 chat mode and 1 agent
    // is inactive" is the sentence that ships when each half agrees its own
    // verb.
    verb: chatModes.length + agents.length > 1 ? 'are' : 'is'
  }
}

/**
 * The confirm in front of a credential's off switch, when something uses it.
 *
 * Switching a credential off is not destructive — nothing is deleted and the
 * switch goes back — so the general rule (ux_rules rule 5: destructive actions
 * confirm) does not by itself ask for a dialog here, and the switch stays a
 * single click for a credential nothing depends on. What earns the confirm is
 * that the *consequence is somewhere else*: the engine is no longer given this
 * credential (`collectEngineProviders`), so every folder agent resolved to it
 * stops running, and every chat mode pinned to it stops starting chats — on
 * screens the user is not looking at, with nothing on this one to say so.
 *
 * So the copy leads with the recoverable half, and then **names** what stops.
 * A count alone ("3 agents") would be a number the user has to go and decode;
 * the names are the whole reason to interrupt them.
 */
export function DisableCredentialDialog({
  credentialName,
  chatModes,
  agents,
  pending,
  errorMessage,
  onConfirm,
  onCancel
}: DisableCredentialDialogProps): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Focus lands on the recoverable choice, so Enter on arrival cancels; and
  // Escape and an outside click are ignored while the write runs, because
  // dismissing would cancel nothing and only hide what is happening.
  useDialogChrome({
    modalRef,
    initialFocusRef: cancelRef,
    pending,
    onDismiss: onCancel
  })

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        // The accessible name is built from the same string the heading renders,
        // so the two cannot drift (ux_rules rule 10).
        aria-labelledby="disable-credential-title"
        className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div
          id="disable-credential-title"
          className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-text)]"
        >
          <AlertTriangle size={16} className="text-[var(--color-warning)]" />
          Switch off {credentialName}
        </div>

        {/*
          The name is in the heading directly above; repeating it here spent two
          more of the dialog's eight lines on it for a long credential name
          (ux_rules rule 7).
        */}
        <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          Nothing is deleted, and nothing is re-pointed at another credential. Turning it back on
          puts everything below back exactly as it is now.
        </p>

        {chatModes.length > 0 && (
          <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
            {chatModes.length === 1 ? 'Chat mode' : 'Chat modes'}{' '}
            <strong className="text-[var(--color-text)]">{listNames(chatModes)}</strong>{' '}
            {chatModes.length === 1 ? 'is' : 'are'} marked inactive and{' '}
            {chatModes.length === 1 ? 'stops' : 'stop'} starting chats.
          </p>
        )}

        {agents.length > 0 && (
          <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
            {agents.length === 1 ? 'Agent' : 'Agents'}{' '}
            <strong className="text-[var(--color-text)]">{listNames(agents)}</strong>{' '}
            {agents.length === 1 ? 'has' : 'have'} no credential to run on — the engine is not
            given this one, so the next turn fails rather than quietly using another key.
          </p>
        )}

        {/*
          Two lines of the 13px leading, reserved. A refusal that arrives after
          the click must not grow the dialog and move the buttons out from under
          the pointer (ux_rules rule 1), and the dialog stays open so the user
          can read it beside the control they pressed (rule 6).
        */}
        <div
          role="alert"
          className="min-h-[3.25rem] text-[13px] leading-relaxed text-[var(--color-danger)]"
        >
          {errorMessage}
        </div>

        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium
              text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]
              disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            // A fixed width, so the longer "Switching off…" does not pull Cancel
            // sideways when the action starts (ux_rules rule 1).
            className="min-w-[8rem] rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px]
              font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)]
              disabled:opacity-50"
          >
            {pending ? 'Switching off…' : 'Switch off'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
