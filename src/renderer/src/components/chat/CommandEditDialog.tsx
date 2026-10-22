import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { CANCEL, DialogShell, ErrorLine, FIELD_BASE, PRIMARY, SECONDARY } from '../agents/local/sharing/ShareDialogs'
import { useUserCommandsStore, type CommandEditRequest } from '../../stores/userCommands.store'
import { MOD_KEY, resolveKey } from '../../constants/hints'
import { homeDisplayPath } from '../../../../shared/userCommands'
import { useHomeDir } from '../../utils/userCommands'

/**
 * Edit and Run…: the reviewed path for a command in an agent's message. One
 * global instance, driven by {@link useUserCommandsStore}.
 *
 * **Fixed layout.** The reason line (when there is one), the command field
 * and the folder line are there from the first frame at fixed heights, so
 * nothing moves while the user types. The field is sized once, at open, to
 * the command's lines (3 to 12 rows); a longer command scrolls in it, and a
 * static "N lines" note under it, counted at open, says so. Top-anchored: a refusal renders last,
 * under the buttons, lengthens the dialog downward and closes nothing; while
 * a start runs the dialog cannot be dismissed and its button shows a spinner.
 * An edited command is not classified again: running it here is the consent.
 */
export function CommandEditDialog(): React.JSX.Element | null {
  const request = useUserCommandsStore((s) => s.edit)
  const seq = useUserCommandsStore((s) => s.editSeq)
  if (!request) return null
  return <CommandEditDialogBody key={seq} request={request} />
}

/** The field's rows for a command: its line count, within these bounds. */
export const FIELD_ROWS = { min: 3, max: 12 } as const

function CommandEditDialogBody({ request }: { request: CommandEditRequest }): React.JSX.Element {
  const [command, setCommand] = useState(request.command)
  // Both fixed at open: neither follows what the user types (ux_rules §1).
  const [{ rows, scrollNote }] = useState(() => {
    const lines = request.command.split('\n').length
    return {
      rows: Math.min(FIELD_ROWS.max, Math.max(FIELD_ROWS.min, lines)),
      scrollNote: lines > FIELD_ROWS.max ? `${lines} lines` : null
    }
  })
  const pending = useUserCommandsStore((s) => s.editPending)
  const error = useUserCommandsStore((s) => s.editError)
  const close = useUserCommandsStore((s) => s.closeEdit)
  const submit = useUserCommandsStore((s) => s.submitEdit)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  // One form however the folder was named: the menu's raw path or main's `~/…`.
  const home = useHomeDir()
  const folder = request.folder === null ? null : homeDisplayPath(request.folder, home)
  const start = (background: boolean): void => { void submit(command, background) }
  const label = 'block text-[11px] text-[var(--color-text-muted)] mb-1'
  return (
    <DialogShell title="Edit and Run" pending={pending !== null} onDismiss={close} initialFocusRef={fieldRef} width="w-[34rem]" align="top">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          start(false)
        }}
      >
        {request.reason && (
          <p className="text-xs text-[var(--color-text-secondary)]">{request.reason}</p>
        )}
        <div>
          <label htmlFor="command-edit-field" className={label}>Command</label>
          <textarea
            id="command-edit-field"
            ref={fieldRef}
            value={command}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={pending !== null}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                start(false)
              }
            }}
            // Rows fixed at open, no resize: the dialog keeps its size while the user types (ux_rules §1).
            rows={rows}
            className={`block w-full resize-none font-mono leading-5 ${FIELD_BASE}`}
          />
          {scrollNote && <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{scrollNote}</p>}
        </div>
        <p className="truncate text-[11px] text-[var(--color-text-muted)]" title={folder ?? undefined}>
          Runs in <span className="font-mono text-[var(--color-text-secondary)]">{folder ?? 'the agent’s folder'}</span>
        </p>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" className={CANCEL} disabled={pending !== null} onClick={close}>
            Cancel
          </button>
          <button type="button" className={SECONDARY} disabled={pending !== null} aria-busy={pending === 'background' || undefined}
            onClick={() => start(true)}>
            {pending === 'background' && <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />}
            Run in background
          </button>
          <button type="submit" className={PRIMARY} disabled={pending !== null} aria-busy={pending === 'run' || undefined}
            title={`Run (${resolveKey(MOD_KEY)}↩)`}>
            {pending === 'run' && <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />}
            Run
          </button>
        </div>
        <ErrorLine error={error} />
      </form>
    </DialogShell>
  )
}
