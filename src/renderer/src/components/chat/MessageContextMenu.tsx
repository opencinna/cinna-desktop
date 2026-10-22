import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Cog, Copy, FolderOpen, Globe, Link, Loader2, MessageSquarePlus, NotebookPen, Play, SquarePen, Upload, type LucideIcon } from 'lucide-react'
import {
  agentFileContentKind,
  isCredentialFileRef,
  type AgentFileActionResult,
  type AgentFileConsentPurpose,
  type AgentFilePathInput,
  type AgentFileRef,
  type AgentFileTextUse
} from '../../../../shared/agentFiles'
import { previewKindFor } from '../../../../shared/filePreview'
import type { ComposerPathRef } from '../../../../shared/pathMentions'
import { useSaveMessageNote } from '../../hooks/useNotes'
import { useAuthStore } from '../../stores/auth.store'
import { useArtifactPublishStore } from '../../stores/artifactPublish.store'
import { useArtifactsSupport } from '../../hooks/useArtifacts'
import { useToastStore } from '../../stores/toast.store'
import { useUIStore } from '../../stores/ui.store'
import { authorizeAgentFile, readAgentFileText } from '../../utils/agentFileAccess'
import { startableAgent } from '../../utils/appShortcuts'
import { fileNoteFromContents } from '../../utils/fileNote'
import { unwrapIpcError } from '../../utils/ipcError'
import { startAgentChat, unavailableAgentMessage } from '../../utils/startAgentChat'
import { fileRefTargetOf, type FileRefTarget } from './fileRefs'
import { detectCommand, looksAutoRunnable } from '../../../../shared/commandRun'
import { USER_COMMAND_RUN_REASONS } from '../../../../shared/userCommands'
import { agentRunsCommands, fenceLanguage, primeHomeDir } from '../../utils/userCommands'
import { useUserCommandsStore } from '../../stores/userCommands.store'

type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>
type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

/** A command found in the right-clicked code, in a message whose agent can run it here. */
export interface MenuCommand {
  /** What runs, prompts stripped (`detectCommand`). */
  text: string
  messageId: string
  /** The agent's folder as far as the renderer knows it, for the edit dialog. */
  folder: string | null
  /** The disk-free half of the own-command rule passed: Run and Run in background are offered. */
  auto: boolean
}

interface MenuState {
  id: number
  x: number
  y: number
  text: string
  /** The code block whose whole text the menu acts on, or the file link right-clicked; outlined while open. */
  highlight?: HTMLElement
  /** The file or folder reference the right-clicked inline code or file link names. */
  file?: FileRefTarget
  /** The right-clicked code that is not a file reference: the menu looks for a command in it. */
  code?: { element: HTMLElement; text: string }
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
  | 'reveal'
  | 'reference'
  | 'publish'
  | 'run'
  | 'run-background'
  | 'edit-run'

/**
 * The menu's items, in groups separated by a divider. Decided once, from the
 * reference as the transcript resolved it, so nothing appears or disappears
 * while the menu is open: a file whose contents cannot be text — a folder, a
 * known binary type, a credential file — offers its path only: copied, shown
 * in its folder, referenced in a new chat. An HTML file
 * (`.html`, `.htm`, `.xhtml`) also offers Open in browser, first.
 *
 * `canPublish` (the profile's instance keeps artifacts) adds Publish…, last,
 * for a file or folder inside the agent's folder that is not a credential
 * file — main would leave nothing of one to publish.
 *
 * `command` (code that is not a file reference holds a command, in a local
 * agent's message) adds a last group: Run, Run in background and Edit and
 * Run… for one that looks safe, Edit and Run… alone for any other.
 */
export function messageMenuItems(file: FileRefTarget | undefined, canPublish = false, command?: { auto: boolean }): MessageMenuItem[][] {
  if (!file) {
    if (!command) return [['copy-text', 'save-text']]
    return [['copy-text', 'save-text'], command.auto ? ['run', 'run-background', 'edit-run'] : ['edit-run']]
  }
  const { ref } = file
  const pathOnly = ref.kind === 'dir' || isCredentialFileRef(ref) || agentFileContentKind(ref.path) === 'binary'
  const pathGroup: MessageMenuItem[] = ['copy-path', 'reveal', 'reference']
  const publish: MessageMenuItem[][] = canPublish && ref.inside && !isCredentialFileRef(ref) ? [['publish']] : []
  if (pathOnly) return [pathGroup, ...publish]
  const contents: MessageMenuItem[] = ['copy-contents', 'save-contents']
  return previewKindFor(ref.path) === 'html'
    ? [['open-in-browser'], contents, pathGroup, ...publish]
    : [contents, pathGroup, ...publish]
}

/** The reference chip a new chat about `ref` starts with. */
export function referenceChip(ref: AgentFileRef): ComposerPathRef {
  return { path: ref.path, displayPath: ref.displayPath, kind: ref.kind }
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

/**
 * Without a selection, a right-click on a resolved file link (`a.file-link`)
 * takes the file it names, as a reference span does. A selection in the link
 * that the click missed takes nothing.
 */
export function fileLinkContextTarget(root: HTMLElement, target: Element, selection: Selection | null): { element: HTMLElement; file: FileRefTarget } | null {
  const element = target.closest<HTMLElement>('a.file-link')
  if (!element || !root.contains(element)) return null
  if (selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(element)) return null
  const file = fileRefTargetOf(element)
  return file ? { element, file } : null
}

/**
 * The command in right-clicked code, or undefined. Only for code that is not a
 * file reference, in a persisted message whose agent is a local agent with a
 * folder (read from the cached chat and agents at open; main checks again).
 */
export function menuCommandOf(
  code: { element: HTMLElement; text: string },
  chat: CachedChat | undefined,
  agents: readonly AgentData[] | undefined
): MenuCommand | undefined {
  const messageId = code.element.closest('[data-message-id]')?.getAttribute('data-message-id')
  if (!messageId || !chat) return undefined
  const message = chat.messages.find((candidate) => candidate.id === messageId)
  if (!message || message.role !== 'assistant') return undefined
  const agentId = message.sourceAgentId ?? chat.agentId
  const agent = agentId ? agents?.find((candidate) => candidate.id === agentId) : undefined
  if (!agentRunsCommands(agent)) return undefined
  const fenced = code.element.tagName === 'PRE'
  const text = detectCommand(code.text, { fenced, lang: fenced ? fenceLanguage(code.element.querySelector('code')) : null })
  if (text === null) return undefined
  // Ready by the time Edit and Run… shows the folder as `~/…`.
  void primeHomeDir()
  return { text, messageId, folder: agent?.localPath ?? null, auto: looksAutoRunnable(text) }
}

export function useMessageContextMenu(chatId: string) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const nextId = useRef(0)
  const profileId = useAuthStore((s) => s.currentUser?.id)
  const { supported: canPublish } = useArtifactsSupport()
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
    // A file link first: code inside one (``[`out.csv`](…)``) is not a reference of its own.
    const link = selected.trim() ? null : fileLinkContextTarget(event.currentTarget, event.target, window.getSelection())
    const code = selected.trim() || link ? null : codeContextTarget(event.currentTarget, event.target, window.getSelection())
    const file = link?.file ?? (code && code.element.tagName === 'CODE' ? fileRefTargetOf(code.element) ?? undefined : undefined)
    const text = link?.file.ref.path ?? code?.text ?? selected
    if (!text.trim()) {
      setMenu(null)
      return
    }
    event.preventDefault()
    const rect = event.target.getBoundingClientRect()
    const highlight = link?.element ?? code?.element
    // Commands are looked for only where no file reference was found.
    setMenu({ id: ++nextId.current, text, highlight, file, code: code && !file ? code : undefined, x: event.clientX || rect.left, y: event.clientY || rect.bottom })
  }, [])
  return {
    onContextMenu,
    menu: menu ? <MessageContextMenu key={menu.id} {...menu} chatId={chatId} canPublish={canPublish} onClose={closeCurrent} /> : null
  }
}

function MessageContextMenu({ x, y, text, highlight, file, code, chatId, canPublish, onClose }: MenuState & { chatId: string; canPublish: boolean; onClose: () => void }) {
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
  // Decided once, at open, from the cached chat and agents (D1); main checks again.
  const [command] = useState(() => code
    ? menuCommandOf(code, queryClient.getQueryData<CachedChat>(['chat', chatId]), queryClient.getQueryData<AgentData[]>(['agents']))
    : undefined)
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

  /** Main asks first for a path outside the agent folder, as a preview would; a decline closes quietly. */
  const launch = async (
    fail: (reason: string) => void,
    purpose: AgentFileConsentPurpose,
    call: (input: AgentFilePathInput) => Promise<AgentFileActionResult>
  ): Promise<void> => {
    if (!file) return
    const input = { agentId: file.agentId, path: file.ref.path }
    consentPending.current = true
    let access: Awaited<ReturnType<typeof authorizeAgentFile>>
    try {
      access = await authorizeAgentFile({ ...input, purpose })
    } finally {
      consentPending.current = false
    }
    if (!access.success) return fail(access.error)
    if (!access.approved) return onClose()
    const result = await call(input)
    if (result.success) onClose()
    else fail(result.error)
  }

  /**
   * Run or Run in background: no confirmation (D4). Main checks the
   * own-command rule against the agent's real folder; a command it will not
   * run unreviewed opens the edit dialog with the reason, never a dead end.
   */
  const runCommand = async (fail: (reason: string) => void, background: boolean): Promise<void> => {
    if (!command) return
    const result = await window.api.userCommands.run({ chatId, messageId: command.messageId, command: command.text, reviewed: false })
    const store = useUserCommandsStore.getState()
    if (result.ok) {
      if (!background) store.openPanel(chatId, result.itemId)
      onClose()
      return
    }
    if (result.code === 'needs_review') {
      onClose()
      store.openEdit({ chatId, messageId: command.messageId, command: command.text, folder: result.folder ?? command.folder, reason: result.reason })
      return
    }
    fail(result.reason)
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
    'open-in-browser': () => run('open-in-browser', (fail) =>
      launch(fail, 'browser', (input) => window.api.agentFiles.openInBrowser(input)), 'Could not open the file in the browser.'),
    'copy-path': () => run('copy-path', async () => {
      if (!file) return
      await navigator.clipboard.writeText(file.ref.path)
      onClose()
    }, 'Could not copy the path.'),
    'reveal': () => run('reveal', (fail) =>
      launch(fail, 'reveal', (input) => window.api.agentFiles.reveal(input)), 'Could not show it in its folder.'),
    'reference': () => run('reference', async () => {
      if (!file) return
      const agents = await queryClient.fetchQuery({ queryKey: ['agents'], queryFn: () => window.api.agents.list() })
      if (!mounted.current) return
      const agent = startableAgent(agents, file.agentId)
      if (agent) {
        startAgentChat(agent.id, { pathRefs: [referenceChip(file.ref)] })
      } else {
        useToastStore.getState().show(unavailableAgentMessage(agents, file.agentId, 'That agent is no longer available'))
      }
      onClose()
    }, 'Could not start a new chat.'),
    // The dialog is app-wide and owns its publish; the menu only opens it.
    'publish': () => run('publish', async () => {
      if (!file) return
      useArtifactPublishStore.getState().open({
        agentId: file.agentId,
        path: file.ref.path,
        kind: file.ref.kind,
        chatId,
        messageId: file.messageId ?? null
      })
      onClose()
    }, 'Could not open Publish.'),
    'run': () => run('run', (fail) => runCommand(fail, false), 'The command could not be started.'),
    'run-background': () => run('run-background', (fail) => runCommand(fail, true), 'The command could not be started.'),
    // The dialog is app-wide and owns its run; the menu only opens it.
    'edit-run': () => run('edit-run', async () => {
      if (!command) return
      useUserCommandsStore.getState().openEdit({
        chatId, messageId: command.messageId, command: command.text, folder: command.folder,
        reason: command.auto ? null : USER_COMMAND_RUN_REASONS.needs_review
      })
      onClose()
    }, 'Could not open Edit and Run.')
  }

  const labels: Record<MessageMenuItem, [string, LucideIcon]> = {
    'copy-text': ['Copy text', Copy],
    'save-text': ['Save to Notes', NotebookPen],
    'open-in-browser': ['Open in browser', Globe],
    'copy-contents': ['Copy contents', Copy],
    'save-contents': ['Save to Notes', NotebookPen],
    'copy-path': ['Copy full path', Link],
    'reveal': ['Show in the folder', FolderOpen],
    'reference': ['Reference in a new chat', MessageSquarePlus],
    'publish': ['Publish…', Upload],
    'run': ['Run', Play],
    // The Cog the Background badge wears.
    'run-background': ['Run in background', Cog],
    'edit-run': ['Edit and Run…', SquarePen]
  }
  // Decided once, at open: nothing appears or disappears while the menu is open.
  const [groups] = useState(() => messageMenuItems(file, canPublish, command))

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
