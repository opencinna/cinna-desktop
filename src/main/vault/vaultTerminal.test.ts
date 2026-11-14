import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { VaultTerminalEvent } from '../../shared/vault/types'

/**
 * Open terminal: one `terminal` approval, a shell inside the vault (the real
 * cinna-vaultd in fake mode, run by the fake backend) with bytes both ways,
 * the vault held while it is open, and refusals as events, never throws.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const env = vi.hoisted(() => ({ root: '' }))
vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
const logged = vi.hoisted(() => [] as string[])
vi.mock('../logger/logger', () => {
  const record = (...args: unknown[]): void => { logged.push(JSON.stringify(args)) }
  return { createLogger: () => ({ debug: record, info: record, warn: record, error: record }), setLogValueRedactor: () => {} }
})
vi.mock('../services/localAgents/agentsHomeService', () => ({
  agentsHomeService: { rootRows: () => [{ id: 'root-1', path: env.root, isDefault: true }] }
}))

const { agentRepo } = await import('../db/agents')
const { installEventPublisher } = await import('../host/events')
const { installVaultBackend, unavailableBackend } = await import('./backend')
const { createFakeBackend } = await import('./fakeBackend')
const { vaultService } = await import('./vaultService')
const { vaultTranscripts } = await import('./transcriptStore')
const { resetVaultAgentsForTest } = await import('./isVaultAgent')
const { openVaultTerminal } = await import('./vaultTerminal')
const { openTerminalPort } = await import('../ipc/vault.ipc')
const { userActivation } = await import('../auth/activation')
const { buildVaultd } = await import('./testSupport/fakeRuntime')

const USER = '__default__'
const AGENT = 'folder:dddddddd-0000-0000-0000-000000000004'
const VAULT = 'vault-term'

let work = ''
let vaultdPath = ''
let backend: ReturnType<typeof createFakeBackend>

function collect(): { events: VaultTerminalEvent[]; text: () => string; until: (match: (e: VaultTerminalEvent[]) => boolean, ms?: number) => Promise<void>; emit: (e: VaultTerminalEvent) => void } {
  const events: VaultTerminalEvent[] = []
  const decoder = new TextDecoder()
  return {
    events,
    emit: (event) => { events.push(event) },
    text: () => events.map((e) => (e.type === 'data' ? decoder.decode(e.data) : '')).join(''),
    until: async (match, ms = 15_000) => {
      const end = Date.now() + ms
      while (!match(events)) {
        if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(events.map((e) => (e.type === "data" ? new TextDecoder().decode(e.data) : e)))}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
  }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'cinna-term-'))
  vaultdPath = await buildVaultd(work)
}, 60_000)

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

beforeEach(async () => {
  holder.current = createTestDatabase()
  env.root = mkdtempSync(join(tmpdir(), 'cinna-term-root-'))
  logged.length = 0
  installEventPublisher(() => {})
  agentRepo.replaceFolderIndex(USER, 'root-1', [{ id: AGENT, name: 'Ledger', description: null, localPath: join(env.root, 'Local', 'ledger'), remoteMetadata: {} as never, launcher: 'claude' }])
  agentRepo.markVault(USER, AGENT, { vaultId: VAULT, engine: 'claude' })
  resetVaultAgentsForTest()
  vaultTranscripts.resetForTest()
  vaultService.resetForTest()
  // macOS's BSD script(1), which the fake-mode `shell` preset runs, refuses a socket for stdin
  // (the guest's util-linux one does not): a stand-in that runs a plain sh on the stream.
  const bin = join(env.root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'script'), '#!/bin/sh\nexec /bin/sh\n', { mode: 0o755 })
  backend = createFakeBackend({ vaultdPath, nodeRuntime: () => ({ command: process.execPath, args: [], env: { PATH: `${bin}:/usr/bin:/bin` } }), windowMs: 60_000 })
  installVaultBackend(backend)
  vaultService.init()
  const dir = vaultService.ensureSecureAgentsDir(USER)
  await backend.create({ dir, vaultId: VAULT, agentId: AGENT, agentName: 'Ledger', engine: 'claude', sizeBytes: 10 * 1024 ** 3, egress: { hosts: [] }, rootfsPath: '' })
})

afterEach(async () => {
  await vaultService.shutdown()
  vaultService.resetForTest()
  vaultTranscripts.resetForTest()
  installVaultBackend(unavailableBackend('helper-missing'))
  resetVaultAgentsForTest()
  vi.restoreAllMocks()
  holder.current?.close()
  holder.current = null
  rmSync(env.root, { recursive: true, force: true })
})

/** Unlock, and lay the vault out as a move would (the shell runs in its agent folder). */
async function unlock(): Promise<void> {
  await vaultService.unlock(USER, AGENT)
  await (await vaultService.client(VAULT)).request('layout.ensure', {})
}

describe('Open terminal', () => {
  it('asks once for a terminal approval, runs a shell inside the vault both ways, and holds the vault while open', async () => {
    await unlock()
    const approve = vi.spyOn(backend, 'approve')
    const hold = vi.spyOn(backend, 'hold')
    const release = vi.spyOn(backend, 'release')
    const out = collect()
    const session = openVaultTerminal(USER, AGENT, out.emit)
    await out.until((events) => events.some((e) => e.type === 'open'))
    expect(approve.mock.calls).toEqual([[VAULT, 'terminal', 'exec:shell']])
    expect(hold).toHaveBeenCalledTimes(1)
    session.write('echo "sum=$((20+22))"; pwd\n')
    await out.until(() => out.text().includes('sum=42'))
    expect(out.text()).toContain(join(env.root, 'SecureAgents', VAULT))
    session.write('exit 3\n')
    await out.until((events) => events.at(-1)?.type === 'exit')
    expect(out.events.at(-1)).toEqual({ type: 'exit', code: 3 })
    expect(release).toHaveBeenCalledTimes(1)
    // Nothing typed or printed reaches a log line.
    expect(logged.join('\n')).not.toContain('sum=')
  }, 30_000)

  it('ends the shell when the window closes it', async () => {
    await unlock()
    const release = vi.spyOn(backend, 'release')
    const out = collect()
    const session = openVaultTerminal(USER, AGENT, out.emit)
    await out.until((events) => events.some((e) => e.type === 'open'))
    session.close()
    expect(out.events.at(-1)).toEqual({ type: 'exit', code: null })
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    // Inert afterwards.
    session.write('echo after\n')
    expect(out.events.filter((e) => e.type === 'exit')).toHaveLength(1)
  }, 30_000)

  it('refuses a locked vault and a declined prompt as events, asking nothing while locked', async () => {
    const approve = vi.spyOn(backend, 'approve')
    const locked = collect()
    openVaultTerminal(USER, AGENT, locked.emit)
    await locked.until((events) => events.length > 0)
    expect(locked.events).toEqual([{ type: 'error', code: 'locked', message: 'Unlock the vault to open a terminal.' }])
    expect(approve).not.toHaveBeenCalled()

    await unlock()
    const { VaultBackendError } = await import('./backend')
    approve.mockRejectedValueOnce(new VaultBackendError('denied', 'Cancelled.'))
    const release = vi.spyOn(backend, 'release')
    const declined = collect()
    openVaultTerminal(USER, AGENT, declined.emit)
    await declined.until((events) => events.length > 0)
    expect(declined.events).toEqual([{ type: 'error', code: 'denied', message: 'Cancelled.' }])
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
  }, 30_000)

  it('the IPC adapter streams over a port and ends the session when the port closes', async () => {
    vi.spyOn(userActivation, 'isActivated').mockReturnValue(true)
    await unlock()
    const posted: VaultTerminalEvent[] = []
    const handlers: Record<string, (arg?: unknown) => void> = {}
    let closed = false
    openTerminalPort({
      start: () => {},
      postMessage: (event: unknown) => { posted.push(event as VaultTerminalEvent) },
      close: () => { closed = true },
      on: ((name: string, fn: (arg?: unknown) => void) => { handlers[name] = fn }) as never
    }, AGENT)
    await vi.waitFor(() => expect(posted.some((e) => e.type === 'open')).toBe(true), { timeout: 15_000 })
    handlers['message']!({ data: { type: 'input', data: 'echo via-port-$((1+1))\n' } })
    await vi.waitFor(() => expect(posted.map((e) => (e.type === 'data' ? new TextDecoder().decode(e.data) : '')).join('')).toContain('via-port-2'), { timeout: 15_000 })
    handlers['close']!()
    expect(closed).toBe(false)
    // Port gone: the session ended, nothing more is posted.
    const count = posted.length
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(posted.length).toBe(count)
  }, 30_000)
})
