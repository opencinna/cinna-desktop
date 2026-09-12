import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UseMutationResult } from '@tanstack/react-query'
import type { RuntimeToolId, ToolInstallPlan, ToolInstallProgress } from '../../../../shared/localTools'
import { useToolInstallProgress } from '../../hooks/useLocalTools'
import { unwrapIpcError } from '../../utils/ipcError'
import { useDialogChrome } from './SettingsLayout'

interface InstallRuntimeDialogProps {
  plan: ToolInstallPlan
  /**
   * Whether finishing this install also makes it the machine's Default runtime.
   *
   * True for a runtime this build can actually run agents on, which is what the
   * user pressed the button for. False for Codex, which is installable and
   * useful and has no launcher here — and the dialog says which of the two it
   * is *before* the install, because "what will this do" is the question a
   * confirm exists to answer (ux_rules rule 5).
   */
  willSelect: boolean
  /**
   * Owned by the settings section, which outlives this dialog — a
   * `mutate`-level success handler would be dropped by the unmount that closing
   * causes (ux_rules rule 5). The section decides what "done" means; this
   * dialog only reports a failure, because a failure is what keeps it open.
   */
  install: UseMutationResult<ToolInstallProgress, Error, RuntimeToolId>
  /** The failure the section kept from the last attempt, if there was one. */
  failure: string | null
  onCancel: () => void
}

/**
 * The confirm in front of running a **third-party installer**.
 *
 * This app is about to execute a script published by somebody else, in a shell,
 * under the user's account, and it writes to their machine. That is not a
 * settings toggle, and a button labelled *Install* with nothing behind it would
 * be a side effect the user did not agree to — so the dialog's job is to show
 * the exact command first (ux_rules rule 5: name the object, state the
 * consequence).
 *
 * The command is quoted from `ToolInstallPlan`, which main resolved from its
 * own table, so what is shown is what runs: the renderer never sends a command
 * across the bridge and could not show a different one.
 *
 * **What is deliberately not promised.** Cinna does not manage what it
 * installed — no version pin, no update, no uninstall — and the copy says so,
 * because every other binary this app puts on a machine (the engine) *is*
 * managed and a user would reasonably assume the same here (ux_rules rule 9).
 */
export function InstallRuntimeDialog({
  plan,
  willSelect,
  install,
  failure,
  onCancel
}: InstallRuntimeDialogProps): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * The installer's last output line, while it runs.
   *
   * In a slot that is always there, at a fixed height, for the same reason the
   * error below it is: this line changes several times a second on a download
   * and a growing dialog would move the button the user is about to press
   * (ux_rules rule 1).
   */
  const progress = useToolInstallProgress(install.isPending ? plan.id : null)

  /**
   * **Dismissable, even while it runs** — which is the opposite of what every
   * other dialog on this screen does, and the reason is the one ux_rules rule 5
   * actually gives: a confirm stays put while its action runs because
   * dismissing it would cancel nothing and *hide what is happening*. Here it
   * hides nothing. The button behind it reports `Installing…` with a spinner
   * for as long as this runs, and a failure lands in the Runtime section's own
   * reserved line — so trapping the user in front of a download that can take
   * fifteen minutes would buy the guarantee nothing and cost them the app.
   *
   * Closing does not stop the installer, and the button label says `Close`
   * rather than `Cancel` while it runs for exactly that reason (rule 4: never a
   * control that promises what it cannot do).
   */
  useDialogChrome({
    modalRef,
    initialFocusRef: cancelRef,
    pending: false,
    onDismiss: onCancel
  })

  const confirm = (): void => {
    setError(null)
    install.mutate(plan.id, {
      // Only a rejection lands here — a *failed installer* resolves with its
      // sentence, which the section keeps and passes back as `failure`, since
      // this dialog may have been remounted by the time it arrives.
      onError: (err) => setError(unwrapIpcError(err, `${plan.label} could not be installed.`))
    })
  }

  const message = error ?? failure

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-runtime-title"
        className="app-popover-surface w-[28rem] space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div id="install-runtime-title" className="text-[14px] font-medium text-[var(--color-text)]">
          Install {plan.label}
        </div>

        <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          Cinna will run {plan.label}&apos;s own installer on this machine, as you:
        </p>

        {/*
          The command, in full and wrapping rather than truncated. It is the one
          thing on this surface the user is being asked to agree to, and a
          truncated shell command is one they cannot judge (ux_rules rule 7).
        */}
        <code className="block rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 font-mono text-[12px] break-all text-[var(--color-text)]">
          {plan.command}
        </code>

        <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          {willSelect
            ? `When it finishes, Cinna runs your folder agents on ${plan.label}.`
            : `Cinna cannot run agents on ${plan.label} yet — installing it makes it available for opening agent folders in.`}
        </p>

        <p className="text-[13px] leading-relaxed text-[var(--color-text-muted)]">
          It installs into your home directory. Cinna does not update or remove it afterwards —{' '}
          <button
            type="button"
            onClick={() => void window.api.system.openExternal(plan.docsUrl)}
            className="text-[var(--color-accent)] underline-offset-2 hover:underline"
          >
            {plan.label}&apos;s install page
          </button>{' '}
          covers both.
        </p>

        {/*
          One line of output and two of message, always reserved. The output
          line arrives only while the install runs and the message only after it
          fails, and either appearing would otherwise move the buttons below
          (ux_rules rule 1).
        */}
        <div
          className="h-[1.125rem] truncate font-mono text-[12px] text-[var(--color-text-muted)]"
          title={progress?.line ?? undefined}
        >
          {install.isPending ? (progress?.line ?? 'Starting…') : ''}
        </div>
        <div
          role="alert"
          className="min-h-[2.5rem] text-[13px] leading-relaxed text-[var(--color-danger)]"
        >
          {message}
        </div>

        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="min-w-[4.5rem] rounded-md border border-[var(--color-border)] px-3 py-1.5
              text-[13px] font-medium text-[var(--color-text-muted)] transition-colors
              hover:text-[var(--color-text)]"
          >
            {/* `Close`, not `Cancel`, once it is running: nothing here cancels
                an installer, and a button that says otherwise is a promise this
                app cannot keep. */}
            {install.isPending ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={install.isPending}
            // Just "Install" — the heading two lines up already names what.
            // `Install Claude Code` is wider than the fixed width below, so the
            // button would *shrink* into "Installing…" and pull Cancel sideways
            // at the moment of the click (ux_rules rule 1).
            className="min-w-[7.5rem] rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px]
              font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {install.isPending ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
