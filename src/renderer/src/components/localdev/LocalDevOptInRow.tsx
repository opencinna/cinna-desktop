/**
 * "Enable local development", as one line on the screen that connects an
 * account rather than a screen of its own.
 *
 * Local development is what almost every Cinna account wants, and asking about
 * it in a separate step after sign-in put a question between the user and the
 * app for a decision they had already effectively made by connecting a server
 * that offers it. So it rides along with the connect button, ticked, and the
 * detail that used to fill that step lives behind the (?) — available to anyone
 * who wants to know what is about to be installed, in the way of nobody who
 * does not.
 *
 * Unticked is a real answer, not a "remind me later": it is recorded as a
 * decline for that host, and Settings → Local Development turns it back on.
 */
import { createPortal } from 'react-dom'
import { HelpCircle } from 'lucide-react'
import { usePopover } from '../ui/usePopover'
import { LocalDevExplainer } from './LocalDevExplainer'

export interface LocalDevOptInRowProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** The Cinna host, for the workspace line in the explainer. */
  host?: string
  /** `<AgentsHome>/Cloud`, when the caller has resolved it. */
  agentsHomeHint?: string
  disabled?: boolean
}

export function LocalDevOptInRow({
  checked,
  onChange,
  host,
  agentsHomeHint,
  disabled
}: LocalDevOptInRowProps): React.JSX.Element {
  // Opens *upward*. The row sits directly above the Connect button, so a
  // popover that dropped would cover the one control the user came here for —
  // and reading what will be installed should not mean dismissing the thing
  // that installs it.
  const popover = usePopover<HTMLButtonElement, HTMLDivElement>('above-left')

  return (
    <div className="flex items-center gap-1.5">
      <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="w-3.5 h-3.5 accent-[var(--color-accent)] cursor-pointer"
        />
        Enable local development
      </label>

      <button
        ref={popover.triggerRef}
        type="button"
        aria-label="What local development installs"
        aria-expanded={popover.open}
        onClick={() => popover.setOpen(!popover.open)}
        className="p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
      >
        <HelpCircle size={13} />
      </button>

      {/* Portaled for the same reason the status modal is: the connect panel is
          rendered inside cards that establish their own containing block, and a
          popover anchored to one of those lands in the wrong place. */}
      {popover.open &&
        popover.style &&
        createPortal(
          <div
            ref={popover.popoverRef}
            role="dialog"
            aria-label="What local development installs"
            style={popover.style}
            className="z-[110] w-[22rem] max-w-[92vw] rounded-lg border border-[var(--color-border)]
              bg-[var(--color-bg-secondary)] shadow-2xl p-4 space-y-2"
          >
            <div className="text-xs font-medium text-[var(--color-text)]">Local development</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              So you can build and run agents on this machine, without setting anything up in a
              terminal.
            </div>
            <LocalDevExplainer host={host} agentsHomeHint={agentsHomeHint} />
          </div>,
          document.body
        )}
    </div>
  )
}
