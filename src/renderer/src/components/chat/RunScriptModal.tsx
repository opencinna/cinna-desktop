import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, ExternalLink, FileText, FolderOpen, Loader2, Minus, MoreHorizontal, Paperclip, SquareTerminal, X } from 'lucide-react'
import type { SessionActivityItem } from '../../../../shared/sessionActivity'
import { COMMAND_COLUMNS, homeDisplayPath, type UserCommandEnd, type UserCommandOutputFrame } from '../../../../shared/userCommands'
import { buildCommand, commandScript, editCommand, preferredFlag, preferredOffFlag, readCommand, type ScriptForm, type ScriptValues } from '../../../../shared/scriptArgs'
import type { ScriptSpec } from '../../../../shared/scriptSpec'
import { splitCommandLine } from '../../../../shared/commandRun'
import { useSessionActivity } from '../../hooks/useSessionActivity'
import { useSessionActivityStop } from '../../hooks/useSessionActivityStop'
import { sourceInput, useRunScriptStore, type RunScriptWindow } from '../../stores/runScript.store'
import { useFilePreviewStore } from '../../stores/filePreview.store'
import { useAuthStore } from '../../stores/auth.store'
import { usePopover } from '../ui/usePopover'
import { INFO_TIP_ATTR } from '../settings/SettingsLayout'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'
import { MOD_KEY, resolveKey } from '../../constants/hints'
import { playCardEntrance, playCardExit, CARD_MOTION } from '../../utils/cardMotion'
import { unwrapIpcError } from '../../utils/ipcError'
import { useHomeDir } from '../../utils/userCommands'
import { CommandTerminal } from './CommandTerminal'
import { RunScriptCommandLine, commandLineRows, measureCharsPerLine } from './RunScriptCommandLine'
import { RUN_SCRIPT_POPOVER_ATTR, RunScriptForm } from './RunScriptForm'
import { formatRunDuration, useCommandOutputAdder, useSecondsNow } from './SessionActivityBadges'

type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>
type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

const NO_ITEMS: readonly SessionActivityItem[] = []

/** How long after an open a press outside the card is ignored (the second press of a double-click). */
const OPEN_PRESS_GUARD_MS = 500

/**
 * How long after Stop takes Run's place a pointer press on it is ignored: the
 * second press of a double-click on Run must not stop the run it started.
 * The keyboard is not held back.
 */
export const STOP_PRESS_GUARD_MS = 400

/** Marks the window's portaled ⋯ menu and help tips, so a press on one is not a press outside the card. */
const POPOVER_ATTR = RUN_SCRIPT_POPOVER_ATTR

/**
 * What the terminal says before the first run when the script's parameters
 * were read: its summary and description, dimmed. Null when it has neither.
 *
 * The docstring is the script author's text written into a terminal, and an
 * escape in a Python literal (`\x1b`, `\a`) is a real control character by
 * now: every C0 control but a line break and a tab, ESC, DEL and the C1
 * range (`\x9b` is a CSI to xterm) are dropped, so it can only print.
 */
export function specHint(spec: ScriptSpec | null): string | null {
  if (!spec) return null
  const text = [spec.summary, spec.description].filter((part): part is string => !!part).join('\n\n')
  // eslint-disable-next-line no-control-regex
  const printable = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
  return printable.trim() === '' ? null : printable.replace(/\n/g, '\r\n')
}

/** The most rows the command line reserves for what the form may add; beyond that it scrolls to the tail. */
export const FORM_LINE_MAX_ROWS = 3

/**
 * The line sized at open: the command plus every switch the form could tick
 * that it does not name yet, so a tick does not hide the flag it added.
 * Values typed into fields are not counted; the line scrolls to them.
 */
export function formSizingLine(spec: ScriptSpec | null, command: string): string {
  if (!spec) return command
  // The words as the shell reads them (`'--apply'` names `--apply`); a line
  // the tokenizer refuses falls back to its whitespace-separated words.
  const words = new Set(splitCommandLine(command) ?? command.split(/\s+/))
  const extra = spec.params
    .filter((param) => param.kind === 'switch' && param.flags.length > 0 &&
      ![...param.flags, ...param.offFlags].some((flag) => words.has(flag)))
    // The flag a toggle writes (as `paramArgs` does): the off flag (`--no-x`) for a switch on by default.
    .map((param) => param.defaultOn && param.offFlags.length > 0 ? preferredOffFlag(param) : preferredFlag(param))
  return extra.length === 0 ? command : `${command} ${extra.join(' ')}`
}

/** The form's state: the values the line last gave it, and whether the line still names the script. */
interface FormState {
  read: ScriptForm | null
  handEdited: boolean
}

/** The Commands badge of `chatId`, if it is on screen: the window collapses into it. */
export function commandsBadgeOf(chatId: string): HTMLElement | null {
  const badges = document.querySelectorAll<HTMLElement>('button[data-badge="command"]')
  for (const badge of Array.from(badges)) if (badge.dataset.chatId === chatId) return badge
  return null
}

/** The script a command runs, as written (`scripts/check.py`), past any env assignments; null for none. */
function scriptOf(command: string): string | null {
  return commandScript(command.split('\n')[0])
}

/** The header's name: the script's file name, else the command's first word. */
function titleOf(command: string, script: string | null): string {
  if (script) return script.split('/').pop() || script
  return command.trim().split(/\s+/)[0] ?? ''
}

function endText(end: UserCommandEnd): string {
  if (end.state === 'stopped') return 'Stopped'
  if (end.state === 'completed') return 'Completed'
  if (end.signal) return end.signal
  return end.exitCode === null ? 'Failed' : `Exit ${end.exitCode}`
}

const ENDED_LABEL: Record<string, string> = { completed: 'Completed', failed: 'Failed', stopped: 'Stopped', lost: 'Lost' }

const iconButton = `shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]
  transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]
  aria-disabled:opacity-40 aria-disabled:cursor-default aria-disabled:hover:bg-transparent`

/** Run and Stop share one slot of this width, so swapping them moves nothing. */
const SLOT_WIDTH = 'w-[6.5rem]'

// Run carries a transparent border so it is exactly Stop's height.
const runButton = `inline-flex ${SLOT_WIDTH} items-center justify-center gap-1.5 rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1.5
  text-xs font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] aria-disabled:opacity-50 aria-disabled:cursor-default`
const stopButton = `inline-flex ${SLOT_WIDTH} items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5
  text-xs font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-bg-hover)] aria-disabled:opacity-50 aria-disabled:cursor-default`
const backgroundButton = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--color-border)] px-3 py-1.5
  text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] aria-disabled:opacity-50 aria-disabled:cursor-default`

/**
 * The Run Script window: one global instance, driven by
 * {@link useRunScriptStore}. A modal card like the file preview — it grows
 * from the click that opened it — with a read-only terminal for its body and
 * the command line at its foot. Collapse shrinks it into the Commands badge,
 * Close (and Escape) fades it; neither stops a run. The card's size is fixed:
 * a refusal line takes its row from the terminal, never from the command line.
 *
 * The body is a row: the terminal takes the width, and a fixed-width sidebar
 * (the script's parameters, later) can sit to its right without moving it.
 */
export function RunScriptModal(): React.JSX.Element | null {
  const live = useRunScriptStore((s) => s.window)
  const [view, setView] = useState<RunScriptWindow | null>(live)
  const [exiting, setExiting] = useState(false)
  if (live && live !== view) {
    setView(live)
    setExiting(false)
  } else if (!live && view && !exiting) {
    setExiting(true)
  }
  if (!view) return null
  return (
    <RunScriptCard
      key={view.seq}
      view={view}
      exiting={exiting}
      onExited={() => {
        setView(null)
        setExiting(false)
      }}
    />
  )
}

interface RunFacts {
  startedAt: number | null
  end: { end: UserCommandEnd; endedAt: number } | null
  missing: boolean
}

function RunScriptCard({ view, exiting, onExited }: {
  view: RunScriptWindow
  exiting: boolean
  onExited: () => void
}): React.JSX.Element {
  const { chatId } = view
  const queryClient = useQueryClient()
  const pending = useRunScriptStore((s) => s.pending)
  const error = useRunScriptStore((s) => s.error)
  const close = useRunScriptStore((s) => s.close)
  const start = useRunScriptStore((s) => s.start)
  const activity = useSessionActivity(chatId)
  const items = activity.data?.items ?? NO_ITEMS
  const itemId = view.runs.length > 0 ? view.runs[view.runs.length - 1] : null
  const item = itemId ? items.find((candidate) => candidate.id === itemId) : undefined
  const stop = useSessionActivityStop(chatId, items)
  const adder = useCommandOutputAdder(chatId)
  const home = useHomeDir()
  const cardRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLTextAreaElement>(null)
  const columns = useRef<number | null>(null)
  const [command, setCommand] = useState(view.command)
  // Fixed at open: nothing resizes while the user types (ux_rules §1). A
  // multi-line block takes Enter as a new line; a long line's rows count its
  // soft wraps, measured once before the first paint.
  const [multiline] = useState(() => view.command.includes('\n'))
  // With a form, room for the switches it could add (at most
  // FORM_LINE_MAX_ROWS); a longer line scrolls to its tail on a form edit.
  const sizeRows = (cells?: number): number => {
    const own = commandLineRows(view.command, cells)
    const withForm = commandLineRows(formSizingLine(view.spec, view.command), cells)
    return Math.max(own, Math.min(withForm, FORM_LINE_MAX_ROWS))
  }
  const [rows, setRows] = useState(() => sizeRows())
  useLayoutEffect(() => {
    const cells = measureCharsPerLine(lineRef.current)
    if (cells !== null) setRows(sizeRows(cells))
    // Once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The form follows the line: a line edit re-reads it, a form edit rewrites
  // the line after the script word. Neither ever changes the form's rows.
  const spec = view.spec
  const [form, setForm] = useState<FormState>(() => {
    const read = spec ? readCommand(spec, view.command) : null
    return { read, handEdited: read === null }
  })
  const onLineChange = (text: string): void => {
    setCommand(text)
    if (!spec) return
    const read = readCommand(spec, text)
    setForm((prev) => (read ? { read, handEdited: false } : { read: prev.read, handEdited: true }))
  }
  const onFormChange = (values: ScriptValues, other: string): void => {
    if (!spec || !form.read || form.handEdited) return
    // Only the edited parameter's words change, in place; the whole line in
    // spec order only when an edit in place would not read back. The rebuilt
    // line may not read back either (a free word taken as the optional
    // positional), so the form shows what the line says, never what was typed.
    const inPlace = editCommand(spec, command, values, other)
    const next = inPlace ?? buildCommand(form.read.prefix, spec, values, other)
    const read: ScriptForm = inPlace !== null ? { ...form.read, values, other } : readCommand(spec, next) ?? { ...form.read, values, other }
    setForm({ read, handEdited: inPlace === null && readCommand(spec, next) === null })
    setCommand(next)
    // A word added at the end may have wrapped below the field's rows: bring it into view.
    if (next.length > command.length && next.startsWith(command)) tailPending.current = true
  }
  const tailPending = useRef(false)
  useLayoutEffect(() => {
    if (!tailPending.current) return
    tailPending.current = false
    const field = lineRef.current
    if (field) field.scrollTop = field.scrollHeight
  }, [command])
  const [facts, setFacts] = useState<Record<string, RunFacts>>({})
  const [actionError, setActionError] = useState<string | null>(null)

  const onFrame = (id: string, frame: UserCommandOutputFrame): void => {
    setFacts((prev) => {
      const current = prev[id] ?? { startedAt: null, end: null, missing: false }
      if (frame.type === 'start') return { ...prev, [id]: { ...current, startedAt: frame.startedAt } }
      if (frame.type === 'end') return { ...prev, [id]: { ...current, end: { end: frame.end, endedAt: frame.endedAt } } }
      if (frame.type === 'missing') return { ...prev, [id]: { ...current, missing: true } }
      return prev
    })
  }
  const run = itemId ? facts[itemId] : undefined
  const missing = run?.missing === true
  const end = run?.end ?? null
  // Running until the run says otherwise; before the first activity push the item is not listed yet.
  const running = itemId !== null && !end && !missing && (item?.state ?? 'running') === 'running'
  const now = useSecondsNow(running)

  // The chat's earlier commands for ↑/↓, most recent first, each once.
  const history = useMemo(() => {
    const seen = new Set<string>()
    return items
      .filter((candidate) => candidate.kind === 'command')
      .slice()
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map((candidate) => candidate.title)
      .filter((title) => (seen.has(title) ? false : (seen.add(title), true)))
  }, [items])

  // The entrance, from the click that opened it; focus to the command line,
  // and back to what held it after a keyboard open.
  useLayoutEffect(() => {
    const card = cardRef.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const animations = card ? playCardEntrance(card, backdropRef.current, view.origin) : []
    lineRef.current?.focus({ preventScroll: true })
    return () => {
      for (const animation of animations) animation.cancel()
      if (view.origin === null && previous?.isConnected) previous.focus({ preventScroll: true })
    }
    // Once per open: the card is keyed by the open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The exit: into the Commands badge for a collapse when it is on screen,
  // else the entrance backwards; unmounts once it has played (at once where
  // nothing can animate).
  useLayoutEffect(() => {
    if (!exiting) return
    const card = cardRef.current
    const how = useRunScriptStore.getState().exit
    const badge = how === 'collapse' ? commandsBadgeOf(chatId) : null
    const into = badge ? badge.getBoundingClientRect() : null
    const animations = card ? playCardExit(card, backdropRef.current, into && into.width > 0 ? into : null) : []
    const timer = setTimeout(onExited, animations.length > 0 ? Number(CARD_MOTION.duration) : 0)
    return () => {
      clearTimeout(timer)
      for (const animation of animations) animation.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exiting])

  // Escape closes; a press outside closes. Both leave the run going. A file
  // preview opened from the ⋯ menu sits over the window and takes them first.
  const openedAt = useRef(Date.now())
  useEffect(() => {
    if (exiting) return
    const previewOpen = (): boolean => useFilePreviewStore.getState().target !== null
    // A parameter's (?) tip is portaled to <body>: open, it takes Escape and
    // its own presses, and the window is not "outside" it.
    const tipOpen = (): boolean => document.querySelector(`[${INFO_TIP_ATTR}]`) !== null
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || previewOpen() || tipOpen()) return
      event.preventDefault()
      close('close')
    }
    const onMouse = (event: MouseEvent): void => {
      const target = event.target as Element
      if (!cardRef.current || cardRef.current.contains(target)) return
      if (target.closest?.(`[${POPOVER_ATTR}]`) || target.closest?.(`[${INFO_TIP_ATTR}]`) || previewOpen()) return
      if (Date.now() - openedAt.current < OPEN_PRESS_GUARD_MS) return
      event.preventDefault()
      close('close')
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse, true)
    }
  }, [exiting, close])

  // Another profile's chats are not this window's: it goes even while a start is in flight.
  const profileId = useAuthStore((s) => s.currentUser?.id)
  const profileAtOpen = useRef(profileId)
  const dismiss = useRunScriptStore((s) => s.dismiss)
  useEffect(() => {
    if (profileId !== profileAtOpen.current) dismiss()
  }, [profileId, dismiss])

  const chat = queryClient.getQueryData<CachedChat>(['chat', chatId])
  const agents = queryClient.getQueryData<AgentData[]>(['agents'])
  const agentId = view.agentId ?? (itemId ? item?.agentId ?? null : null)
  const agent = agentId ? agents?.find((candidate) => candidate.id === agentId) : undefined
  /** A reply of the run's agent, for a window opened on a run this renderer did not start. */
  const fallbackMessageId = (): string | null => {
    if (view.messageId || !chat || !agentId) return null
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const message = chat.messages[i]
      if (message.role === 'assistant' && (message.sourceAgentId ?? chat.agentId) === agentId) return message.id
    }
    return null
  }

  // Set when Run is pressed here, so the Stop that then takes its place is
  // guarded against the rest of a double-click; a window opened on a running
  // run shows Stop unguarded.
  const startedHere = useRef(false)
  const startRun = (background: boolean): void => {
    if (pending || running || exiting) return
    startedHere.current = true
    setActionError(null)
    void start(command, background, columns.current ?? COMMAND_COLUMNS.default, fallbackMessageId())
  }

  const script = scriptOf(view.command)
  const title = titleOf(view.command, script)
  const shownPath = script && script !== title ? script : null
  const folder = view.folder ? homeDisplayPath(view.folder, home) : null
  // A script inside the folder, as written relative to it: the ⋯ menu's file actions.
  const localPath = agent?.localPath ?? null
  const scriptPath = script && localPath && !script.startsWith('/') && !script.startsWith('~') && !script.split('/').includes('..')
    ? `${localPath.replace(/[\\/]+$/, '')}/${script.replace(/^\.\//, '')}`
    : null

  const begin = run?.startedAt ?? item?.startedAt.getTime() ?? null
  const elapsed = begin === null ? null : formatRunDuration((end?.endedAt ?? item?.endedAt?.getTime() ?? now) - begin)
  const state: { text: string; tone: string } | null = itemId === null ? null
    : missing ? { text: 'Output no longer available', tone: 'text-[var(--color-text-muted)]' }
      : end ? {
        text: endText(end.end),
        tone: end.end.state === 'completed' ? 'text-[var(--color-success)]' : end.end.state === 'stopped' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-danger)]'
      }
        : item && item.state !== 'running' ? { text: ENDED_LABEL[item.state] ?? 'Ended', tone: 'text-[var(--color-text-muted)]' }
          : { text: 'Running', tone: 'text-[var(--color-accent)]' }
  const ended = itemId !== null && !running && !missing && (!!end || (!!item && item.state !== 'running'))
  const stopping = itemId ? stop.pending(itemId) : false
  const showStop = running && !!itemId && !!item?.canStop
  const stopShownAt = useRef<number | null>(null)
  useLayoutEffect(() => {
    stopShownAt.current = showStop && startedHere.current ? Date.now() : null
  }, [showStop, itemId])
  const shownError = error ?? actionError ?? (itemId ? adder.error(itemId) ?? stop.refusal(itemId) : null)

  return createPortal(
    <div className={`fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]${exiting ? ' pointer-events-none' : ''}`}>
      <div ref={backdropRef} aria-hidden className="app-modal-scrim absolute inset-0" />
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Run ${title}`}
        className="relative flex h-[70vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border
          app-modal-panel focus:outline-none"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4">
          <SquareTerminal size={15} aria-hidden className="shrink-0 text-[var(--color-text-muted)]" />
          <span className="max-w-[40%] shrink-0 truncate text-sm font-semibold text-[var(--color-text)]" title={title}>{title}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={[shownPath, folder].filter(Boolean).join(' · ')}>
            {shownPath && <span className="font-mono">{shownPath}</span>}
            {shownPath && folder && ' · '}
            {folder && <span className="font-mono">{folder}</span>}
          </span>
          {/* The run's state and time: a fixed place, rewritten in place. */}
          <span data-slot="state" className="shrink-0 text-[11px] tabular-nums">
            {state && (
              <span className={`inline-flex items-center gap-1 ${state.tone}`}>
                {running && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] animate-pulse motion-reduce:animate-none" />}
                {state.text}
              </span>
            )}
            {state && elapsed && <span className="text-[var(--color-text-muted)]"> · {elapsed}</span>}
          </span>
          <RunScriptActions
            disabled={exiting}
            adding={itemId ? adder.pending(itemId) : false}
            scriptPath={scriptPath}
            canOpenFolder={!!localPath && !!agentId}
            canAddOutput={ended}
            onOpenScript={() => {
              if (!agentId || !scriptPath) return
              void window.api.agentFiles.open({ agentId, path: scriptPath })
                .then((result) => setActionError(result.success ? null : result.error))
                .catch((err) => setActionError(unwrapIpcError(err, 'The script could not be opened.')))
            }}
            onPreview={() => {
              if (!agentId || !scriptPath || !script) return
              void useFilePreviewStore.getState().openAgentFile(
                agentId, { text: script, path: scriptPath, displayPath: script, kind: 'file', inside: true }, null, view.messageId
              )
            }}
            onOpenFolder={() => {
              if (!agentId) return
              void window.api.localAgents.openPath({ agentId })
                .then(() => setActionError(null))
                .catch((err) => setActionError(unwrapIpcError(err, 'The folder could not be opened.')))
            }}
            onCopy={() => {
              void navigator.clipboard.writeText(command)
                .then(() => setActionError(null))
                .catch(() => setActionError('The command could not be copied.'))
            }}
            onAddOutput={() => { if (itemId) adder.add(itemId) }}
          />
          <button type="button" className={iconButton} aria-label="Collapse" title="Collapse (the command keeps running)"
            aria-disabled={pending !== null || undefined} onClick={() => close('collapse')}>
            <Minus size={14} aria-hidden />
          </button>
          <button type="button" className={iconButton} aria-label="Close" title="Close (the command keeps running)"
            aria-disabled={pending !== null || undefined} onClick={() => close('close')}>
            <X size={14} aria-hidden />
          </button>
        </div>
        {/* A row: the parameters' fixed-width sidebar, when the script has one, is there from the open. */}
        <div className="flex min-h-0 flex-1">
          <div className="app-modal-well m-2 mr-0 min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg">
            <CommandTerminal
              chatId={chatId}
              itemId={itemId}
              runNumber={view.runs.length}
              onFrame={onFrame}
              idleHint={specHint(spec) ?? `Press Run (${multiline ? resolveKey(MOD_KEY) : ''}↩) to start.`}
              onColumns={(cols) => { columns.current = cols }}
            />
          </div>
          {spec && (
            <RunScriptForm
              spec={spec}
              values={form.read?.values ?? {}}
              other={form.read?.other ?? ''}
              readOnly={running || pending !== null}
              handEdited={form.handEdited}
              scriptName={title}
              onChange={onFormChange}
              onChoosePath={async () => {
                const input = sourceInput(view, fallbackMessageId())
                if (!input) return null
                try {
                  const result = 'messageId' in input
                    ? await window.api.userCommands.chooseArgPath(chatId, input.messageId)
                    : await window.api.userCommands.chooseArgPath(chatId, null, input.agentId)
                  if (!result.ok) { setActionError(result.reason); return null }
                  setActionError(null)
                  return 'canceled' in result ? null : result.path
                } catch (err) {
                  setActionError(unwrapIpcError(err, 'The path could not be chosen.'))
                  return null
                }
              }}
            />
          )}
        </div>
        <div className="shrink-0 space-y-1.5 border-t border-[var(--color-border)] px-4 py-2.5">
          {/* Only when something was refused, above the line: it closes nothing and moves the line not at all. */}
          {shownError && <p role="alert" className="text-xs text-[var(--color-danger)]">{shownError}</p>}
          {view.reason && <p className="text-xs text-[var(--color-text-secondary)]">{view.reason}</p>}
          <div className="flex items-start gap-2">
            <RunScriptCommandLine
              ref={lineRef}
              value={command}
              onChange={onLineChange}
              rows={rows}
              multiline={multiline}
              readOnly={running || pending !== null}
              history={history}
              onRun={startRun}
            />
            {/* Fixed slots: hidden while it runs, never removed, so nothing slides. */}
            <span className={running ? 'invisible' : ''}>
              <button type="button" className={backgroundButton} aria-disabled={pending !== null || undefined}
                aria-busy={pending === 'background' || undefined} title={`Run in background (⇧${resolveKey(MOD_KEY)}↩)`}
                onClick={() => startRun(true)}>
                {pending === 'background' && <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                Run in background
              </button>
            </span>
            <span className={`inline-flex ${SLOT_WIDTH} shrink-0`}>
              {showStop && itemId ? (
                <button type="button" className={stopButton} aria-disabled={stopping || undefined}
                  aria-label={stopping ? 'Stopping' : 'Stop'} onClick={(event) => {
                    // A pointer press (detail > 0) right after Stop appeared is the end of a double-click on Run.
                    const shownAt = stopShownAt.current
                    if (event.detail > 0 && shownAt !== null && Date.now() - shownAt < STOP_PRESS_GUARD_MS) return
                    if (!stopping) stop.stop(itemId)
                  }}>
                  {stopping ? 'Stopping…' : 'Stop'}
                </button>
              ) : (
                <button type="button" className={runButton} aria-disabled={pending !== null || running || undefined}
                  aria-busy={pending === 'run' || undefined} title={`Run (${multiline ? '' : '↩ or '}${resolveKey(MOD_KEY)}↩)`}
                  onClick={() => startRun(false)}>
                  {pending === 'run' && <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                  {view.runs.length > 0 ? 'Run again' : 'Run'}
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** The window's ⋯ menu: the occasional actions on the script, its folder, the command and the output. */
function RunScriptActions({
  disabled, adding, scriptPath, canOpenFolder, canAddOutput, onOpenScript, onPreview, onOpenFolder, onCopy, onAddOutput
}: {
  disabled: boolean
  adding: boolean
  scriptPath: string | null
  canOpenFolder: boolean
  canAddOutput: boolean
  onOpenScript: () => void
  onPreview: () => void
  onOpenFolder: () => void
  onCopy: () => void
  onAddOutput: () => void
}): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  const { open, setOpen, triggerRef, popoverRef } = menu

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled, setOpen])

  useEffect(() => {
    if (open && menu.style) popoverRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, menu.style !== null])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        // Before the window's own listener, which would close the window.
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus({ preventScroll: true })
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const list = Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
      if (list.length === 0) return
      event.preventDefault()
      const at = list.indexOf(document.activeElement as HTMLButtonElement)
      list[(at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen, triggerRef, popoverRef])

  const pick = (fn: () => void) => (): void => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
    fn()
  }

  return (
    <>
      <button ref={triggerRef} type="button" className={iconButton} aria-haspopup="menu" aria-expanded={open}
        aria-label="More run actions" title="More run actions" onClick={() => setOpen(!open)}>
        {adding ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <MoreHorizontal size={14} aria-hidden />}
      </button>
      {open && menu.style && createPortal(
        <div ref={popoverRef} role="menu" aria-label="Run actions" style={menu.style} className={MENU_SURFACE} {...{ [POPOVER_ATTR]: '' }}>
          <button type="button" role="menuitem" className={MENU_ITEM} disabled={!scriptPath} onClick={pick(onOpenScript)}>
            <ExternalLink size={12} aria-hidden />Open script
          </button>
          <button type="button" role="menuitem" className={MENU_ITEM} disabled={!scriptPath} onClick={pick(onPreview)}>
            <FileText size={12} aria-hidden />Preview source
          </button>
          <button type="button" role="menuitem" className={MENU_ITEM} disabled={!canOpenFolder} onClick={pick(onOpenFolder)}>
            <FolderOpen size={12} aria-hidden />Open folder
          </button>
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={pick(onCopy)}>
            <Copy size={12} aria-hidden />Copy command
          </button>
          {canAddOutput && (
            <button type="button" role="menuitem" className={MENU_ITEM} disabled={adding} onClick={pick(onAddOutput)}>
              <Paperclip size={12} aria-hidden />Add output to message
            </button>
          )}
        </div>,
        document.body
      )}
    </>
  )
}
