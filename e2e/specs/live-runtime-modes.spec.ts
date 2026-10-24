import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test, type CinnaApp } from '../fixtures/app'
import { ANTHROPIC_API_KEY, anthropicKeyProblem, pinClaudeApiProfile, seedAnthropicCredential } from '../fixtures/claudeApiAuth'
import { LIVE_REQUESTED, OPENAI_API_KEY, PREFERRED_MODELS } from '../fixtures/live'
import { claudeBinary } from '../fixtures/liveEngine'

/**
 * **Runtime modes on real engines** — billed, a few short turns per engine.
 *
 * Per engine the runtime mode is starred in Settings → Chats, so a new chat
 * starts on it with no agent attached, and Tools is its default, Workspace:
 * the engine's own file and shell tools in `<userData>/chat-conductors/<chatId>`,
 * every native action behind Cinna's permission ask, and *Always allow* kept
 * for that chat alone.
 *
 * 1. Workspace: a write asks; *Always allow* says "this chat"; the file lands
 *    in the chat's folder; the same write again in that chat does not ask; a
 *    new chat asks again.
 * 2. Connected tools: the same runtime answers a question, and no native tool
 *    is asked for or leaves a file (best effort — a model that wanted no tool
 *    proves nothing about refusing one).
 *
 * Claude Agent runs in API Token mode on `.env`'s `ANTHROPIC_API_KEY` (the
 * key must be scoped to a workspace) on Effort Low — haiku — in the ordinary
 * sandbox, set up as `live-claude-api-token.spec.ts` sets it up: over IPC,
 * never by pressing a Claude runtime card, which on a logged-out sandbox
 * starts a real browser login. OpenCode runs on the cached pinned engine and
 * `.env`'s `OPENAI_API_KEY`, on `gpt-5.6-luna` (`CINNA_E2E_LIVE_MODEL`
 * overrides). Codex and Antigravity are not run here.
 *
 * The OpenCode card binds the credential and model explicitly, so the turn
 * runs on the cheap live model rather than the credential's own default.
 * Automatic credential choice is covered by `runtime-modes.spec.ts`.
 */

const CLAUDE = claudeBinary()

const WRITE = 'Create a file named hello.txt containing the word cinna in the current directory, then reply DONE'
const AGAIN = 'Write the word cinna to hello.txt again in the current directory, replacing it with the same tool, then reply DONE'
/** Connected tools: the answer is not in the prompt. */
const QUESTION = 'What is 17 + 25? Reply with the number only.'
const ANSWER = '42'

const composer = (cinna: CinnaApp): Locator => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
const status = (cinna: CinnaApp, engine: string): Locator => cinna.page.locator(`[data-runtime-status="${engine}"]`)
const header = (cinna: CinnaApp, engine: string): Locator => status(cinna, engine).locator('xpath=..')

async function openChatsSettings(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const settingsOnly = page.getByRole('button', { name: 'MCP Providers', exact: true })
  if (!(await settingsOnly.isVisible())) {
    const user = await page.evaluate(() => window.api.auth.getCurrent())
    await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(settingsOnly).toBeVisible()
  }
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Runtimes', exact: true })).toBeVisible()
}

async function leaveSettings(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(composer(cinna)).toBeVisible()
}

/** Expand a runtime card (a click on its name; never a runtime picker). */
async function expand(cinna: CinnaApp, engine: string, name: string): Promise<void> {
  await header(cinna, engine).getByText(name, { exact: true }).click()
  await expect(cinna.page.getByLabel('Effort', { exact: true })).toBeVisible()
}

async function star(cinna: CinnaApp, engine: string): Promise<void> {
  await header(cinna, engine).getByRole('button', { name: 'Set as default', exact: true }).click()
  await expect(header(cinna, engine).getByRole('button', { name: 'Remove as default', exact: true })).toBeVisible()
}

async function runtimeMode(cinna: CinnaApp, engine: string) {
  return (await cinna.page.evaluate(() => window.api.chatModes.list())).find((mode) => mode.builtinEngine === engine)!
}

async function newChatId(cinna: CinnaApp, known: readonly string[]): Promise<string> {
  let id = ''
  await expect.poll(async () => {
    const chats = await cinna.page.evaluate(() => window.api.chat.list())
    id = chats.find((chat) => !known.includes(chat.id))?.id ?? ''
    return id
  }, { message: 'the new chat exists' }).not.toBe('')
  return id
}

async function turnEnds(cinna: CinnaApp, chatId: string): Promise<void> {
  await expect.poll(() => cinna.page.evaluate((id) => window.api.chat.get(id).then((chat) => chat?.activeRunId ?? null), chatId),
    { message: 'the turn ends', timeout: 180_000 }).toBeNull()
}

/** Send, and wait until the turn is either asking or over: whichever comes first. */
async function sendAndSettle(cinna: CinnaApp, chatId: string | null, text: string, known: readonly string[]): Promise<{ chatId: string; asked: boolean }> {
  await composer(cinna).fill(text)
  await composer(cinna).press('Enter')
  const id = chatId ?? await newChatId(cinna, known)
  const always = cinna.page.getByRole('button', { name: 'Always allow', exact: true })
  let asked = false
  await expect.poll(async () => {
    if (await always.first().isVisible()) { asked = true; return 'asked' }
    const run = await cinna.page.evaluate((chat) => window.api.chat.get(chat).then((row) => row?.activeRunId ?? null), id)
    return run === null ? 'over' : 'running'
  }, { message: 'the turn asks or ends', timeout: 180_000, intervals: [500] }).not.toBe('running')
  return { chatId: id, asked }
}

async function expectNoAgentAttached(cinna: CinnaApp, chatId: string, engine: string): Promise<void> {
  const detail = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
  expect(detail?.modeId).toBe((await runtimeMode(cinna, engine)).id)
  const agent = (await cinna.page.evaluate(() => window.api.agents.list())).find((row) => row.id === detail?.agentId)
  expect(agent, 'the chat runs on its own runtime row').toMatchObject({ conductor: true })
  await expect(cinna.page.getByRole('button', { name: /^Remove agent / })).toHaveCount(0)
}

/**
 * What the chat's runtime row captured from its mode (`driver_config`): the
 * witness that Effort Low meant haiku. Read-only, from the sandbox DB only.
 */
async function capturedRuntime(cinna: CinnaApp, chatId: string): Promise<Record<string, unknown>> {
  const agentId = (await cinna.page.evaluate((id) => window.api.chat.get(id), chatId))?.agentId
  return cinna.electronApp.evaluate(({ app }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${input.userData}/cinna.db`, { readonly: true, fileMustExist: true })
    try {
      const row = db.prepare('SELECT driver_config FROM agents WHERE id = ?').get(input.agentId) as { driver_config: string } | undefined
      return row ? JSON.parse(row.driver_config) as Record<string, unknown> : {}
    } finally { db.close() }
  }, { userData: cinna.sandbox.userData, agentId: agentId ?? '' })
}

const folderOf = (cinna: CinnaApp, chatId: string): string => join(cinna.sandbox.userData, 'chat-conductors', chatId)

/** The Workspace scenario, on whichever runtime mode is starred. */
async function workspaceFlow(cinna: CinnaApp, engine: string, model: string): Promise<void> {
  const page = cinna.page
  const remembered = page.getByText('Allowed, and remembered for this chat.', { exact: true })
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()

  let first = ''
  await test.step('a write in a new chat on the starred runtime asks, with no agent attached', async () => {
    const sent = await sendAndSettle(cinna, null, WRITE, [])
    first = sent.chatId
    expect(sent.asked, 'the native write raised a permission block').toBe(true)
    await expectNoAgentAttached(cinna, first, engine)
    expect(await capturedRuntime(cinna, first)).toMatchObject({ conductorEngine: engine, conductorModel: model, conductorToolPolicy: 'workspace' })
  })

  await test.step('Always allow is remembered for this chat, and the file is in the chat folder', async () => {
    // A model may take more than one native step to write a file; each is allowed for this chat.
    for (let asks = 0; asks < 3; asks++) {
      await page.getByRole('button', { name: 'Always allow', exact: true }).first().click()
      await expect(remembered).toHaveCount(asks + 1)
      if (!(await sendAndSettleWait(cinna, first))) break
    }
    await turnEnds(cinna, first)
    const file = join(folderOf(cinna, first), 'hello.txt')
    expect(existsSync(file), `${file} exists`).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('cinna')
  })

  await test.step('the same write again in this chat does not ask', async () => {
    const before = await remembered.count()
    const writeAsks = page.getByText(/^Permission to (edit|write) a file$/)
    const writeAsksBefore = await writeAsks.count()
    let sent = await sendAndSettle(cinna, first, AGAIN, [])
    // The model may reach for an unrelated tool first (OpenCode's `skill` was
    // seen live); that ask is not the point, so it is allowed once. Only a
    // second write ask in this chat fails the step.
    for (let asks = 0; sent.asked && asks < 3; asks++) {
      expect(await writeAsks.count(), 'a second write ask in the same chat').toBe(writeAsksBefore)
      await page.getByRole('button', { name: 'Allow once', exact: true }).first().click()
      sent = { ...sent, asked: await sendAndSettleWait(cinna, first) }
    }
    expect(sent.asked, 'the turn ends without another ask').toBe(false)
    expect(await writeAsks.count(), 'a second write ask in the same chat').toBe(writeAsksBefore)
    await turnEnds(cinna, first)
    await expect(remembered).toHaveCount(before)
    expect(readFileSync(join(folderOf(cinna, first), 'hello.txt'), 'utf8')).toContain('cinna')
  })

  await test.step('a new chat on the same runtime asks again', async () => {
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const sent = await sendAndSettle(cinna, null, WRITE, [first])
    expect(sent.asked, 'the new chat asks again').toBe(true)
    await expectNoAgentAttached(cinna, sent.chatId, engine)
    // Denied: this chat's outcome is not the point. A model may try another way; each is denied too.
    for (let asks = 0; asks < 3; asks++) {
      await page.getByRole('button', { name: 'Deny', exact: true }).first().click()
      await expect(page.getByText('Denied.', { exact: true })).toHaveCount(asks + 1)
      if (!(await sendAndSettleWait(cinna, sent.chatId))) break
    }
    await turnEnds(cinna, sent.chatId)
    expect(existsSync(join(folderOf(cinna, sent.chatId), 'hello.txt'))).toBe(false)
  })
}

/** After an answer: true when the same turn asks again, false when it ends. */
async function sendAndSettleWait(cinna: CinnaApp, chatId: string): Promise<boolean> {
  const live = cinna.page.getByRole('button', { name: 'Always allow', exact: true })
  let state = 'running'
  await expect.poll(async () => {
    if (await live.first().isVisible()) { state = 'asked'; return state }
    const run = await cinna.page.evaluate((chat) => window.api.chat.get(chat).then((row) => row?.activeRunId ?? null), chatId)
    state = run === null ? 'over' : 'running'
    return state
  }, { message: 'the turn asks again or ends', timeout: 180_000, intervals: [500] }).not.toBe('running')
  return state === 'asked'
}

/** Tools = Connected tools on the card, then one question in a new chat. */
async function connectorsFlow(cinna: CinnaApp, engine: string, name: string): Promise<void> {
  const page = cinna.page
  await openChatsSettings(cinna)
  await expand(cinna, engine, name)
  await page.getByLabel('Tools', { exact: true }).selectOption('connectors')
  await expect.poll(async () => (await runtimeMode(cinna, engine)).toolPolicy).toBe('connectors')
  await leaveSettings(cinna)
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const sent = await sendAndSettle(cinna, null, QUESTION, [])
  expect(sent.asked, 'a Connected tools chat asked for a native tool').toBe(false)
  await turnEnds(cinna, sent.chatId)
  await expectNoAgentAttached(cinna, sent.chatId, engine)
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Always allow', exact: true })).toHaveCount(0)
  // Only the instructions files a non-workspace folder carries; nothing the model made.
  expect(readdirSync(folderOf(cinna, sent.chatId)).sort()).toEqual(['AGENTS.md', 'CLAUDE.md'])
}

test.describe('Claude Agent runtime mode on the API token', () => {
  test.use({ liveEngineCheck: CLAUDE ? { engine: 'claude', binary: CLAUDE } : null })

  test.beforeEach(() => {
    test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
    test.skip(CLAUDE === null, 'no Claude Code binary (set CINNA_E2E_CLAUDE_PATH, or install ~/.local/bin/claude)')
    test.skip(ANTHROPIC_API_KEY === '', 'ANTHROPIC_API_KEY is not set in .env')
  })

  /** API Token mode as `pinClaudeApiProfile` sets it, then Effort Low and the star on the Claude Agent card. */
  async function arrangeClaude(cinna: CinnaApp): Promise<void> {
    await cinna.skipOnboarding()
    const credentialId = await seedAnthropicCredential(cinna.page)
    const problem = await anthropicKeyProblem(cinna.page, credentialId)
    test.skip(problem !== null, problem ?? '')
    await pinClaudeApiProfile(cinna.page, { binary: CLAUDE! })
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    // A setting written over IPC is not pushed to the renderer's cached query.
    await cinna.page.reload()
    await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
    await openChatsSettings(cinna)
    await expect(status(cinna, 'claude')).toHaveText('Ready')
    await expand(cinna, 'claude', 'Claude Agent')
    await cinna.page.getByLabel('Effort', { exact: true }).selectOption({ label: 'Low' })
    await expect(cinna.page.getByLabel('Model override', { exact: true })).toHaveValue('')
    await expect.poll(async () => (await runtimeMode(cinna, 'claude')).complexity).toBe('simple')
    await star(cinna, 'claude')
    await leaveSettings(cinna)
  }

  test('@live a Claude Agent workspace chat asks per chat and writes in its own folder', async ({ cinna }) => {
    test.setTimeout(600_000)
    await arrangeClaude(cinna)
    // Effort Low and no model override: haiku.
    await workspaceFlow(cinna, 'claude', 'haiku')
  })

  test('@live a Claude Agent chat on Connected tools answers without native tools', async ({ cinna }) => {
    test.setTimeout(300_000)
    await arrangeClaude(cinna)
    await connectorsFlow(cinna, 'claude', 'Claude Agent')
  })
})

test.describe('OpenCode runtime mode on the OpenAI key', () => {
  test.use({ engine: true, liveEngineCheck: { engine: 'opencode', binary: null } })

  test.beforeEach(() => {
    test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
    test.skip(OPENAI_API_KEY === '', 'OPENAI_API_KEY is not set in .env')
  })

  /** The key as a credential over IPC, then credential, model and the star on the OpenCode card. */
  async function arrangeOpenCode(cinna: CinnaApp): Promise<string> {
    await cinna.skipOnboarding()
    const model = await cinna.page.evaluate(async ({ apiKey, preferred }) => {
      await window.api.settings.set('autoChatTitles', false)
      const { id } = await window.api.providers.upsert({ type: 'openai', name: 'OpenAI', apiKey, enabled: true })
      const tested = await window.api.providers.test(id)
      if (!tested.success) throw new Error(`provider test failed: ${tested.error}`)
      const listed = (await window.api.providers.listModels()).filter((m) => m.providerId === id)
      return preferred.map((p) => listed.find((m) => m.id === p)).find(Boolean)?.id ?? null
    }, { apiKey: OPENAI_API_KEY, preferred: PREFERRED_MODELS })
    expect(model, 'the key lists one of the preferred live models').not.toBeNull()
    // The credential was added over IPC; a reload stands in for the add form's invalidation.
    await cinna.page.reload()
    await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
    await openChatsSettings(cinna)
    await expect(status(cinna, 'opencode')).toHaveText('Ready')
    await expand(cinna, 'opencode', 'OpenCode')
    await cinna.page.getByLabel('AI credential', { exact: true }).selectOption({ label: 'OpenAI' })
    await cinna.page.getByLabel('Model override', { exact: true }).selectOption(model!)
    await expect.poll(async () => (await runtimeMode(cinna, 'opencode')).modelId).toBe(model)
    await star(cinna, 'opencode')
    await leaveSettings(cinna)
    return model!
  }

  test('@live an OpenCode workspace chat asks per chat and writes in its own folder', async ({ cinna }) => {
    test.setTimeout(600_000)
    const model = await arrangeOpenCode(cinna)
    await workspaceFlow(cinna, 'opencode', model)
  })

  test('@live an OpenCode chat on Connected tools answers without native tools', async ({ cinna }) => {
    test.setTimeout(300_000)
    await arrangeOpenCode(cinna)
    await connectorsFlow(cinna, 'opencode', 'OpenCode')
  })
})
