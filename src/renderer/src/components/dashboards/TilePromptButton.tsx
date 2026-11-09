import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, MessageSquare } from 'lucide-react'
import type { ComponentPrompt } from '../../../../shared/dashboards'
import { ContextMenu, CONTEXT_MENU_ITEM } from '../ui/ContextMenu'

const PART = 'border border-[var(--color-border)] py-0.5 transition-colors hover:bg-[var(--color-bg-hover)]'

/**
 * A tile's suggested questions on its bar, as the agent page's Open in… (ux rule
 * 8): the first is sent by one click, the others are behind the chevron, in the
 * keyboard-capable menu shell. A single question has no chevron. On a narrow
 * tile the label takes less, so the title keeps some of the bar.
 */
export function TilePromptButton({
  prompts,
  tileTitle,
  onPrompt,
  onMenuChange
}: {
  prompts: ComponentPrompt[]
  tileTitle: string
  onPrompt: (prompt: ComponentPrompt) => void
  /** The menu opened or closed: it is portaled, so a floating header would otherwise leave from under it. */
  onMenuChange?: (open: boolean) => void
}): React.JSX.Element | null {
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(null)
  const [main, ...others] = prompts
  const closeMenu = useCallback(() => setMenu(null), [])
  // Nothing left to list (the agent changed them, the tile narrowed): closed, and it does not come back by itself.
  useEffect(() => {
    if (others.length === 0) setMenu(null)
  }, [others.length])
  const open = menu !== null
  useEffect(() => {
    onMenuChange?.(open)
    return () => { if (open) onMenuChange?.(false) }
  }, [open, onMenuChange])
  if (!main) return null
  return (
    <div className="flex min-w-0 shrink-0 items-center">
      <button
        type="button"
        title={main.prompt}
        onClick={() => onPrompt(main)}
        className={`${PART} max-w-[5.5rem] truncate px-1.5 text-[12px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] @sm:max-w-[10rem] ${others.length > 0 ? 'rounded-l-md' : 'rounded-md'}`}
      >
        {main.label}
      </button>
      {others.length > 0 && (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`More questions about ${tileTitle}`}
          title="More questions"
          // Past the open menu's outside press, so a second click closes it rather than closing and reopening.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu(open ? null : { x: rect.right, y: rect.bottom + 4, anchor: event.currentTarget })
          }}
          className={`${PART} flex items-center self-stretch rounded-r-md border-l-0 px-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]`}
        >
          <ChevronDown size={12} />
        </button>
      )}
      {menu && others.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} align="right" label={`More questions about ${tileTitle}`} onClose={closeMenu}>
          {others.map((prompt, index) => (
            <button key={index} type="button" role="menuitem" title={prompt.prompt} className={CONTEXT_MENU_ITEM} onClick={() => { setMenu(null); onPrompt(prompt) }}>
              <MessageSquare size={12} className="shrink-0" />
              <span className="truncate">{prompt.label}</span>
            </button>
          ))}
        </ContextMenu>
      )}
    </div>
  )
}
