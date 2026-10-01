import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, Globe, Link, Loader2, MessageSquarePlus, NotebookPen, type LucideIcon } from 'lucide-react'
import {
  agentFileContentKind,
  isCredentialFileRef,
  type AgentFileRef,
  type AgentFileTextUse
} from '../../../../shared/agentFiles'
import { previewKindFor } from '../../../../shared/filePreview'
import { useSaveMessageNote } from '../../hooks/useNotes'
import { useAuthStore } from '../../stores/auth.store'
import { useToastStore } from '../../stores/toast.store'
import { useUIStore } from '../../stores/ui.store'
import { authorizeAgentFile, readAgentFileText } from '../../utils/agentFileAccess'
import { startableAgent } from '../../utils/appShortcuts'
import { fileNoteFromContents } from '../../utils/fileNote'
import { unwrapIpcError } from '../../utils/ipcError'
import { startAgentChat, unavailableAgentMessage } from '../../utils/startAgentChat'
import { fileRefTargetOf, type FileRefTarget } from './fileRefs'

interface MenuState {
  id: number
  x: number
  y: number
  text: string
  /** The code block whose whole text the menu acts on; outlined while open. */
  highlight?: HTMLElement
  /** The file or folder reference the right-clicked inline code names. */
  file?: FileRefTarget
}

/** Room kept below a top-anchored menu for an error row (two lines of `text-xs`). */
const ERROR_ROW_RESERVE = 48

/** Viewport placement: anchored by its top edge, or by its bottom edge near the window's foot. */
type MenuPosition = { left: number; top: number; bottom?: undefined } | { left: number; bottom: number; top?: undefined }

export type MessageMenuItem =
  | 'copy-text'
  | 'save-text'
  | 'open-in-browser'
  | 'copy-contents'
  | 'save-contents'
  | 'copy-path'
  | 'reference'

/**
 * The menu's items, in groups separated by a divider. Decided once, from the
 * reference as the transcript resolved it, so nothing appears or disappears
 * while the menu is open: a file whose contents cannot be text — a folder, a
 * known binary type, a credential file — offers its path only. An HTML file
 * (`.html`, `.htm`, `.xhtml`) also offers Open in browser, first.
 */
export function messageMenuItems(file: FileRefTarget | undefined): MessageMenuItem[][] {
  if (!file) return [['copy-text', 'save-text']]
  const { ref } = file
  const pathOnly = ref.kind === 'dir' || isCredentialFileRef(ref) || agentFileContentKind(ref.path) === 'binary'
  const pathGroup: MessageMenuItem[] = ['copy-path', 'reference']
  if (pathOnly) return [pathGroup]
  const contents: MessageMenuItem[] = ['copy-contents', 'save-contents']
  return previewKindFor(ref.path) === 'html' ? [['open-in-browser'], contents, pathGroup] : [contents, pathGroup]
}

/** What a new chat about `ref` starts with: its path, ready for the rest of the sentence. */
export function referenceDraft(ref: AgentFileRef): string {
  return `The ${ref.kind === 'dir' ? 'folder' : 'file'} \`${ref.path}\` `
}

/**
 * A range's boxes are as tall as its glyphs, but the highlight fills the line,
 * so each box is stretched by the half-leading around it: a right-click in the
 * gap between two selected lines is still on the selection.
 */
function pointOnSelection(range: Range, target: Element, { x, y }: { x: number; y: number }): boolean {
  const style = getComputedStyle(target)
  const slack = Math.max(0, (parseFloat(style.lineHeight) - parseFloat(style.fontSize)) / 2) || 0
  return Array.from(range.getClientRects()).some((rect) =>
    x >= rect.left && x <= rect.right && y >= rect.top - slack && y <= rect.bottom + slack)
}

/**
 * Capture before focusing the menu changes the browser selection. Only a
 * selection the right-click lands on counts; without one there is no menu.
 * `point` is the pointer position; a keyboard-opened menu has none.
 */
export function messageContextText(root: HTMLElement, target: Element, selection: Selection | null, point?: { x: number; y: number }): string {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ''
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || !range.intersectsNode(target)) return ''
  // Blank space beside a selection still intersects it as an ancestor.
  if (point && !pointOnSelection(range, target, point)) return ''
  const selected = selection.toString()
  if (!selected.trim()) return ''
  // Selecting the complete rendered message can retain its exact source. The
  // range's DOM text is compared: the selection's own text follows layout and
  // adds line breaks between blocks that `textContent` does not have.
  const message = target.closest<HTMLElement>('[data-message-markdown]')
  if (message && root.contains(message) && range.toString().trim() === message.textContent?.trim()) {
    return message.dataset.messageMarkdown ?? selected
  }
  return selected
}

/** A fenced block's `code` ends in the fence's newline; inline code is taken as is. */
function codeText(element: HTMLElement): string {
  return element.tagName === 'PRE' ? (element.textContent ?? '').replace(/\n$/, '') : element.textContent ?? ''
}

/**
 * Without a selection, a right-click on code takes the whole block, or the
 * whole inline span. A selection in the same code that the click missed takes
 * nothing: the user chose part of it, so the whole block would surprise them.
 */
export function codeContextTarget(root: HTMLElement, target: Element, selection: Selection | null): { element: HTMLElement; text: string } | null {
  const code = target.closest<HTMLElement>('code')
  if (!code || !root.contains(code)) return null
  const element = code.parentElement?.tagName === 'PRE' ? code.parentElement : code
  if (selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(element)) return null
  const text = codeText(element)
  return text.trim() ? { element, text } : null
}

export function useMessageContextMenu(chatId: string) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const nextId = useRef(0)
  const profileId = useAuthStore((s) => s.currentUser?.id)
  const close = useCallback(() => setMenu(null), [])
  const closeCurrent = useCallback(() => setMenu((current) => current === menu ? null : current), [menu])
  useEffect(close, [chatId, profileId, close])
  const onContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element) || event.target.closest('input, textarea, [contenteditable="true"]')) {
      setMenu(null)
      return
    }
    const point = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined
    const selected = messageContextText(event.currentTarget, event.target, window.getSelection(), point)
    const code = selected.trim() ? null : codeContextTarget(event.currentTarget, event.target, window.getSelection())
    const file = code && code.element.tagName === 'CODE' ? fileRefTargetOf(code.element) ?? undefined : undefined
    const text = code?.text ?? selected
    if (!text.trim()) {
      setMenu(null)
      return
    }
    event.preventDefault()
    const rect = event.target.getBoundingClientRect()
    setMenu({ id: ++nextId.current, text, highlight: code?.element, file, x: event.clientX || rect.left, y: event.clientY || rect.bottom })
  }, [])
  return {
    onContextMenu,
    menu: menu ? <MessageContextMenu key={menu.id} {...menu} onClose={closeCurrent} /> : null
  }
}

function MessageContextMenu({ x, y, text, highlight, file, onClose }: MenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<MenuPosition>({ left: x, top: y })
  const [error, setError] = useState<string | null>(null)
  /** The item whose action is running; the others are dimmed until it ends. */
  const [busyItem, setBusyItem] = useState<MessageMenuItem | null>(null)
  const acting = useRef(false)
  /** True while main may be showing the consent dialog, which takes the window's focus. */
  const consentPending = useRef(false)
  const mounted = useRef(true)
  const saveMessageNote = useSaveMessageNote()
  const queryClient = useQueryClient()
  // A block right-clicked mid-stream keeps growing under its outline; the
  // action takes the block as it is now, not as it was at the right-click.
  const payload = (): string => (highlight?.isConnected ? codeText(highlight) : text)

  // Placed once, at open. A menu that would meet the bottom of the window —
  // counting the room an error row takes — is anchored by its bottom edge,
  // with the error row above the items, so an error grows the menu upwards
  // and no item moves under the pointer.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    // A window shorter than the menu keeps its first items on screen.
    if (rect.height + 16 > window.innerHeight) {
      setPosition({ left, top: 8 })
    } else if (y + rect.height + ERROR_ROW_RESERVE + 8 <= window.innerHeight) {
      setPosition({ left, top: Math.max(8, y) })
    } else {
      const bottomEdge = Math.min(y + rect.height, window.innerHeight - 8)
      setPosition({ left, bottom: Math.max(8, window.innerHeight - bottomEdge) })
    }
  }, [x, y])

  useLayoutEffect(() => {
    if (!highlight) return
    highlight.setAttribute('data-context-target', '')
    return () => highlight.removeAttribute('data-context-target')
  }, [highlight])

  useLayoutEffect(() => {
    mounted.current = true
    const menu = ref.current
    const previousFocus = document.activeElement as HTMLElement | null
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const outside = (event: globalThis.MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    // Streaming follows the transcript with programmatic scroll events. Only
    // user scrolling dismisses the captured excerpt's actions.
    window.addEventListener('wheel', onClose, true)
    window.addEventListener('touchmove', onClose, true)
    window.addEventListener('resize', onClose)
    // A file outside the agent folder is read only after a native consent
    // dialog, which takes the window's focus: the menu waits for its answer.
    const blur = (): void => {
      if (!consentPending.current) onClose()
    }
    window.addEventListener('blur', blur)
    return () => {
      mounted.current = false
      const hadFocus = menu?.contains(document.activeElement)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('wheel', onClose, true)
      window.removeEventListener('touchmove', onClose, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', blur)
      if (hadFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [onClose])

  /**
   * One action at a time; a failure is said in the menu, which stays open
   * for a retry with focus on the item that failed.
   */
  const run = async (item: MessageMenuItem, action: (fail: (reason: string) => void) => Promise<void>, fallback: string): Promise<void> => {
    if (acting.current) return
    acting.current = true
    setBusyItem(item)
    setError(null)
    let failed = false
    const fail = (reason: string): void => {
      failed = true
      setError(reason)
    }
    try {
      await action(fail)
    } catch (err) {
      fail(unwrapIpcError(err, fallback))
    } finally {
      acting.current = false
      setBusyItem(null)
      if (failed && mounted.current) {
        ref.current?.querySelector<HTMLButtonElement>(`[data-menu-item="${item}"]`)?.focus({ preventScroll: true })
      }
    }
  }

  const saveNote = async (body: string, title?: string): Promise<void> => {
    const note = await saveMessageNote(body, title)
    // Saving may finish after the user dismisses the menu or changes chats.
    if (note && mounted.current) {
      const ui = useUIStore.getState()
      // The sidebar follows the center, so the new note shows as selected,
      // and its row is brought into view once it renders.
      ui.setSidebarTab('notes')
      ui.setRevealNoteId(note.id)
      ui.setActiveNoteId(note.id)
      ui.setActiveView('note-detail')
      onClose()
    }
  }

  /** The referenced file's text, or null once the failure is said (or the user declined). */
  const fileText = async (
    target: FileRefTarget,
    use: AgentFileTextUse,
    fail: (reason: string) => void
  ): Promise<string | null> => {
    const outcome = await readAgentFileText(target.agentId, target.ref, use, {
      onAuthorize: (pending) => {
        consentPending.current = pending
      }
    })
    if (outcome.status === 'text') return outcome.text
    if (outcome.status === 'denied') onClose()
    else fail(outcome.error)
    return null
  }

  const actions: Record<MessageMenuItem, () => Promise<void>> = {
    'copy-text': () => run('copy-text', async () => {
      await navigator.clipboard.writeText(payload())
      onClose()
    }, 'Could not copy text.'),
    'save-text': () => run('save-text', () => saveNote(payload()), 'Could not save to Notes.'),
    // Main's clipboard: after a consent dialog the document may not have its
    // focus back, and `navigator.clipboard` rejects without it.
    'copy-contents': () => run('copy-contents', async (fail) => {
      if (!file) return
      const contents = await fileText(file, 'copy', fail)
      if (contents === null) return
      const result = await window.api.clipboard.writeText(contents)
      if (result.success) onClose()
      else fail('Could not copy the file.')
    }, 'Could not copy the file.'),
    'save-contents': () => run('save-contents', async (fail) => {
      if (!file) return
      const contents = await fileText(file, 'note', fail)
      if (contents === null) return
      const note = fileNoteFromContents(file.ref.path, contents)
      await saveNote(note.body, note.title)
    }, 'Could not save to Notes.'),
    // Main asks first for a file outside the agent folder, as a preview would.
    'open-in-browser': () => run('open-in-browser', async (fail) => {
      if (!file) return
      const input = { agentId: file.agentId, path: file.ref.path }
      consentPending.current = true
      let access: Awaited<ReturnType<typeof authorizeAgentFile>>
      try {
        access = await authorizeAgentFile(input)
      } finally {
        consentPending.current = false
      }
      if (!access.success) return fail(access.error)
      if (!access.approved) return onClose()
      const result = await window.api.agentFiles.openInBrowser(input)
      if (result.success) onClose()
      else fail(result.error)
    }, 'Could not open the file in the browser.'),
    'copy-path': () => run('copy-path', async () => {
      if (!file) return
      await navigator.clipboard.writeText(file.ref.path)
      onClose()
    }, 'Could not copy the path.'),
    'reference': () => run('reference', async () => {
      if (!file) return
      const agents = await queryClient.fetchQuery({ queryKey: ['agents'], queryFn: () => window.api.agents.list() })
      if (!mounted.current) return
      const agent = startableAgent(agents, file.agentId)
      if (agent) {
        startAgentChat(agent.id, { draft: referenceDraft(file.ref) })
      } else {
        useToastStore.getState().show(unavailableAgentMessage(agents, file.agentId, 'That agent is no longer available'))
      }
      onClose()
    }, 'Could not start a new chat.')
  }

  const labels: Record<MessageMenuItem, [string, LucideIcon]> = {
    'copy-text': ['Copy text', Copy],
    'save-text': ['Save to Notes', NotebookPen],
    'open-in-browser': ['Open in browser', Globe],
    'copy-contents': ['Copy contents', Copy],
    'save-contents': ['Save to Notes', NotebookPen],
    'copy-path': ['Copy full path', Link],
    'reference': ['Reference in a new chat', MessageSquarePlus]
  }
  const groups = messageMenuItems(file)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (['Escape', 'Tab', 'PageUp', 'PageDown'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
      if (!items.length) return
      const current = items.findIndex((item) => item === document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
  }

  // Mouse and keyboard share focus, so the initial Copy highlight cannot stay
  // behind when the pointer moves onto Save to Notes.
  // Items stay focusable while an action runs (`aria-disabled`, not
  // `disabled`), so focus never drops out of the menu and the arrows still move.
  const focusItem = (event: React.PointerEvent<HTMLButtonElement>): void => {
    event.currentTarget.focus({ preventScroll: true })
  }
  const itemClass = 'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text)] focus:bg-[var(--color-bg-hover)] focus:outline-none transition-[background-color,opacity] duration-100 motion-reduce:transition-none'
  const bottomAnchored = position.bottom !== undefined
  const errorRow = error && <p role="alert" className="break-words px-3 py-2 text-xs text-[var(--color-danger)]">{error}</p>
  return createPortal(
    <div ref={ref} role="menu" aria-label="Message actions" onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={{ position: 'fixed', ...position }}
      className={`app-popover-surface z-[100] ${file ? 'w-56' : 'w-48'} rounded-lg border border-[var(--color-border)] p-1 shadow-lg`}>
      {bottomAnchored && errorRow}
      {groups.map((group, index) => (
        <Fragment key={group.join()}>
          {index > 0 && <div role="separator" className="my-1 border-t border-[var(--color-border)]" />}
          {group.map((item) => {
            const [label, Icon] = labels[item]
            const running = busyItem === item
            return (
              <button key={item} type="button" role="menuitem" data-menu-item={item}
                aria-disabled={busyItem !== null || undefined} aria-busy={running || undefined}
                className={`${itemClass} ${busyItem !== null && !running ? 'opacity-50' : ''}`}
                onPointerEnter={focusItem} onPointerMove={focusItem}
                onClick={() => {
                  if (!acting.current) void actions[item]()
                }}>
                {running
                  ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                  : <Icon size={14} aria-hidden />}
                {label}
              </button>
            )
          })}
        </Fragment>
      ))}
      {!bottomAnchored && errorRow}
    </div>, document.body
  )
}
