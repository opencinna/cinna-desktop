import { useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionActivityItem } from '../../../../shared/sessionActivity'
import type { UserCommandEnd } from '../../../../shared/userCommands'
import { useSessionActivity } from '../../hooks/useSessionActivity'
import { useSessionActivityStop } from '../../hooks/useSessionActivityStop'
import { useUserCommandsStore } from '../../stores/userCommands.store'
import { useUIStore } from '../../stores/ui.store'
import { formatRunDuration, useCommandOutputAdder, useSecondsNow } from './SessionActivityBadges'

const NO_ITEMS: readonly SessionActivityItem[] = []

/** The panel's fixed height: the header row plus the terminal. It never changes while the run streams. */
export const COMMAND_PANEL_HEIGHT = 240

/**
 * xterm draws on a canvas and needs concrete colours, so the theme is read
 * from the app's `--color-*` variables when the panel mounts, and again when
 * the app's theme changes while it is open.
 */
export function terminalTheme(style: Pick<CSSStyleDeclaration, 'getPropertyValue'> = getComputedStyle(document.documentElement)): ITheme {
  const read = (name: string): string | undefined => style.getPropertyValue(name).trim() || undefined
  return {
    background: read('--color-bg-secondary'),
    foreground: read('--color-text'),
    cursor: read('--color-bg-secondary'),
    selectionBackground: read('--color-bg-tertiary'),
    red: read('--color-danger'),
    brightRed: read('--color-danger'),
    green: read('--color-success'),
    brightGreen: read('--color-success'),
    yellow: read('--color-warning'),
    brightYellow: read('--color-warning'),
    blue: read('--color-accent'),
    brightBlue: read('--color-accent'),
    brightBlack: read('--color-text-muted')
  }
}

const ENDED_LABEL: Record<string, string> = { completed: 'Completed', failed: 'Failed', stopped: 'Stopped', lost: 'Lost' }

function endText(end: UserCommandEnd): string {
  if (end.state === 'stopped') return 'Stopped'
  if (end.state === 'completed') return 'Exit 0'
  if (end.signal) return end.signal
  return end.exitCode === null ? 'Failed' : `Exit ${end.exitCode}`
}

const headerButton = `shrink-0 px-1.5 rounded border leading-4 text-[11px] font-medium
  border-[var(--color-border)] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]
  aria-disabled:opacity-50 aria-disabled:cursor-default
  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]`

/**
 * A run's output, docked between the message list and the composer: one per
 * chat, opened by Run or Open output, replaced by the next one opened. A
 * read-only terminal (`disableStdin`) at a fixed height, so the transcript
 * shrinks once, on the click that opened it, and nothing moves while the
 * output streams. Close keeps the run going.
 *
 * The header's right end is Stop's slot, before Close: once the run ends it
 * holds how it ended, as text, and Add output to message arrives left of the
 * time, where Stop never was — so a second click on Stop hits nothing (§1).
 */
export function CommandOutputPanel({ chatId }: { chatId: string }): React.JSX.Element | null {
  const itemId = useUserCommandsStore((s) => s.panels[chatId])
  if (!itemId) return null
  return <CommandOutputPanelBody key={`${chatId}\n${itemId}`} chatId={chatId} itemId={itemId} />
}

function CommandOutputPanelBody({ chatId, itemId }: { chatId: string; itemId: string }): React.JSX.Element {
  const activity = useSessionActivity(chatId)
  const items = activity.data?.items ?? NO_ITEMS
  const item = items.find((candidate) => candidate.id === itemId)
  const stop = useSessionActivityStop(chatId, items)
  const adder = useCommandOutputAdder(chatId)
  const closePanel = useUserCommandsStore((s) => s.closePanel)
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const appTheme = useUIStore((s) => s.theme)
  const [command, setCommand] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [end, setEnd] = useState<{ end: UserCommandEnd; endedAt: number } | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      disableStdin: true,
      convertEol: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      fontSize: 12,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      scrollback: 10_000,
      theme: terminalTheme()
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    const refit = (): void => {
      try { fit.fit() } catch { /* not laid out yet */ }
    }
    refit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit)
    observer?.observe(host)
    const unsubscribe = window.api.userCommands.output(chatId, itemId, (frame) => {
      if (frame.type === 'start') {
        setCommand(frame.command)
        setStartedAt(frame.startedAt)
        if (frame.backlog) terminal.write(frame.backlog)
      } else if (frame.type === 'chunk') {
        terminal.write(frame.data)
      } else if (frame.type === 'end') {
        setEnd({ end: frame.end, endedAt: frame.endedAt })
      } else {
        setMissing(true)
      }
    })
    return () => {
      unsubscribe()
      observer?.disconnect()
      terminalRef.current = null
      terminal.dispose()
    }
  }, [chatId, itemId])

  // The variables follow `data-theme`, which the store sets before it changes.
  const themeSeen = useRef(appTheme)
  useEffect(() => {
    if (themeSeen.current === appTheme) return
    themeSeen.current = appTheme
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme()
  }, [appTheme])

  const running = !end && !missing && item?.state !== undefined && item.state === 'running'
  const now = useSecondsNow(running)

  const title = command ?? item?.title ?? ''
  // How it ended, in Stop's slot; while it runs (or is gone) the state sits left of the time.
  const endedText = end ? endText(end.end) : !missing && item && item.state !== 'running' ? ENDED_LABEL[item.state] ?? 'Ended' : null
  const endTone = !end ? 'text-[var(--color-text-muted)]'
    : end.end.state === 'completed' ? 'text-[var(--color-success)]' : end.end.state === 'stopped' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-danger)]'
  const liveText = missing ? 'Output no longer available' : endedText === null ? 'Running' : null
  const liveTone = missing ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-accent)]'
  const begin = startedAt ?? item?.startedAt.getTime() ?? null
  const elapsed = begin === null ? null : formatRunDuration((end?.endedAt ?? now) - begin)
  const ended = !!end
  const adding = adder.pending(itemId)
  const error = adder.error(itemId) ?? stop.refusal(itemId)
  const stopping = stop.pending(itemId)

  return (
    <section
      aria-label="Command output"
      style={{ height: COMMAND_PANEL_HEIGHT }}
      className="w-full max-w-3xl mx-auto px-4 mb-2 flex flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2.5 text-[11px]">
          <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text)]" title={title}>{title.split('\n')[0]}</span>
          {/* The error, when there is one, takes the header's middle: it moves nothing (§1, §6). */}
          {error && <span role="alert" className="min-w-0 max-w-[40%] truncate text-[var(--color-danger)]" title={error}>{error}</span>}
          {ended && (
            <button type="button" className={`${headerButton} inline-flex items-center gap-1`} aria-disabled={adding || undefined}
              onClick={() => { if (!adding) adder.add(itemId) }}>
              {adding && <Loader2 size={10} className="animate-spin motion-reduce:animate-none" aria-hidden />}
              Add output to message
            </button>
          )}
          {liveText && <span className={`shrink-0 tabular-nums ${liveTone}`}>{liveText}</span>}
          {elapsed && <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{elapsed}</span>}
          {/* Stop's slot: at least Stop's width, so nothing slides into where it was. */}
          <span data-slot="stop" className="grid shrink-0 justify-items-end">
            <span aria-hidden className="invisible [grid-area:1/1] px-1.5 border border-transparent leading-4 font-medium">Stopping…</span>
            {running && item?.canStop ? (
              <button type="button" className={`${headerButton} [grid-area:1/1]`} aria-disabled={stopping || undefined}
                aria-label={`${stopping ? 'Stopping' : 'Stop'} ${title}`}
                onClick={() => { if (!stopping) stop.stop(itemId) }}>
                <span className="grid">
                  <span aria-hidden className={`[grid-area:1/1] text-center ${stopping ? 'invisible' : ''}`}>Stop</span>
                  <span aria-hidden className={`[grid-area:1/1] text-center ${stopping ? '' : 'invisible'}`}>Stopping…</span>
                </span>
              </button>
            ) : endedText !== null ? (
              <span className={`[grid-area:1/1] px-1.5 border border-transparent leading-4 tabular-nums ${endTone}`}>{endedText}</span>
            ) : null}
          </span>
          <button type="button" aria-label="Close output" title="Close (the command keeps running)"
            onClick={() => closePanel(chatId)}
            className="shrink-0 rounded p-0.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
            <X size={13} aria-hidden />
          </button>
        </div>
        <div ref={hostRef} data-testid="command-output-terminal" className="min-h-0 flex-1 px-2 py-1" />
      </div>
    </section>
  )
}
