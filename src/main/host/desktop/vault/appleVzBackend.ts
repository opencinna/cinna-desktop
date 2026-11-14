/**
 * The Apple Virtualization backend: VaultHelper.app as a child of Cinna,
 * spoken to over its stdio in frames (D25). Nothing listens on a socket; only
 * this process holds the pipes. Closing the helper's stdin stops every VM
 * (D33), which is what quitting Cinna does.
 *
 * A packaged Cinna accepts only a `release` helper (D31): a dev or test
 * helper skips the parent check and gates, so it is refused here and the
 * availability says `helper-untrusted`.
 *
 * The helper is restarted once after an unexpected exit; a second exit leaves
 * the backend in an error state until the app restarts.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { HELPER_PROTOCOL, VAULT_LOCK_TIMEOUTS, type HelperEvent, type VaultAvailability, type VaultState } from '../../../../shared/vault/protocol'
import { VaultBackendError, type VaultBackend, type VaultHello } from '../../../vault/backend'
import { HelperSession, type HelperDuplex } from '../../../vault/frames'
import { createLogger } from '../../../logger/logger'

const logger = createLogger('vault-helper')

/** A presence prompt waits on a person; give it ten minutes, not the control default. */
const PROMPT_TIMEOUT_MS = 10 * 60_000
const MAX_RESTARTS = 1

export interface AppleVzBackendOptions {
  helperPath: string
  /** A packaged app refuses every flavor but `release`. */
  isPackaged: boolean
  /** Test seam: how the helper is started. */
  spawnHelper?: (path: string) => ChildProcess
}

function stdioDuplex(child: ChildProcess): HelperDuplex {
  const stdin = child.stdin!
  const stdout = child.stdout!
  return {
    write: (bytes) => new Promise<void>((resolve, reject) => {
      if (stdin.destroyed || !stdin.writable) {
        reject(new VaultBackendError('unavailable', 'The vault helper is not running.'))
        return
      }
      const flushed = stdin.write(bytes, (error) => { if (error) reject(error) })
      if (flushed) resolve()
      else stdin.once('drain', () => resolve())
    }),
    onData: (listener) => { stdout.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) },
    onClose: (listener) => {
      child.once('exit', (code, signal) => listener(new VaultBackendError('unavailable', `The vault helper exited (${signal ?? code}).`)))
      child.once('error', (error) => listener(error))
    },
    pause: () => stdout.pause(),
    resume: () => stdout.resume()
  }
}

export function createAppleVzBackend(options: AppleVzBackendOptions): VaultBackend {
  const listeners = new Set<(event: HelperEvent) => void>()
  /** Last state per vault, so a helper crash can report `error` for each. */
  const states = new Map<string, VaultState>()
  let current: Promise<{ session: HelperSession; hello: VaultHello; child: ChildProcess }> | null = null
  let restarts = 0
  let broken: VaultBackendError | null = null
  let untrusted: string | null = null
  let stopping = false

  const emit = (event: HelperEvent): void => {
    if (event.event === 'vault.state') states.set(event.vaultId, event.state)
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // a listener's failure is its own
      }
    }
  }

  const start = (): Promise<{ session: HelperSession; hello: VaultHello; child: ChildProcess }> => {
    if (broken) return Promise.reject(broken)
    if (untrusted) return Promise.reject(new VaultBackendError('unavailable', untrusted))
    if (current) return current
    if (!existsSync(options.helperPath)) return Promise.reject(new VaultBackendError('unavailable', 'The vault helper is not installed.'))
    const attempt = (async () => {
      const child = (options.spawnHelper ?? ((path) => spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] })))(options.helperPath)
      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) logger.debug('helper stderr', { line: line.slice(0, 500) })
      })
      const session = new HelperSession(stdioDuplex(child))
      session.onEvent(emit)
      session.onClose((error) => {
        if (current !== attempt) return
        current = null
        if (stopping) return
        logger.warn('vault helper exited', { error: error.message })
        if (restarts >= MAX_RESTARTS) broken = new VaultBackendError('unavailable', 'The vault helper keeps exiting. Restart Cinna to try again.')
        else restarts++
        // Every VM went with it: say so for each vault we knew.
        for (const [vaultId, state] of states) {
          if (state === 'locked' || state === 'stopped') continue
          emit({ event: 'vault.state', vaultId, state: 'error', error: 'The vault helper exited.' })
        }
      })
      try {
        const answer = await session.request('hello', { protocol: HELPER_PROTOCOL })
        if (answer.protocol !== HELPER_PROTOCOL) throw new VaultBackendError('unavailable', `The vault helper speaks protocol ${answer.protocol}; this Cinna needs ${HELPER_PROTOCOL}.`)
        if (options.isPackaged && answer.flavor !== 'release') {
          untrusted = `This Cinna accepts only a release vault helper; this one is a ${answer.flavor} build.`
          throw new VaultBackendError('unavailable', untrusted)
        }
        return { session, hello: { flavor: answer.flavor, helperVersion: answer.helperVersion, guest: answer.guest }, child }
      } catch (error) {
        stopping = true
        session.close('hello failed')
        child.stdin?.end()
        child.kill('SIGTERM')
        stopping = false
        throw error
      }
    })()
    current = attempt
    attempt.catch(() => { if (current === attempt) current = null })
    return attempt
  }

  const session = async (): Promise<HelperSession> => (await start()).session

  return {
    kind: 'apple-vz',
    capabilities: () => ({ separateKernel: true, hardwareKey: true, perActionPresence: true, lockTimeouts: VAULT_LOCK_TIMEOUTS, idleTouch: true }),
    hello: async () => (await start()).hello,

    async availability(): Promise<VaultAvailability> {
      if (!existsSync(options.helperPath)) return { ok: false, reason: 'helper-missing' }
      try {
        return await (await session()).request('availability', {})
      } catch (error) {
        if (untrusted) return { ok: false, reason: 'helper-untrusted', detail: untrusted }
        return { ok: false, reason: 'helper-missing', detail: error instanceof Error ? error.message : String(error) }
      }
    },

    list: async (dir) => (await (await session()).request('vault.list', { dir })).vaults,
    create: async (spec) => (await (await session()).request('vault.create', spec)).vault,
    status: async (vaultId) => (await session()).request('vault.status', { vaultId }),
    unlock: async (vaultId, purpose) => (await (await session()).request('vault.unlock', { vaultId, purpose }, { timeoutMs: PROMPT_TIMEOUT_MS })).state,
    lock: async (vaultId) => (await (await session()).request('vault.lock', { vaultId })).state,
    hold: async (vaultId, holdId) => { await (await session()).request('vault.hold', { vaultId, holdId }) },
    release: async (vaultId, holdId) => { await (await session()).request('vault.release', { vaultId, holdId }) },
    approve: async (vaultId, action, detail) =>
      (await (await session()).request('vault.approve', { vaultId, action, detail }, { timeoutMs: PROMPT_TIMEOUT_MS })).token,
    setEgress: async (vaultId, policy, token) => { await (await session()).request('vault.setEgress', { vaultId, policy, token }) },
    setLockTimeout: async (vaultId, lockAfterMs, token) => {
      await (await session()).request('vault.setLockTimeout', { vaultId, lockAfterMs, ...(token ? { token } : {}) })
    },
    touch: async (vaultId) => { await (await session()).request('vault.touch', { vaultId }) },
    resize: async (vaultId, sizeBytes, token) => { await (await session()).request('vault.resize', { vaultId, sizeBytes, token }) },
    destroy: async (vaultId, token) => { await (await session()).request('vault.destroy', { vaultId, token }, { timeoutMs: PROMPT_TIMEOUT_MS }) },
    open: async (vaultId) => (await session()).openChannel(vaultId),

    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async shutdown() {
      const running = current
      if (!running) return
      stopping = true
      try {
        const { session: s, child } = await running
        // stdin EOF is the helper's "stop every VM and exit" (D33).
        child.stdin?.end()
        s.close('Cinna is quitting.')
      } catch {
        // never started
      } finally {
        current = null
      }
    }
  }
}
