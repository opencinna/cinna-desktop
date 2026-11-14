/**
 * **Open terminal** on a vault agent (phase 2): a shell inside the vault, as
 * the agent user, in the agent's folder (vaultd's `shell` exec preset: bash
 * under script(1), so it has a pty).
 *
 * Gated: every terminal is one presence prompt (`terminal`, a single-use token
 * bound to `exec:shell`), asked by the helper in its own words. The vault is
 * held for as long as the terminal is open, so the unlock window does not
 * close under someone typing. Bytes go both ways untouched; the session ends
 * when the shell exits or the window closes it (closing the stream kills the
 * shell's process group in the guest). Nothing typed or printed is logged.
 *
 * Hub core: the desktop's window and its MessagePort are the IPC adapter's.
 */
import { approvalDetail } from '../../shared/vault/protocol'
import type { VaultTerminalEvent } from '../../shared/vault/types'
import { createLogger } from '../logger/logger'
import { vaultBackend } from './backend'
import { VaultError, vaultService } from './vaultService'

const logger = createLogger('vault-terminal')

export interface VaultTerminalSession {
  /** Keystrokes (or pasted text) for the shell; ignored once ended. */
  write(data: Uint8Array | string): void
  /** End the session: the shell is killed, the hold released. Idempotent. */
  close(): void
}

/**
 * Open a terminal and stream it to `emit`: `open` once the shell is attached,
 * `data` as it prints, then exactly one `exit` or `error`. Never throws: a
 * refusal (locked, a declined prompt) is an `error` event and an inert session.
 */
export function openVaultTerminal(userId: string, agentId: string, emit: (event: VaultTerminalEvent) => void): VaultTerminalSession {
  let ended = false
  let closeRequested = false
  let release: (() => Promise<void>) | null = null
  let channel: { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array>; close(reason?: string): void } | null = null
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  let stopExit: (() => void) | null = null
  const encoder = new TextEncoder()

  const finish = (event: VaultTerminalEvent): void => {
    if (ended) return
    ended = true
    stopExit?.()
    try { writer?.releaseLock() } catch { /* already released */ }
    channel?.close('terminal closed')
    void release?.()
    emit(event)
  }

  void (async () => {
    try {
      const { ref } = vaultService.refFor(userId, agentId)
      if (vaultService.stateOf(ref.vaultId) !== 'unlocked') throw new VaultError('locked', 'Unlock the vault to open a terminal.')
      release = await vaultService.hold(userId, agentId)
      if (closeRequested) return finish({ type: 'exit', code: null })
      const token = await vaultBackend().approve(ref.vaultId, 'terminal', approvalDetail({ method: 'exec', preset: 'shell' }))
      if (closeRequested) return finish({ type: 'exit', code: null })
      const client = await vaultService.client(ref.vaultId)
      let stream: string | null = null
      let exitCode: number | null | undefined
      stopExit = client.onNotification((notification) => {
        if (notification.method !== 'exec.exit' || notification.params.stream !== stream) return
        exitCode = notification.params.code
      })
      stream = (await client.request('exec', { preset: 'shell', token })).stream
      channel = await client.attach(stream)
      if (closeRequested) return finish({ type: 'exit', code: null })
      writer = channel.writable.getWriter()
      emit({ type: 'open' })
      logger.info('a vault terminal opened', { agentId })
      const reader = channel.readable.getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && !ended) emit({ type: 'data', data: value })
        }
      } catch {
        // the stream broke: the exit says why, or the close did it
      } finally {
        reader.releaseLock()
      }
      // vaultd sends `exec.exit` as the shell ends; give it a moment to arrive.
      for (let i = 0; i < 20 && exitCode === undefined && !ended; i++) await new Promise((resolve) => setTimeout(resolve, 25))
      logger.info('a vault terminal closed', { agentId })
      finish({ type: 'exit', code: exitCode ?? null })
    } catch (error) {
      // The vault's own codes and words (a declined prompt is `denied`), as every vault call answers.
      const result = await vaultService.result((): void => { throw error })
      finish(result.ok ? { type: 'exit', code: null } : { type: 'error', code: result.code, message: result.message })
    }
  })()

  return {
    write(data) {
      if (ended || !writer) return
      const bytes = typeof data === 'string' ? encoder.encode(data) : data
      if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) return
      writer.write(bytes).catch(() => {})
    },
    close() {
      closeRequested = true
      if (writer || channel) finish({ type: 'exit', code: null })
    }
  }
}
