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
    const handle = window.api.vault.openTerminal(agentId, (event) => {
      if (event.type === 'open') {
        terminal.reset()
        setPhase('open')
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
    const input = terminal.onData((data) => handle.write(data))
    return () => {
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
      width="max-w-3xl"
    >
      <p className="text-[13px] text-[var(--color-text-muted)]">
        A shell inside the vault, as the agent, in its folder. Closing ends it.
      </p>
      <div
        ref={hostRef}
        data-vault-terminal
        className="h-[22rem] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2"
      />
      <DialogFooter error={error}>
        <button ref={closeRef} type="button" className={PRIMARY} onClick={close}>
          Close
        </button>
      </DialogFooter>
    </VaultDialog>
  )
}
