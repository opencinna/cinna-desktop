/**
 * A vault backend with no VM and no helper: each vault is cinna-vaultd run as
 * a plain Node process in fake mode, on a unix socket, over a directory beside
 * the vault (`<SecureAgents>/<vaultId>/fake-root`). Approvals are granted at
 * once, with real tokens (`approvalTokens.ts`), so vaultd's checks still run.
 *
 * For unit tests and E2E only: the composition root installs it when
 * `CINNA_VAULT_FAKE=1` in an unpackaged build. It protects nothing.
 *
 * It emulates the helper's state machine (D13): unlock opens a window that
 * closes `windowMs` after the last hold is released; a lock stops the vaultd
 * process (a cold stop, where the real helper would pause the VM).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, type Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import {
  VAULT_UNLOCK_WINDOW_MS,
  type EgressPolicy,
  type GatedAction,
  type HelperEvent,
  type VaultEngine,
  type VaultState,
  type VaultSummary
} from '../../shared/vault/protocol'
import { readApprovalToken, signApprovalToken } from './approvalTokens'
import { VaultBackendError, type VaultBackend, type VaultChannel, type VaultCreateSpec, type VaultHello } from './backend'

/** `vault.json` of a fake vault. Unsigned: the fake guards nothing. */
interface FakeVaultFile {
  vaultId: string
  agentId: string
  agentName: string
  engine: VaultEngine
  sizeBytes: number
  egress: EgressPolicy
  createdAt: number
  imageVersion: string
  flavor: 'fake'
}

interface FakeVault {
  dir: string
  file: FakeVaultFile
  state: VaultState
  until: number | null
  holds: Set<string>
  key: Buffer
  socket: string
  process: ChildProcess | null
  starting: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
  error: string | null
}

export interface FakeBackendOptions {
  /** `out/main/vaultd.js` (the bundled cinna-vaultd). */
  vaultdPath: string
  /** How to run Node: the host's child runtime (`runtimeHost.nodeRuntime()`). */
  nodeRuntime: () => { command: string; args: string[]; env: Record<string, string> }
  /** Unlock window; defaults to `CINNA_VAULT_FAKE_WINDOW_MS` or 60 s. */
  windowMs?: number
  /** How long to wait for vaultd's socket. */
  startTimeoutMs?: number
  now?: () => number
}

const FILE = 'vault.json'

function windowFromEnv(): number {
  const raw = Number(process.env['CINNA_VAULT_FAKE_WINDOW_MS'])
  return Number.isFinite(raw) && raw > 0 ? raw : VAULT_UNLOCK_WINDOW_MS
}

/** A unix socket path short enough for macOS (104 bytes), unique per vault and process. */
function socketPathFor(vaultId: string): string {
  const tag = createHash('sha256').update(`${process.pid}:${vaultId}`).digest('hex').slice(0, 12)
  return join(tmpdir(), `cinna-vault-${tag}.sock`)
}

function connectOnce(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.removeAllListeners('error')
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

function socketChannel(socket: Socket): VaultChannel {
  const web = Duplex.toWeb(socket) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
  return {
    readable: web.readable,
    writable: web.writable,
    close: () => socket.destroy()
  }
}

export function createFakeBackend(options: FakeBackendOptions): VaultBackend {
  const vaults = new Map<string, FakeVault>()
  const listeners = new Set<(event: HelperEvent) => void>()
  const windowMs = options.windowMs ?? windowFromEnv()
  const now = options.now ?? Date.now
  const startTimeoutMs = options.startTimeoutMs ?? 10_000

  const emit = (vault: FakeVault): void => {
    const event: HelperEvent = {
      event: 'vault.state', vaultId: vault.file.vaultId, state: vault.state,
      ...(vault.state === 'unlocked' ? { until: vault.until } : {}),
      ...(vault.error ? { error: vault.error } : {})
    }
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // a listener's failure is its own
      }
    }
  }

  const summary = (vault: FakeVault): VaultSummary => ({
    vaultId: vault.file.vaultId,
    agentId: vault.file.agentId,
    agentName: vault.file.agentName,
    state: vault.state,
    ...(vault.state === 'unlocked' ? { until: vault.until } : {}),
    sizeBytes: vault.file.sizeBytes,
    egress: vault.file.egress,
    engine: vault.file.engine,
    createdAt: vault.file.createdAt,
    imageVersion: vault.file.imageVersion
  })

  const adopt = (dir: string, file: FakeVaultFile): FakeVault => {
    const known = vaults.get(file.vaultId)
    if (known) {
      known.dir = dir
      known.file = file
      return known
    }
    const vault: FakeVault = {
      dir, file, state: 'locked', until: null, holds: new Set(), key: randomBytes(32),
      socket: socketPathFor(file.vaultId), process: null, starting: null, timer: null, error: null
    }
    vaults.set(file.vaultId, vault)
    return vault
  }

  const need = (vaultId: string): FakeVault => {
    const vault = vaults.get(vaultId)
    if (!vault) throw new VaultBackendError('not_found', 'No such vault.')
    return vault
  }

  const writeFile_ = (vault: FakeVault): Promise<void> =>
    writeFile(join(vault.dir, vault.file.vaultId, FILE), JSON.stringify(vault.file, null, 2))

  const stopProcess = (vault: FakeVault): void => {
    const child = vault.process
    vault.process = null
    vault.starting = null
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }

  const clearTimer = (vault: FakeVault): void => {
    if (vault.timer) clearTimeout(vault.timer)
    vault.timer = null
  }

  const lockNow = (vault: FakeVault): void => {
    clearTimer(vault)
    vault.holds.clear()
    stopProcess(vault)
    vault.until = null
    if (vault.state !== 'locked') {
      vault.state = 'locked'
      emit(vault)
    }
  }

  /** (Re)arm the window: open while held, else closes `windowMs` from now. */
  const arm = (vault: FakeVault): void => {
    clearTimer(vault)
    if (vault.state !== 'unlocked') return
    if (vault.holds.size > 0) {
      vault.until = null
      return
    }
    vault.until = now() + windowMs
    vault.timer = setTimeout(() => lockNow(vault), windowMs)
    vault.timer.unref?.()
  }

  const start = (vault: FakeVault): Promise<void> => {
    if (vault.process && vault.process.exitCode === null) return vault.starting ?? Promise.resolve()
    if (!existsSync(options.vaultdPath)) {
      return Promise.reject(new VaultBackendError('unavailable', `cinna-vaultd is not built (${options.vaultdPath}).`))
    }
    const root = join(vault.dir, vault.file.vaultId, 'fake-root')
    const runtime = options.nodeRuntime()
    vault.starting = (async () => {
      await mkdir(root, { recursive: true })
      await rm(vault.socket, { force: true })
      const child = spawn(runtime.command, [
        ...runtime.args, options.vaultdPath, '--fake', '--root', root, '--listen', vault.socket,
        '--approval-key', vault.key.toString('hex'), '--vault-id', vault.file.vaultId
      ], { env: { ...process.env, ...runtime.env }, stdio: ['ignore', 'ignore', 'pipe'] })
      vault.process = child
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
      child.once('exit', () => {
        if (vault.process !== child) return
        vault.process = null
        vault.starting = null
        if (vault.state === 'unlocked' || vault.state === 'booting') {
          clearTimer(vault)
          vault.state = 'error'
          vault.error = 'cinna-vaultd exited.'
          emit(vault)
        }
      })
      const deadline = now() + startTimeoutMs
      for (;;) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new VaultBackendError('internal', `cinna-vaultd exited while starting.${stderr ? ` ${stderr.trim().split('\n').at(-1)}` : ''}`)
        }
        try {
          const probe = await connectOnce(vault.socket)
          probe.destroy()
          return
        } catch {
          if (now() > deadline) {
            child.kill('SIGKILL')
            throw new VaultBackendError('timeout', 'cinna-vaultd did not start in time.')
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
    })()
    return vault.starting
  }

  const verify = (vault: FakeVault, token: string, action: GatedAction): void => {
    const claims = readApprovalToken(vault.key, token, now())
    if (!claims || claims.vaultId !== vault.file.vaultId || claims.action !== action) {
      throw new VaultBackendError('bad_token', 'The approval is not valid for this change.')
    }
  }

  const hello: VaultHello = { flavor: 'fake', helperVersion: 'fake', guest: { version: 'fake', rootHash: '' } }

  return {
    kind: 'fake',
    capabilities: () => ({ separateKernel: false, hardwareKey: false, perActionPresence: false }),
    hello: async () => hello,
    availability: async () => existsSync(options.vaultdPath)
      ? { ok: true }
      : { ok: false, reason: 'helper-missing', detail: 'cinna-vaultd is not built; run `npx electron-vite build`.' },

    async list(dir) {
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return []
      }
      const out: VaultSummary[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        try {
          const file = JSON.parse(await readFile(join(dir, entry.name, FILE), 'utf8')) as FakeVaultFile
          if (file.vaultId !== entry.name) continue
          out.push(summary(adopt(dir, file)))
        } catch {
          // not a vault
        }
      }
      return out
    },

    async create(spec: VaultCreateSpec) {
      if (vaults.has(spec.vaultId) || existsSync(join(spec.dir, spec.vaultId))) {
        throw new VaultBackendError('invalid', 'That vault already exists.')
      }
      await mkdir(join(spec.dir, spec.vaultId), { recursive: true })
      const file: FakeVaultFile = {
        vaultId: spec.vaultId, agentId: spec.agentId, agentName: spec.agentName, engine: spec.engine,
        sizeBytes: spec.sizeBytes, egress: spec.egress, createdAt: now(), imageVersion: 'fake', flavor: 'fake'
      }
      const vault = adopt(spec.dir, file)
      await writeFile_(vault)
      return summary(vault)
    },

    status: async (vaultId) => summary(need(vaultId)),

    async unlock(vaultId) {
      const vault = need(vaultId)
      if (vault.state === 'unlocked') {
        arm(vault)
        emit(vault)
        return vault.state
      }
      vault.error = null
      vault.state = 'booting'
      emit(vault)
      try {
        await start(vault)
      } catch (error) {
        vault.state = 'error'
        vault.error = error instanceof Error ? error.message : String(error)
        emit(vault)
        throw error
      }
      vault.state = 'unlocked'
      arm(vault)
      emit(vault)
      return vault.state
    },

    async lock(vaultId) {
      const vault = need(vaultId)
      lockNow(vault)
      return vault.state
    },

    async hold(vaultId, holdId) {
      const vault = need(vaultId)
      if (vault.state !== 'unlocked') throw new VaultBackendError('locked', 'The vault is locked.')
      vault.holds.add(holdId)
      arm(vault)
      emit(vault)
    },

    async release(vaultId, holdId) {
      const vault = need(vaultId)
      if (!vault.holds.delete(holdId)) return
      arm(vault)
      emit(vault)
    },

    async approve(vaultId, action, detail) {
      const vault = need(vaultId)
      const token = signApprovalToken(vault.key, { vaultId, action, detail, now: now() })
      // A gated action restarts the window (D13), like a released hold.
      if (vault.state === 'unlocked' && vault.holds.size === 0) {
        arm(vault)
        emit(vault)
      }
      return token
    },

    async setEgress(vaultId, policy, token) {
      const vault = need(vaultId)
      verify(vault, token, 'egress')
      vault.file = { ...vault.file, egress: { hosts: [...policy.hosts] } }
      await writeFile_(vault)
    },

    async resize(vaultId, sizeBytes, token) {
      const vault = need(vaultId)
      verify(vault, token, 'resize')
      vault.file = { ...vault.file, sizeBytes }
      await writeFile_(vault)
    },

    async destroy(vaultId, token) {
      const vault = need(vaultId)
      verify(vault, token, 'destroy')
      lockNow(vault)
      vaults.delete(vaultId)
      await rm(join(vault.dir, vaultId), { recursive: true, force: true })
      await rm(vault.socket, { force: true })
    },

    async open(vaultId) {
      const vault = need(vaultId)
      if (vault.state !== 'unlocked') throw new VaultBackendError('locked', 'The vault is locked.')
      await (vault.starting ?? Promise.resolve())
      return socketChannel(await connectOnce(vault.socket))
    },

    // vaultd in fake mode runs over `<vault>/fake-root`, so its agent folder is on this disk.
    guestAgentPath: (vaultId) => join(need(vaultId).dir, vaultId, 'fake-root', 'agent'),

    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async shutdown() {
      for (const vault of vaults.values()) {
        clearTimer(vault)
        stopProcess(vault)
        void rm(vault.socket, { force: true }).catch(() => {})
      }
    }
  }
}
