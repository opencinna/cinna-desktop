import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Driver readiness, phase 2 of the agent runtime plan: **the composer refuses**
 * a direct send to an agent whose driver has said it cannot take a turn, says
 * why, and lets the user ask again.
 *
 * ## What this pins
 *
 * One hand-added A2A agent whose card URL points at a loopback port nobody is
 * listening on, and then — on the same port — a minimal fake A2A agent.
 *
 * 1. `agents.list()` answers `readiness: null` at first and kicks a background
 *    check; the check lands as `unreachable` with a reason sentence. Polled over
 *    IPC, never slept on.
 * 2. Agent page → Settings → Connection shows the reason beside **Test
 *    Connection** (read from the list row, not hard-coded here). The header
 *    shows a stable A2A type icon instead of a readiness dot.
 * 3. The new-chat composer, with that agent as the single agent (the routing
 *    badge reads `Remote agent connection`): **Send is disabled**, its accessible
 *    description is the reason, **Check again** is offered, and Enter creates
 *    no chat and leaves the typed message in the textarea.
 * 4. Recovery: the fake agent starts on the port, **Check again** is pressed,
 *    the reason and the button leave, Send enables, and sending creates the
 *    chat whose reply — a string that is not in the prompt — arrives from the
 *    fake.
 *
 * Not pinned: the push (`agent:readiness-changed`) on its own. Every renderer
 * surface here also re-reads the list for another reason — Check again's
 * `onSettled`, a query observer mounting — so a broken push would still pass.
 * And recovery relies on Check again only because the A2A readiness TTL is a
 * minute (`REMOTE_READINESS_TTL_MS`) and this test reaches that step well
 * inside it; a background re-check would flip the same state.
 *
 * ## Why the dead port is made this way
 *
 * A port the OS just handed to a `node:net` server that has since closed:
 * nothing listens there, so the card fetch fails at once with `ECONNREFUSED` —
 * the `unreachable` branch of the A2A driver, with its connection-refused
 * sentence. A routable-but-silent address would instead wait out the 5s
 * readiness timeout and test a different sentence, and a fixed low port (`:1`)
 * could not be bound again by the test for the recovery step. The same number
 * is reused for the fake, so the agent row never changes between steps 3 and 4.
 *
 * ## Negative control
 *
 * Deleting the `refusal !== null ||` term from Send's `disabled` in
 * `src/renderer/src/components/chat/ChatInput.tsx` fails step 3 at
 * `toBeDisabled()`: the typed text alone enables Send. Verified against a copy
 * of the repo with that line removed and its own build. The spec failed there
 * and nowhere earlier, with Send `enabled` while its `aria-describedby` and
 * `title` still carried the reason, so that one term is what the assertion
 * guards. Enter is guarded separately (`refusalRef` in `handleSend`), which is
 * why the chat-count and textarea checks are not what fail.
 */

const AGENT = 'Dead Agent'
const MESSAGE = 'Are you there?'
/** Only the fake produces this; it is not in the prompt. */
const REPLY = 'Fake agent answering: kumquat-7141'

/** A loopback port that nobody is listening on, and that this process can bind again. */
async function closedPort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())))
  return port
}

/**
 * The smallest A2A agent the desktop's client accepts: a v0.3 card with
 * streaming off, and a JSON-RPC `message/send` answered with one agent message.
 */
async function startFakeAgent(port: number): Promise<{ server: Server; sends: string[] }> {
  const sends: string[] = []
  const card = {
    name: AGENT,
    description: 'A fake A2A agent owned by driver-readiness.spec.ts',
    url: `http://127.0.0.1:${port}/a2a`,
    protocolVersion: '0.3.0',
    version: '1.0.0',
    capabilities: { streaming: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: []
  }
  const server = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(card))
      return
    }
    if (req.method === 'POST' && req.url === '/a2a') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const rpc = JSON.parse(body) as { id: number | string; method: string }
        sends.push(rpc.method)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              kind: 'message',
              messageId: 'e2e-reply-1',
              role: 'agent',
              contextId: 'e2e-context-1',
              parts: [{ kind: 'text', text: REPLY }]
            }
          })
        )
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return { server, sends }
}

/** Sidebar agent → its own Settings → Connection. */
async function openAgentsSettings(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Connection', exact: true }).click()
  const heading = page.getByRole('heading', { level: 1, name: AGENT, exact: true })
  await expect(heading.getByTitle('A2A agent')).toBeVisible()
  await expect(heading.locator('svg.lucide-circle')).toHaveCount(0)
}

async function chatCount(page: Page): Promise<number> {
  return (await page.evaluate(() => window.api.chat.list())).length
}

test('an unreachable A2A agent is refused in the composer, and Check again lets it through once it answers', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const port = await closedPort()
  let fake: { server: Server; sends: string[] } | null = null

  try {
    await cinna.skipOnboarding()
    const created = await cinna.page.evaluate(
      (url) =>
        window.api.agents.upsert({
          name: 'Dead Agent',
          protocol: 'a2a',
          cardUrl: `${url}/.well-known/agent-card.json`,
          endpointUrl: `${url}/a2a`
        }),
      `http://127.0.0.1:${port}`
    )
    if (!created.success || !created.id) throw new Error(`agents.upsert failed: ${created.error}`)
    const agentId = created.id
    // The composer's agent query is stale for a row seeded over IPC; a restart
    // is the reliable arrangement. It also empties main's in-memory readiness,
    // so the check below is one this launch's list call started.
    await cinna.relaunch()
    await cinna.skipOnboarding()

    const readiness = await test.step('the list reports the agent unreachable', async () => {
      const page = cinna.page
      const readOnce = (): Promise<{
        state: string
        reason: string | null
        detail?: string | null
      } | null> =>
        page.evaluate(
          async (id) => (await window.api.agents.list()).find((a) => a.id === id)?.readiness ?? null,
          agentId
        )
      await expect.poll(readOnce, { timeout: 20_000 }).toMatchObject({ state: 'unreachable' })
      const answer = await readOnce()
      expect(answer?.reason, 'an unreachable answer carries a sentence').toEqual(expect.any(String))
      return { state: answer!.state, reason: answer!.reason!, detail: answer!.detail ?? null }
    })

    await test.step('agent Settings → Connection shows the readiness reason and a stable type icon', async () => {
      const page = cinna.page
      await openAgentsSettings(cinna)
      const testConnection = page.getByRole('button', { name: 'Test Connection', exact: true })
      await expect(testConnection).toBeVisible()
      // The row Test Connection sits in: "beside Test" is being in that row.
      const row = testConnection.locator('..')
      // The row shows the short reason; its tooltip is the underlying error the
      // driver kept (`detail`), and only falls back to the reason without one.
      const reasonText = row.getByText(readiness.reason, { exact: true })
      await expect(reasonText).toBeVisible()
      await expect(reasonText).toHaveAttribute('title', readiness.detail ?? readiness.reason)

      await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    })

    await test.step('the composer refuses a direct send, with the reason and Check again', async () => {
      const page = cinna.page
      const composer = input(page)
      await composer.fill('@')
      const mentions = page.getByRole('listbox', { name: 'Agents and MCP servers' })
      await mentions.getByRole('option').filter({ hasText: AGENT }).click()
      await expect(page.getByRole('status', { name: 'Remote agent connection' })).toBeVisible()

      await composer.fill(MESSAGE)
      const send = page.getByRole('button', { name: 'Send', exact: true })
      await expect(send).toBeDisabled()
      await expect(send).toHaveAccessibleDescription(readiness.reason)
      await expect(page.getByRole('status').filter({ hasText: readiness.reason })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()

      const before = await chatCount(page)
      await composer.press('Enter')
      await expect(composer).toHaveValue(MESSAGE)
      expect(await chatCount(page), 'Enter on a refused composer creates no chat').toBe(before)
      await expect(send).toBeDisabled()
    })

    await test.step('once the agent answers, Check again clears the refusal and the send goes through', async () => {
      const page = cinna.page
      fake = await startFakeAgent(port)
      const before = await chatCount(page)

      await page.getByRole('button', { name: 'Check again', exact: true }).click()
      const send = page.getByRole('button', { name: 'Send', exact: true })
      await expect(send).toBeEnabled()
      await expect(page.getByRole('button', { name: 'Check again' })).toHaveCount(0)
      await expect(page.getByRole('status').filter({ hasText: readiness.reason })).toHaveCount(0)
      await expect(send).not.toHaveAttribute('aria-describedby')
      await expect(input(page)).toHaveValue(MESSAGE)

      await input(page).press('Enter')
      await expect(page.getByText(REPLY, { exact: true })).toBeVisible()
      expect(await chatCount(page), 'the send created the chat').toBe(before + 1)
      expect(fake.sends, 'the reply came from the fake over message/send').toEqual(['message/send'])
    })
  } finally {
    // Assigned inside a step callback, which narrowing does not follow.
    const server = (fake as { server: Server } | null)?.server
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function input(page: Page) {
  return page.getByRole('combobox', { name: 'Type a message...', exact: true })
}
