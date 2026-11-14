/**
 * `make vault-switch-live`: a vault agent's change of engine on a real VM,
 * with THREE short billed turns (README "Testing", live lane). Opt-in, never
 * in `npm test`.
 *
 * - test-flavor VaultHelper.app (approvals granted without a prompt; this lane
 *   counts them by kind), the real guest image (build/vault-guest), the real
 *   pinned linux-arm64 runtimes (the download cache in build/vault-guest/smoke/
 *   is reused, so nothing is fetched twice);
 * - a sandboxed HOME and userData (temp dirs);
 * - keys from the repo `.env`: `OPENAI_API_KEY` (OpenCode on `openai`) and
 *   `GEMINI_API_KEY` (Antigravity), handed in by the switch and never printed.
 *   No Anthropic key: the agent moves in on Claude without one (the move's
 *   check tolerates auth_required) and never runs a Claude turn.
 *
 * Steps: move a kit agent in on Claude → switch to OpenCode (openai,
 * gpt-5.6-luna or CINNA_E2E_LIVE_MODEL; set up: install + egress approvals),
 * one turn → switch to Antigravity (set up), pin a Gemini Flash model in
 * `cinna.launch` (the app offers no model choice for Antigravity in a vault;
 * the switch leaves the CLI's default), one turn → switch back to OpenCode
 * with no key: no install or egress approval, one turn on the stored key →
 * the allowlist holds all three engines' hosts, nothing of any turn in this
 * computer's SQLite → destroy.
 *
 *   make vault-helper          # FLAVOR=test
 *   make vault-image
 *   make vault-switch-live
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../src/main/db/testSupport/nodeSqlite'
import type { VaultMoveProgressEvent } from '../../src/shared/vault/types'
import type { RunEvent } from '../../src/shared/runEvents'

const ROOT = resolve(__dirname, '../..')
const HELPER = join(ROOT, 'resources/vault/VaultHelper.app/Contents/MacOS/VaultHelper')
const ROOTFS = join(ROOT, 'build/vault-guest/rootfs.img')
const RUNTIME_CACHE = join(ROOT, 'build/vault-guest/smoke/userData/vault/runtime')
const USER = '__default__'
const AGENT = 'folder:7a11ce00-0000-4000-8000-0000000115e1'
/** The cheap OpenCode model of the live lanes (overridable as in the E2E live specs). */
const OPENCODE_MODEL = process.env['CINNA_E2E_LIVE_MODEL'] || 'gpt-5.6-luna'
/** Gemini Flash at its lowest tier, as the Antigravity live specs run it (`ANTIGRAVITY_COMPLEXITY_MODELS.simple`). */
const ANTIGRAVITY_MODEL = 'gemini-3.8-flash-low'
/**
 * VAULT_SWITCH_SKIP_ANTIGRAVITY_TURN=1 checks Antigravity's readiness instead
 * of sending its turn: the Gemini free tier allows 20 Flash requests a day per
 * project, and on a 429 the pinned server retries without a word, so the turn
 * would only hang until the timeout below.
 */
const SKIP_ANTIGRAVITY_TURN = process.env['VAULT_SWITCH_SKIP_ANTIGRAVITY_TURN'] === '1'
/** A turn that has not ended by then fails (and is cancelled) instead of hanging the lane. */
const TURN_TIMEOUT_MS = 180_000

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const env = vi.hoisted(() => ({ root: '', folder: '' }))

vi.mock('../../src/main/db/client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))
vi.mock('../../src/main/logger/logger', () => ({
  createLogger: (scope: string) => ({
    debug: () => {},
    info: (message: string, data?: unknown) => console.log(`[${scope}] ${message}`, data ? JSON.stringify(data) : ''),
    warn: (message: string, data?: unknown) => console.log(`[${scope}] WARN ${message}`, data ? JSON.stringify(data) : ''),
    error: (message: string, data?: unknown) => console.log(`[${scope}] ERROR ${message}`, data ? JSON.stringify(data) : '')
  }),
  setLogValueRedactor: () => {}
}))
vi.mock('../../src/main/services/jobService', () => ({ jobService: { reportRunCompletion: () => {} } }))
vi.mock('../../src/main/services/localAgents/agentsHomeService', () => ({
  agentsHomeService: { rootRows: () => [{ id: 'root-1', path: env.root, isDefault: true }] }
}))
vi.mock('../../src/main/services/localAgents/scannerService', () => ({ markRootDirty: () => {}, scannerService: { markRootDirty: () => {} } }))
vi.mock('../../src/main/services/localAgents/localAgentService', () => ({
  localAgentService: {
    get: (_userId: string, agentId: string) => ({
      id: agentId, manifestId: agentId.slice('folder:'.length), name: 'Vault Switch', path: env.folder, kind: 'kit', rootId: 'root-1',
      runtime: { engine: 'claude' }, credentials: [], manifest: {}
    })
  }
}))

const t0 = Date.now()
const stamp = (): string => `${String(Date.now() - t0).padStart(7)} ms`
const say = (...parts: unknown[]): void => console.log(stamp(), ...parts)
const timings: Record<string, number> = {}

function readEnvKey(name: string): string {
  const text = readFileSync(join(ROOT, '.env'), 'utf8')
  const line = text.split('\n').find((l) => new RegExp(`^\\s*${name}\\s*=`).test(l))
  const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') ?? ''
  if (!value) throw new Error(`No ${name} in the repo .env`)
  return value
}

let openaiKey = ''
let geminiKey = ''
let sandbox = ''

beforeAll(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple silicon only')
  if (!existsSync(HELPER)) throw new Error(`no helper at ${HELPER}: make vault-helper`)
  if (!existsSync(ROOTFS)) throw new Error(`no guest image at ${ROOTFS}: make vault-image`)
  openaiKey = readEnvKey('OPENAI_API_KEY')
  geminiKey = readEnvKey('GEMINI_API_KEY')
  sandbox = mkdtempSync(join(tmpdir(), 'cinna-vault-switch-live-'))
  const home = join(sandbox, 'home')
  const userData = join(sandbox, 'userData')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(userData, 'vault'), { recursive: true })
  // Nothing below may read the real home.
  process.env['HOME'] = home
  // The pinned downloads, reused (each digest is checked again before an install).
  if (existsSync(RUNTIME_CACHE)) symlinkSync(RUNTIME_CACHE, join(userData, 'vault', 'runtime'))
  const { installRuntimeHost } = await import('../../src/main/host/runtimeHost')
  const require = createRequire(join(ROOT, 'package.json'))
  installRuntimeHost({
    getPath: (name: string) => (name === 'userData' ? userData : home),
    getVersion: () => '0.0.0-vault-switch-live',
    getAppPath: () => ROOT,
    isPackaged: false,
    resourcesPath: join(ROOT, 'resources'),
    resolvePackageFile: (specifier: string) => require.resolve(specifier),
    http: { fetch: (input: string, init?: RequestInit) => fetch(input, init) },
    nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }),
    onShutdown: () => {}
  } as never)

  holder.current = createTestDatabase()
  env.root = join(sandbox, 'agents')
  env.folder = join(env.root, 'Local', 'vault-switch')
  mkdirSync(env.folder, { recursive: true })
  writeFileSync(join(env.folder, 'agent.md'), '# Vault Switch\nA test agent.\n')
  writeFileSync(join(env.folder, 'cinna-agent.json'), JSON.stringify({ id: AGENT.slice('folder:'.length), name: 'Vault Switch' }, null, 2) + '\n')
}, 10 * 60_000)

afterAll(async () => {
  const { vaultService } = await import('../../src/main/vault/vaultService')
  await vaultService.shutdown().catch(() => {})
  holder.current?.close()
  if (process.env['VAULT_LIVE_KEEP'] !== '1') rmSync(sandbox, { recursive: true, force: true })
})

describe('Agent Vault engine switch live (three short billed turns)', () => {
  it('moves in on Claude, switches to OpenCode and Antigravity (each set up on first choice) and back, one turn on each', async () => {
    const { agentRepo } = await import('../../src/main/db/agents')
    const { chatRepo } = await import('../../src/main/db/chats')
    const { messageRepo } = await import('../../src/main/db/messages')
    const { installEventPublisher } = await import('../../src/main/host/events')
    const { installVaultBackend } = await import('../../src/main/vault/backend')
    const { createAppleVzBackend } = await import('../../src/main/host/desktop/vault/appleVzBackend')
    const { vaultService } = await import('../../src/main/vault/vaultService')
    const { vaultAgentState } = await import('../../src/main/vault/vaultAgentState')
    const { moveService, installVaultMoveDeps } = await import('../../src/main/vault/moveService')
    const { createAcpDriver } = await import('../../src/main/agents/drivers/acp/acpDriver')
    const { createAcpProcessPool } = await import('../../src/main/agents/drivers/acp/acpProcessPool')
    const { startAcpConnection } = await import('../../src/main/agents/drivers/acp/acpConnection')
    const { vaultAcpRuntime, vaultDriverDeps } = await import('../../src/main/agents/drivers/acp/vaultRuntime')
    const { pendingRequests } = await import('../../src/main/agents/drivers/pendingRequests')
    const { a2aStreamingService } = await import('../../src/main/services/a2aStreamingService')
    const { approvalDetail, VAULT_ENGINE_HOSTS } = await import('../../src/shared/vault/protocol')

    agentRepo.replaceFolderIndex(USER, 'root-1', [{
      id: AGENT, name: 'Vault Switch', description: null, localPath: env.folder, remoteMetadata: {} as never, launcher: 'claude'
    }])
    const stepStart = new Map<string, number>()
    const events: VaultMoveProgressEvent[] = []
    installEventPublisher((channel, payload) => {
      if (channel !== 'vault:move-progress') return
      const event = payload as VaultMoveProgressEvent
      events.push(event)
      if (event.output) {
        for (const line of event.output.split('\n').filter(Boolean)) say(`  [${event.step}]`, line.slice(0, 160))
        return
      }
      if (event.status === 'running') stepStart.set(`${event.moveId}.${event.step}`, Date.now())
      else if (stepStart.has(`${event.moveId}.${event.step}`)) timings[`${event.moveId.slice(0, 4)}.${event.step}`] = Date.now() - stepStart.get(`${event.moveId}.${event.step}`)!
      say(event.step, event.status, event.message ?? '')
    })
    const backend = createAppleVzBackend({ helperPath: HELPER, isPackaged: false })
    // Every approval the helper grants, by kind: a switch to a set-up engine must ask none.
    const approvals: string[] = []
    const approve = backend.approve.bind(backend)
    backend.approve = ((vaultId: string, kind: string, detail: string) => {
      approvals.push(kind)
      return approve(vaultId, kind as never, detail)
    }) as typeof backend.approve
    installVaultBackend(backend)
    vaultService.init()
    // One pool for the whole run, retired by a switch as the app's is.
    const pool = createAcpProcessPool({ start: startAcpConnection })
    installVaultMoveDeps({
      instructions: () => 'You are Vault Switch, a test agent. Follow the user\'s instructions exactly and keep answers short.',
      launchFacts: () => ({ model: null, approval: 'ask' }),
      hostClaudeOnSubscription: async () => true,
      defaultEngine: () => 'claude',
      hasBackgroundWork: () => false,
      stopAgentProcesses: (agentId) => pool.retire(agentId)
    })
    expect((await backend.hello()).flavor).toBe('test')
    const driver = createAcpDriver({
      pool, launcher: () => undefined, vault: vaultDriverDeps(),
      readRuntime: (_userId, agent) => vaultAcpRuntime(agent),
      withLock: (_id, _owner, fn) => fn(),
      registerRequest: (input) => pendingRequests.register(input),
      resolveRequest: (id, resolution) => pendingRequests.resolve(id, resolution) !== null
    })

    const finalOf = (moveId: string): VaultMoveProgressEvent | undefined => events.filter((e) => e.moveId === moveId && !e.output).at(-1)
    const stepsOf = (moveId: string): Record<string, string> =>
      Object.fromEntries(events.filter((e) => e.moveId === moveId && !e.output && e.status !== 'running').map((e) => [e.step, e.status]))
    const noKeys = (): void => {
      const text = JSON.stringify(events)
      expect(text.includes(openaiKey), 'OpenAI key in progress').toBe(false)
      expect(text.includes(geminiKey), 'Gemini key in progress').toBe(false)
    }

    /** One switch through moveService, timed; returns its steps' outcomes and the approvals it asked for. */
    const switchTo = async (label: string, options: Record<string, unknown>): Promise<{ steps: Record<string, string>; asked: string[] }> => {
      const before = approvals.length
      const at = Date.now()
      const { moveId } = await moveService.switchEngine(USER, AGENT, options)
      await moveService.waitForMove(moveId)
      timings[`switch.${label}`] = Date.now() - at
      expect(finalOf(moveId), JSON.stringify(events.filter((e) => e.moveId === moveId && !e.output))).toMatchObject({ status: 'done' })
      noKeys()
      const out = { steps: stepsOf(moveId), asked: approvals.slice(before) }
      say(`switch ${label}`, JSON.stringify(out))
      return out
    }

    /** One short turn in a new vault chat (a chat's session belongs to the engine it ran on). */
    const turn = async (label: string, phrase: string): Promise<string> => {
      const row = agentRepo.getOwned(USER, AGENT)!
      expect(await driver.readiness(USER, row), `${label} readiness`).toEqual({ state: 'ok', reason: null })
      const chatId = chatRepo.create(USER, {}).id
      vaultService.bindChat(USER, USER, chatId, AGENT)
      const prompt = `Reply with exactly: ${phrase}`
      const userMessageId = messageRepo.saveUser({ chatId, content: prompt })
      const posted: RunEvent[] = []
      let turnResult: Awaited<ReturnType<typeof driver.run>> | null = null
      const at = Date.now()
      await a2aStreamingService.streamToAgent({
        chatId, agentId: AGENT,
        port: { postMessage: (event) => void posted.push(event), close: () => {} },
        marker: { profileId: USER, userMessageId, driver: 'acp' },
        run: async (io) => {
          turnResult = await driver.run(USER, row, {
            chatId, wireContent: prompt, signal: AbortSignal.any([io.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]),
            onEvent: (event) => {
              io.onEvent(event)
              if (event.type === 'needs_input') {
                // No tool is asked for; refuse whatever is.
                say('ask', JSON.stringify(event).slice(0, 200))
                const owner = pendingRequests.owner(event.requestId)!
                driver.respond({ requestId: event.requestId, ...owner }, { kind: 'permission', reply: 'reject' })
              }
            }
          })
          return turnResult
        }
      })
      timings[`turn.${label}`] = Date.now() - at
      const reply = chatRepo.listMessages(chatId).filter((m) => m.role === 'assistant').map((m) => m.content).join('\n')
      say(`reply ${label}`, JSON.stringify(reply.slice(-300)))
      say(`telemetry ${label}`, JSON.stringify((turnResult as { telemetry?: unknown } | null)?.telemetry ?? null))
      expect(posted.at(-1), JSON.stringify(posted.slice(-3)).slice(0, 2000)).toMatchObject({ type: 'done' })
      expect(reply).toContain(phrase)
      return reply
    }

    // ---- 1. Move to vault… on Claude, no key.
    let at = Date.now()
    const { moveId } = await moveService.moveIn(USER, AGENT, {})
    await moveService.waitForMove(moveId)
    timings['move.total'] = Date.now() - at
    expect(finalOf(moveId), JSON.stringify(events.filter((e) => !e.output))).toMatchObject({ status: 'done' })
    const vaultId = (agentRepo.getOwned(USER, AGENT)!.driverConfig!['vault'] as { vaultId: string }).vaultId
    const client = async (): Promise<Awaited<ReturnType<typeof vaultService.client>>> => vaultService.client(vaultId)
    const engineOfRow = (): unknown => (agentRepo.getOwned(USER, AGENT)!.driverConfig!['vault'] as { engine: string }).engine
    expect(engineOfRow()).toBe('claude')
    say('approvals after move', JSON.stringify(approvals))
    try {
      // ---- 2. → OpenCode (set up on first choice), one turn.
      const toOpencode = await switchTo('opencode', { engine: 'opencode', provider: 'openai', model: OPENCODE_MODEL, apiKey: openaiKey })
      expect(toOpencode.steps).toMatchObject({ runtime: 'done', egress: 'done', credentials: 'done', engine: 'done' })
      expect(toOpencode.asked).toEqual(expect.arrayContaining(['install', 'egress']))
      expect(engineOfRow()).toBe('opencode')
      await turn('opencode', 'vault opencode ok')

      // ---- 3. → Antigravity (set up), on Gemini Flash, one turn.
      const toAntigravity = await switchTo('antigravity', { engine: 'antigravity', apiKey: geminiKey })
      expect(toAntigravity.steps).toMatchObject({ runtime: 'done', egress: 'done', credentials: 'done', engine: 'done' })
      expect(toAntigravity.asked).toEqual(expect.arrayContaining(['install', 'egress']))
      expect(engineOfRow()).toBe('antigravity')
      // The switch leaves the CLI's default model, and the app offers no other for Antigravity in a vault.
      const launch = await vaultAgentState.launch(await client())
      expect(launch.model).toBeNull()
      await vaultAgentState.writeLaunch(await client(), { ...launch, model: ANTIGRAVITY_MODEL })
      if (SKIP_ANTIGRAVITY_TURN) {
        expect(await driver.readiness(USER, agentRepo.getOwned(USER, AGENT)!), 'antigravity readiness').toEqual({ state: 'ok', reason: null })
        say('antigravity turn skipped (VAULT_SWITCH_SKIP_ANTIGRAVITY_TURN=1); readiness ok')
      } else {
        await turn('antigravity', 'vault antigravity ok')
      }

      // ---- 4. Back to OpenCode, no key: nothing to set up or allow, the stored key signs in.
      const back = await switchTo('opencode-again', { engine: 'opencode', provider: 'openai', model: OPENCODE_MODEL })
      expect(back.steps).toMatchObject({ runtime: 'skipped', egress: 'skipped', credentials: 'skipped', engine: 'done' })
      expect(back.asked).toEqual([])
      expect(engineOfRow()).toBe('opencode')
      await turn('opencode-again', 'vault opencode again')
      await pool.shutdown()

      // ---- 5. Every engine's hosts allowed; nothing of any turn on this computer.
      const hosts = (await backend.status(vaultId)).egress?.hosts ?? []
      say('egress hosts', JSON.stringify(hosts))
      for (const host of [...VAULT_ENGINE_HOSTS.claude, ...VAULT_ENGINE_HOSTS.opencode, ...VAULT_ENGINE_HOSTS.antigravity]) expect(hosts, host).toContain(host)
      const sqlite = holder.current!.sqlite
      for (const table of ['messages', 'messages_search', 'inflight_turns']) {
        expect((sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0)
      }
      const dump = JSON.stringify(['chats', 'agents', 'a2a_sessions', 'tasks'].map((t) => sqlite.prepare(`SELECT * FROM ${t}`).all()))
      for (const phrase of ['vault opencode ok', 'vault antigravity ok', 'vault opencode again']) expect(dump).not.toContain(phrase)
      expect(dump.includes(openaiKey)).toBe(false)
      expect(dump.includes(geminiKey)).toBe(false)
      say('approvals', JSON.stringify(approvals))
      say('timings', JSON.stringify(timings))
    } finally {
      // ---- 6. Clean up, pass or fail: the test helper grants the destroy approval.
      await pool.shutdown().catch(() => {})
      await backend.destroy(vaultId, await backend.approve(vaultId, 'destroy', approvalDetail({ method: 'vault.destroy' })))
    }
  })
})
