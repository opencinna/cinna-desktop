/**
 * `make vault-provider-error-smoke`: a vault Antigravity turn whose server
 * stays silent shows the Gemini error the server wrote into its own
 * transcript, read by the guest's vaultd (`engine.providerErrors`) — on a real
 * VM, real guest image and vaultd. **Not billed**: the Antigravity server is
 * the E2E fake (`e2e/fixtures/fakeAntigravityServer.ts`, `silent-provider-error`),
 * the key is a dummy, and Gemini's hosts are off the vault's allowlist anyway.
 * Opt-in, never in `npm test`.
 *
 * ## Why a fake server
 *
 * The real pinned server is not silent without Gemini: the proxy answers 403
 * and the turn ends at once with `Agent execution error: doRequest: …
 * Forbidden` on the wire (lane run, 2026-11-19). A silent server needs a fake.
 * So the lane's runtime source (`installVaultMoveDeps({ runtimeSource })`, the
 * seam the fake backend uses too) hands out, for Antigravity only, a
 * deterministic tar of the fake (`agy_acp_server.par`, shebang the guest's
 * `/usr/local/bin/node`, plus a `localharness_external` stub) as the "pinned"
 * archive: vaultd commits only bytes that hash to the `expectedSha256` main
 * sends, and main checks the installed row against the same source's pin, so
 * the whole install path runs unchanged with the fake's hash as the pin.
 * Claude is the real pinned download (no prompt ever reaches it).
 *
 * ## What it proves
 *
 * The turn goes the way `run:start` sends it: the real `runQueueService.submit`
 * → the real `runExecutionService.start` (hub core initialized as the desktop
 * does), whose `driverFor` resolves the app's own `acpDriver` and vault
 * runtime. In order:
 * 1. Move to vault… on Claude, keyless, then the app's switch to Antigravity
 *    with **no key** (Google's key check is never asked), which installs the
 *    fake through `runtime.install`;
 * 2. a dummy `GEMINI_API_KEY` stored straight into the vault (`secrets.put`),
 *    and Gemini's hosts taken off the allowlist the switch had just widened;
 * 3. one turn: the fake answers `authenticate` and `session/new`, never the
 *    prompt, and 2 s later writes a USER_INPUT, a MODEL denial and a SYSTEM 503
 *    into `$GEMINI_HOME/antigravity-acp/brain/<sid>/…/transcript_full.jsonl` —
 *    the vault home's, as the agent user it runs as;
 * 4. the run's events carry the warning note `Gemini answered an error (503):
 *    The model is currently unreachable.`, never the denial and no generic
 *    "No reply from …" note; Stop (the run's cancel) ends it `canceled`, with
 *    no error row; nothing of the chat is in this computer's SQLite.
 * The vault is destroyed pass or fail.
 *
 * ## Against an older guest (the fallback)
 *
 * `VAULT_PROVIDER_ERROR_GUEST_DIR=<dir>`: the guest image in `<dir>` (a guest
 * built before `engine.providerErrors`, e.g. an unpacked 0.12.0-1 release
 * guest; it becomes `CINNA_VAULT_GUEST_DIR`). The helper must accept that
 * image (a test helper built against it). Expected: vaultd answers -32601, the
 * app logs once that the vault cannot report provider errors and stops asking,
 * **no** provider note and no error row, and Stop ends the turn cleanly. The
 * generic note comes at 90 s (the app's driver is not reconfigurable from
 * here): the lane waits for it up to `VAULT_PROVIDER_ERROR_SILENT_WAIT_MS`
 * (default 120000); `0` skips that wait and only checks for 20 s that no
 * provider note came.
 *
 * ## What it does not prove
 *
 * The renderer (the warning row: agent-vault.spec.ts V10 on the fake backend),
 * the real server's own behaviour (it is replaced), nor that a real Gemini 503
 * is written the way the fake writes it (the step shape is the one read from
 * a real 1.4.5 transcript).
 *
 * ## Prerequisites
 *
 *   npx electron-vite build    # the Claude adapter tar
 *   make vault-helper          # FLAVOR=test
 *   make vault-image           # build/vault-guest (with engine.providerErrors)
 *   make vault-provider-error-smoke
 *
 * Env: `VAULT_PROVIDER_ERROR_DRY=1` — wiring only (hub core, the backend, the
 * helper says `test`, the app's driver resolves, the fake tar packs; nothing
 * moves); `VAULT_PROVIDER_ERROR_GUEST_DIR=<dir>` and
 * `VAULT_PROVIDER_ERROR_SILENT_WAIT_MS` — the older-guest scenario above;
 * `VAULT_LIVE_KEEP=1` keeps the sandbox; `CINNA_VAULT_TEST_SCREEN_LOCKED=0` on
 * a Mac whose screen is locked. HOME and userData are temp dirs; the runtime
 * download cache in build/vault-guest/smoke/ is reused. */
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { VaultMoveProgressEvent } from '../../src/shared/vault/types'
import type { RunEvent } from '../../src/shared/runEvents'
import type { RunHandle, RunOutcome, RunScope } from '../../src/main/services/runExecutionService'
import type { QueueStartOptions } from '../../src/main/services/runQueueService'
import type { RuntimeSource } from '../../src/main/vault/runtimeInstall'
import { fakeAntigravityScript, FAKE_MODEL_DENIAL } from '../../e2e/fixtures/fakeAntigravityServer'

const ROOT = resolve(__dirname, '../..')
const HELPER = join(ROOT, 'resources/vault/VaultHelper.app/Contents/MacOS/VaultHelper')
const OLD_GUEST = process.env['VAULT_PROVIDER_ERROR_GUEST_DIR']?.trim() || ''
const GUEST_DIR = OLD_GUEST || join(ROOT, 'build/vault-guest')
const ROOTFS = join(GUEST_DIR, 'rootfs.img')
const RUNTIME_CACHE = join(ROOT, 'build/vault-guest/smoke/userData/vault/runtime')
const USER = '__default__'
const AGENT = 'folder:7a11ce00-0000-4000-8000-0000000115e3'
const DRY = process.env['VAULT_PROVIDER_ERROR_DRY'] === '1'
/** Never a real key: the fake server signs in with anything. */
const DUMMY_KEY = 'AIza-vault-provider-error-smoke-not-a-key'
const PROMPT = 'Reply with the single word ready.'
const PROVIDER_NOTE = 'Gemini answered an error (503): The model is currently unreachable.'
const GEMINI_HOSTS = ['generativelanguage.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com', 'cloudcode-pa.googleapis.com']
/** The fake writes its 503 2 s after the prompt and the driver polls every 5 s: the note is there well within this. */
const NOTE_WAIT_MS = 45_000
/** The older guest's fallback: how long to wait for the generic note (it comes at 90 s); 0 skips the wait. */
const SILENT_WAIT_MS = Number(process.env['VAULT_PROVIDER_ERROR_SILENT_WAIT_MS'] ?? 120_000)
/** With no wait for the generic note: how long the older guest must stay without a provider note. */
const NO_NOTE_WAIT_MS = 20_000
/** The guest's node (native/vault/guest/build/init-build checks it there): the fake server's interpreter. */
const GUEST_NODE = '/usr/local/bin/node'
/** The fake's files, as the real archive names them. */
const FAKE_FILES = ['agy_acp_server.par', 'localharness_external']

const env = vi.hoisted(() => ({ root: '', folder: '' }))
/** Every line the app logged, for the older-guest scenario's one info line. */
const logged = vi.hoisted(() => ({ lines: [] as string[] }))

vi.mock('../../src/main/logger/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/logger/logger')>()
  const print = (scope: string, level: string, message: string, data?: unknown): void => {
    const line = `[${scope}] ${level}${message} ${data ? JSON.stringify(data) : ''}`
    logged.lines.push(line)
    console.log(line)
  }
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
        id: agentId, manifestId: agentId.slice('folder:'.length), name: 'Vault Provider Error', path: env.folder, kind: 'kit', rootId: 'root-1',
        runtime: { engine: 'claude' }, credentials: [], manifest: {}
      })
    }
  }
})

/** Gemini's API and Google's sign-in: what the lane's host side must never call. */
const GOOGLE_API_HOSTS = new Set([
  'generativelanguage.googleapis.com', 'cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com',
  'oauth2.googleapis.com', 'www.googleapis.com', 'accounts.google.com'
])
const t0 = Date.now()
const stamp = (): string => `${String(Date.now() - t0).padStart(7)} ms`
const say = (...parts: unknown[]): void => console.log(stamp(), ...parts)
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function waitFor<T>(probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms: number, every = 250): Promise<T | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) return null
    await delay(every)
  }
}

async function outcomeWithin(handle: RunHandle, ms: number): Promise<RunOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((done) => { timer = setTimeout(() => done(null), ms) })
  try { return await Promise.race([handle.completed, timeout]) } finally { clearTimeout(timer) }
}

let sandbox = ''
let fakeDir = ''
let hubUp = false

beforeAll(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple silicon only')
  if (!existsSync(HELPER)) throw new Error(`no helper at ${HELPER}: make vault-helper`)
  if (!existsSync(ROOTFS)) throw new Error(`no guest image at ${ROOTFS}: ${OLD_GUEST ? 'check VAULT_PROVIDER_ERROR_GUEST_DIR' : 'make vault-image'}`)
  if (OLD_GUEST) process.env['CINNA_VAULT_GUEST_DIR'] = OLD_GUEST
  sandbox = mkdtempSync(join(tmpdir(), 'cinna-vault-provider-error-'))
  const home = join(sandbox, 'home')
  const userData = join(sandbox, 'userData')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(userData, 'vault'), { recursive: true })
  process.env['HOME'] = home
  if (existsSync(RUNTIME_CACHE)) symlinkSync(RUNTIME_CACHE, join(userData, 'vault', 'runtime'))
  const { installRuntimeHost } = await import('../../src/main/host/runtimeHost')
  const require = createRequire(join(ROOT, 'package.json'))
  const unavailable = (): never => { throw new Error('Desktop capability unavailable in the vault provider-error lane') }
  installRuntimeHost({
    getPath: (name: string) => (name === 'userData' ? userData : home),
    getVersion: () => '0.0.0-vault-provider-error-smoke',
    getAppPath: () => ROOT,
    isPackaged: false,
    resourcesPath: join(ROOT, 'resources'),
    resolvePackageFile: (specifier: string) => require.resolve(specifier),
    http: { fetch: (input: string, init?: RequestInit) => fetch(input, init) },
    keystore: { prepare: async () => {}, isEncryptionAvailable: () => true, isSecureStorageAvailable: () => false, encryptString: async () => unavailable(), decryptString: async () => unavailable() },
    resolveProxy: async () => 'DIRECT',
    nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }),
    onShutdown: () => {},
    shell: { openExternal: unavailable, openPath: unavailable, showItemInFolder: unavailable, trashItem: unavailable }
  } as never)
  // Nothing in this lane may ask Gemini or a Google sign-in: the key check is never reached (no key in the switch),
  // and this proves it. Pinned runtime downloads (storage.googleapis.com, dl.google.com) are not Gemini or a sign-in.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const host = new URL(url).host
    if (GOOGLE_API_HOSTS.has(host)) throw new Error(`the provider-error lane must not reach Google (${host})`)
    return realFetch(input, init)
  }) as typeof fetch

  // The fake Antigravity server, packed below as the vault's "pinned" archive.
  fakeDir = join(sandbox, 'fake-antigravity')
  mkdirSync(fakeDir, { recursive: true })
  writeFileSync(join(fakeDir, 'agy_acp_server.par'), fakeAntigravityScript({ node: GUEST_NODE, mode: 'silent-provider-error', logDir: null }), { mode: 0o755 })
  writeFileSync(join(fakeDir, 'localharness_external'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  env.root = join(sandbox, 'agents')
  env.folder = join(env.root, 'Local', 'vault-provider-error')
  mkdirSync(env.folder, { recursive: true })
  writeFileSync(join(env.folder, 'agent.md'), '# Vault Provider Error\nA test agent.\n')
  writeFileSync(join(env.folder, 'cinna-agent.json'), JSON.stringify({ id: AGENT.slice('folder:'.length), name: 'Vault Provider Error' }, null, 2) + '\n')
}, 10 * 60_000)

afterAll(async () => {
  if (hubUp) {
    const { shutdownHubCore, userActivation } = await import('../../src/main/hub/core')
    const { closeDatabase } = await import('../../src/main/db/client')
    await userActivation.deactivate().catch(() => {})
    await shutdownHubCore('The vault provider-error lane finished.').catch(() => {})
    closeDatabase()
  }
  if (sandbox && process.env['VAULT_LIVE_KEEP'] !== '1') rmSync(sandbox, { recursive: true, force: true })
})

describe(`Agent Vault provider-error smoke (${OLD_GUEST ? 'older guest: the fallback' : 'engine.providerErrors'}; not billed)`, () => {
  it(OLD_GUEST ? 'keeps the generic note and no provider note on a guest without engine.providerErrors' : 'shows the 503 vaultd read from a silent vault Antigravity turn’s transcript, and Stop ends it cleanly', async () => {
    const { installEventPublisher } = await import('../../src/main/host/events')
    const { installVaultBackend } = await import('../../src/main/vault/backend')
    const { createAppleVzBackend } = await import('../../src/main/host/desktop/vault/appleVzBackend')
    const { adaptDatabase } = await import('../../src/main/db/testSupport/nodeSqlite')

    const events: VaultMoveProgressEvent[] = []
    installEventPublisher((channel, payload) => {
      if (channel !== 'vault:move-progress') return
      const event = payload as VaultMoveProgressEvent
      events.push(event)
      if (event.output) return
      say(event.step, event.status, event.message ?? '')
    })
    const backend = createAppleVzBackend({ helperPath: HELPER, isPackaged: false })
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
    const { activeRunsByChat } = await import('../../src/main/services/runExecutionState')
    const { approvalDetail } = await import('../../src/shared/vault/protocol')
    const { defaultRuntimeSource } = await import('../../src/main/vault/runtimeInstall')
    const { deterministicTar, deterministicTarSha256 } = await import('../../src/main/vault/adapterTar')
    const { RUNTIME_PINS } = await import('../../src/shared/runtimePins')

    // The pinned runtimes, but Antigravity is the fake: its tar's own hash is its pin.
    const fake = await deterministicTarSha256(fakeDir, FAKE_FILES)
    const fakeVersion = `${RUNTIME_PINS.antigravity.cli}-lane-fake`
    const pinned = defaultRuntimeSource()
    const laneSource: RuntimeSource = {
      pins: (engine) => engine === 'antigravity'
        ? [{ engine, kind: 'archive', version: fakeVersion, sha256: fake.sha256 }]
        : pinned.pins(engine),
      artifacts: async (engine) => engine === 'antigravity'
        ? [{ engine, version: fakeVersion, kind: 'archive', name: 'agy_acp_server.par', open: () => deterministicTar(fakeDir, FAKE_FILES), expectedSha256: fake.sha256 }]
        : pinned.artifacts(engine)
    }
    say('fake Antigravity tar', fake.sha256.slice(0, 12), `${fake.bytes} bytes`)

    agentRepo.replaceFolderIndex(USER, 'root-1', [{
      id: AGENT, name: 'Vault Provider Error', description: null, localPath: env.folder, remoteMetadata: {} as never, launcher: 'claude'
    }])
    installVaultMoveDeps({
      instructions: () => 'You are Vault Provider Error, a test agent. Keep answers short.',
      launchFacts: () => ({ model: 'haiku', approval: 'ask' }),
      hostClaudeOnSubscription: async () => true,
      defaultEngine: () => 'claude',
      runtimeSource: () => laneSource
    })
    expect((await backend.hello()).flavor).toBe('test')
    expect(driverFor(agentRepo.getOwned(USER, AGENT)!)).toBe(acpDriver)
    const scope: RunScope = { profileUserId: USER, settingsUserId: USER }
    if (DRY) {
      say(`DRY: hub core up, profile activated, helper flavor test, driverFor → acpDriver, the fake Antigravity packed; guest ${GUEST_DIR}; nothing moved.`)
      return
    }

    const finalOf = (moveId: string): VaultMoveProgressEvent | undefined => events.filter((e) => e.moveId === moveId && !e.output).at(-1)
    const engineOfRow = (): unknown => (agentRepo.getOwned(USER, AGENT)!.driverConfig!['vault'] as { engine: string }).engine

    // ---- 1. Move in on Claude, keyless; switch to Antigravity (the fake) with no key (no key check).
    const { moveId } = await moveService.moveIn(USER, AGENT, {})
    await moveService.waitForMove(moveId)
    const vaultId = (agentRepo.getOwned(USER, AGENT)?.driverConfig?.['vault'] as { vaultId?: string } | undefined)?.vaultId
    try {
      expect(finalOf(moveId), JSON.stringify(events.filter((e) => !e.output))).toMatchObject({ status: 'done' })
      if (!vaultId) throw new Error('no vault after the move')
      const switched = (await moveService.switchEngine(USER, AGENT, { engine: 'antigravity' })).moveId
      await moveService.waitForMove(switched)
      expect(finalOf(switched), JSON.stringify(events.filter((e) => e.moveId === switched && !e.output))).toMatchObject({ status: 'done' })
      expect(engineOfRow()).toBe('antigravity')

      // ---- 2. The dummy key straight into the vault; Gemini's hosts off the allowlist.
      const client = await vaultService.client(vaultId)
      await client.request('secrets.put', { name: 'GEMINI_API_KEY', value: DUMMY_KEY })
      const allowed = (await backend.status(vaultId)).egress?.hosts ?? []
      await vaultService.applyEgress(vaultId, { hosts: allowed.filter((host) => !GEMINI_HOSTS.includes(host)).sort() })
      const after = (await backend.status(vaultId)).egress?.hosts ?? []
      say('allowlist now', JSON.stringify(after))
      expect(after.filter((host) => GEMINI_HOSTS.includes(host)), 'no Gemini host is allowed').toEqual([])

      // ---- 3. One turn.
      const row = agentRepo.getOwned(USER, AGENT)!
      const ready = await driverFor(row).readiness(USER, row)
      if (ready && ready.state !== 'ok') throw new Error(`readiness ${JSON.stringify(ready)}`)
      const chatId = chatRepo.create(USER, { router: 'direct', agentId: AGENT }).id
      vaultService.bindChat(USER, USER, chatId, AGENT)
      const runEvents: RunEvent[] = []
      const notices = (): { text: string; tone?: string }[] =>
        runEvents.flatMap((event) => (event.type === 'delta' && event.kind === 'notice' ? [{ text: event.text, ...(event.tone ? { tone: event.tone } : {}) }] : []))
      const options: QueueStartOptions = (sent) => ({
        preserveOnRefusal: inboxService.hasNextMessage(USER, sent.chatId),
        observe: (ctx, event) => {
          inboxService.recordRunEvent(ctx, event)
          runEvents.push(event)
          if (event.type === 'delta' && event.kind === 'notice') say('notice', JSON.stringify({ text: event.text, tone: event.tone ?? null }))
          else if (event.type !== 'delta') say('event', event.type)
        },
        onAccepted: (ctx) => inboxService.resumeChat(ctx, sent.content)
      })
      const started = await runQueueService.submit(scope, { chatId, content: PROMPT }, options)
      if (started.kind !== 'started') throw new Error(`the message came back ${JSON.stringify(started)}`)
      const handle = activeRunsByChat.get(chatId)
      if (!handle) throw new Error('no active run for the chat')
      const ended: { outcome: RunOutcome | null } = { outcome: null }
      void handle.completed.then((outcome) => { ended.outcome = outcome })

      try {
        const providerNotes = (): { text: string }[] => notices().filter((n) =>
          n.text.startsWith('Gemini answered') || n.text.startsWith('Antigravity could not reach') || n.text.startsWith('Antigravity reported'))
        if (!OLD_GUEST) {
          // ---- 4. The note, live; never the denial; no generic one.
          const note = await waitFor(() => notices().find((n) => n.text === PROVIDER_NOTE) ?? (ended.outcome ? 'ended' : null), NOTE_WAIT_MS)
          say('notices', JSON.stringify(notices()))
          if (note === 'ended') throw new Error(`the turn ended before the note: ${JSON.stringify(ended.outcome).slice(0, 500)}`)
          if (!note) throw new Error(`no provider note within ${NOTE_WAIT_MS / 1000} s; notices ${JSON.stringify(notices())}`)
          expect(note.tone).toBe('warning')
          expect(providerNotes().map((n) => n.text), 'only the 503').toEqual([PROVIDER_NOTE])
          expect(JSON.stringify(runEvents), 'the MODEL denial is never surfaced').not.toContain(FAKE_MODEL_DENIAL)
          expect(notices().filter((n) => n.text.startsWith('No reply from')), 'no generic silent-turn note').toEqual([])
        } else {
          // ---- 4'. The fallback: one info line, no provider note, the generic note at 90 s (when waited for).
          if (SILENT_WAIT_MS > 0) {
            const generic = await waitFor(() => notices().find((n) => n.text.startsWith('No reply from')) ?? (ended.outcome ? 'ended' : null), SILENT_WAIT_MS, 1_000)
            if (generic === 'ended') throw new Error(`the turn ended on its own: ${JSON.stringify(ended.outcome).slice(0, 500)}`)
            if (!generic) throw new Error(`no generic note within ${SILENT_WAIT_MS / 1000} s on the older guest`)
          } else {
            await delay(NO_NOTE_WAIT_MS)
          }
          say('notices', JSON.stringify(notices()))
          expect(providerNotes(), 'no provider note').toEqual([])
          expect(logged.lines.filter((line) => line.includes('cannot report Antigravity’s provider errors')), 'one info line').toHaveLength(1)
        }
        if (ended.outcome) throw new Error(`the turn ended on its own: ${JSON.stringify(ended.outcome).slice(0, 500)}`)

        // ---- Stop: canceled, no error row.
        handle.cancel()
        const outcome = await outcomeWithin(handle, 60_000)
        if (!outcome) throw new Error('the stopped turn did not end')
        expect(outcome.state).toBe('canceled')
        const rows = await waitFor(() => {
          const list = chatRepo.listMessages(chatId)
          return list.length >= 1 ? list : null
        }, 20_000) ?? []
        say('rows', JSON.stringify(rows.map((m) => `${m.role}:${m.content.slice(0, 100)}`)))
        expect(rows.filter((m) => m.role === 'error'), 'no error row').toEqual([])
        if (!OLD_GUEST) expect(rows.some((m) => m.role === 'agent_transition' && m.content.includes(PROVIDER_NOTE)), 'the note saved in the vault transcript').toBe(true)
      } finally {
        const active = activeRunsByChat.get(chatId)
        if (active) {
          active.cancel()
          await outcomeWithin(active, 60_000)
        }
      }

      // ---- Nothing of the chat on this computer.
      const sqlite = getRawSqlite()
      for (const table of ['messages', 'messages_search', 'inflight_turns']) {
        expect((sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0)
      }
      const dump = JSON.stringify(['chats', 'agents', 'a2a_sessions'].map((t) => sqlite.prepare(`SELECT * FROM ${t}`).all()))
      expect(dump, 'the dummy key in host SQLite').not.toContain(DUMMY_KEY)
    } finally {
      if (vaultId) {
        const { acpProcessPool } = await import('../../src/main/agents/drivers')
        await acpProcessPool.shutdown().catch(() => {})
        await backend.destroy(vaultId, await backend.approve(vaultId, 'destroy', approvalDetail({ method: 'vault.destroy' })))
        say('vault destroyed')
      }
    }
  })
})
