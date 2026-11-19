/**
 * `make vault-send-now-live`: a queued message's **Send now** in a vault
 * agent's chat on a real VM, on every engine a vault runs — Claude, OpenCode,
 * Antigravity and Codex — with about TWO short billed turns per engine (the
 * hold, stopped within seconds of its `sleep`, and the drained answer).
 * Opt-in, never in `npm test`.
 *
 * ## What it proves
 *
 * The turns go the way `run:start` sends them: the real
 * `runQueueService.submit` → the real `runExecutionService.start` (hub core
 * initialized as the desktop does, `initializeHubCore` + `userActivation`),
 * whose `driverFor` resolves the app's own `acpDriver`
 * (`agents/drivers/index.ts`: the app's process pool, launchers, turn lock and
 * vault runtime) — the lane builds no driver of its own. Send now is the real
 * `runQueueService.sendNow`, as `run:queue-send-now` calls it. Per engine, in
 * a new vault chat (`vaultService.bindChat`):
 * 1. a turn is asked to run a 90-second loop of `sleep 1` with its shell tool; the lane waits for
 *    its tool call (a `delta` of kind `tool`) or permission ask (the vault launches with approval *ask*;
 *    that first ask is never answered: it holds the turn as well as the sleep);
 * 2. a text-only follow-up with a random `HERON-xxxxxx` code word is submitted
 *    and must be **queued** (a tool call in flight withdraws steering); a steer
 *    would not exercise Send now, so `injected` fails the engine;
 * 3. `sendNow` on it: the first run ends `canceled` (not failed), no error row,
 *    the queue drains as a new run whose user row follows the first one, its
 *    asks are rejected (at most four, through `inboxService.answerFromTranscript`
 *    as the transcript's buttons answer), it ends `completed`, its reply holds
 *    the code word, and the queue ends empty and not held.
 * At the end: no code word and no key in this computer's SQLite, no key in any
 * move progress or run event. Each engine logs one `PASS`/`FAIL` line; one
 * failing does not skip the next, and the test fails at the end with all of
 * them. The vault is destroyed pass or fail.
 *
 * ## What it does not prove
 *
 * The renderer (the chip, its labels, edit blocking: `pending-messages.spec.ts`),
 * that the engine killed the `sleep` inside the VM, several queued messages
 * merged, a stopped turn that fails on its way out, nor a queued message with
 * files. The Inbox/window side of `run:start` (activation checks, the queue's
 * `run:queue-changed` channel) is not here: this is a Node harness, not the app.
 *
 * ## Cost and prerequisites
 *
 * ≈2 short turns per selected engine: Claude Haiku on the repo `.env`
 * `ANTHROPIC_API_KEY`; OpenCode (provider openai) and Codex on `OPENAI_API_KEY`,
 * model gpt-5.6-luna (or CINNA_E2E_LIVE_MODEL); Antigravity on `GEMINI_API_KEY`,
 * pinned to `gemini-3.8-flash-low`. Keys are read only for the selected engines,
 * handed in by the move or the switch, never printed (the log mock blanks them).
 * Needs a test-flavor helper and the guest image (the runtime download cache in
 * build/vault-guest/smoke/ is reused); HOME and userData are temp dirs.
 *
 *   make vault-helper          # FLAVOR=test
 *   make vault-image           # build/vault-guest
 *   make vault-send-now-live
 *
 * Env:
 * - `VAULT_SEND_NOW_ENGINES=claude,opencode,antigravity,codex` (the default,
 *   always run in that order): which engines get a scenario. The move in is
 *   always on Claude (keyless unless claude is selected); the lane switches
 *   only to the selected engines, so a rerun spends only the failing ones.
 * - `VAULT_SEND_NOW_DRY=1`: free wiring check — hub core and the vault backend
 *   initialize, the helper says `test`, the app's driver resolves; nothing moves.
 * - `VAULT_LIVE_KEEP=1` keeps the sandbox; `CINNA_VAULT_TEST_SCREEN_LOCKED=0`
 *   on a Mac whose screen is locked.
 *
 * ## Observed (2026-11-19, guest 1.0.0-20261118, test helper)
 *
 * - Codex (gpt-5.6-luna): passed first run — parked on its `sleep 90` ask,
 *   stopped in 77 ms, the follow-up answered 936 ms after Send now.
 * - Claude (haiku) and OpenCode (gpt-5.6-luna): passed on the second run, held
 *   on the tool (stopped in 35 / 38 ms, answered in 903 / 1134 ms). The first
 *   run failed on the lane, not the product: Claude Code blocks a bare
 *   foreground `sleep 90` and backgrounds it (the hold is now a loop of
 *   `sleep 1`), and an ACP tool call reaches the run as a `delta` of kind
 *   `tool`, which the busy check did not count.
 * - Antigravity (gemini-3.8-flash-low, Gemini API key): failed all three runs
 *   with no reply from the engine at all. In runs 2 and 3 the first turn was
 *   stopped (78 / 57 ms) and the follow-up reached the server as the next turn
 *   (run 3's transcript, step 1), but Gemini answered both requests 503 "The
 *   model is currently unreachable." (read in run 3), which
 *   the server writes into its transcript and never sends on the wire, so the
 *   drained turn hangs until the lane's 180 s limit. A failed Antigravity
 *   scenario prints that transcript's error lines.
 */
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { VaultMoveProgressEvent } from '../../src/shared/vault/types'
import type { RunEvent } from '../../src/shared/runEvents'
import type { RunHandle, RunOutcome, RunScope } from '../../src/main/services/runExecutionService'
import type { QueueStartOptions } from '../../src/main/services/runQueueService'

const ROOT = resolve(__dirname, '../..')
const HELPER = join(ROOT, 'resources/vault/VaultHelper.app/Contents/MacOS/VaultHelper')
const ROOTFS = join(ROOT, 'build/vault-guest/rootfs.img')
const RUNTIME_CACHE = join(ROOT, 'build/vault-guest/smoke/userData/vault/runtime')
const USER = '__default__'
const AGENT = 'folder:7a11ce00-0000-4000-8000-0000000115e2'
const ENGINES = ['claude', 'opencode', 'antigravity', 'codex'] as const
type Engine = (typeof ENGINES)[number]
/** The cheap OpenAI model of the live lanes (overridable as in the E2E live specs). */
const OPENAI_MODEL = process.env['CINNA_E2E_LIVE_MODEL'] || 'gpt-5.6-luna'
/** Gemini Flash at its lowest tier, as the Antigravity live specs run it. */
const ANTIGRAVITY_MODEL = 'gemini-3.8-flash-low'
const DRY = process.env['VAULT_SEND_NOW_DRY'] === '1'
/**
 * A first-turn event that shows the turn busy on its tool: an ACP agent's tool
 * call reaches the run as a `delta` of kind `tool` (the stream accumulator's
 * parts), not as the local-LLM `tool_use` event; or its permission ask.
 */
function busyOf(event: RunEvent): string | null {
  if (event.type === 'needs_input') return 'needs_input'
  if (event.type === 'tool_use') return 'tool_use'
  if (event.type === 'delta' && event.kind === 'tool') return `tool ${event.toolName ?? ''}`.trim()
  return null
}

/**
 * A loop of one-second sleeps in the foreground: Claude Code blocks a bare
 * foreground `sleep 90` and runs it in the background instead, which ends the
 * turn at once (the first Claude run, 2026-11-19).
 */
const HOLD = 'Use your shell tool to run this exact command in the foreground (not in the background) and wait for it to finish: `for i in $(seq 1 90); do sleep 1; done`. Only after it has finished, reply with the single word done.'
const followUpOf = (word: string): string => `Stop waiting for that command and do not run it again. Do not use any tools. Reply with only this code word: ${word}`
/**
 * How long the lane waits for the first turn's tool call or ask. A turn still
 * running without one by then is stopped anyway: Send now needs a running turn,
 * not a tool. (Antigravity reached no tool call in 90 s on the first run.) A
 * follow-up an engine steers instead of queueing still fails the engine.
 */
const BUSY_TIMEOUT_MS = 30_000
/** A turn that has not ended by then fails (and is cancelled) instead of hanging the lane. */
const TURN_TIMEOUT_MS = 180_000
/** Asks rejected in a drained turn before the lane stops answering. */
const MAX_REJECTS = 4

const env = vi.hoisted(() => ({ root: '', folder: '' }))
/** Key values the log mock blanks, whatever logs them. */
const secrets = vi.hoisted(() => ({ values: [] as string[] }))

vi.mock('../../src/main/logger/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/logger/logger')>()
  const scrub = (text: string): string => secrets.values.reduce((out, key) => (key ? out.split(key).join('<key>') : out), text)
  const print = (scope: string, level: string, message: string, data?: unknown): void =>
    console.log(scrub(`[${scope}] ${level}${message} ${data ? JSON.stringify(data) : ''}`))
  return {
    ...actual,
    createLogger: (scope: string) => ({
      debug: () => {},
      info: (message: string, data?: unknown) => print(scope, '', message, data),
      warn: (message: string, data?: unknown) => print(scope, 'WARN ', message, data),
      error: (message: string, data?: unknown) => print(scope, 'ERROR ', message, data)
    }),
    setLogValueRedactor: () => {}
  }
})
vi.mock('../../src/main/services/jobService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/jobService')>()
  return { ...actual, jobService: { ...actual.jobService, reportRunCompletion: () => {} } }
})
vi.mock('../../src/main/services/localAgents/agentsHomeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/localAgents/agentsHomeService')>()
  return { ...actual, agentsHomeService: { ...actual.agentsHomeService, rootRows: () => [{ id: 'root-1', path: env.root, isDefault: true }] } }
})
// No rescan of the agents root: the agent row is the lane's, as in the other vault lanes.
vi.mock('../../src/main/services/localAgents/scannerService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/localAgents/scannerService')>()
  return {
    ...actual,
    markRootDirty: () => {},
    markAllRootsDirty: () => {},
    installCredentialReadiness: () => {},
    scannerService: { ...actual.scannerService, markRootDirty: () => {} }
  }
})
vi.mock('../../src/main/services/localAgents/localAgentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/localAgents/localAgentService')>()
  return {
    ...actual,
    localAgentService: {
      ...actual.localAgentService,
      get: (_userId: string, agentId: string) => ({
        id: agentId, manifestId: agentId.slice('folder:'.length), name: 'Vault Send Now', path: env.folder, kind: 'kit', rootId: 'root-1',
        runtime: { engine: 'claude' }, credentials: [], manifest: {}
      })
    }
  }
})

const t0 = Date.now()
const stamp = (): string => `${String(Date.now() - t0).padStart(7)} ms`
const say = (...parts: unknown[]): void => console.log(stamp(), ...parts)
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function readEnvKey(name: string): string {
  const text = readFileSync(join(ROOT, '.env'), 'utf8')
  const line = text.split('\n').find((l) => new RegExp(`^\\s*${name}\\s*=`).test(l))
  const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') ?? ''
  if (!value) throw new Error(`No ${name} in the repo .env`)
  return value
}

function selectedEngines(): Engine[] {
  const raw = process.env['VAULT_SEND_NOW_ENGINES']
  if (!raw || !raw.trim()) return [...ENGINES]
  const names = raw.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
  const unknown = names.filter((name) => !(ENGINES as readonly string[]).includes(name))
  if (unknown.length) throw new Error(`VAULT_SEND_NOW_ENGINES: unknown ${unknown.join(', ')} (choose from ${ENGINES.join(',')})`)
  return ENGINES.filter((engine) => names.includes(engine))
}

/** Polls until `probe` answers something truthy, or null at the deadline. */
async function waitFor<T>(probe: () => T | null | undefined | false, ms: number, every = 100): Promise<T | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() >= deadline) return null
    await delay(every)
  }
}

/** A run's outcome, or null after `ms`. */
async function outcomeWithin(handle: RunHandle, ms: number): Promise<RunOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((done) => { timer = setTimeout(() => done(null), ms) })
  try { return await Promise.race([handle.completed, timeout]) } finally { clearTimeout(timer) }
}

const engines = selectedEngines()
/** One shell inside the vault (gated: a `terminal` token for `exec:shell`), fed `script`, its output returned (as vault-live.vault.ts). */
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
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  channel.close('done')
  return out
}

/**
 * A failed Antigravity scenario: the pinned server's own transcript inside the
 * vault says why a turn was silent (vault_llm.md: a `doRequest … i/o timeout`
 * line is the network). Its last lines and any error lines, keys blanked.
 */
const ANTIGRAVITY_TRANSCRIPT = [
  'f=$(ls -t "$HOME"/.gemini/antigravity-acp/brain/*/.system_generated/logs/transcript_full.jsonl 2>/dev/null | head -1)',
  'echo "transcript: ${f:-none}"',
  '[ -n "$f" ] && grep -iE "doRequest|timeout|error|429|quota|refused|denied|proxy" "$f" | tail -20 | cut -c1-400',
  '[ -n "$f" ] && echo "--- tail" && tail -5 "$f" | cut -c1-400'
].join('\n')

const keys: { anthropic: string; openai: string; gemini: string } = { anthropic: '', openai: '', gemini: '' }
let sandbox = ''
let hubUp = false

beforeAll(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple silicon only')
  if (!existsSync(HELPER)) throw new Error(`no helper at ${HELPER}: make vault-helper`)
  if (!existsSync(ROOTFS)) throw new Error(`no guest image at ${ROOTFS}: make vault-image`)
  if (!DRY) {
    if (engines.includes('claude')) keys.anthropic = readEnvKey('ANTHROPIC_API_KEY')
    if (engines.includes('opencode') || engines.includes('codex')) keys.openai = readEnvKey('OPENAI_API_KEY')
    if (engines.includes('antigravity')) keys.gemini = readEnvKey('GEMINI_API_KEY')
    secrets.values = [keys.anthropic, keys.openai, keys.gemini].filter(Boolean)
  }
  sandbox = mkdtempSync(join(tmpdir(), 'cinna-vault-send-now-live-'))
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
  const unavailable = (): never => { throw new Error('Desktop capability unavailable in the vault send-now lane') }
  installRuntimeHost({
    getPath: (name: string) => (name === 'userData' ? userData : home),
    getVersion: () => '0.0.0-vault-send-now-live',
    getAppPath: () => ROOT,
    isPackaged: false,
    resourcesPath: join(ROOT, 'resources'),
    resolvePackageFile: (specifier: string) => require.resolve(specifier),
    http: { fetch: (input: string, init?: RequestInit) => fetch(input, init) },
    // No host secret is stored: keys go into the vault. Refuse rather than invent a keystore.
    keystore: { prepare: async () => {}, isEncryptionAvailable: () => true, isSecureStorageAvailable: () => false, encryptString: async () => unavailable(), decryptString: async () => unavailable() },
    resolveProxy: async () => 'DIRECT',
    nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }),
    onShutdown: () => {},
    shell: { openExternal: unavailable, openPath: unavailable, showItemInFolder: unavailable, trashItem: unavailable }
  } as never)

  env.root = join(sandbox, 'agents')
  env.folder = join(env.root, 'Local', 'vault-send-now')
  mkdirSync(env.folder, { recursive: true })
  writeFileSync(join(env.folder, 'agent.md'), '# Vault Send Now\nA test agent.\n')
  writeFileSync(join(env.folder, 'cinna-agent.json'), JSON.stringify({ id: AGENT.slice('folder:'.length), name: 'Vault Send Now' }, null, 2) + '\n')
}, 10 * 60_000)

afterAll(async () => {
  if (hubUp) {
    const { shutdownHubCore, userActivation } = await import('../../src/main/hub/core')
    const { closeDatabase } = await import('../../src/main/db/client')
    await userActivation.deactivate().catch(() => {})
    // Stops the app's pool and every vault (the helper with them).
    await shutdownHubCore('The vault send-now lane finished.').catch(() => {})
    closeDatabase()
  }
  if (sandbox && process.env['VAULT_LIVE_KEEP'] !== '1') rmSync(sandbox, { recursive: true, force: true })
})

describe('Agent Vault Send now live (≈2 short billed turns per engine)', () => {
  it('stops a running vault turn with Send now and drains the queued message, on each selected engine', async () => {
    const { installEventPublisher } = await import('../../src/main/host/events')
    const { installVaultBackend } = await import('../../src/main/vault/backend')
    const { createAppleVzBackend } = await import('../../src/main/host/desktop/vault/appleVzBackend')
    const { adaptDatabase } = await import('../../src/main/db/testSupport/nodeSqlite')

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
      say(event.step, event.status, event.message ?? '')
    })
    // The composition root's order: the backend first, then hub core (whose vault service attaches to it).
    const backend = createAppleVzBackend({ helperPath: HELPER, isPackaged: false })
    const approvals: string[] = []
    const approve = backend.approve.bind(backend)
    backend.approve = ((vaultId: string, kind: string, detail: string) => {
      approvals.push(kind)
      return approve(vaultId, kind as never, detail)
    }) as typeof backend.approve
    installVaultBackend(backend)

    const { initializeHubCore, userActivation, inboxService } = await import('../../src/main/hub/core')
    initializeHubCore((path) => adaptDatabase(new DatabaseSync(path)))
    hubUp = true
    await userActivation.activate(USER)
    userActivation.requireActivated()

    const { getRawSqlite } = await import('../../src/main/db/client')
    const { agentRepo } = await import('../../src/main/db/agents')
    const { chatRepo } = await import('../../src/main/db/chats')
    const { vaultService } = await import('../../src/main/vault/vaultService')
    const { moveService, installVaultMoveDeps } = await import('../../src/main/vault/moveService')
    const { acpDriver, driverFor } = await import('../../src/main/agents/drivers')
    const { runQueueService } = await import('../../src/main/services/runQueueService')
    const { activeRunsByChat, onRunOpened } = await import('../../src/main/services/runExecutionState')
    const { approvalDetail } = await import('../../src/shared/vault/protocol')

    agentRepo.replaceFolderIndex(USER, 'root-1', [{
      id: AGENT, name: 'Vault Send Now', description: null, localPath: env.folder, remoteMetadata: {} as never, launcher: 'claude'
    }])
    // Over the app's (installed when drivers/index loaded): a fixed prompt, Haiku on Claude,
    // approval *ask* so every engine's tool call asks; the pool, runtime source and
    // background-work checks stay the app's.
    installVaultMoveDeps({
      instructions: () => 'You are Vault Send Now, a test agent. Follow the user\'s instructions exactly and keep answers short.',
      launchFacts: () => ({ model: 'haiku', approval: 'ask' }),
      hostClaudeOnSubscription: async () => true,
      defaultEngine: () => 'claude'
    })
    expect((await backend.hello()).flavor).toBe('test')
    // The run service's resolver gives the app's own ACP driver for this agent.
    expect(driverFor(agentRepo.getOwned(USER, AGENT)!)).toBe(acpDriver)
    const scope: RunScope = { profileUserId: USER, settingsUserId: USER }
    if (DRY) {
      say('DRY: hub core up, profile activated, helper flavor test, driverFor → acpDriver; nothing moved, nothing billed. Engines selected:', engines.join(','))
      return
    }

    const runEvents: RunEvent[] = []
    const noKeys = (): void => {
      const text = JSON.stringify(events) + JSON.stringify(runEvents)
      for (const [name, value] of Object.entries(keys)) if (value) expect(text.includes(value), `${name} key in progress or run events`).toBe(false)
    }
    const finalOf = (moveId: string): VaultMoveProgressEvent | undefined => events.filter((e) => e.moveId === moveId && !e.output).at(-1)
    const engineOfRow = (): unknown => (agentRepo.getOwned(USER, AGENT)!.driverConfig!['vault'] as { engine: string }).engine

    /** One switch through moveService; a switch refused as busy (the stopped turn's process winding down) is retried for up to 2 min. */
    const switchTo = async (engine: Engine, options: Record<string, unknown>): Promise<void> => {
      const before = approvals.length
      const deadline = Date.now() + 120_000
      let moveId = ''
      for (;;) {
        try {
          moveId = (await moveService.switchEngine(USER, AGENT, options)).moveId
          break
        } catch (error) {
          if ((error as { code?: string }).code !== 'busy' || Date.now() > deadline) throw error
          say(`switch ${engine}: busy, retrying`, error instanceof Error ? error.message : String(error))
          await delay(5_000)
        }
      }
      await moveService.waitForMove(moveId)
      const final = finalOf(moveId)
      if (final?.status !== 'done') throw new Error(`switch to ${engine} ended ${JSON.stringify(events.filter((e) => e.moveId === moveId && !e.output)).slice(0, 1500)}`)
      noKeys()
      if (engineOfRow() !== engine) throw new Error(`after the switch the row names ${String(engineOfRow())}`)
      say(`switch ${engine} done; approvals asked`, JSON.stringify(approvals.slice(before)))
    }

    const words: string[] = []

    /** The Send now scenario in a new vault chat; throws with the reason it failed. */
    const scenario = async (engine: Engine): Promise<void> => {
      const row = agentRepo.getOwned(USER, AGENT)!
      const driver = driverFor(row)
      if (driver !== acpDriver) throw new Error('driverFor did not resolve the app ACP driver')
      const ready = await driver.readiness(USER, row)
      // Null is "could not tell", which the composer does not refuse either.
      if (ready && ready.state !== 'ok') throw new Error(`readiness ${JSON.stringify(ready)}`)
      say(`[${engine}] readiness`, JSON.stringify(ready))
      const chatId = chatRepo.create(USER, { router: 'direct', agentId: AGENT }).id
      vaultService.bindChat(USER, USER, chatId, AGENT)
      const word = `HERON-${randomBytes(3).toString('hex')}`
      words.push(word)
      const followUp = followUpOf(word)
      const seen: { turnId: string | undefined; event: RunEvent }[] = []
      const ids = { first: '' }
      let rejects = 0
      const rejectAsk = (event: Extract<RunEvent, { type: 'needs_input' }>): void => {
        if (event.request.kind !== 'permission') {
          say(`[${engine}] a ${event.request.kind} ask in the drained turn; not a permission, left alone`)
          return
        }
        if (++rejects > MAX_REJECTS) {
          say(`[${engine}] more than ${MAX_REJECTS} asks in the drained turn; left alone`)
          return
        }
        // After the observer has recorded it, as a click on the transcript's button would come.
        setImmediate(() => {
          void Promise.resolve(inboxService.answerFromTranscript(USER, event.requestId, { kind: 'permission', reply: 'reject' }))
            .then((answer) => say(`[${engine}] rejected ask`, JSON.stringify(answer)))
            .catch((error: unknown) => say(`[${engine}] reject failed`, String(error)))
        })
      }
      // As `run:start` builds them, plus the lane's own record of every event.
      const options: QueueStartOptions = (sent) => ({
        preserveOnRefusal: inboxService.hasNextMessage(USER, sent.chatId),
        observe: (ctx, event) => {
          inboxService.recordRunEvent(ctx, event)
          seen.push({ turnId: ctx.turnId, event })
          runEvents.push(event)
          if (event.type === 'needs_input') {
            const first = ctx.turnId === ids.first
            say(`[${engine}] ask in the ${first ? 'first (left unanswered)' : 'drained'} turn`, JSON.stringify(event.request).slice(0, 200))
            if (!first) rejectAsk(event)
          }
        },
        onAccepted: (ctx) => inboxService.resumeChat(ctx, sent.content)
      })

      try {
        // ---- 1. The hold.
        const started = await runQueueService.submit(scope, { chatId, content: HOLD }, options)
        if (started.kind !== 'started') throw new Error(`the first message came back ${JSON.stringify(started)}`)
        ids.first = started.runId
        const first = activeRunsByChat.get(chatId)
        if (!first || first.id !== started.runId) throw new Error('the first run is not the chat\'s active run')
        const firstEnd: { outcome: RunOutcome | null } = { outcome: null }
        void first.completed.then((outcome) => { firstEnd.outcome = outcome })

        // ---- 2. Busy on its tool, or parked on its ask.
        const busy = await waitFor(() => firstEnd.outcome ? 'ended'
          : seen.map((s) => s.turnId === ids.first ? busyOf(s.event) : null).find(Boolean), BUSY_TIMEOUT_MS)
        if (busy === 'ended') throw new Error(`the first turn ended before it was busy: ${JSON.stringify(firstEnd.outcome).slice(0, 500)}`)
        const firstKinds = [...new Set(seen.filter((s) => s.turnId === ids.first)
          .map((s) => s.event.type === 'delta' ? `delta:${s.event.kind}` : s.event.type))]
        say(`[${engine}] first-turn events so far: ${JSON.stringify(firstKinds)}`)
        say(`[${engine}] first turn busy: ${busy ?? `still running, no tool call or ask in ${BUSY_TIMEOUT_MS / 1000} s`}`)

        // ---- 3. The follow-up queues.
        const submitted = await runQueueService.submit(scope, { chatId, content: followUp }, options)
        if (submitted.kind === 'injected') throw new Error('the follow-up was steered into the running turn (injected), so Send now was not exercised')
        if (submitted.kind !== 'queued') throw new Error(`the follow-up came back ${JSON.stringify(submitted)}`)
        const queued = runQueueService.list(scope, chatId)
        if (!queued.items.some((item) => item.id === submitted.queuedId)) throw new Error(`the queue does not list it: ${JSON.stringify(queued)}`)

        // ---- 4. Send now.
        let drained: RunHandle | null = null
        const unwatch = onRunOpened((opened) => {
          const handle = opened === chatId ? activeRunsByChat.get(chatId) : undefined
          if (handle && handle.id !== ids.first) drained = handle
        })
        try {
          if (runQueueService.sendNow(scope, chatId, submitted.queuedId) !== true) throw new Error('sendNow answered false')
          const at = Date.now()

          // ---- 5. Stopped, then drained.
          const firstOutcome = await outcomeWithin(first, TURN_TIMEOUT_MS)
          if (!firstOutcome) throw new Error('the stopped turn did not end')
          if (firstOutcome.state !== 'canceled') throw new Error(`the stopped turn ended ${firstOutcome.state}: ${JSON.stringify(firstOutcome.error ?? null)}`)
          say(`[${engine}] first turn canceled after ${Date.now() - at} ms`)
          const next = await waitFor(() => drained, 30_000, 25)
          if (!next) throw new Error(`no drained run started; queue ${JSON.stringify(runQueueService.list(scope, chatId))}`)
          const nextOutcome = await outcomeWithin(next, TURN_TIMEOUT_MS)
          if (!nextOutcome) throw new Error(`the drained turn did not end within ${TURN_TIMEOUT_MS / 1000} s`)
          if (nextOutcome.state !== 'completed') throw new Error(`the drained turn ended ${nextOutcome.state}: ${JSON.stringify(nextOutcome.error ?? null)}`)
          say(`[${engine}] drained turn completed ${Date.now() - at} ms after Send now; asks rejected: ${rejects}`)
        } finally {
          unwatch()
        }

        // The rows (the vault's): the hold, then the follow-up as its own user row, a reply with the word, no error row.
        const rows = await waitFor(() => {
          const list = chatRepo.listMessages(chatId)
          const at = list.findIndex((m) => m.role === 'user' && m.content === followUp)
          return at >= 0 && list.slice(at + 1).some((m) => m.role === 'assistant' && m.content.includes(word)) ? list : null
        }, 20_000, 250) ?? chatRepo.listMessages(chatId)
        const summary = rows.map((m) => `${m.role}:${m.content.slice(0, 80)}`)
        say(`[${engine}] rows`, JSON.stringify(summary))
        const errors = rows.filter((m) => m.role === 'error')
        if (errors.length) throw new Error(`error rows in the chat: ${JSON.stringify(errors.map((m) => m.content)).slice(0, 500)}`)
        const holdAt = rows.findIndex((m) => m.role === 'user' && m.content === HOLD)
        const followAt = rows.findIndex((m) => m.role === 'user' && m.content === followUp)
        if (holdAt < 0 || followAt <= holdAt) throw new Error(`user rows out of order (hold ${holdAt}, follow-up ${followAt})`)
        const reply = rows.slice(followAt + 1).filter((m) => m.role === 'assistant').map((m) => m.content).join('\n')
        say(`[${engine}] reply`, JSON.stringify(reply.slice(-200)))
        if (!reply.includes(word)) throw new Error(`the reply after the follow-up lacks ${word}`)
        const view = runQueueService.list(scope, chatId)
        if (view.held || view.items.length) throw new Error(`the queue ends ${JSON.stringify(view)}`)
        noKeys()
      } finally {
        // Nothing left to drain or run into the next switch.
        const left = runQueueService.take(scope, chatId)
        if (left.length) say(`[${engine}] took back ${left.length} queued message(s)`)
        const active = activeRunsByChat.get(chatId)
        if (active) {
          active.cancel()
          if (!(await outcomeWithin(active, 60_000))) say(`[${engine}] a run still active after cancel`)
        }
      }
    }

    const results: { engine: Engine; error: string | null }[] = []
    const record = (engine: Engine, error: unknown): void => {
      const reason = error === null ? null : error instanceof Error ? error.message : String(error)
      results.push({ engine, error: reason })
      say(reason === null ? `PASS ${engine}` : `FAIL ${engine}: ${reason}`)
    }
    const vaultIdNow = (): string | undefined =>
      (agentRepo.getOwned(USER, AGENT)?.driverConfig?.['vault'] as { vaultId?: string } | undefined)?.vaultId
    const runEngine = async (engine: Engine, setup: () => Promise<void>): Promise<void> => {
      if (!engines.includes(engine)) return
      try {
        await setup()
        await scenario(engine)
        record(engine, null)
      } catch (error) {
        record(engine, error)
        if (engine === 'antigravity' && vaultIdNow()) {
          try {
            let out = await vaultShell(vaultIdNow()!, ANTIGRAVITY_TRANSCRIPT)
            for (const value of Object.values(keys)) if (value) out = out.split(value).join('<key>')
            say('[antigravity] server transcript inside the vault:\n' + out.slice(-6000))
          } catch (readError) {
            say('[antigravity] could not read the server transcript', String(readError))
          }
        }
      }
    }

    // ---- Move to vault… on Claude, with its key only when Claude is tested.
    const { moveId } = await moveService.moveIn(USER, AGENT, keys.anthropic ? { apiKey: keys.anthropic } : {})
    await moveService.waitForMove(moveId)
    const vaultRef = agentRepo.getOwned(USER, AGENT)?.driverConfig?.['vault'] as { vaultId?: string } | undefined
    const vaultId = vaultRef?.vaultId
    try {
      expect(finalOf(moveId), JSON.stringify(events.filter((e) => !e.output))).toMatchObject({ status: 'done' })
      expect(engineOfRow()).toBe('claude')
      noKeys()
      say('approvals after move', JSON.stringify(approvals))

      await runEngine('claude', async () => {})
      await runEngine('opencode', () => switchTo('opencode', { engine: 'opencode', provider: 'openai', model: OPENAI_MODEL, apiKey: keys.openai }))
      await runEngine('antigravity', async () => {
        await switchTo('antigravity', { engine: 'antigravity', apiKey: keys.gemini })
        // The app's Runs with path (vault:set-runs-with) pins Gemini Flash in cinna.launch.
        await moveService.setRunsWith(USER, AGENT, { model: ANTIGRAVITY_MODEL, effort: null, complexity: null })
      })
      await runEngine('codex', async () => {
        await switchTo('codex', { engine: 'codex', apiKey: keys.openai })
        await moveService.setRunsWith(USER, AGENT, { model: OPENAI_MODEL, effort: null, complexity: null })
      })

      // ---- Nothing of any chat on this computer, no key anywhere.
      noKeys()
      const sqlite = getRawSqlite()
      for (const table of ['messages', 'messages_search', 'inflight_turns']) {
        expect((sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0)
      }
      const dump = JSON.stringify(['chats', 'agents', 'a2a_sessions', 'tasks', 'task_input_requests'].map((t) => sqlite.prepare(`SELECT * FROM ${t}`).all()))
      for (const word of words) expect(dump, `${word} in host SQLite`).not.toContain(word)
      for (const [name, value] of Object.entries(keys)) if (value) expect(dump.includes(value), `${name} key in host SQLite`).toBe(false)
      say('host task_input_requests rows:', (sqlite.prepare('SELECT count(*) AS n FROM task_input_requests').get() as { n: number }).n)
      say('approvals', JSON.stringify(approvals))
    } finally {
      // ---- Clean up, pass or fail: the test helper grants the destroy approval.
      if (vaultId) {
        const { acpProcessPool } = await import('../../src/main/agents/drivers')
        await acpProcessPool.shutdown().catch(() => {})
        await backend.destroy(vaultId, await backend.approve(vaultId, 'destroy', approvalDetail({ method: 'vault.destroy' })))
        say('vault destroyed')
      }
    }

    say('summary', results.map((r) => `${r.error === null ? 'PASS' : 'FAIL'} ${r.engine}`).join(' · '))
    const failed = results.filter((r) => r.error !== null)
    expect(failed.map((r) => `${r.engine}: ${r.error}`), 'engines that failed').toEqual([])
  })
})
