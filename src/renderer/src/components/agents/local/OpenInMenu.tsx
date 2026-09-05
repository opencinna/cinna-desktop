import { createPortal } from 'react-dom'
import { Check, ChevronDown, Code2, FolderOpen, TerminalSquare } from 'lucide-react'
import { usePopover } from '../../ui/usePopover'
import { useDefaultTool, useOpenIn, useSetDefaultTool } from '../../../hooks/useLocalTools'
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
 * at all still gets Terminal and Reveal.
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
   */
  onError: (message: string | null) => void
}

export function OpenInMenu({ agent, onError }: OpenInMenuProps): React.JSX.Element {
  const { tool: defaultTool, launchable } = useDefaultTool()
  const setDefaultTool = useSetDefaultTool()
  const openIn = useOpenIn()
  const menu = usePopover<HTMLButtonElement>('below-right')

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
      {launchable.length === 0 && (
        <div className="px-2 pb-1 pt-1.5 text-[10px] text-[var(--color-text-muted)]">
          No coding assistant or editor found. Install one, then Refresh in Settings → Local
          Agents.
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
