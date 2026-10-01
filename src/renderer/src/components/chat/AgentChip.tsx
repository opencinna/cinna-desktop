import { createContext, useCallback, useContext, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Bot, FolderOpen, SquareArrowOutUpRight, Workflow, X } from 'lucide-react'
import { CONTEXT_MENU_ITEM, ContextMenu, useContextMenuAction } from '../ui/ContextMenu'
import { hasAgentPage, useOpenAgentPage } from '../../hooks/useOpenAgentPage'
import { useLocalAgents, useOpenAgentPath } from '../../hooks/useLocalAgents'

/**
 * The width range of a chip under the composer (agent and MCP chips alike).
 * At most 12rem, a longer name truncated and whole in its `title`; when the
 * row is short of room the chips shrink, down to 4.5rem — the icon, a few
 * characters and the remove button — and past that the chip strip scrolls
 * (`ChatInput`). The composer's chip row never wraps.
 */
export const agentChipClass = 'shrink min-w-[4.5rem] max-w-[12rem]'

/**
 * The hidden Default runtime, which has no identity of its own to colour by:
 * the accent colours. Every agent the user picked — bound or attached,
 * coordinating or not — is in its per-agent hash colour.
 */
export const ACCENT_CHIP = {
  border: 'var(--color-accent)',
  bg: 'color-mix(in oklab, var(--color-accent) 10%, transparent)'
}

/**
 * "Set as Coordinator" for one chip. Absent when the agent already
 * coordinates (or the chip is not an agent the chat could hand the role to).
 */
export interface ChipCoordinatorAction {
  /** Why the item is disabled, shown as a line under it; null when it can be picked. */
  disabledReason: string | null
  /** Rejects with a user-readable reason, which the menu shows in place. */
  onSet: () => unknown
}

/** What a chip's right-click menu offers. */
export interface AgentChipMenu {
  /** The agent the menu acts on. */
  agent: { id: string; name: string; source?: string | null; enabled?: boolean }
  setCoordinator?: ChipCoordinatorAction
}

interface AgentChipProps {
  name: string
  /**
   * The agent's per-agent hash colour, the colour it has in the transcript;
   * {@link ACCENT_CHIP} only for the hidden Default runtime.
   */
  colors: { border: string; bg: string }
  /** The chat's coordinator: both sides one pixel heavier, in the chip's own border colour. */
  coordinator?: boolean
  /** In a chat the user routes: the agent the next message goes to. */
  addressed?: boolean
  /** The chip's `title` and accessible name — the role is in it ("Beta — Coordinator"). */
  label: string
  /** Supplied in a chat the user routes, where clicking a chip addresses it. */
  onAddress?: () => void
  onRemove?: () => void
  /** The right-click (Shift+F10, ContextMenu key) menu; absent for a chip that is not an agent. */
  menu?: AgentChipMenu
}

/**
 * One agent chip under the composer — the bound agent and every attached one
 * are this component (ux_rules §13).
 *
 * Two marks, never meaning the same thing and neither changing the chip's
 * size, so the chips beside it do not slide when either moves (ux_rules §1):
 *
 *  - **Coordinator**: an inset 1px shadow on the left and right, in the chip's
 *    own border colour — the sides read 2px against 1px. A wider border would
 *    widen the chip.
 *  - **Addressed** (`human` chats): a 2px ring in the foreground colour. Not
 *    the agent's colour: two agents can hash to the same preset, and a ring in
 *    the chip's own colour then reads as nothing but a thicker border.
 *
 * Both are box-shadows, composed by Tailwind's shadow and ring layers rather
 * than one overwriting the other.
 */
export function AgentChip({
  name, colors, coordinator, addressed, label, onAddress, onRemove, menu
}: AgentChipProps): React.JSX.Element {
  const chipRef = useRef<HTMLDivElement>(null)
  const host = useContext(MenuHostContext)
  const local = useChipMenuState()
  const menus = host ?? local

  const openAt = (x: number, y: number, restore: HTMLElement | null): void => {
    if (menu) menus.open({ x, y, anchor: chipRef.current, restore, menu })
  }
  const onContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
    if (!menu) return
    event.preventDefault()
    // A keyboard-raised contextmenu event carries no pointer position.
    if (event.clientX === 0 && event.clientY === 0) {
      const rect = event.currentTarget.getBoundingClientRect()
      openAt(rect.left, rect.top, document.activeElement as HTMLElement | null)
    } else openAt(event.clientX, event.clientY, null)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!menu || !((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu')) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    openAt(rect.left, rect.top, document.activeElement as HTMLElement | null)
  }

  // A chip with no control inside it is focusable itself, so the keyboard can
  // reach its menu; otherwise the address and remove buttons carry the key.
  const ownFocus = !!menu && !onAddress && !onRemove
  const style = { color: colors.border, borderColor: colors.border, backgroundColor: colors.bg, '--chip-border': colors.border } as CSSProperties
  const content = (
    <>
      <Bot size={12} className="shrink-0" aria-hidden="true" />
      {/* No `title` of its own: it would hide the chip's, which carries the role. */}
      <span className="min-w-0 truncate text-[11px] font-medium whitespace-nowrap">{name}</span>
    </>
  )

  return (
    <>
      <div
        ref={chipRef}
        data-coordinator={coordinator || undefined}
        className={`flex items-center gap-1 pl-1.5 ${onRemove ? 'pr-1' : 'pr-2'} py-1 rounded-lg border ${agentChipClass} transition-shadow${
          coordinator ? ' shadow-[inset_1px_0_0_var(--chip-border),inset_-1px_0_0_var(--chip-border)]' : ''
        }${addressed ? ' ring-2 ring-[var(--color-text)]' : ''}${
          ownFocus ? ' focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]' : ''
        }`}
        style={style}
        title={label}
        role={ownFocus ? 'group' : undefined}
        aria-label={ownFocus ? label : undefined}
        aria-haspopup={ownFocus ? 'menu' : undefined}
        tabIndex={ownFocus ? 0 : undefined}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      >
        {onAddress ? (
          <button
            type="button"
            onClick={onAddress}
            aria-pressed={!!addressed}
            aria-label={label}
            // `cursor-pointer` explicitly: preflight gives every `button` a
            // default cursor, so a chip that is a control looked exactly as
            // inert as one that is not.
            className="flex items-center gap-1 min-w-0 rounded cursor-pointer
              hover:bg-black/10 [[data-theme=light]_&]:hover:bg-black/5 transition-colors"
          >
            {content}
          </button>
        ) : content}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 ml-0.5 p-0.5 rounded hover:bg-black/10 [[data-theme=light]_&]:hover:bg-black/5 transition-colors"
            aria-label={`Remove agent ${name}`}
          >
            <X size={11} />
          </button>
        )}
      </div>
      {!host && local.element}
    </>
  )
}

interface ChipMenuRequest {
  x: number
  y: number
  anchor: HTMLElement | null
  /** Where focus goes back on close: the focused chip control, for a menu opened from the keyboard. */
  restore: HTMLElement | null
  menu: AgentChipMenu
}

function useChipMenuState(): { open: (request: ChipMenuRequest) => void; element: ReactNode } {
  const [request, setRequest] = useState<ChipMenuRequest | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const open = useCallback((next: ChipMenuRequest) => {
    restoreRef.current = next.restore
    setRequest(next)
  }, [])
  const close = useCallback(() => {
    setRequest(null)
    restoreRef.current?.focus({ preventScroll: true })
    restoreRef.current = null
  }, [])
  const element = request
    ? <AgentChipContextMenu x={request.x} y={request.y} anchor={request.anchor} menu={request.menu} onClose={close} />
    : null
  return { open, element }
}

const MenuHostContext = createContext<{ open: (request: ChipMenuRequest) => void } | null>(null)

/**
 * Holds the chips' right-click menu above the chips themselves. "Set as
 * Coordinator" moves the picked chip optimistically — an attached chip becomes
 * the bound one — which unmounts the chip it was opened on; the menu has to
 * outlive it to show a failure in place (ux_rules §6). Without a host, a chip
 * keeps its own menu.
 */
export function AgentChipMenuHost({ children }: { children: ReactNode }): React.JSX.Element {
  const { open, element } = useChipMenuState()
  const [value] = useState(() => ({ open }))
  return (
    <MenuHostContext.Provider value={value}>
      {children}
      {element}
    </MenuHostContext.Provider>
  )
}

function AgentChipContextMenu({
  x, y, anchor, menu, onClose
}: { x: number; y: number; anchor: HTMLElement | null; menu: AgentChipMenu; onClose: () => void }): React.JSX.Element {
  const { busy, error, run } = useContextMenuAction(onClose)
  const openAgentPage = useOpenAgentPage()
  const openAgentPath = useOpenAgentPath()
  // A folder agent is one the folder scan lists — membership, as the Chats
  // list's Open Folder asks it, rather than another branch on the id's kind.
  const { data: folders } = useLocalAgents()
  const { agent, setCoordinator } = menu
  const reason = setCoordinator?.disabledReason ?? null
  const reasonId = useId()
  return (
    <ContextMenu x={x} y={y} anchor={anchor} label={`Agent ${agent.name}`} error={error} onClose={onClose}>
      {setCoordinator && (
        <>
          <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM}
            disabled={busy || !!reason}
            aria-describedby={reason ? reasonId : undefined}
            onClick={() => void run(async () => setCoordinator.onSet(), 'Could not change the coordinator.')}>
            <Workflow size={12} aria-hidden="true" />Set as Coordinator
          </button>
          {/* Visible, not a `title`: the arrow keys skip a disabled item, so a
              tooltip on it is out of the keyboard's reach. There from the
              menu's first frame, so nothing below it moves. */}
          {reason && (
            <p id={reasonId} className="-mt-1 pb-1.5 pl-7 pr-2 text-[10px] leading-snug text-[var(--color-text-muted)]">
              {reason}
            </p>
          )}
        </>
      )}
      {hasAgentPage(agent) && (
        <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} disabled={busy}
          onClick={() => { openAgentPage(agent); onClose() }}>
          <SquareArrowOutUpRight size={12} aria-hidden="true" />Go to Agent
        </button>
      )}
      {folders?.agents.some((folder) => folder.id === agent.id) && (
        <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} disabled={busy}
          onClick={() => void run(() => openAgentPath.mutateAsync({ agentId: agent.id }), 'Could not open the agent folder.')}>
          <FolderOpen size={12} aria-hidden="true" />Open Agent Folder
        </button>
      )}
    </ContextMenu>
  )
}
