import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { linkSandboxAccount } from '../fixtures/jobRemoteService'

/**
 * Improvement request — the composer's `[+]` → `Actions` → `Improvement
 * request…` on a chat with a cloud **bundle consumer install**
 * (`ImprovementRequestDialog.tsx`, `improvementRequestService.ts`), against a
 * loopback fake core. No model.
 *
 * ## What is real, and what is seeded
 *
 * The fake serves the remote-agents listing (`GET /api/v1/external/agents`),
 * one A2A agent card + `message/send` per remote agent, core's pre-flight
 * (`GET /api/v1/sessions/<id>/improvement-context`) and the create
 * (`POST /api/v1/improvement-requests`). The remote rows are written by the
 * product's own `agents.syncRemote()`; the first chat's session id is written
 * by a real A2A turn sent from the composer (the fake answers with a `taskId`,
 * which main keeps in `a2a_sessions.task_id`). Only the second agent of the
 * picker test is seeded: an attached agent's session row inserted into the
 * sandbox DB, because answering as a second agent of a chat needs routing that
 * is not what is under test.
 *
 * ## What it does not prove
 *
 * That real cinna-core accepts the request, picks the recipient, or captures
 * the transcript — `live-improvement-request.spec.ts` does that.
 */

const BUNDLE_A = 'Order Desk'
const BUNDLE_B = 'Refund Desk'
const OWN = 'My Own Cloud Agent'
const PUBLISHER = 'Dana Publisher'
const BUNDLE_ID = 'com.acme.order-desk'

interface FakeAgent {
  name: string
  targetId: string
  sessionId: string
  bundle: boolean
}

interface Created {
  session_id: string
  comment: string
  include_memory: boolean
}

interface FakeCore {
  host: string
  agents: FakeAgent[]
  contexts: string[]
  created: Created[]
  /** When set, the create answers 429 with this as core's `detail`. */
  refuse: string | null
  close(): Promise<void>
}

async function fakeCore(): Promise<FakeCore> {
  const agents: FakeAgent[] = [
    { name: BUNDLE_A, targetId: randomUUID(), sessionId: randomUUID(), bundle: true },
    { name: BUNDLE_B, targetId: randomUUID(), sessionId: randomUUID(), bundle: true },
    { name: OWN, targetId: randomUUID(), sessionId: randomUUID(), bundle: false }
  ]
  const core: FakeCore = {
    host: '',
    agents,
    contexts: [],
    created: [],
    refuse: null,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const send = (status: number, value: unknown): void => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    }
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.method === 'GET' && url.pathname === '/api/v1/external/agents') {
        send(200, {
          targets: agents.map((agent) => ({
            target_type: 'agent',
            target_id: agent.targetId,
            name: agent.name,
            description: `${agent.name} on the fake core.`,
            entrypoint_prompt: null,
            example_prompts: [],
            session_mode: null,
            ui_color_preset: null,
            agent_card_url: `${core.host}/agents/${agent.targetId}/.well-known/agent-card.json`,
            protocol_versions: ['0.3.0'],
            metadata: agent.bundle
              ? { bundle_id: BUNDLE_ID, bundle_uuid: randomUUID(), is_publisher_install: false }
              : // What an agent the user created on the server carries: a bundle id, no bundle uuid.
                { bundle_id: 'com.me.own', bundle_uuid: null, is_publisher_install: false }
          }))
        })
        return
      }
      const agentRoute = url.pathname.match(/^\/agents\/([0-9a-f-]+)\/(\.well-known\/agent-card\.json|a2a)$/)
      const agent = agentRoute ? agents.find((a) => a.targetId === agentRoute[1]) : undefined
      if (agentRoute && agent && req.method === 'GET' && agentRoute[2] !== 'a2a') {
        send(200, {
          name: agent.name,
          description: agent.name,
          url: `${core.host}/agents/${agent.targetId}/a2a`,
          protocolVersion: '0.3.0',
          version: '1.0.0',
          capabilities: { streaming: false },
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: []
        })
        return
      }
      if (agentRoute && agent && req.method === 'POST' && agentRoute[2] === 'a2a') {
        const rpc = JSON.parse(body) as { id: number | string }
        send(200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            kind: 'message',
            messageId: randomUUID(),
            role: 'agent',
            contextId: `ctx-${agent.sessionId}`,
            taskId: agent.sessionId,
            parts: [{ kind: 'text', text: `${agent.name} here: ok.` }]
          }
        })
        return
      }
      const context = url.pathname.match(/^\/api\/v1\/sessions\/([0-9a-f-]+)\/improvement-context$/)
      if (context && req.method === 'GET') {
        const owner = agents.find((a) => a.sessionId === context[1])
        core.contexts.push(context[1])
        if (!owner) return send(404, { detail: 'Session not found' })
        send(200, {
          eligible: true,
          reason: null,
          is_shared_externally: true,
          recipient_display: PUBLISHER,
          target_agent_name: owner.name,
          bundle_id: BUNDLE_ID,
          installed_version: '1.2',
          message_count: 2,
          existing_request_count: 0
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/improvement-requests') {
        core.created.push(JSON.parse(body) as Created)
        if (core.refuse) return send(429, { detail: core.refuse })
        send(201, { id: randomUUID() })
        return
      }
      send(404, { detail: 'No fixture route for this request' })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  core.host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return core
}

let core: FakeCore
test.beforeEach(async () => {
  core = await fakeCore()
})
test.afterEach(async () => {
  await core?.close()
})

/** Onboarding skipped, the profile linked to the fake, the remote rows synced by the product, restarted. */
async function arrange(cinna: CinnaApp): Promise<Record<string, string>> {
  await cinna.skipOnboarding()
  await linkSandboxAccount(cinna, core.host)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  const synced = await cinna.page.evaluate(() => window.api.agents.syncRemote())
  expect(synced).toMatchObject({ success: true, synced: 3 })
  const rows = await cinna.page.evaluate(() => window.api.agents.list())
  const ids: Record<string, string> = {}
  for (const agent of core.agents) {
    const row = rows.find((r) => r.name === agent.name)
    expect(row, `${agent.name} was not synced`).toMatchObject({ source: 'remote', remoteTargetType: 'agent' })
    ids[agent.name] = row!.id
  }
  // The renderer reads the profile's server at startup; restart so it and the agent list are fresh.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  return ids
}

/** The agent's page composer sends `text`, which starts a new chat; waits for the reply. */
async function chatWith(cinna: CinnaApp, name: string, text: string): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(text)
  await input.press('Enter')
  await expect(page.getByText(`${name} here: ok.`, { exact: true })).toBeVisible({ timeout: 30_000 })
}

async function openPlus(cinna: CinnaApp) {
  await cinna.page.getByRole('button', { name: 'Add to chat', exact: true }).click()
  const menu = cinna.page.getByRole('menu', { name: 'Add to chat', exact: true })
  await expect(menu).toBeVisible()
  return menu
}

async function openImprovementDialog(cinna: CinnaApp) {
  const menu = await openPlus(cinna)
  await menu.getByRole('menuitem', { name: 'Actions', exact: true }).click()
  await menu.getByRole('menuitem', { name: 'Improvement request…', exact: true }).click()
  const dialog = cinna.page.getByRole('dialog', { name: 'Improvement request', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

async function chatIdStartedWith(cinna: CinnaApp, text: string): Promise<string> {
  let id: string | null = null
  await expect
    .poll(async () => {
      id = await cinna.page.evaluate(async (first) => {
        for (const row of await window.api.chat.list()) {
          const chat = await window.api.chat.get(row.id)
          if (chat?.messages.find((m) => m.role === 'user')?.content === first) return row.id
        }
        return null
      }, text)
      return id
    })
    .not.toBeNull()
  return id!
}

test('an own cloud agent offers no Actions; a bundle install offers them only once it has replied', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna)

  await test.step('the bundle agent’s new-chat composer: no Actions before any reply', async () => {
    await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
    await cinna.page.getByRole('button', { name: BUNDLE_A, exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1 })).toHaveText(BUNDLE_A)
    const menu = await openPlus(cinna)
    await expect(menu.getByRole('menuitem').first()).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Actions', exact: true })).toHaveCount(0)
    await cinna.page.keyboard.press('Escape')
  })

  await test.step('an agent the user created on the server: replied, and still no Actions', async () => {
    await chatWith(cinna, OWN, 'Hello own agent')
    const targets = await cinna.page.evaluate((id) => window.api.improvementRequests.targets(id), await chatIdStartedWith(cinna, 'Hello own agent'))
    expect(targets).toEqual([])
    const menu = await openPlus(cinna)
    await expect(menu.getByRole('menuitem').first()).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Actions', exact: true })).toHaveCount(0)
    await cinna.page.keyboard.press('Escape')
  })

  await test.step('the bundle install, once it has replied: Actions › Improvement request…', async () => {
    await chatWith(cinna, BUNDLE_A, 'Hello order desk')
    const menu = await openPlus(cinna)
    await expect(menu.getByRole('menuitem', { name: 'Actions', exact: true })).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Actions', exact: true }).click()
    await expect(menu.getByRole('menuitem')).toHaveText(['Improvement request…'])
    expect(core.contexts).toEqual([])
  })
})

test('one bundle agent: the publisher named, Send needs a message, memory unticked is sent as false, the toast names the recipient', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const order = core.agents[0]
  await chatWith(cinna, BUNDLE_A, 'Where is order 42?')
  const dialog = await openImprovementDialog(cinna)

  await test.step('the pre-flight: the agent as its chip, the publisher in bold, the message count, no callout', async () => {
    await expect(dialog.getByRole('combobox', { name: 'Agent session' })).toHaveCount(0)
    await expect(dialog.locator('[data-improvement-agent]')).toHaveText(/^Order Desk(just now|\d+ min ago)$/)
    await expect(dialog.locator('[data-improvement-recipient]')).toHaveText(PUBLISHER)
    const disclosure = dialog.locator('[data-improvement-context]')
    await expect(disclosure).toContainText(`Goes to ${PUBLISHER}, who publishes the bundle this agent was installed from.`)
    await expect(disclosure).toContainText('2 messages will be captured as they are right now. Continuing the conversation afterwards won’t change what is shared.')
    await expect(dialog.getByText('This cannot be undone.', { exact: false })).toHaveCount(0)
    expect(core.contexts).toEqual([order.sessionId])
  })

  const send = dialog.getByRole('button', { name: 'Send request', exact: true })
  const message = dialog.getByLabel('Message', { exact: true })
  const memory = dialog.getByRole('checkbox', { name: 'Include MEMORY files of this agent' })

  await test.step('Send stays disabled until the message has more than blanks; memory starts ticked', async () => {
    await expect(message).toBeFocused()
    await expect(send).toBeDisabled()
    await message.fill('   ')
    await expect(send).toBeDisabled()
    await message.fill('  It should quote the tracking number.  ')
    await expect(send).toBeEnabled()
    await expect(memory).toBeChecked()
  })

  await test.step('untick memory, Send: the dialog closes, the toast names the publisher, core got include_memory false', async () => {
    await memory.click()
    await expect(memory).not.toBeChecked()
    await send.click()
    await expect(dialog).toHaveCount(0)
    await expect(cinna.page.getByRole('status').filter({ hasText: 'Improvement request sent to' })).toHaveText(
      `Improvement request sent to ${PUBLISHER}.`
    )
    expect(core.created).toEqual([
      { session_id: order.sessionId, comment: 'It should quote the tracking number.', include_memory: false }
    ])
  })
})

test('two bundle agents: the picker sends the chosen session; a 429 shows core’s sentence and keeps the dialog and the text', async ({ cinna }) => {
  test.setTimeout(150_000)
  const ids = await arrange(cinna)
  const [order, refund] = core.agents
  const first = 'Two desks, one chat'
  await chatWith(cinna, BUNDLE_A, first)
  const chatId = await chatIdStartedWith(cinna, first)

  await test.step('arrange: Refund Desk attached to the chat, with a cloud session of its own (seeded)', async () => {
    expect(await cinna.page.evaluate(([c, a]) => window.api.chat.addOnDemandAgent(c, a), [chatId, ids[BUNDLE_B]])).toMatchObject({ success: true })
    await cinna.electronApp.evaluate(({ app }, row) => {
      if (app.getPath('userData') !== row.userData) throw new Error('Not the isolated test profile')
      const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
      const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(`${row.userData}/cinna.db`, { fileMustExist: true })
      const now = Math.floor(Date.now() / 1000)
      try {
        db.prepare(`INSERT INTO a2a_sessions (id, chat_id, agent_id, context_id, task_id, task_state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`).run(`e2e-${row.taskId}`, row.chatId, row.agentId, `ctx-${row.taskId}`, row.taskId, now, now)
      } finally { db.close() }
    }, { userData: cinna.sandbox.userData, chatId, agentId: ids[BUNDLE_B], taskId: refund.sessionId })
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
    await cinna.page.locator(`[data-chat-row="${chatId}"]`).click()
    await expect(cinna.page.getByText(`${BUNDLE_A} here: ok.`, { exact: true })).toBeVisible()
  })

  const dialog = await openImprovementDialog(cinna)
  const picker = dialog.getByRole('combobox', { name: 'Agent session' })
  const message = dialog.getByLabel('Message', { exact: true })
  const send = dialog.getByRole('button', { name: 'Send request', exact: true })

  await test.step('the picker lists both, the chat’s own agent first and selected', async () => {
    await expect(picker.locator('option')).toHaveText([
      /^Order Desk · (just now|\d+ min ago)$/,
      /^Refund Desk · (just now|\d+ min ago)$/
    ])
    await expect(picker).toHaveValue(ids[BUNDLE_A])
    await expect(dialog.locator('[data-improvement-context]')).toContainText(`Goes to ${PUBLISHER}`)
  })

  await test.step('pick Refund Desk: the pre-flight asks about its session', async () => {
    await message.fill('Refunds should name the policy.')
    await picker.selectOption(ids[BUNDLE_B])
    await expect.poll(() => core.contexts.at(-1)).toBe(refund.sessionId)
    await expect(dialog.locator('[data-improvement-recipient]')).toHaveText(PUBLISHER)
    await expect(message).toHaveValue('Refunds should name the policy.')
  })

  const LIMIT = 'You have already submitted 5 improvement requests for this session, which is the limit.'
  await test.step('core answers 429: its sentence under the buttons, the dialog and the text stay, nothing toasts', async () => {
    core.refuse = LIMIT
    await send.click()
    await expect(dialog.getByRole('alert')).toHaveText(LIMIT)
    await expect(dialog).toBeVisible()
    await expect(message).toHaveValue('Refunds should name the policy.')
    await expect(send).toBeEnabled()
    await expect(cinna.page.getByRole('status').filter({ hasText: 'Improvement request sent' })).toHaveCount(0)
    expect(core.created).toEqual([{ session_id: refund.sessionId, comment: 'Refunds should name the policy.', include_memory: true }])
    expect(core.created.some((c) => c.session_id === order.sessionId)).toBe(false)
  })
})
