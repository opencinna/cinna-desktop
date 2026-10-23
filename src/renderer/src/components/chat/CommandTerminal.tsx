import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { UserCommandOutputFrame } from '../../../../shared/userCommands'
import { useUIStore } from '../../stores/ui.store'

/**
 * xterm draws on a canvas and needs concrete colours, so the theme is read
 * from the app's `--color-*` variables when the terminal mounts, and again
 * when the app's theme changes while it is open.
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

/** The terminal's font size; `estimateRunColumns` sizes a cell from it. */
export const TERMINAL_FONT_SIZE = 12

/** The dimmed line a rerun starts the terminal with: `── run 2 ──`. */
export function runSeparator(n: number): string {
  return `\x1b[2m── run ${n} ──\x1b[0m\r\n`
}

/** A dimmed line of its own, e.g. the hint before the first run. */
export function dimLine(text: string): string {
  return `\x1b[2m${text}\x1b[0m\r\n`
}

/**
 * A read-only terminal (`disableStdin`) following one run's output: the log's
 * tail on `start`, then live chunks, then the end. Each run is its own
 * MessagePort subscription to `userCommands:output`; closing one never stops
 * the run. When `itemId` changes to a later run of the same window, the
 * terminal clears and starts with a `── run N ──` line, so a rerun does not
 * clear silently. Before any run it shows `idleHint`, dimmed, which the
 * first run clears. Reports its column count once laid out and on resize.
 */
export function CommandTerminal({
  chatId,
  itemId,
  runNumber,
  idleHint = null,
  onFrame,
  onColumns
}: {
  chatId: string
  /** The run shown, or null before the first run. */
  itemId: string | null
  /** Which run of the window this is (1 for the first); 2 and up start with the separator. */
  runNumber: number
  /** Written once at mount when there is no run yet; read at mount only. */
  idleHint?: string | null
  onFrame: (itemId: string, frame: UserCommandOutputFrame) => void
  onColumns: (cols: number) => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const appTheme = useUIStore((s) => s.theme)
  // The latest callbacks, without resubscribing when the parent re-renders.
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame
  const onColumnsRef = useRef(onColumns)
  onColumnsRef.current = onColumns
  // Something to clear before the first run's output: the idle hint.
  const hintShown = useRef(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      disableStdin: true,
      convertEol: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      fontSize: TERMINAL_FONT_SIZE,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      scrollback: 10_000,
      theme: terminalTheme()
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    if (itemId === null && idleHint) {
      terminal.write(dimLine(idleHint))
      hintShown.current = true
    }
    const refit = (): void => {
      try { fit.fit() } catch { /* not laid out yet */ }
      if (typeof terminal.cols === 'number' && terminal.cols > 0) onColumnsRef.current(terminal.cols)
    }
    refit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit)
    observer?.observe(host)
    return () => {
      observer?.disconnect()
      terminalRef.current = null
      terminal.dispose()
    }
    // Once per mount: the hint is for the terminal's first sight only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One subscription per run shown. The first run of a window writes into the
  // terminal (clearing the idle hint); a later one clears it and marks where it begins.
  const firstShown = useRef(true)
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || itemId === null) return
    if (!firstShown.current || hintShown.current) {
      terminal.reset()
      if (!firstShown.current && runNumber > 1) terminal.write(runSeparator(runNumber))
    }
    firstShown.current = false
    hintShown.current = false
    const unsubscribe = window.api.userCommands.output(chatId, itemId, (frame) => {
      if (frame.type === 'start') {
        if (frame.backlog) terminal.write(frame.backlog)
      } else if (frame.type === 'chunk') {
        terminal.write(frame.data)
      }
      onFrameRef.current(itemId, frame)
    })
    return unsubscribe
    // runNumber follows itemId: a new run is always a new number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, itemId])

  // The variables follow `data-theme`, which the store sets before it changes.
  const themeSeen = useRef(appTheme)
  useEffect(() => {
    if (themeSeen.current === appTheme) return
    themeSeen.current = appTheme
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme()
  }, [appTheme])

  return <div ref={hostRef} data-testid="command-output-terminal" className="h-full min-h-0 w-full px-3 py-2" />
}
