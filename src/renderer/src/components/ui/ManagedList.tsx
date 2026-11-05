import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode
} from 'react'
import { Check, ChevronDown, Loader2, MoreHorizontal } from 'lucide-react'
import { CONTEXT_MENU_ITEM, CONTEXT_MENU_SURFACE, ContextMenu } from './ContextMenu'

/**
 * The compact managed list: a small working list inside a feature (who has
 * access to an item, its versions), not a top-level settings list — those
 * keep the Expandable Card Pattern.
 *
 * One tinted surface, rows without borders of their own and a hairline
 * between them; a leading glyph, a title with its meta, an optional second
 * line and the row's own controls at the end. A destructive action asks in
 * the row itself, so nothing outside the row moves (ux_rules rules 1 and 5).
 * The look is in `main.css` (`.managed-list*`), the metrics here.
 *
 * Two scales, chosen by the surface the list renders into (ui_guidelines
 * "Typography"): `settings` (the default) and the denser `chrome`.
 */

export type ManagedListScale = 'settings' | 'chrome'

interface ScaleClasses {
  title: string
  meta: string
  sub: string
  mono: string
  lead: string
  avatar: string
  icon: string
  pick: string
  badge: string
  button: string
  message: string
  link: string
}

const SCALE: Record<ManagedListScale, ScaleClasses> = {
  // The settings table (ui_guidelines "Settings scale"): 14 a listed item's
  // name, 13 sub-lines and controls, 12 secondary metadata and mono, 11 badges.
  settings: {
    title: 'text-[14px]',
    meta: 'text-[12px]',
    sub: 'text-[13px]',
    mono: 'text-[12px]',
    lead: 'w-6',
    avatar: 'h-6 w-6 text-[11px]',
    icon: 'h-7 w-7',
    pick: 'h-[26px] pl-2 pr-1.5 text-[13px]',
    badge: 'h-5 px-[7px] text-[11px]',
    button: 'h-[26px] px-[9px] text-[13px]',
    message: 'text-[13px]',
    link: 'text-[13px]'
  },
  chrome: {
    title: 'text-[11px]',
    meta: 'text-[10px]',
    sub: 'text-[10px]',
    mono: 'text-[10px]',
    lead: 'w-5',
    avatar: 'h-5 w-5 text-[9px]',
    icon: 'h-6 w-6',
    pick: 'h-[22px] pl-1.5 pr-1 text-[11px]',
    badge: 'h-[18px] px-1.5 text-[10px]',
    button: 'h-[22px] px-2 text-[11px]',
    message: 'text-[11px]',
    link: 'text-[11px]'
  }
}

const ScaleContext = createContext<ManagedListScale>('settings')

function useScale(): ScaleClasses {
  return SCALE[useContext(ScaleContext)]
}

/** The id of the row's title, for a control in the row to be described by (whose access a picker sets). */
const RowTitleContext = createContext<string | undefined>(undefined)

/** The tint every control in a row takes under the pointer, and while its menu is open. */
const HOVER_TINT =
  'hover:bg-[color-mix(in_srgb,var(--color-text)_9%,transparent)] aria-expanded:bg-[color-mix(in_srgb,var(--color-text)_9%,transparent)]'

export function ManagedList({
  children,
  message,
  footer,
  scale = 'settings',
  ordered = false,
  surfaceClassName = '',
  'aria-label': ariaLabel
}: {
  /** The rows ({@link ManagedListRow}). */
  children?: ReactNode
  /**
   * One muted line inside the same surface ({@link ManagedListMessage}):
   * loading, a failed read with its Retry, an empty list — or, after the
   * rows, a note on them.
   */
  message?: ReactNode
  /** Under the surface: a "Show all (n)" link ({@link ManagedListFooterLink}). */
  footer?: ReactNode
  scale?: ManagedListScale
  /** An `<ol>` rather than a `<ul>`: the order means something (newest first). */
  ordered?: boolean
  /** Extra classes on the tinted surface: a fixed height that scrolls, so rows coming and going move nothing below. */
  surfaceClassName?: string
  'aria-label'?: string
}): React.JSX.Element {
  const List = ordered ? 'ol' : 'ul'
  return (
    <ScaleContext.Provider value={scale}>
      <div>
        <div className={`managed-list ${surfaceClassName}`} data-scale={scale}>
          {/* A named list stays on the page when empty: it is still the place its rows go. */}
          {(Children.toArray(children).length > 0 || ariaLabel !== undefined) && (
            <List aria-label={ariaLabel} className="m-0 list-none p-0">
              {children}
            </List>
          )}
          {message}
        </div>
        {footer && <div className="flex items-center pt-1.5">{footer}</div>}
      </div>
    </ScaleContext.Provider>
  )
}

/** One muted line inside the surface: loading, nothing yet, a hint. */
export function ManagedListMessage({
  children,
  tone = 'muted',
  role
}: {
  children: ReactNode
  tone?: 'muted' | 'danger'
  role?: 'alert' | 'status'
}): React.JSX.Element {
  const s = useScale()
  return (
    <div
      role={role}
      className={`managed-list-message flex flex-wrap items-center gap-2 ${s.message} ${
        tone === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'
      }`}
    >
      {children}
    </div>
  )
}

/** The in-row confirm: the row asks, its controls give way to Cancel and the action. */
export interface ManagedListConfirm {
  /** The question, in place of the title ("Remove Bob's access?"). */
  text: string
  /** The danger button's label ("Remove"). */
  action: string
  cancel: string
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ManagedListRow({
  lead,
  title,
  titleClassName = 'font-medium',
  titleTooltip,
  meta,
  sub,
  subMono = false,
  trailing,
  confirm,
  children
}: {
  /** The 24px leading column: {@link ManagedListAvatar}, {@link ManagedListDot} or an icon. */
  lead?: ReactNode
  title: ReactNode
  /** The title's weight; `font-semibold` for a version label. */
  titleClassName?: string
  /** The title's tooltip, for one that may truncate. */
  titleTooltip?: string
  /** Inline after the title, muted; it truncates before the title does. */
  meta?: ReactNode
  /** A second line under the title, muted. */
  sub?: ReactNode
  subMono?: boolean
  /** The row's own controls, at its end. The last enabled button takes focus back after a confirm. */
  trailing?: ReactNode
  /**
   * While set, the row asks this instead of showing its title and controls:
   * Cancel takes focus, Escape in the row is Cancel (and goes no further, so
   * a dialog around the list stays open), and after Cancel focus goes back to
   * the row's last control — the ⋯ the question came from.
   */
  confirm?: ManagedListConfirm | null
  /** More of the row under the second line (expanded notes), in the title column. */
  children?: ReactNode
}): React.JSX.Element {
  const s = useScale()
  const confirming = !!confirm
  // Decided by the props a row is given, not by whether its extra content is
  // open right now: notes opening under the second line move nothing beside it.
  const stacked = !!sub || children !== undefined
  const cancelRef = useRef<HTMLButtonElement>(null)
  const rowRef = useRef<HTMLLIElement>(null)
  const trailingRef = useRef<HTMLDivElement>(null)
  const wasConfirming = useRef(false)
  const titleId = useId()
  useEffect(() => {
    if (confirming) {
      wasConfirming.current = true
      cancelRef.current?.focus({ preventScroll: true })
      return
    }
    if (!wasConfirming.current) return
    wasConfirming.current = false
    // Cancel went with the question; focus goes back to where it was asked
    // from, unless the user has already moved it somewhere else.
    const active = document.activeElement
    if (active && active !== document.body && !rowRef.current?.contains(active)) return
    const controls = trailingRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
    controls?.[controls.length - 1]?.focus({ preventScroll: true })
  }, [confirming])
  // In a two-line row the glyph and the controls sit on the first line, one
  // line box tall (the title's), so they line up with the title the same way
  // open or closed; a one-line row centres them.
  const side = stacked ? `self-start h-[1lh] ${s.title}` : 'self-center'
  return (
    <li
      ref={rowRef}
      data-managed-row=""
      data-two-line={stacked ? '' : undefined}
      data-confirming={confirming ? '' : undefined}
      className="managed-list-row flex items-center gap-2.5"
      onKeyDown={
        confirming
          ? (event) => {
              if (event.key !== 'Escape') return
              // The row's question takes Escape: a dialog listening further up must not close.
              event.preventDefault()
              event.stopPropagation()
              event.nativeEvent.stopImmediatePropagation()
              if (!confirm.pending) confirm.onCancel()
            }
          : undefined
      }
    >
      {lead !== undefined && (
        <div className={`${s.lead} flex shrink-0 items-center justify-center text-[var(--color-text-secondary)] ${side}`}>
          {lead}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            id={titleId}
            className={`min-w-0 truncate ${s.title} ${titleClassName} text-[var(--color-text)]`}
            title={confirming ? confirm.text : titleTooltip}
          >
            {confirming ? confirm.text : title}
          </span>
          {!confirming && meta && (
            <span className={`min-w-0 shrink-[1000] truncate ${s.meta} text-[var(--color-text-muted)]`}>{meta}</span>
          )}
        </div>
        {sub && (
          <div
            className={`mt-px truncate text-[var(--color-text-muted)] ${subMono ? `font-mono ${s.mono}` : s.sub}`}
          >
            {sub}
          </div>
        )}
        {children}
      </div>
      {confirming ? (
        <div className={`flex shrink-0 items-center gap-1.5 ${side}`}>
          <button
            ref={cancelRef}
            type="button"
            onClick={confirm.onCancel}
            disabled={confirm.pending}
            className={`inline-flex shrink-0 items-center rounded-[7px] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] ${s.button} font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {confirm.cancel}
          </button>
          <button
            type="button"
            onClick={confirm.onConfirm}
            disabled={confirm.pending}
            aria-busy={confirm.pending}
            className={`inline-flex shrink-0 items-center rounded-[7px] border border-[var(--color-danger)] bg-[var(--color-danger)] ${s.button} font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50`}
          >
            {/* Both labels laid out in one cell, the hidden one holding the
                width: the spinner arriving neither widens the button nor
                moves Cancel (ux_rules rule 1). */}
            <span className="grid justify-items-center">
              <span
                aria-hidden={confirm.pending}
                className={`col-start-1 row-start-1 ${confirm.pending ? 'invisible' : ''}`}
              >
                {confirm.action}
              </span>
              <span
                aria-hidden={!confirm.pending}
                className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 ${confirm.pending ? '' : 'invisible'}`}
              >
                <Loader2 size={12} className={confirm.pending ? 'animate-spin' : ''} aria-hidden="true" />
                {confirm.action}
              </span>
            </span>
          </button>
        </div>
      ) : (
        trailing && (
          <div ref={trailingRef} className={`flex shrink-0 items-center gap-0.5 ${side}`}>
            <RowTitleContext.Provider value={titleId}>{trailing}</RowTitleContext.Provider>
          </div>
        )
      )}
    </li>
  )
}

/** Initials of a name, two at most: "Anna Petrova" → "AP". */
export function managedListInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '')
  return letters.join('').toUpperCase()
}

/** A person (or a role) in the leading column: their initials in a tinted circle. */
export function ManagedListAvatar({ name }: { name: string }): React.JSX.Element {
  const s = useScale()
  return (
    <span
      aria-hidden="true"
      className={`${s.avatar} flex items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_26%,var(--color-bg-secondary))] font-bold tracking-[0.02em] text-[var(--color-text)]`}
    >
      {managedListInitials(name)}
    </span>
  )
}

const DOT_TONE = {
  ok: 'bg-[var(--color-success)]',
  warn: 'bg-[var(--color-warning)]',
  err: 'bg-[var(--color-danger)]',
  off: 'bg-[var(--color-text-muted)] opacity-60'
} as const

/** A state in the leading column. `label` names it for a screen reader and in a tooltip. */
export function ManagedListDot({
  tone,
  label
}: {
  tone: keyof typeof DOT_TONE
  label?: string
}): React.JSX.Element {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
      className={`block h-2 w-2 rounded-full ${DOT_TONE[tone]}`}
    />
  )
}

/** A fixed value where others have a picker (your own access, Everyone's Can use). */
export function ManagedListBadge({
  children,
  title,
  tone = 'neutral'
}: {
  children: ReactNode
  title?: string
  tone?: 'neutral' | 'accent' | 'warn'
}): React.JSX.Element {
  const s = useScale()
  const toneClass =
    tone === 'accent'
      ? 'text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_13%,transparent)]'
      : tone === 'warn'
        ? 'text-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_13%,transparent)]'
        : 'text-[var(--color-text-secondary)] bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)]'
  return (
    <span
      title={title}
      className={`mr-1 inline-flex shrink-0 items-center whitespace-nowrap rounded-full ${s.badge} font-medium ${toneClass}`}
    >
      {children}
    </span>
  )
}

/** Holds a row's control column where a row has no control, so the columns line up. */
export function ManagedListSpacer(): React.JSX.Element {
  const s = useScale()
  return <span aria-hidden="true" className={`${s.icon} shrink-0`} />
}

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'aria-label' | 'type'> & {
  ref?: React.Ref<HTMLButtonElement>
  /** Required: an icon has no visible name, so the tooltip and the accessible name carry it. */
  title: string
  'aria-label': string
}

/**
 * A borderless icon button in a row. Secondary text colour, a step above the
 * muted meta beside it, so it reads as a control before it is hovered
 * (ux_rules rule 11).
 */
export function ManagedListIconButton({ className = '', children, ...props }: IconButtonProps): React.JSX.Element {
  const s = useScale()
  return (
    <button
      type="button"
      {...props}
      className={`${s.icon} inline-flex shrink-0 items-center justify-center rounded-[7px] text-[var(--color-text-secondary)] transition-colors ${HOVER_TINT} hover:text-[var(--color-text)] aria-expanded:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * A menu opened by a button rather than at the pointer: the shared
 * {@link ContextMenu}, below the trigger with its right edge at the
 * trigger's. A press on the open trigger closes it rather than opening it
 * again, and closing from the keyboard puts focus back on the trigger.
 */
function useTriggeredMenu(): {
  at: { x: number; y: number; anchor: HTMLElement } | null
  close: () => void
  trigger: {
    ref: React.RefObject<HTMLButtonElement | null>
    'aria-haspopup': 'menu'
    'aria-expanded': boolean
    onPointerDown: () => void
    onClick: (event: MouseEvent<HTMLButtonElement>) => void
  }
} {
  const [at, setAt] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(null)
  const ref = useRef<HTMLButtonElement | null>(null)
  // The menu closes on the press that lands on its own trigger, before the
  // click: without this the click would open it straight back.
  const pressedWhileOpen = useRef(false)
  const close = useCallback(() => {
    const focusInMenu = document.activeElement instanceof HTMLElement && document.activeElement.closest('[role="menu"]')
    setAt(null)
    if (focusInMenu) ref.current?.focus({ preventScroll: true })
  }, [])
  return {
    at,
    close,
    trigger: {
      ref,
      'aria-haspopup': 'menu',
      'aria-expanded': at !== null,
      onPointerDown: () => {
        pressedWhileOpen.current = at !== null
      },
      onClick: (event) => {
        if (pressedWhileOpen.current) {
          pressedWhileOpen.current = false
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        setAt({ x: rect.right, y: rect.bottom + 4, anchor: event.currentTarget })
      }
    }
  }
}

export interface ManagedListMenuItem {
  label: string
  onSelect: () => void
  tone?: 'danger'
  disabled?: boolean
}

/** The row's ⋯: its less frequent actions, a destructive one last and in the danger tone. */
export function ManagedListMenu({
  label,
  items,
  disabled
}: {
  /** The trigger's tooltip and accessible name, and the menu's ("Actions for Bob"). */
  label: string
  items: ManagedListMenuItem[]
  disabled?: boolean
}): React.JSX.Element {
  const menu = useTriggeredMenu()
  return (
    <>
      <ManagedListIconButton {...menu.trigger} title={label} aria-label={label} disabled={disabled}>
        <MoreHorizontal size={16} aria-hidden="true" />
      </ManagedListIconButton>
      {menu.at && (
        <ContextMenu x={menu.at.x} y={menu.at.y} anchor={menu.at.anchor} align="right" label={label} onClose={menu.close}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                menu.close()
                item.onSelect()
              }}
              className={`${CONTEXT_MENU_ITEM} ${item.tone === 'danger' ? 'text-[var(--color-danger)]' : ''}`}
            >
              {item.label}
            </button>
          ))}
        </ContextMenu>
      )}
    </>
  )
}

export interface ManagedListPickerOption<V extends string> {
  value: V
  label: string
  /** One muted line under the label: what picking it means. */
  description?: string
}

/** The picker's menu: wide enough for a one-line description under each label. */
const PICKER_SURFACE = CONTEXT_MENU_SURFACE.replace('w-44', 'w-60')

/**
 * A value picked in place: the value as text with a caret, no box, a tint
 * under the pointer. Its accessible name is the value it shows (ux_rules rule
 * 10), and in a row it is described by the row's title, so a screen reader
 * hears whose value it is; `menuLabel` names the menu it opens ("Access for
 * Bob"). The menu opens on the current value.
 */
export function ManagedListPicker<V extends string>({
  value,
  options,
  onChange,
  menuLabel,
  disabled
}: {
  value: V
  options: ManagedListPickerOption<V>[]
  /** Not called when the current value is picked again. */
  onChange: (value: V) => void
  menuLabel: string
  disabled?: boolean
}): React.JSX.Element {
  const s = useScale()
  const menu = useTriggeredMenu()
  const idBase = useId()
  const rowTitleId = useContext(RowTitleContext)
  const checkedRef = useRef<HTMLButtonElement>(null)
  const current = options.find((option) => option.value === value)
  const open = menu.at !== null
  // After the menu's own focus on its first item (a child's layout effect runs first).
  useLayoutEffect(() => {
    if (open) checkedRef.current?.focus({ preventScroll: true })
  }, [open])
  return (
    <>
      <button
        type="button"
        {...menu.trigger}
        aria-describedby={rowTitleId}
        disabled={disabled}
        className={`${s.pick} mr-0.5 inline-flex shrink-0 items-center gap-[3px] whitespace-nowrap rounded-[7px] font-medium text-[var(--color-text)] transition-colors ${HOVER_TINT} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span>{current?.label ?? value}</span>
        <ChevronDown size={13} aria-hidden="true" className="text-[var(--color-text-secondary)]" />
      </button>
      {menu.at && (
        <ContextMenu
          x={menu.at.x}
          y={menu.at.y}
          anchor={menu.at.anchor}
          align="right"
          label={menuLabel}
          className={PICKER_SURFACE}
          onClose={menu.close}
        >
          {options.map((option, index) => {
            const checked = option.value === value
            const labelId = `${idBase}-${index}`
            const descriptionId = `${idBase}-${index}-d`
            return (
              <button
                key={option.value}
                ref={checked ? checkedRef : undefined}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                aria-labelledby={labelId}
                aria-describedby={option.description ? descriptionId : undefined}
                onClick={() => {
                  menu.close()
                  if (!checked) onChange(option.value)
                }}
                className={CONTEXT_MENU_ITEM.replace('items-center', 'items-start')}
              >
                <span className="mt-px inline-flex w-3.5 shrink-0 text-[var(--color-accent)]">
                  {checked && <Check size={13} aria-hidden="true" />}
                </span>
                <span className="min-w-0">
                  <span id={labelId} className="block">
                    {option.label}
                  </span>
                  {option.description && (
                    <span id={descriptionId} className="block truncate text-[11px] text-[var(--color-text-muted)]">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </ContextMenu>
      )}
    </>
  )
}

/** The footer's accent link: Show all (n) / Show less. */
export function ManagedListFooterLink({
  children,
  onClick,
  'aria-expanded': ariaExpanded
}: {
  children: ReactNode
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  'aria-expanded'?: boolean
}): React.JSX.Element {
  const s = useScale()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      // The hover tint's padding hangs outside: the text lines up with the list's edge and its heading.
      className={`-ml-1.5 rounded-md px-1.5 py-[3px] ${s.link} font-medium text-[var(--color-accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]`}
    >
      {children}
    </button>
  )
}
