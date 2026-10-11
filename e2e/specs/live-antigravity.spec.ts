import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { launch, test, expect, type Sandbox } from '../fixtures/app'
import { LIVE_REQUESTED } from '../fixtures/live'
import { RUNTIME_PINS } from '../../src/shared/runtimePins'

/**
 * @live — real turns on **Google Antigravity**, on the developer's own Google
 * login. Opt-in: `CINNA_E2E_ANTIGRAVITY_REAL_HOME=1 make e2e-one SPEC=live-antigravity`.
 *
 * ## Why the real HOME, and what stays sandboxed
 *
 * Antigravity's login is the macOS keychain item (service `gemini`, account
 * `antigravity-acp`) plus `~/.gemini/antigravity-acp/settings.json`; neither
 * exists under a sandbox `HOME`. So, like `live-sharing-skill-engines` T2.3b /
 * T2.3c, the app runs on the **real `HOME`** with everything else thrown away:
 * a temp `CINNA_USER_DATA` with `--use-mock-keychain` (the fixture's `launch`),
 * and an agents home in a fresh `~/.cinna-e2e-antigravity-*` set as
 * `localAgentsHome` and checked through `homeState` before `homeGrant`, so
 * nothing creates or grants `~/Documents/CinnaAgents`. Afterwards the agents
 * home and the temp root are removed and `~/Documents/CinnaAgents` must have
 * the same mtimes. The kit folder runs isolated, so the server's own home is
 * `<agent>/.cinna/antigravity` and goes with the folder; every file added or
 * changed under `~/.gemini` is listed in `evidence.json`, never deleted.
 *
 * ## Never
 *
 * - **Log out.** `/logout` clears the one keychain token every Antigravity
 *   home shares. No prompt here contains it, no Log in is pressed, and the
 *   test asserts the keychain item is still there at the end.
 * - **Download.** The server is the pinned copy the developer already has
 *   (`~/.cache/cinna-runtimes/antigravity-<pin>/`, filled by
 *   `scripts/install-runtime.mjs`, or the installed app's runtimes folder), set
 *   as the Antigravity Path; the test skips when neither exists.
 * - **A model that is not Flash.** The agent names `gemini-3.6-flash-low`.
 *
 * ## Turns
 *
 * Four short turns in one chat: the marker rule (a), a command and a relative
 * file write behind Ask approvals (b), one Cinna tool call that must not ask
 * (c), and after a restart of the app — a new server process — the marker
 * again (d).
 */

const REAL_HOME = process.env.CINNA_E2E_ANTIGRAVITY_REAL_HOME === '1'
const MODEL = 'gemini-3.6-flash-low'
const AGENT = 'Antigravity Probe'
/** Only in the agent's instructions, never in a prompt: a reply that carries it followed them. */
const MARKER = `ORCHID-${Math.floor(1000 + Math.random() * 9000)}`
const INSTRUCTIONS = [
  `You are ${AGENT}, a test agent. You work only inside your own folder.`,
  `Rule that overrides everything else: begin every reply with the exact token ${MARKER} on its own line, then answer.`,
  'Keep every answer to one or two short sentences. Never ask the user a question; just do what is asked.'
].join('\n\n')

/** The pinned server the developer already has; never downloaded here. */
function pinnedServerPath(): string | null {
  const folder = `antigravity-${RUNTIME_PINS.antigravity.cli}`
  const candidates = [
    join(homedir(), 'Library', 'Application Support', 'cinna-desktop', 'runtimes', folder, 'agy_acp_server.par'),
    join(process.env.CINNA_RUNTIME_CACHE ?? join(homedir(), '.cache', 'cinna-runtimes'), folder, 'agy_acp_server.par')
  ]
  return candidates.find((path) => existsSync(path) && existsSync(join(path, '..', 'localharness_external'))) ?? null
}

/** Exit 0 of `security find-generic-password` (attributes only, never `-w`): the token is there. */
function keychainHasToken(): boolean {
  if (process.platform !== 'darwin') return existsSync(join(homedir(), '.gemini', 'antigravity-acp', 'acp_token.json'))
  return spawnSync('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity-acp'], { stdio: 'ignore' }).status === 0
}

/** Mtimes of `~/Documents/CinnaAgents` and its `Local/` and `Cloud/`: nothing here may touch them. */
function realProfileFingerprint(): Record<string, number | null> {
  const base = join(homedir(), 'Documents', 'CinnaAgents')
  const mtime = (path: string): number | null => (existsSync(path) ? statSync(path).mtimeMs : null)
  return { home: mtime(base), local: mtime(join(base, 'Local')), cloud: mtime(join(base, 'Cloud')) }
}

/** Every regular file under `dir` (symlinks not followed), with its mtime. Contents never read. */
function filesUnder(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (current: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        try {
          out.set(path, statSync(path).mtimeMs)
        } catch {
          // removed meanwhile
        }
      }
    }
  }
  walk(dir)
  return out
}

/** Every path named `name` under `dir`, symlinks not followed. */
function findNamed(dir: string, name: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.name === name) found.push(path)
      if (entry.isDirectory()) walk(path)
    }
  }
  walk(dir)
  return found
}

/** The app on the real HOME with a throwaway userData — the fixture's `launch`, without its sandbox HOME. */
class RealHomeApp {
  private current: { electronApp: ElectronApplication; page: Page } | null = null
  constructor(readonly sandbox: Sandbox) {}

  get page(): Page {
    if (!this.current) throw new Error('the app is not running')
    return this.current.page
  }

  async start(): Promise<void> {
    this.current = await launch(this.sandbox)
    // Past the first-run screen the way a user with no key does, then the
    // fixture's pin: OpenCode as Default runtime, so nothing unnamed drifts to
    // the developer's own Claude Code. The agent names its engine itself.
    const skip = this.page.getByRole('button', { name: 'Skip for now' })
    const shell = this.page.getByRole('button', { name: 'Chats', exact: true })
    await skip.or(shell).first().waitFor()
    if (await skip.isVisible()) await skip.click()
    await shell.waitFor()
    await this.page.evaluate(() => window.api.settings.set('localAgentsDefaultEngine', 'opencode'))
  }

  async close(): Promise<void> {
    if (this.current) await this.current.electronApp.close()
    this.current = null
  }

  async relaunch(): Promise<void> {
    await this.close()
    await this.start()
  }
}

interface TurnResult {
  asks: string[]
  reply: string
  errors: string[]
}

/**
 * Send `text` in the open chat and wait for the turn to end, answering every
 * ask with Allow once (at most six). The turn has ended when no Stop is shown
 * and main has stored one more assistant message than before.
 */
async function sendAndSettle(app: RealHomeApp, chatId: string | null, text: string): Promise<TurnResult & { chatId: string }> {
  const page = app.page
  const assistantCount = async (id: string | null): Promise<number> => {
    if (!id) return 0
    const chat = await page.evaluate((chat) => window.api.chat.get(chat), id)
    return (chat?.messages ?? []).filter((message) => message.role === 'assistant').length
  }
  const before = await assistantCount(chatId)
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(text)
  await input.press('Enter')
  let id = chatId
  const asks: string[] = []
  await expect
    .poll(
      async () => {
        const ask = page.getByText(/^The agent is asking to /)
        if ((await ask.count()) > 0) {
          if (asks.length >= 6) return 'too many asks'
          asks.push(await ask.first().innerText())
          await page.getByRole('button', { name: 'Allow once', exact: true }).first().click()
          return 'answered an ask'
        }
        if (!id) {
          id = await page.evaluate(async (first) => {
            for (const row of await window.api.chat.list()) {
              const chat = await window.api.chat.get(row.id)
              if (chat?.messages.find((message) => message.role === 'user')?.content === first) return chat.id
            }
            return null
          }, text)
          if (!id) return 'starting'
        }
        const chat = await page.evaluate((chat) => window.api.chat.get(chat), id)
        const error = chat?.messages.slice(-1).find((message) => message.role === 'error')
        if (error) return `error: ${String(error.content).slice(0, 300)}`
        const busy = (await page.getByRole('button', { name: 'Stop', exact: true }).count()) > 0
        return !busy && (await assistantCount(id)) > before ? 'done' : 'running'
      },
      { timeout: 240_000, intervals: [1000] }
    )
    .toMatch(/^(done|too many asks|error: .*)$/)
  const chat = await page.evaluate((chat) => window.api.chat.get(chat), id!)
  const messages = chat?.messages ?? []
  const last = messages.filter((message) => message.role === 'assistant').slice(before)
  return {
    chatId: id!,
    asks,
    reply: last.map((message) => String(message.content ?? '')).join('\n'),
    errors: messages.filter((message) => message.role === 'error').map((message) => String(message.content).slice(0, 500))
  }
}

test('live Antigravity: instructions, an approved command and file, a Cinna tool with no ask, and a restart', async () => {
  test.skip(!REAL_HOME, 'Opt-in: set CINNA_E2E_ANTIGRAVITY_REAL_HOME=1 to run real Gemini Flash turns on your own Antigravity login (the app gets your real HOME; see the file header)')
  test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
  const server = pinnedServerPath()
  test.skip(server === null, `the pinned Antigravity ${RUNTIME_PINS.antigravity.cli} server is neither in the real app's runtimes folder nor in ~/.cache/cinna-runtimes`)
  test.skip(!existsSync(join(homedir(), '.gemini', 'antigravity-acp', 'settings.json')) || !keychainHasToken(),
    'Antigravity is not logged in on this machine (no ~/.gemini/antigravity-acp/settings.json or no keychain token)')
  test.setTimeout(900_000)

  const realHome = homedir()
  const geminiHome = join(realHome, '.gemini')
  const profileBefore = realProfileFingerprint()
  const geminiBefore = filesUnder(geminiHome)
  const root = mkdtempSync(join(tmpdir(), 'cinna-e2e-antigravity-'))
  const sandbox: Sandbox = { root, home: realHome, userData: join(root, 'userData') }
  mkdirSync(sandbox.userData, { recursive: true })
  const agentsHome = mkdtempSync(join(realHome, '.cinna-e2e-antigravity-'))
  const app = new RealHomeApp(sandbox)
  const evidence: Record<string, unknown> = { marker: MARKER, model: MODEL }
  let passed = false
  try {
    await app.start()
    const page = app.page
    await page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    await page.evaluate((path) => window.api.settings.set('localAgentsHome', path), agentsHome)
    const state = await page.evaluate(() => window.api.localAgents.homeState())
    if (state.path !== agentsHome || state.guarded) throw new Error('the agents home is not the throwaway folder; refusing to grant')
    await page.evaluate(() => window.api.localAgents.homeGrant())
    const roots = await page.evaluate(() => window.api.localAgents.rootsList())
    if (roots.length !== 1 || roots[0].path !== agentsHome) throw new Error('a root outside the throwaway agents home')
    await page.evaluate((path) => window.api.settings.set('localAgentsAntigravityPath', path), server!)

    const agent = await page.evaluate((input) => window.api.localAgents.create(input), {
      rootId: roots[0].id, name: AGENT, description: 'Probes Antigravity for the E2E suite.'
    })
    expect(agent.path.startsWith(`${agentsHome}/`)).toBe(true)
    for (const prompt of ['workflow', 'entrypoint'] as const) {
      const outcome = await page.evaluate(async ({ agentId, prompt, value }) => {
        const doc = await window.api.localAgents.readDoc({ agentId, prompt })
        if (!doc.stamp) throw new Error(`${doc.relPath} does not exist`)
        return window.api.localAgents.updateField({ agentId, update: { field: 'prompt', prompt, value }, expectedStamp: doc.stamp })
      }, { agentId: agent.id, prompt, value: INSTRUCTIONS })
      expect(outcome.ok, `${prompt} prompt saved`).toBe(true)
    }
    const fresh = await page.evaluate((id) => window.api.localAgents.get(id), agent.id)
    if (!fresh.ok) throw new Error('the agent could not be read back')
    const runtime = await page.evaluate((input) => window.api.localAgents.updateField({
      agentId: input.agentId, expectedStamp: input.stamp,
      update: { field: 'runtime', value: { engine: 'antigravity', credential: null, modelId: input.model, complexity: null } }
    }), { agentId: agent.id, stamp: fresh.value.stamps['cinna-agent.json']!, model: MODEL })
    expect(runtime.ok).toBe(true)
    const approval = await page.evaluate((id) => window.api.localAgents.setAntigravityApproval(id, 'ask'), agent.id)
    expect(approval.ok).toBe(true)

    await app.relaunch()
    await app.page.evaluate(() => window.api.localAgents.rescan())
    await expect.poll(() => app.page.evaluate(() => window.api.localTools.antigravityAuth()), { timeout: 30_000 }).toEqual({ state: 'logged_in' })
    expect(await app.page.evaluate(() => window.api.engine.resolveAntigravity())).toMatchObject({ state: 'ready', path: server, source: 'configured' })

    await app.page.getByRole('button', { name: 'Agents', exact: true }).click()
    await app.page.getByRole('button', { name: AGENT, exact: true }).click()
    const summary = app.page.getByRole('group', { name: 'Runtime summary', exact: true })
    await expect(summary.getByText('Antigravity', { exact: true })).toBeVisible()
    await expect(summary.getByText(MODEL, { exact: true })).toBeVisible()

    await test.step('(a) the first reply follows the marker rule in the instructions', async () => {
      const turn = await sendAndSettle(app, null, 'Say hello in one short sentence.')
      evidence.a = turn
      expect(turn.errors).toEqual([])
      expect(turn.asks).toEqual([])
      expect(turn.reply).toContain(MARKER)
      evidence.chatId = turn.chatId
    })
    const chatId = evidence.chatId as string

    await test.step('(b) a command and a relative file write ask first, and the file lands in the agent folder', async () => {
      const turn = await sendAndSettle(app, chatId,
        'Run the shell command pwd. Then create a file named probe.txt, using exactly that relative path, whose only content is the output of pwd. Then reply with the word done.')
      evidence.b = turn
      expect(turn.errors).toEqual([])
      expect(turn.asks.length, 'Ask approval raised at least one ask').toBeGreaterThan(0)
      // Each ask is worded as a verb phrase, never the raw `antigravity:<kind>` action.
      for (const ask of turn.asks) expect(ask).not.toMatch(/antigravity:/)
      const probe = join(agent.path, 'probe.txt')
      expect(existsSync(probe), `probe.txt in ${agent.path}`).toBe(true)
      const everywhere = findNamed(agentsHome, 'probe.txt')
      evidence.probeFiles = everywhere.map((path) => relative(agentsHome, path))
      expect(everywhere).toEqual([probe])
      expect(findNamed(geminiHome, 'probe.txt')).toEqual([])
      const written = readFileSync(probe, 'utf8').trim()
      evidence.probeContent = written
      expect([agent.path, realpathSync(agent.path)]).toContain(written)
    })

    await test.step('(c) a Cinna tool call completes with no ask to the user', async () => {
      const turn = await sendAndSettle(app, chatId,
        'Call your tasks_list tool once (the one from the cinna server), then reply with how many tasks it listed.')
      evidence.c = turn
      expect(turn.errors).toEqual([])
      expect(turn.asks).toEqual([])
      const chat = await app.page.evaluate((id) => window.api.chat.get(id), chatId)
      const toolCalls = (chat?.messages ?? []).flatMap((message: any) => (message.parts ?? []).filter((part: any) => part.kind === 'tool'))
        .map((part: any) => ({ name: part.toolName, status: part.status ?? null }))
      const stored = (chat?.messages ?? []).filter((message: any) => message.role === 'tool' || message.toolName)
        .map((message: any) => ({ name: message.toolName ?? null, error: message.toolError ?? null }))
      evidence.toolCalls = toolCalls
      evidence.toolMessages = stored
      expect(JSON.stringify([toolCalls, stored]), 'the chat records a tasks_list call').toContain('tasks_list')
    })

    await test.step('(d) after a restart (a new server process) the chat still follows the instructions', async () => {
      await app.relaunch()
      await app.page.getByText('Say hello in one short sentence.', { exact: true }).first().click()
      const turn = await sendAndSettle(app, chatId, 'Say goodbye in one short sentence.')
      evidence.d = turn
      expect(turn.errors).toEqual([])
      expect(turn.asks).toEqual([])
      expect(turn.reply).toContain(MARKER)
      const chat = await app.page.evaluate((id) => window.api.chat.get(id), chatId)
      evidence.telemetryModels = (chat?.messages ?? []).map((message: any) => message.telemetry?.model).filter(Boolean)
      for (const model of evidence.telemetryModels as string[]) expect(model).toBe(MODEL)
    })
    passed = true
  } finally {
    if (!passed) {
      try {
        writeFileSync(test.info().outputPath('screen.yaml'), await app.page.locator('body').ariaSnapshot())
        await app.page.screenshot({ path: test.info().outputPath('screen.png') })
      } catch {
        // the app may be gone already
      }
    }
    await app.close().catch(() => {})
    execFileSync('chmod', ['-R', 'u+w', agentsHome], { stdio: 'ignore' })
    rmSync(agentsHome, { recursive: true, force: true })
    evidence.agentsHomeRemoved = !existsSync(agentsHome)
    try {
      execFileSync('chmod', ['-R', 'u+w', root], { stdio: 'ignore' })
    } catch {
      // already gone
    }
    rmSync(root, { recursive: true, force: true })
    const geminiAfter = filesUnder(geminiHome)
    evidence.geminiNew = [...geminiAfter.keys()].filter((path) => !geminiBefore.has(path)).map((path) => relative(geminiHome, path))
    evidence.geminiChanged = [...geminiAfter].filter(([path, mtime]) => geminiBefore.has(path) && geminiBefore.get(path) !== mtime)
      .map(([path]) => relative(geminiHome, path))
    evidence.stillLoggedIn = keychainHasToken()
    evidence.realAgentsHomeBefore = profileBefore
    evidence.realAgentsHomeAfter = realProfileFingerprint()
    test.info().annotations.push({ type: 'real-HOME evidence', description: JSON.stringify(evidence).slice(0, 4000) })
    writeFileSync(test.info().outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
  }
  expect(evidence.agentsHomeRemoved).toBe(true)
  expect(evidence.stillLoggedIn, 'the shared Antigravity keychain token is still there').toBe(true)
  expect(evidence.realAgentsHomeAfter).toEqual(profileBefore)
})
