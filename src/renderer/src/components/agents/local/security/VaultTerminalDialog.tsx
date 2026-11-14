import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { VaultTerminalEvent } from '../../../../../../shared/vault/types'
import { TERMINAL_FONT_SIZE, dimLine, terminalTheme } from '../../../chat/CommandTerminal'
import { DialogFooter, PRIMARY } from '../sharing/ShareDialogs'
import { VaultDialog } from './VaultDialog'

/** "Cancelled at the prompt — nothing changed." for a declined approval, else main's sentence. */
function terminalErrorText(event: Extract<VaultTerminalEvent, { type: 'error' }>): string {
  return event.code === 'denied' ? 'Cancelled at the prompt — nothing was opened.' : event.message
}

/**
 * **Open terminal**: a shell inside the vault, as the agent, in its folder.
 * The same xterm look as the Run Script window's terminal, with input on.
 * The helper asks first (its own prompt); until then the terminal says it is
 * waiting. While the shell runs, Escape and an outside click go to the shell
 * and not to the dialog: only Close ends it.
 */
export function VaultTerminalDialog({
  agentId,
  agentName,
  onClose
}: {
  agentId: string
  agentName: string
  onClose: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [phase, setPhase] = useState<'approval' | 'open' | 'ended'>('approval')
  const [error, setError] = useState<string | null>(null)
  const handleRef = useRef<ReturnType<typeof window.api.vault.openTerminal> | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: TERMINAL_FONT_SIZE,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      scrollback: 5_000,
      theme: terminalTheme()
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    try { fit.fit() } catch { /* not laid out yet */ }
    terminal.write(dimLine('Waiting for approval…'))
    // The shell's pty follows the terminal: refit, and tell the other side when the grid changed.
    let sent = { cols: 0, rows: 0 }
    const sync = (): void => {
      try { fit.fit() } catch { /* not laid out yet */ }
      if (terminal.cols === sent.cols && terminal.rows === sent.rows) return
      sent = { cols: terminal.cols, rows: terminal.rows }
      handle.resize(terminal.cols, terminal.rows)
    }
    const handle = window.api.vault.openTerminal(agentId, (event) => {
      if (event.type === 'open') {
        terminal.reset()
        setPhase('open')
        sync()
        terminal.focus()
      } else if (event.type === 'data') {
        terminal.write(event.data)
      } else if (event.type === 'exit') {
        terminal.write(`\r\n${dimLine(event.code === null ? 'The terminal closed.' : `The shell exited (${event.code}).`)}`)
        setPhase('ended')
        closeRef.current?.focus()
      } else {
        setError(terminalErrorText(event))
        setPhase('ended')
        closeRef.current?.focus()
      }
    })
    handleRef.current = handle
    // Sent before the approval too: the shell starts at this size.
    sync()
    let frame = 0
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        sync()
      })
    })
    observer?.observe(host)
    const input = terminal.onData((data) => handle.write(data))
    return () => {
      observer?.disconnect()
      if (frame) cancelAnimationFrame(frame)
      input.dispose()
      handle.close()
      handleRef.current = null
      terminal.dispose()
    }
  }, [agentId])

  const close = (): void => {
    handleRef.current?.close()
    onClose()
  }

  return (
    <VaultDialog
      title={`Terminal — ${agentName}`}
      // While the shell runs, Escape belongs to it.
      pending={phase === 'open'}
      onDismiss={close}
      initialFocusRef={closeRef}
      width="max-w-5xl"
    >
      <p className="text-[13px] text-[var(--color-text-muted)]">
        A shell inside the vault, as the agent, in its folder. Closing ends it.
      </p>
      {/* Drag the corner to make it taller (never past the dialog's own height, so Close stays in view); the shell follows. */}
      <div
        ref={hostRef}
        data-vault-terminal
        className="h-[22rem] min-h-[12rem] max-h-[min(70vh,calc(84vh_-_11rem))] resize-y overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2"
      />
      <DialogFooter error={error}>
        <button ref={closeRef} type="button" className={PRIMARY} onClick={close}>
          Close
        </button>
      </DialogFooter>
    </VaultDialog>
  )
}
