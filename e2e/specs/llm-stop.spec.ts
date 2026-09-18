import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'

/**
 * Plain chats run on ACP. The scripted runtime emits two text chunks, then
 * waits for session/cancel; its wire log proves Stop canceled the live turn.
 * Real launcher, IPC, transcript persistence and UI; no model API or credentials.
 * Tool-round cancellation is covered separately.
 */

const MODEL = 'qwen3:8b'
const PROMPT = 'Count slowly to ten.'
/** What streams before the hold. The rest of the count is never sent. */
const CHUNKS = ['Counting slowly: ', 'one, two, three,']
const PARTIAL = CHUNKS.join('')

function fakeOllama(): Server {
  return createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }]
          })
        )
        return
      }
      if (req.url === '/api/version') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ version: '0.6.2' }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
}

let server: Server
let host = ''

test.beforeAll(async () => {
  server = fakeOllama()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/**
 * A keyless credential and a default chat mode on it, then a restart —
 * credentials and modes seeded over IPC are stale in the renderer until then.
 * Titles are off so the only runtime prompt is the turn under test.
 */
async function arrange(cinna: CinnaApp): Promise<FakeAcpEngine> {
  await cinna.skipOnboarding()
  const fake = await installFakeAcpEngine(cinna, { prompt: {
    emit: [...CHUNKS.map((text) => ({ kind: 'update' as const,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })),
      { kind: 'awaitCancel' }], response: { stopReason: 'cancelled' }
  } })
  await cinna.page.evaluate(
    async ({ host, modelId }) => {
      await window.api.settings.set('autoChatTitles', false)
      const { id } = await window.api.providers.upsert({
        type: 'ollama',
        name: 'Ollama',
        baseUrl: host,
        enabled: true
      })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId, engine: 'opencode', toolPolicy: 'none', isDefault: true })
    },
    { host, modelId: MODEL }
  )
  await cinna.relaunch()
  await cinna.skipOnboarding()
  return fake
}

/** The only chat's persisted rows, as role and content. */
async function persisted(cinna: CinnaApp): Promise<{ role: string; content: string }[]> {
  return cinna.page.evaluate(async () => {
    const [chat] = await window.api.chat.list()
    if (!chat) return []
    const detail = await window.api.chat.get(chat.id)
    return (detail?.messages ?? []).map((m) => ({ role: m.role, content: m.content }))
  })
}

test('Stop mid-reply ends streaming, and the part that streamed stays in the transcript', async ({
  cinna
}) => {
  test.setTimeout(90_000)
  const fake = await arrange(cinna)
  const page = cinna.page
  // By role, not placeholder: for ~260ms after the first send the chat curtain
  // (`ChatTransition`) keeps an inert, aria-hidden clone of the new-chat
  // composer, placeholder included, and this spec reaches the composer again
  // inside that window.
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  const send = page.getByRole('button', { name: 'Send', exact: true })
  const reply = page.getByRole('paragraph').filter({ hasText: PARTIAL })

  await test.step('the reply streams and the composer offers only Stop', async () => {
    await input.fill(PROMPT)
    await input.press('Enter')
    await expect(reply).toHaveText(PARTIAL, { timeout: 20_000 })
    await expect(stop).toBeEnabled()
    await expect(send).toHaveCount(0)
    expect(fake.received('session/prompt')).toHaveLength(1)
    expect(fake.received('session/cancel')).toHaveLength(0)
    expect(JSON.stringify(fake.received('session/prompt')[0].params?.prompt)).toContain(PROMPT)
    const conductor = await cinna.page.evaluate(async () => {
      const [chat] = await window.api.chat.list()
      const detail = await window.api.chat.get(chat.id)
      return (await window.api.agents.list()).find((agent) => agent.id === detail?.agentId)
    })
    expect(conductor).toMatchObject({ conductor: true, name: 'OpenCode' })
  })

  await test.step('Stop aborts the request, and the composer offers Send again', async () => {
    await stop.click()
    await expect.poll(() => fake.received('session/cancel').length, { message: 'the runtime received Stop' }).toBe(1)
    expect(fake.received('session/cancel')[0].params?.sessionId).toBe(fake.received('session/prompt')[0].params?.sessionId)
    await expect(stop).toHaveCount(0)
    await expect(send).toBeDisabled()
    await input.fill('And the rest?')
    await expect(send).toBeEnabled()
    await input.fill('')
  })

  await test.step('the partial reply is saved and stays on screen after the refetch', async () => {
    await expect
      .poll(() => persisted(cinna))
      .toEqual([
        { role: 'user', content: PROMPT },
        { role: 'assistant', content: PARTIAL }
      ])
    await expect(reply).toHaveText(PARTIAL)
    // A stop is not a failure: no error row, no banner.
    await expect(page.getByRole('alert')).toHaveCount(0)
    // No second request was made on the user's behalf.
    expect(fake.received('session/prompt')).toHaveLength(1)
  })

  await test.step('after a restart the chat reopens with the partial reply', async () => {
    await cinna.relaunch()
    await cinna.skipOnboarding()
    const reopened = cinna.page
    await reopened.getByText(PROMPT, { exact: true }).first().click()
    await expect(reopened.getByRole('paragraph').filter({ hasText: PARTIAL })).toHaveText(PARTIAL)
    await expect(reopened.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  })
})
