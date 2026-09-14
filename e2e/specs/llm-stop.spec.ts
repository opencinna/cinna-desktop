import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Stop, pressed in an LLM chat while the reply is still streaming.
 *
 * Before the fix the adapter's abort made `_runStreamLoop` return having posted
 * nothing, so the chat sat in the streaming state — the composer offering only
 * Stop — until the user switched chats, and the text they had watched arrive
 * was never saved. Now the round's partial reply is saved and the port gets
 * `done {stopReason: 'canceled'}`.
 *
 * ## How the reply is held open
 *
 * An Ollama credential is keyless and keeps its host, and its chats stream
 * through the OpenAI adapter against `<host>/v1`. So the "model" is a
 * `node:http` server on a port this spec owns: `/api/tags` lists one model, and
 * `POST /v1/chat/completions` writes two SSE chunks and then **never finishes**.
 * Nothing but the client can end that response, which is what makes Stop land
 * mid-reply every time, with no timing involved — and the server seeing its
 * socket closed by the client is the witness that Stop aborted the request
 * rather than the stream happening to end. Nothing leaves the machine.
 *
 * Composer buttons use their accessible names. The sidebar's interrupt
 * action also contains a square icon, including when its spinner is showing,
 * so an icon-only locator would select both unrelated controls.
 *
 * ## What it does not cover
 *
 * A stop during a tool round (the skipped calls' `toolError` rows), an agent
 * chat's Stop, and the pre-fix behaviour — `src/` is not reverted from a spec,
 * so this was not run against the old code.
 */

const MODEL = 'qwen3:8b'
const PROMPT = 'Count slowly to ten.'
/** What streams before the hold. The rest of the count is never sent. */
const CHUNKS = ['Counting slowly: ', 'one, two, three,']
const PARTIAL = CHUNKS.join('')

/** What the fake model has seen, for the spec to read. Reset per test. */
const model = { streams: 0, closedByClient: 0, open: [] as ServerResponse[] }

function fakeOllama(): Server {
  return createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
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
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw || '{}') as { stream?: boolean }
        if (!body.stream) {
          // Nothing in this spec asks for one (titles are switched off); answer
          // plainly rather than hold a request nobody will stop.
          res.statusCode = 400
          res.end(JSON.stringify({ error: { message: 'the fake only streams' } }))
          return
        }
        model.streams += 1
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        for (const content of CHUNKS) {
          const chunk = {
            id: 'chatcmpl-e2e',
            object: 'chat.completion.chunk',
            created: 1,
            model: MODEL,
            choices: [{ index: 0, delta: { content }, finish_reason: null }]
          }
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
        model.open.push(res)
        // `res`, not `req`: the request's own `close` fires once its body is read.
        res.on('close', () => {
          if (!res.writableEnded) model.closedByClient += 1
        })
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
  for (const res of model.open) res.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/**
 * A keyless credential and a default chat mode on it, then a restart —
 * credentials and modes seeded over IPC are stale in the renderer until then.
 * Titles are off so the only model call is the turn under test.
 */
async function arrange(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(
    async ({ host, modelId }) => {
      await window.api.settings.set('autoChatTitles', false)
      const { id } = await window.api.providers.upsert({
        type: 'ollama',
        name: 'Ollama',
        baseUrl: host,
        enabled: true
      })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId, isDefault: true })
    },
    { host, modelId: MODEL }
  )
  await cinna.relaunch()
  await cinna.skipOnboarding()
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
  model.streams = 0
  model.closedByClient = 0
  await arrange(cinna)
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
    expect(model.streams).toBe(1)
    expect(model.closedByClient).toBe(0)
  })

  await test.step('Stop aborts the request, and the composer offers Send again', async () => {
    await stop.click()
    await expect.poll(() => model.closedByClient, { message: 'the model request was aborted' }).toBe(1)
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
    expect(model.streams).toBe(1)
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
