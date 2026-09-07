import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronDown,
  ClipboardCheck,
  ClipboardCopy,
  Code2,
  FolderOpen,
  TerminalSquare
} from 'lucide-react'
import { usePopover } from '../../ui/usePopover'
import { useDefaultTool, useOpenIn, useSetDefaultTool } from '../../../hooks/useLocalTools'
import { useCopyAgentInitPrompt } from '../../../hooks/useLocalAgents'
import { actionForTool, type DetectedTool } from '../../../../../shared/localTools'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { unwrapIpcError } from '../../../utils/ipcError'

/** One row of the menu. */
export const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ' +
  'text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] ' +
  'disabled:cursor-not-allowed disabled:opacity-40'

export const MENU_SURFACE =
  'app-popover-surface z-50 w-56 rounded-lg border border-[var(--color-border)] p-1 shadow-xl'

const SPLIT_LEFT =
  'flex items-center gap-1.5 rounded-l-md border border-[var(--color-border)] px-2.5 py-1.5 ' +
  'text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]'
const SPLIT_RIGHT =
  'flex items-center rounded-r-md border border-l-0 border-[var(--color-border)] px-1.5 py-1.5 ' +
  'text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'

/**
 * How long "Copied" stands before the label reverts. The same number as the
 * app's other two copy buttons (`CloudSyncSettingsSection`, `SyncSetupModal`) —
 * one dwell time, not three.
 */
const COPIED_REVERT_MS = 1500

function ToolIcon({ tool }: { tool: DetectedTool }): React.JSX.Element {
  return tool.kind === 'editor' ? <Code2 size={12} /> : <TerminalSquare size={12} />
}

/**
 * "Open in <tool>": the folder handed to the user's own tool in one click.
 *
 * Most people build every agent with the same assistant, so the button's
 * primary action is the default tool and the menu behind the chevron is for
 * the exception. Picking from the menu **also makes that tool the default** —
 * the setting exists so the button says the right thing next time, and the
 * pick is the clearest statement of what "right" is. Settings → Local Agents
 * can change or clear it.
 *
 * With no default (never picked, or the tool was uninstalled) the primary is
 * the menu itself, labelled "Open in…". A machine with no assistant or editor
 * at all still gets Terminal, Reveal, and the prompt to paste into whatever it
 * does have — the menu can only *launch* the tools the desktop detects, so the
 * copy is how every other assistant reaches the same folder.
 *
 * Main re-validates the folder against the registered agents roots, so a
 * refusal here is expected and shown rather than swallowed.
 */
interface OpenInMenuProps {
  agent: LocalAgentDto
  /**
   * Where a refusal is shown. The page owns one error slot for every header
   * action, so two failures cannot draw on top of each other and the next
   * action clears the last message — see `LocalAgentPage`.
   *
   * Every item that closes the menu reports here. The copy does not close it,
   * so it reports here only in the one case where this slot is not covered by
   * the popover: a failure landing after the user has closed the menu.
   */
  onError: (message: string | null) => void
}

export function OpenInMenu({ agent, onError }: OpenInMenuProps): React.JSX.Element {
  const { tool: defaultTool, launchable } = useDefaultTool()
  const setDefaultTool = useSetDefaultTool()
  const openIn = useOpenIn()
  const copyInitPrompt = useCopyAgentInitPrompt()
  const menu = usePopover<HTMLButtonElement>('below-right')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read by the mutation's callbacks, which resolve after the click that
  // started them and cannot see the `menu.open` their closure captured.
  // Assigned in an effect rather than during render: a render that React
  // discards (a transition, a Suspense boundary above this page) still runs
  // its body, and the ref would then describe a render that never committed.
  const menuOpen = useRef(menu.open)

  // Both the confirmation and the reason belong to one opening of the menu:
  // either one still showing the next time it opens would describe an
  // interaction the user has already left.
  useEffect(() => {
    menuOpen.current = menu.open
    if (!menu.open) {
      setCopied(false)
      setCopyError(null)
    }
  }, [menu.open])
  useEffect(() => () => clearTimeout(copiedTimer.current ?? undefined), [])

  const launch = (request: Parameters<typeof openIn.mutate>[0]): void => {
    onError(null)
    menu.setOpen(false)
    openIn.mutate(request, {
      onError: (err) => onError(unwrapIpcError(err, 'Could not open that.'))
    })
  }

  const launchTool = (tool: DetectedTool): void => {
    if (tool.id !== defaultTool?.id) setDefaultTool(tool.id)
    launch({ folder: agent.path, toolId: tool.id, action: actionForTool(tool) })
  }

  /**
   * Copy the init prompt — the one item here that does not close the menu, in
   * either direction.
   *
   * Nothing else on screen changes when a clipboard is written, so closing
   * would make the action silent; the label is the confirmation. And a failure
   * cannot use the page's error slot the way the launchers do: that slot sits
   * under the header, which this `below-right` popover covers — so the reason
   * is rendered *inside* the menu, below every control, where it can be read
   * without moving anything the user is about to click (UX rules 1 and 6).
   *
   * Both callbacks resolve after the click that started them, so both ask
   * where the user now is. A confirmation that arrives once the menu has
   * closed is dropped — it would re-arm on the next opening, describing a
   * click made in a session the user has left. A *failure* is never dropped:
   * it goes to the page slot instead, which is not covered once the menu is
   * gone, because the clipboard still holds whatever it held before and the
   * user believes otherwise.
   */
  const copyPrompt = (): void => {
    onError(null)
    setCopyError(null)
    copyInitPrompt.mutate(agent.id, {
      onSuccess: () => {
        if (!menuOpen.current) return
        setCopied(true)
        clearTimeout(copiedTimer.current ?? undefined)
        copiedTimer.current = setTimeout(() => setCopied(false), COPIED_REVERT_MS)
      },
      onError: (err) => {
        const message = unwrapIpcError(err, 'Could not copy the prompt.')
        if (menuOpen.current) setCopyError(message)
        else onError(message)
      }
    })
  }

  const items = (
    <>
      {launchable.map((tool) => (
        <button
          key={tool.id}
          type="button"
          role="menuitem"
          className={MENU_ITEM}
          onClick={() => launchTool(tool)}
        >
          <ToolIcon tool={tool} />
          <span className="flex-1 truncate">{tool.label}</span>
          {tool.id === defaultTool?.id && (
            <Check size={12} className="text-[var(--color-accent)]" aria-label="Default" />
          )}
        </button>
      ))}
      {launchable.length > 0 && <div className="my-1 border-t border-[var(--color-border)]" />}
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        onClick={() => launch({ folder: agent.path, action: 'terminal' })}
      >
        <TerminalSquare size={12} />
        Terminal
      </button>
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        onClick={() => launch({ folder: agent.path, action: 'reveal' })}
      >
        <FolderOpen size={12} />
        Reveal folder
      </button>
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        disabled={copyInitPrompt.isPending}
        title="Copy a briefing that points any coding assistant at this folder"
        onClick={copyPrompt}
      >
        {/*
          Three states, all inside the row the item already occupies, so none of
          them grows the menu (rule 1): dimmed-and-unchanged would read as
          *unavailable* rather than working.

          `ClipboardCheck` and not a bare `Check`, because inside *this* menu an
          accent check already means "this is your default tool" (rule 8), and
          the two would otherwise appear together either side of the list.

          And not "Copy init prompt": this page's Prompts tab holds the agent's
          own prompt documents, so "prompt" here already means
          `WORKFLOW_PROMPT.md`. The label names the audience instead (rule 7),
          and fits the menu's 191px of item width where "…another assistant"
          would truncate.
        */}
        {copied ? (
          <ClipboardCheck size={12} className="text-[var(--color-accent)]" />
        ) : (
          <ClipboardCopy size={12} />
        )}
        {copied ? 'Copied' : copyInitPrompt.isPending ? 'Copying…' : 'Copy prompt for another tool'}
      </button>
      {/*
        The label swap is the confirmation, and a changed accessible name is
        not reliably announced — so the one audience for whom the label *is*
        the message would be the one that never hears it. The failure has
        `role="alert"` below; this is its counterpart for the success.
      */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
      {/*
        The prose tail, after every control: appearing pushes nothing the user
        is about to click, and the popover grows downward away from its trigger.
        Ruled off, because otherwise the two paragraphs abut the last menu row
        and the no-tools state reads as five lines of glued prose.
      */}
      {(copyError || launchable.length === 0) && (
        <div className="mt-1 border-t border-[var(--color-border)] pt-1.5">
          {/*
            The reason first: the note below is advice about something else, and
            it must not sit between the user and why their click failed.
          */}
          {copyError && (
            <div role="alert" className="px-2 pb-1 text-[10px] text-[var(--color-danger)]">
              {copyError}
            </div>
          )}
          {launchable.length === 0 && (
            <div className="px-2 pb-1 text-[10px] text-[var(--color-text-muted)]">
              No coding assistant or editor found. Install one, then Refresh in Settings →
              Local Agents.
            </div>
          )}
        </div>
      )}
    </>
  )

  return (
    <div>
      <div className="flex">
        {defaultTool ? (
          <>
            <button
              type="button"
              className={SPLIT_LEFT}
              onClick={() => launchTool(defaultTool)}
              disabled={openIn.isPending}
              title={`Open this folder in ${defaultTool.label}`}
            >
              <ToolIcon tool={defaultTool} />
              Open in {defaultTool.label}
            </button>
            <button
              ref={menu.triggerRef}
              type="button"
              className={SPLIT_RIGHT}
              onClick={() => menu.setOpen(!menu.open)}
              aria-haspopup="menu"
              aria-expanded={menu.open}
              aria-label="More ways to open this folder"
            >
              <ChevronDown size={12} />
            </button>
          </>
        ) : (
          <button
            ref={menu.triggerRef}
            type="button"
            className={`${SPLIT_LEFT} rounded-r-md`}
            onClick={() => menu.setOpen(!menu.open)}
            aria-haspopup="menu"
            aria-expanded={menu.open}
          >
            <FolderOpen size={12} />
            Open in…
            <ChevronDown size={12} className="text-[var(--color-text-muted)]" />
          </button>
        )}
      </div>
      {menu.open &&
        menu.style &&
        createPortal(
          <div
            ref={menu.popoverRef}
            role="menu"
            aria-label="Open this folder in"
            style={menu.style}
            className={MENU_SURFACE}
          >
            {items}
          </div>,
          document.body
        )}
    </div>
  )
}
