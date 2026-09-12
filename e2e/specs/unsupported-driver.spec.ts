import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

const AGENT = 'Future Driver Agent'
const TITLE = 'Unsupported driver conversation'
const DRIVER = 'future-driver-v99'
const REASON = 'This agent does not name a driver supported by this version of Cinna.'
const DRAFT = 'Please verify the launch notes.'
const MAIN_PROMPT = 'Verify these notes through the main execution boundary.'

/** A valid A2A endpoint makes any accidental source-based fallback observable. */
async function serve(): Promise<{ server: Server; host: string; posts: string[] }> {
  let host = ''
  const posts: string[] = []
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: AGENT, description: AGENT, url: `${host}/a2a`,
        protocolVersion: '0.3.0', version: '1.0.0', capabilities: { streaming: false },
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] }))
      return
    }
    if (req.method === 'POST') {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        posts.push(raw)
        const rpc = JSON.parse(raw) as { id: string | number }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
          kind: 'message', messageId: 'unexpected-fallback', role: 'agent',
          parts: [{ kind: 'text', text: 'Unexpected A2A fallback: maple-9741' }]
        } }))
      })
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve)
  })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { server, host, posts }
}

async function readAgent(cinna: CinnaApp, agentId: string) {
  return cinna.page.evaluate(async (id) => (await window.api.agents.list()).find((row) => row.id === id), agentId)
}

/** Only the fixture-owned DB can represent a driver from a future app version. */
async function setUnknownDriver(cinna: CinnaApp, agentId: string): Promise<void> {
  const changed = await cinna.electronApp.evaluate(({ app }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${app.getPath('userData')}/cinna.db`)
    try { return db.prepare('UPDATE agents SET driver = ? WHERE id = ?').run(input.driver, input.agentId).changes }
    finally { db.close() }
  }, { userData: cinna.sandbox.userData, agentId, driver: DRIVER })
  expect(changed).toBe(1)
}

test('an unknown driver survives restart, remains visible, and refuses UI and main sends without transport fallback', async ({ cinna }) => {
  const fake = await serve()
  try {
    await cinna.skipOnboarding()
    const { agentId, chatId } = await cinna.page.evaluate(async ({ host, name, title }) => {
      await window.api.settings.set('autoChatTitles', false)
      const agent = await window.api.agents.upsert({ name, protocol: 'a2a',
        cardUrl: `${host}/.well-known/agent-card.json`, endpointUrl: `${host}/a2a` })
      if (!agent.success || !agent.id) throw new Error('Could not create fixture agent')
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { title, agentId: agent.id, router: 'direct' })
      await window.api.chat.showInList(chat.id)
      return { agentId: agent.id, chatId: chat.id }
    }, { host: fake.host, name: AGENT, title: TITLE })
    await setUnknownDriver(cinna, agentId)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    expect(await readAgent(cinna, agentId)).toMatchObject({ id: agentId, name: AGENT, source: 'local', driver: DRIVER,
      readiness: { state: 'invalid', reason: REASON },
      capabilities: { streaming: false, cancel: false, sessions: 'none', commands: 'none' } })

    const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
    await cinna.page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1, name: 'Agents', exact: true })).toBeVisible()
    await expect(cinna.page.getByText(AGENT, { exact: true })).toBeVisible()
    await cinna.page.getByRole('button', { name: 'Back', exact: true }).click()
    await cinna.page.getByText(TITLE, { exact: true }).click()
    const input = cinna.page.getByPlaceholder('Type a message...')
    await input.fill(DRAFT)
    const send = cinna.page.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeDisabled()
    await expect(send).toHaveAccessibleDescription(REASON)
    await expect(cinna.page.getByRole('status').filter({ hasText: REASON })).toBeVisible()
    await input.press('Enter')
    await expect(input).toHaveValue(DRAFT)
    expect((await cinna.page.evaluate((id) => window.api.chat.get(id), chatId))?.messages).toEqual([])
    expect(fake.posts).toEqual([])

    // UI refusal is not the main boundary: call the real public API independently.
    // start acknowledges persisted input, then the unsupported driver records failure.
    const runId = await cinna.page.evaluate(({ chatId, content }) => window.api.run.start({ chatId, content }),
      { chatId, content: MAIN_PROMPT })
    expect(runId).toEqual(expect.any(String))
    await expect.poll(async () => {
      const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
      return { activeRunId: chat?.activeRunId ?? null, roles: chat?.messages.map((row) => row.role) }
    }).toEqual({ activeRunId: null, roles: ['user', 'error'] })
    const saved = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
    expect(saved?.messages[0].content).toBe(MAIN_PROMPT)
    expect(JSON.parse(saved!.messages[1].content)).toMatchObject({ short: REASON })
    expect(fake.posts).toEqual([])

    await cinna.relaunch()
    await cinna.skipOnboarding()
    expect(await readAgent(cinna, agentId)).toMatchObject({ driver: DRIVER, readiness: { state: 'invalid', reason: REASON } })
    const restarted = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
    expect(restarted?.messages).toEqual(saved?.messages)
    await cinna.page.getByText(TITLE, { exact: true }).click()
    await expect(cinna.page.getByText(REASON, { exact: true })).toHaveCount(2)
    await expect(cinna.page.getByText(REASON, { exact: true }).first()).toBeVisible()
    await expect(cinna.page.getByText('Unexpected A2A fallback: maple-9741', { exact: true })).toHaveCount(0)
    expect(fake.posts).toEqual([])
  } finally {
    fake.server.closeAllConnections()
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})
