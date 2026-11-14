/**
 * `make vault-live`: Agent Vault end to end on a real VM with ONE billed
 * Claude Haiku turn (README "Testing", live lane). Opt-in, never in `npm test`.
 *
 * - test-flavor VaultHelper.app (approvals granted without a prompt), the real
 *   guest image (build/vault-guest), the real pinned linux-arm64 Claude Code
 *   and this checkout's patched adapter;
 * - a sandboxed HOME and userData (temp dirs; only the pinned Claude download
 *   is reused from build/vault-guest/smoke/ so it is not fetched every run);
 * - the API key is the repo `.env` `ANTHROPIC_API_KEY`, handed into the vault
 *   with `secrets.put` by Move to vault… and never printed.
 *
 * Steps: move a kit fixture with a uv dependency (pyproject + uv.lock, `six`)
 * in; delete the host copy; one Haiku turn through the real ACP driver and
 * VaultAcpConnection that runs one Bash command inside (a secret's length and
 * the locked dependency's version; its permission ask is answered "once" by
 * this test) and answers a fixed phrase; then from the host: no message text
 * in SQLite, the transcript readable after lock → unlock, and `curl` from the
 * vault's own shell to a host off the allowlist fails while an allowlisted one
 * answers.
 *
 *   make vault-helper          # FLAVOR=test
 *   make vault-image
 *   make vault-live
 */
import { execFileSync } from 'node:child_process'
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
const AGENT = 'folder:7a11ce00-0000-4000-8000-0000000117e0'
const PHRASE = 'VAULT-LIVE-PINEAPPLE-42'
/** A value only the vault holds; the turn reports its length, never the value. */
const SECRET_VALUE = 'vault-secret-1234567'

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
      id: agentId, manifestId: agentId.slice('folder:'.length), name: 'Vault Live', path: env.folder, kind: 'kit', rootId: 'root-1',
      runtime: { engine: 'claude' }, credentials: [], manifest: {}
    })
  }
}))

const t0 = Date.now()
const stamp = (): string => `${String(Date.now() - t0).padStart(7)} ms`
const say = (...parts: unknown[]): void => console.log(stamp(), ...parts)
const timings: Record<string, number> = {}

function readEnvKey(): string {
  const text = readFileSync(join(ROOT, '.env'), 'utf8')
  const line = text.split('\n').find((l) => /^\s*ANTHROPIC_API_KEY\s*=/.test(l))
  const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') ?? ''
  if (!value) throw new Error('No ANTHROPIC_API_KEY in the repo .env')
  return value
}

let apiKey = ''
let sandbox = ''

beforeAll(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple silicon only')
  if (!existsSync(HELPER)) throw new Error(`no helper at ${HELPER}: make vault-helper`)
  if (!existsSync(ROOTFS)) throw new Error(`no guest image at ${ROOTFS}: make vault-image`)
  apiKey = readEnvKey()
  sandbox = mkdtempSync(join(tmpdir(), 'cinna-vault-live-'))
  const home = join(sandbox, 'home')
  const userData = join(sandbox, 'userData')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(userData, 'vault'), { recursive: true })
  // Nothing below may read the real home.
  process.env['HOME'] = home
  // The pinned Claude download, reused (its digest was checked when it was published there).
  if (existsSync(RUNTIME_CACHE)) symlinkSync(RUNTIME_CACHE, join(userData, 'vault', 'runtime'))
  const { installRuntimeHost } = await import('../../src/main/host/runtimeHost')
  const require = createRequire(join(ROOT, 'package.json'))
  installRuntimeHost({
    getPath: (name: string) => (name === 'userData' ? userData : home),
    getVersion: () => '0.0.0-vault-live',
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
  env.folder = join(env.root, 'Local', 'vault-live')
  mkdirSync(join(env.folder, 'credentials'), { recursive: true })
  writeFileSync(join(env.folder, 'agent.md'), '# Vault Live\nA test agent.\n')
  // Delete original checks the folder is still this agent's by its manifest id.
  writeFileSync(join(env.folder, 'cinna-agent.json'), JSON.stringify({ id: AGENT.slice('folder:'.length), name: 'Vault Live' }, null, 2) + '\n')
  writeFileSync(join(env.folder, 'pyproject.toml'), '[project]\nname = "vault-live"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = ["six==1.17.0"]\n')
  writeFileSync(join(env.folder, '.python-version'), '3.12\n')
  // The lock is made on this machine; inside, `uv sync --locked` installs exactly it.
  execFileSync('uv', ['lock', '--quiet'], { cwd: env.folder, env: { ...process.env, HOME: home, UV_CACHE_DIR: join(sandbox, 'uv-cache') } })
  rmSync(join(env.folder, '.venv'), { recursive: true, force: true })
}, 10 * 60_000)

afterAll(async () => {
  const { vaultService } = await import('../../src/main/vault/vaultService')
  await vaultService.shutdown().catch(() => {})
  holder.current?.close()
  if (process.env['VAULT_LIVE_KEEP'] !== '1') rmSync(sandbox, { recursive: true, force: true })
})

/** One shell inside the vault (gated: a `terminal` token for `exec:shell`), fed `script`, its output returned. */
async function vaultShell(vaultId: string, script: string): Promise<string> {
  const { vaultBackend } = await import('../../src/main/vault/backend')
  const { vaultService } = await import('../../src/main/vault/vaultService')
  const { approvalDetail } = await import('../../src/shared/vault/protocol')
  const token = await vaultBackend().approve(vaultId, 'terminal', approvalDetail({ method: 'exec', preset: 'shell' }))
  const client = await vaultService.client(vaultId)
  const { stream } = await client.request('exec', { preset: 'shell', token })
  const channel = await client.attach(stream)
  const writer = channel.writable.getWriter()
  await writer.write(new TextEncoder().encode(`${script}\nexit\n`))
  writer.releaseLock()
  const reader = channel.readable.getReader()
  const decoder = new TextDecoder()
  let out = ''
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  channel.close('done')
  return out
}

describe('Agent Vault live (one billed Haiku turn)', () => {
  it('moves a kit agent with a uv dependency in, answers one turn inside, and keeps everything off the host', async () => {
    const { agentRepo } = await import('../../src/main/db/agents')
    const { chatRepo } = await import('../../src/main/db/chats')
    const { messageRepo } = await import('../../src/main/db/messages')
    const { installEventPublisher } = await import('../../src/main/host/events')
    const { installVaultBackend } = await import('../../src/main/vault/backend')
    const { createAppleVzBackend } = await import('../../src/main/host/desktop/vault/appleVzBackend')
    const { vaultService } = await import('../../src/main/vault/vaultService')
    const { moveService, installVaultMoveDeps } = await import('../../src/main/vault/moveService')
    const { createAcpDriver } = await import('../../src/main/agents/drivers/acp/acpDriver')
    const { createAcpProcessPool } = await import('../../src/main/agents/drivers/acp/acpProcessPool')
    const { startAcpConnection } = await import('../../src/main/agents/drivers/acp/acpConnection')
    const { vaultAcpRuntime, vaultDriverDeps } = await import('../../src/main/agents/drivers/acp/vaultRuntime')
    const { pendingRequests } = await import('../../src/main/agents/drivers/pendingRequests')
    const { a2aStreamingService } = await import('../../src/main/services/a2aStreamingService')

    agentRepo.replaceFolderIndex(USER, 'root-1', [{
      id: AGENT, name: 'Vault Live', description: null, localPath: env.folder, remoteMetadata: {} as never, launcher: 'claude'
    }])
    const stepStart = new Map<string, number>()
    const events: VaultMoveProgressEvent[] = []
    installEventPublisher((channel, payload) => {
      if (channel !== 'vault:move-progress') return
      const event = payload as VaultMoveProgressEvent
      events.push(event)
      // Progress never carries the key; checked below as well.
      if (event.output) {
        for (const line of event.output.split('\n').filter(Boolean)) say(`  [${event.step}]`, line.slice(0, 160))
        return
      }
      if (event.status === 'running') stepStart.set(event.step, Date.now())
      else if (stepStart.has(event.step) && !(`move.${event.step}` in timings)) timings[`move.${event.step}`] = Date.now() - stepStart.get(event.step)!
      say(event.step, event.status, event.message ?? '')
    })
    const backend = createAppleVzBackend({ helperPath: HELPER, isPackaged: false })
    installVaultBackend(backend)
    vaultService.init()
    installVaultMoveDeps({
      // The kit agent's sealed prompt, as the host would have assembled it.
      instructions: () => 'You are Vault Live, a test agent. Follow the user\'s instructions exactly and keep answers short.',
      launchFacts: () => ({ model: 'haiku', approval: 'ask' }),
      hostClaudeOnSubscription: async () => true,
      defaultEngine: () => 'claude'
    })
    expect((await backend.hello()).flavor).toBe('test')

    // ---- Move to vault…
    let at = Date.now()
    const { moveId } = await moveService.moveIn(USER, AGENT, { apiKey })
    await moveService.waitForMove(moveId)
    timings['move.total'] = Date.now() - at
    const final = events.filter((e) => e.moveId === moveId && !e.output).at(-1)!
    expect(final, JSON.stringify(events.filter((e) => !e.output))).toMatchObject({ status: 'done' })
    expect(JSON.stringify(events)).not.toContain(apiKey)
    const row = agentRepo.getOwned(USER, AGENT)!
    const vaultId = (row.driverConfig!['vault'] as { vaultId: string }).vaultId
    timings['boot.cold'] = timings['move.unlock'] ?? -1

    // A secret only the vault holds, for the turn to read.
    await vaultService.setSecret(USER, AGENT, 'VAULT_LIVE_SECRET', SECRET_VALUE)

    // ---- The host copy goes.
    await moveService.deleteHostCopy(USER, AGENT, 'Vault Live')
    expect(existsSync(env.folder)).toBe(false)

    // ---- One Haiku turn through the driver.
    const chatId = chatRepo.create(USER, {}).id
    vaultService.bindChat(USER, USER, chatId, AGENT)
    const pool = createAcpProcessPool({ start: startAcpConnection })
    const driver = createAcpDriver({
      pool, launcher: () => undefined, vault: vaultDriverDeps(),
      readRuntime: (_userId, agent) => vaultAcpRuntime(agent),
      withLock: (_id, _owner, fn) => fn(),
      registerRequest: (input) => pendingRequests.register(input),
      resolveRequest: (id, resolution) => pendingRequests.resolve(id, resolution) !== null
    })
    expect(await driver.readiness(USER, row)).toEqual({ state: 'ok', reason: null })
    const command = 'printf %s "$VAULT_LIVE_SECRET" | wc -c; .venv/bin/python -c "import six; print(six.__version__)"'
    const prompt = `Run exactly this one command with the Bash tool, once: ${command}\nThen reply with one line: ${PHRASE} <the two output values, space separated>. Nothing else.`
    const userMessageId = messageRepo.saveUser({ chatId, content: prompt })
    const posted: RunEvent[] = []
    let asks = 0
    let turnResult: Awaited<ReturnType<typeof driver.run>> | null = null
    at = Date.now()
    await a2aStreamingService.streamToAgent({
      chatId, agentId: AGENT,
      port: { postMessage: (event) => void posted.push(event), close: () => {} },
      marker: { profileId: USER, userMessageId, driver: 'acp' },
      run: async (io) => {
        turnResult = await driver.run(USER, row, {
          chatId, wireContent: prompt, signal: io.signal,
          onEvent: (event) => {
            io.onEvent(event)
            if (event.type === 'needs_input') {
              asks++
              const owner = pendingRequests.owner(event.requestId)!
              say('ask', JSON.stringify(event).slice(0, 200))
              driver.respond({ requestId: event.requestId, ...owner }, { kind: 'permission', reply: 'once' })
            }
          }
        })
        return turnResult
      }
    })
    timings['turn'] = Date.now() - at
    expect(posted.at(-1), JSON.stringify(posted.slice(-3)).slice(0, 2000)).toMatchObject({ type: 'done' })
    const reply = chatRepo.listMessages(chatId).filter((m) => m.role === 'assistant').map((m) => m.content).join('\n')
    say('reply', JSON.stringify(reply.slice(-300)))
    say('telemetry', JSON.stringify((turnResult as { telemetry?: unknown } | null)?.telemetry ?? null), 'asks', asks)
    expect(reply).toContain(PHRASE)
    // The secret's length (20) and the locked dependency (six 1.17.0), read inside.
    expect(reply).toMatch(new RegExp(`${PHRASE}\\s+${SECRET_VALUE.length}\\s+1\\.17\\.0`))
    expect(reply).not.toContain(SECRET_VALUE)
    await pool.shutdown()

    // ---- Nothing of it on the host.
    const sqlite = holder.current!.sqlite
    for (const table of ['messages', 'messages_search', 'inflight_turns']) {
      expect((sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0)
    }
    const dump = JSON.stringify(['chats', 'agents', 'a2a_sessions', 'tasks'].map((t) => sqlite.prepare(`SELECT * FROM ${t}`).all()))
    expect(dump).not.toContain(PHRASE)
    expect(dump).not.toContain(apiKey)

    // ---- Lock → unlock: the transcript comes back from the vault's journal.
    expect(await vaultTranscriptSaved(vaultId, chatId)).toBe('saved')
    await vaultService.lock(USER, AGENT)
    expect(chatRepo.listMessages(chatId)).toEqual([])
    at = Date.now()
    await vaultService.unlock(USER, AGENT)
    timings['unlock.resume'] = Date.now() - at
    expect(chatRepo.listMessages(chatId).map((m) => m.content).join('\n')).toContain(PHRASE)

    // ---- Egress: off the allowlist fails, on it answers.
    at = Date.now()
    const shell = await vaultShell(vaultId, [
      'curl -sS -m 15 -o /dev/null -w "DENIED_HTTP=%{http_code}\\n" https://example.com; echo "DENIED_EXIT=$?"',
      'curl -sS -m 15 -o /dev/null -w "ALLOWED_HTTP=%{http_code}\\n" https://api.anthropic.com/v1/models; echo "ALLOWED_EXIT=$?"'
    ].join('\n'))
    timings['egress'] = Date.now() - at
    say('shell', JSON.stringify(shell.replace(/\r/g, '').split('\n').filter((l) => /DENIED|ALLOWED|curl/.test(l))))
    expect(shell).toMatch(/DENIED_EXIT=[1-9]/)
    expect(shell).toMatch(/ALLOWED_HTTP=(401|200|404|405)/)

    say('timings', JSON.stringify(timings))

    // ---- Clean up: the test helper grants the destroy approval.
    const { approvalDetail } = await import('../../src/shared/vault/protocol')
    await backend.destroy(vaultId, await backend.approve(vaultId, 'destroy', approvalDetail({ method: 'vault.destroy' })))
  })
})

async function vaultTranscriptSaved(vaultId: string, chatId: string): Promise<string> {
  const { vaultTranscripts } = await import('../../src/main/vault/transcriptStore')
  return vaultTranscripts.settled(vaultId, chatId, 15_000)
}
