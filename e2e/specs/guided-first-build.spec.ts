import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from '@playwright/test'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { splitTurnHeader } from '../fixtures/turnHeader'

/**
 * Guided first build: a freshly scaffolded kit agent (`LocalAgentDto.unbuilt`)
 * hides the example prompts on its new-chat screens and offers the guidance in
 * a composer notice row with Skip guidance, and a `build_brief_propose` the agent proposed renders as a brief
 * card whose Start building opens the building chat.
 *
 * ## What is real and what is not
 *
 * The agents are real kit scaffolds (`localAgents.create`), so `unbuilt` is the
 * scanner's own answer; Skip guidance and Start building write the real
 * marker under `userData`. The brief card's tool row cannot be produced
 * without a model calling the tool, so it is written into the sandbox
 * database as the run pipeline persists one — `tool_name`
 * `build_brief_propose`, `tool_provider` `Cinna guided build`, the input as
 * JSON — after a user message, in a chat bound to the agent. Start building's
 * turn is answered by the scripted fake ACP engine on a keyless Ollama
 * credential; nothing is billed.
 *
 * ## What it does not prove
 *
 * - That a real agent calls `build_brief_propose` with a valid brief, or that
 *   the guided turn header steers it (unit-tested in `guidedBuild.test.ts`,
 *   `buildBriefToolProvider.test.ts`).
 * - The live (streaming) brief card, Edit / Include / Leave out, Apply effort
 *   and Add in Credentials.
 */

const AGENT = 'Inbox Helper'
const OTHER = 'Second Helper'
const MODEL = 'qwen3:8b'
const REPLY = 'Building it now.'
const INTERVIEW_TEXT = 'I’m not sure yet what you should do — interview me.'
const GUIDANCE_TEXT = 'New agent — this chat starts with guidance, then builds it with you.'
const GUIDED_HEADING = 'What kind of agent will this be?'

const CHAT_TITLE = 'Planning the inbox helper'
const BRIEF_SUMMARY = 'Sort the morning inbox and flag what needs a reply.'
const BRIEF_PROMPT = 'Build me an agent that reads my inbox every weekday morning and lists the mails that need a reply.'
const BRIEF = {
  summary: BRIEF_SUMMARY,
  prompt: BRIEF_PROMPT,
  capabilities: [
    { id: 'schedules', state: 'used', note: 'every weekday at 8' },
    { id: 'artifacts', state: 'not_needed', note: '' }
  ],
  credentials: [{ name: 'Gmail' }]
}
/** `composeBuildMessage` for {@link BRIEF} with nothing optional included. */
const BUILD_MESSAGE = `${BRIEF_PROMPT}\n\nSet up:\n- Schedules — every weekday at 8\n- Credentials: Gmail`

/** The composer's guided-build row. It names no agent: one composer shows at a time. */
function invitation(page: Page): Locator {
  return page.getByRole('listitem').filter({ hasText: GUIDANCE_TEXT })
}

/** The composer's input card: its top edge must not move when the row comes or goes. */
async function composerTop(page: Page): Promise<number> {
  const box = await page.locator('textarea[data-chat-composer]').first().boundingBox()
  if (!box) throw new Error('no composer on screen')
  return box.y
}

function guidedComposer(page: Page, name = AGENT): Locator {
  return page.getByRole('combobox', { name: `Describe what ${name} should do for you…`, exact: true })
}

function composer(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Type a message...', exact: true })
}

async function openAgent(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

async function openFeatures(page: Page): Promise<void> {
  // Off the agent page first: its header has a Settings button of its own.
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Features', exact: true }).click()
}

async function arrangeAgent(cinna: CinnaApp): Promise<string> {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, undefined, { unbuilt: true })
  expect(agent.unbuilt).toBe(true)
  return agent.id
}

test('a new kit agent hides the example prompts and offers the guidance in its composer, on both empty screens', async ({ cinna }) => {
  await arrangeAgent(cinna)
  const page = cinna.page
  await openAgent(page, AGENT)

  const row = invitation(page)
  await expect(row).toBeVisible()
  // Its one button, named by the visible label (StableLabel keeps the hidden "Skipping…" in the DOM).
  await expect(row.getByRole('button')).toHaveCount(1)
  await expect(row.getByRole('button', { name: 'Skip guidance', exact: true })).toBeVisible()
  // In the composer's notice panel: "Guidance" alone, "Agent status" beside a readiness row.
  await expect(page.getByRole('status', { name: /^(Guidance|Agent status)$/ }).filter({ has: row })).toBeVisible()
  // The message on the left, Skip guidance on its right, on one line.
  const sentence = await row.getByText(GUIDANCE_TEXT, { exact: true }).boundingBox()
  const skip = await row.getByRole('button', { name: 'Skip guidance', exact: true }).boundingBox()
  expect(sentence && skip).toBeTruthy()
  expect(skip!.x).toBeGreaterThan(sentence!.x + sentence!.width - 1)
  expect(Math.abs((skip!.y + skip!.height / 2) - (sentence!.y + sentence!.height / 2))).toBeLessThan(2)
  // No starters, no capability popover, no example prompts, no heading of its own.
  await expect(page.getByRole('button', { name: 'What can agents do?' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Interview me' })).toHaveCount(0)
  await expect(page.getByRole('listbox', { name: 'Example prompts' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: GUIDED_HEADING })).toHaveCount(0)
  await expect(guidedComposer(page)).toBeVisible()
  await expect(composer(page)).toHaveCount(0)

  // The same on the new-chat screen. The shortcut's pick is dropped while the
  // merged agent list (refetched on the agent page's mount) still lacks an
  // agent seeded over IPC; the agent page now paints at once, so the click
  // can beat that refetch. Retried until the list has caught up.
  await expect(async () => {
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
    await expect(invitation(page)).toBeVisible({ timeout: 1000 })
  }).toPass()
  // Here the screen's own heading box asks it, in place of "What can I help with?".
  await expect(page.getByRole('heading', { name: GUIDED_HEADING, level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toHaveCount(0)
  await expect(guidedComposer(page)).toBeVisible()
  await expect(page.getByRole('listbox', { name: 'Example prompts' })).toHaveCount(0)
  // Typing is the person's; nothing is sent until they send.
  await guidedComposer(page).fill(INTERVIEW_TEXT)
  await expect(invitation(page)).toBeVisible()
  expect(await page.evaluate(() => window.api.chat.list())).toEqual([])

  // The panel is drawn out of the flow, above the box, and the screen reserves
  // its reach: it covers neither the heading nor the prompt slot, and Skip
  // guidance moves the heading and slot, never the box being typed in.
  const panel = page.getByTestId('composer-notice-anchor')
  const clearOf = async (): Promise<void> => {
    const p = await panel.boundingBox()
    const heading = await page.getByRole('heading', { level: 1 }).boundingBox()
    const slot = await page.getByTestId('new-chat-prompt-slot').boundingBox()
    expect(p && heading && slot).toBeTruthy()
    expect(p!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height)
    expect(p!.y).toBeGreaterThanOrEqual(slot!.y + slot!.height - 1)
  }
  await clearOf()
  const top = await composerTop(page)
  await invitation(page).getByRole('button', { name: 'Skip guidance', exact: true }).click()
  await expect(invitation(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'What can I help with?', level: 1 })).toBeVisible()
  expect(await composerTop(page)).toBe(top)
  if (await panel.count()) await clearOf()
})

test('Skip guidance removes the invitation, and it stays gone after reselecting the agent', async ({ cinna }) => {
  await arrangeAgent(cinna)
  const page = cinna.page
  await page.evaluate(async (name) => {
    const [root] = await window.api.localAgents.rootsList()
    await window.api.localAgents.create({ rootId: root.id, name, description: `${name}, scaffolded by the E2E suite.` })
  }, OTHER)
  await openAgent(page, AGENT)
  await expect(invitation(page)).toBeVisible()
  const top = await composerTop(page)

  await invitation(page).getByRole('button', { name: 'Skip guidance', exact: true }).click()
  await expect(invitation(page)).toHaveCount(0)
  await expect(composer(page)).toBeVisible()
  // The row leaving moves nothing: the panel was anchored out of the flow.
  expect(await composerTop(page)).toBe(top)
  await expect(guidedComposer(page)).toHaveCount(0)

  // Another unbuilt agent still invites; coming back to the first does not.
  await page.getByRole('button', { name: OTHER, exact: true }).click()
  await expect(guidedComposer(page, OTHER)).toBeVisible()
  await expect(invitation(page)).toBeVisible()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { name: AGENT, level: 1 })).toBeVisible()
  await expect(composer(page)).toBeVisible()
  await expect(invitation(page)).toHaveCount(0)

  // And across a restart, on the new-chat screen.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
  await expect(composer(cinna.page)).toBeVisible()
  await expect(invitation(cinna.page)).toHaveCount(0)
})

test('turning the Features setting off hides the invitation', async ({ cinna }) => {
  await arrangeAgent(cinna)
  const page = cinna.page
  await openAgent(page, AGENT)
  await expect(invitation(page)).toBeVisible()

  await openFeatures(page)
  const toggle = page.getByRole('switch', { name: 'Guide the first build of new agents', exact: true })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(() => page.evaluate(async () => (await window.api.settings.getAll()).guidedFirstBuild)).toBe(false)
  await page.getByRole('button', { name: 'Back', exact: true }).click()

  await openAgent(page, AGENT)
  await expect(composer(page)).toBeVisible()
  await expect(invitation(page)).toHaveCount(0)
  // The agent itself is still unbuilt: only the setting hides it.
  const agents = await page.evaluate(() => window.api.localAgents.list())
  expect(agents.agents.find((a) => a.name === AGENT)?.unbuilt).toBe(true)
})

function fakeOllama(): Server {
  return createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] }))
        return
      }
      if (req.url === '/api/version') {
        res.end(JSON.stringify({ version: '0.6.2' }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
}

test.describe('the brief card', () => {
  let server: Server
  let ollamaHost = ''

  test.beforeAll(async () => {
    server = fakeOllama()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    ollamaHost = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  test.afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** A chat with the agent holding one user message and the persisted brief after it. */
  async function seedBriefChat(cinna: CinnaApp, agentId: string): Promise<string> {
    const chatId = await cinna.page.evaluate(
      async ({ agentId, title }) => {
        const chat = await window.api.chat.create()
        await window.api.chat.update(chat.id, { title, agentId, router: 'direct' })
        await window.api.chat.addMessage(chat.id, { role: 'user', content: 'Help me with my inbox.' })
        return chat.id
      },
      { agentId, title: CHAT_TITLE }
    )
    await cinna.electronApp.evaluate(({ app }, row) => {
      if (app.getPath('userData') !== row.userData) throw new Error('Not the isolated test profile')
      const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
      const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(`${row.userData}/cinna.db`, { fileMustExist: true })
      try {
        const next = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM messages WHERE chat_id = ?').get(row.chatId) as { n: number }).n
        db.prepare(`INSERT INTO messages (id, chat_id, role, content, tool_call_id, tool_name, tool_input, tool_error, tool_provider, sort_order, created_at)
          VALUES (?, ?, 'tool_call', '', ?, 'build_brief_propose', ?, 0, 'Cinna guided build', ?, ?)`)
          .run(`e2e-brief-${Date.now().toString(36)}`, row.chatId, 'call_e2e_brief', JSON.stringify(row.brief), next, Math.floor(Date.now() / 1000))
      } finally { db.close() }
    }, { userData: cinna.sandbox.userData, chatId, brief: BRIEF })
    return chatId
  }

  /** The fake engine on a keyless Ollama default, and one unbuilt agent. */
  async function arrangeEngine(cinna: CinnaApp): Promise<{ fake: FakeAcpEngine; agentId: string }> {
    await cinna.skipOnboarding()
    const fake = await installFakeAcpEngine(cinna, {
      newSession: { sessionId: 'ses_e2e_guided_build' },
      prompt: {
        emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }],
        response: { stopReason: 'end_turn' }
      }
    })
    await cinna.page.evaluate(
      async ({ host, model }) => {
        await window.api.settings.set('autoChatTitles', false)
        const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
        await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, isDefault: true })
      },
      { host: ollamaHost, model: MODEL }
    )
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, AGENT, undefined, { unbuilt: true })
    expect(agent.unbuilt).toBe(true)
    return { fake, agentId: agent.id }
  }

  function promptText(fake: FakeAcpEngine, index: number): string {
    return (fake.received('session/prompt')[index].params?.prompt as { type: string; text: string }[]).map((p) => p.text).join('')
  }

  test('a message sent from the guided composer starts a guided chat', async ({ cinna }) => {
    const { fake, agentId } = await arrangeEngine(cinna)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    const page = cinna.page
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await answerAgentsFolder(cinna)
    await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
    await expect(invitation(page)).toBeVisible()
    await guidedComposer(page).fill(INTERVIEW_TEXT)
    await guidedComposer(page).press('Enter')
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })

    const [chat] = (await page.evaluate(() => window.api.chat.list())).filter((c) => c.agentId === agentId)
    expect(chat.guidedBuild).toBe(true)
    // The guidance travels in the turn header, after the facts, never in the prompt itself.
    const wire = promptText(fake, 0)
    expect(wire).toContain('\n\nGuided first build:\n- This agent has not been built yet')
    expect(wire.endsWith(`\n\n${INTERVIEW_TEXT}`)).toBe(true)
  })

  test('a persisted brief renders as a card, and Start building opens the building chat and ends the invitation', async ({ cinna }) => {
    const { fake, agentId } = await arrangeEngine(cinna)
    const agent = { id: agentId }
    const briefChatId = await seedBriefChat(cinna, agent.id)

    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    const page = cinna.page
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await answerAgentsFolder(cinna)

    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await page.locator('.app-sidebar-wrap').getByText(CHAT_TITLE, { exact: true }).click()
    const card = page.getByRole('group', { name: 'Build brief', exact: true })
    await expect(card).toBeVisible()
    await expect(card.getByText(BRIEF_SUMMARY, { exact: true })).toBeVisible()
    await expect(card.getByText(BRIEF_PROMPT, { exact: true })).toBeVisible()
    await expect(card.getByText('Not needed now: Published dashboards', { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Keep talking', exact: true })).toBeVisible()

    await card.getByRole('button', { name: 'Start building', exact: true }).click()

    // A new chat, its first message the brief, answered by the agent.
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-message-markdown]').filter({ hasText: BRIEF_PROMPT })).toHaveCount(1)
    const chats = await page.evaluate(() => window.api.chat.list())
    const building = chats.filter((c) => c.id !== briefChatId && c.agentId === agent.id)
    expect(building).toHaveLength(1)
    const full = await page.evaluate((id) => window.api.chat.get(id), building[0].id)
    expect(full?.guidedBuild).toBe(false)
    expect(full?.messages.find((m) => m.role === 'user')?.content).toBe(BUILD_MESSAGE)
    expect(fake.received('session/prompt')).toHaveLength(1)
    expect(splitTurnHeader(promptText(fake, 0)).prompt).toBe(BUILD_MESSAGE)

    // The agent no longer reads as unbuilt: no invitation, and the old brief is a record.
    await expect.poll(async () => (await page.evaluate(() => window.api.localAgents.list())).agents.find((a) => a.id === agent.id)?.unbuilt).toBe(false)
    await openAgent(page, AGENT)
    await expect(composer(page)).toBeVisible()
    await expect(invitation(page)).toHaveCount(0)

    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await page.locator('.app-sidebar-wrap').getByText(CHAT_TITLE, { exact: true }).click()
    await expect(page.getByRole('group', { name: 'Build brief', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start building', exact: true })).toHaveCount(0)
  })
})
