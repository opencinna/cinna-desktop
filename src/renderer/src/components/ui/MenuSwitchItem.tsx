import { useId, type ReactNode } from 'react'
import { CONTEXT_MENU_ITEM } from './ContextMenu'
import { SwitchTrack } from './SwitchTrack'

/**
 * An on/off setting inside a menu: the label, and the app's switch at the
 * right edge, scaled to the row. The whole row is the control
 * (`role="menuitemcheckbox"`, so the menus' arrow-key navigation reaches it).
 *
 * This is the one way to show a boolean in a menu: not a check mark (which
 * reads as "the current pick"), and not a Fixed / On Hover radio pair (which
 * reads as two checkboxes switching each other off). Check marks stay for
 * genuine multi-choice radio groups, such as the microphone list.
 *
 * Toggling does not close the menu, so the user sees the switch move; the
 * caller closes it when the toggle makes the menu meaningless (hiding the
 * very button the menu belongs to).
 */
export function MenuSwitchItem({
  label,
  checked,
  onToggle,
  description,
  disabled = false,
  className = CONTEXT_MENU_ITEM
}: {
  label: string
  checked: boolean
  onToggle: () => void
  /** A second, muted line under the label: what "on" means, when the label alone cannot say it. */
  description?: ReactNode
  disabled?: boolean
  /** The row's classes; defaults to the shared menu row with a keyboard focus mark. */
  className?: string
}): React.JSX.Element {
  const descriptionId = useId()
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      // Named by the label alone; the description is read as a description.
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      disabled={disabled}
      className={className}
      onClick={onToggle}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        {description && (
          <span id={descriptionId} className="text-[10px] leading-snug text-[var(--color-text-muted)]">
            {description}
          </span>
        )}
      </span>
      <SwitchTrack checked={checked} size="sm" />
    </button>
  )
}
