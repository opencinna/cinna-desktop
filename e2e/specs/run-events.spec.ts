import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { fakeEngineCalls, installFakeEngine } from '../fixtures/fakeEngine'

/**
 * A folder agent that stops mid-turn to ask — permission, then a question —
 * and the user answering from the chat.
 *
 * ## What is real and what is not
 *
 * The **engine** is `e2e/fixtures/fakeEngine.mjs`, started by the app through
 * the engine path setting, because a real `opencode` needs a real model to
 * decide to ask. It plays the engine's own event frames (the golden fixtures'
 * shapes) and logs what it is sent. Everything else is the product: engine
 * manager, turn runner, pending-request registry, the turn's `MessagePort`,
 * the preload `isRunEvent` guard, `useChatStream`, the chat store and the
 * blocks. The model catalogue is a fake Ollama `/api/tags` on a port this spec
 * owns, so the config generator has a model to give the agent and nothing
 * leaves the machine.
 *
 * ## The registry poll is pinned empty, on purpose
 *
 * A block can be made answerable by two sources: the stream's `needs_input`
 * (phase 1) and `useAgentRequests` polling `agent:pending-requests`. Either
 * alone would pass a test that allowed both, so the poll's handler is replaced
 * with one answering `[]` — the only thing left that can make a block live is
 * the `needs_input` that crossed the port. The *answer* path is untouched:
 * `agent:answer-request` resolves against the real registry, and the fake
 * engine's log is the witness that the reply reached the engine in its own
 * vocabulary. The poll is restored by the restart before the replay step.
 *
 * ## What it proves
 *
 * - The ask is rendered live while the turn is still open, with its controls.
 * - The user's answer reaches the engine as OpenCode's own reply body
 *   (`{reply: 'once'}` / `{answers: [['Teal']]}`), and the turn then finishes.
 * - The block stops offering controls once answered.
 * - The decision is persisted in the transcript, and a replayed block is
 *   read-only after a restart, when no registry entry and no stream exist.
 *
 * ## What it does not
 *
 * The poll path (reload while parked), orchestrated mode (`child` events),
 * *Always allow* and its grant file (`agent-permissions.spec.ts` covers the
 * card; `localAgentTurnRunner.test.ts` the grant), expiry, and abort.
 */

const AGENT = 'Report Builder'
const MODEL = 'qwen3:8b'

/** The prompts pick the fake engine's script; the replies never repeat the answer. */
const PERMISSION_PROMPT = 'Delete the build folder.'
const QUESTION_PROMPT = 'Pick a colour for the report.'

function fakeOllama(): Server {
  return createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(
        JSON.stringify({
          models: [
            {
              name: MODEL,
              model: MODEL,
              details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' }
            }
          ]
        })
      )
      return
    }
    if (req.url === '/api/version') {
      res.end(JSON.stringify({ version: '0.6.2' }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
}

let server: Server
let ollamaHost = ''

test.beforeAll(async () => {
  server = fakeOllama()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  ollamaHost = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/**
 * A folder agent on a keyless credential, the fake engine, and a restart so
 * the renderer's agent query can see the agent. The registry poll is pinned
 * after the restart, because handlers are per process.
 */
async function arrange(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await installFakeEngine(cinna)
  await cinna.page.evaluate(
    async ({ host, model }) => {
      const { id } = await window.api.providers.upsert({
        type: 'ollama',
        name: 'Ollama',
        baseUrl: host,
        enabled: true
      })
      // The Default runtime is the default chat mode's credential and model.
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, isDefault: true })
    },
    { host: ollamaHost, model: MODEL }
  )
  const root = await addAgentRoot(cinna)
  // Description equal to the name, so the sidebar row reads as the name alone.
  await createFolderAgent(cinna, root, AGENT, AGENT)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await cinna.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agent:pending-requests')
    ipcMain.handle('agent:pending-requests', () => [])
  })
}

/** Agents → the row's chat button → type and send, as a user does. */
async function sendToAgent(cinna: CinnaApp, text: string): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  // Opacity-hidden until hover, but in the tree and clickable.
  await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
  const input = page.getByPlaceholder('Type a message...')
  await input.fill(text)
  await input.press('Enter')
}

/** The assistant parts persisted for the only chat, or [] while none is. */
async function persistedParts(
  cinna: CinnaApp
): Promise<{ kind: string; text: string; toolId?: string }[]> {
  return cinna.page.evaluate(async () => {
    const [chat] = await window.api.chat.list()
    if (!chat) return []
    const detail = await window.api.chat.get(chat.id)
    return (detail?.messages ?? [])
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.parts ?? [])
      .map((p) => ({ kind: p.kind, text: p.text, toolId: p.toolId }))
  })
}

/** Restart, and open the chat from the sidebar by its first message. */
async function reopenChat(cinna: CinnaApp, title: string): Promise<void> {
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.getByText(title, { exact: true }).first().click()
}

/** POSTs the fake engine received on a reply or reject endpoint. */
function replies(cinna: CinnaApp): { path: string; body?: unknown }[] {
  return fakeEngineCalls(cinna)
    .filter((call) => call.method === 'POST' && /\/(reply|reject)$/.test(call.path))
    .map(({ path, body }) => ({ path, body }))
}

test('a folder agent asks permission mid-turn, the user allows it, and the transcript keeps the decision', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  await sendToAgent(cinna, PERMISSION_PROMPT)
  const page = cinna.page
  const allowOnce = page.getByRole('button', { name: 'Allow once', exact: true })

  await test.step('the ask arrives as a live block while the turn is parked', async () => {
    await expect(page.getByText('The agent is asking to run a command', { exact: true })).toBeVisible({
      timeout: 30_000
    })
    await expect(page.getByText('rm -rf build', { exact: true })).toBeVisible()
    await expect(allowOnce).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Always allow', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeEnabled()
    // Parked, not answered: nothing has been posted back to the engine.
    expect(replies(cinna)).toEqual([])
  })

  await test.step('Allow once reaches the engine as its own reply, and the turn finishes', async () => {
    await allowOnce.click()
    await expect(page.getByText('Allowed once.', { exact: true })).toBeVisible()
    await expect(allowOnce).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toHaveCount(0)
    await expect
      .poll(() => replies(cinna))
      .toEqual([{ path: '/api/session/ses_e2e_1/permission/per_e2e_rm/reply', body: { reply: 'once' } }])
    await expect(page.getByText('Done, the folder is gone.', { exact: true })).toBeVisible()
  })

  await test.step('the decision is in the transcript, and the replayed block is read-only', async () => {
    await expect
      .poll(() => persistedParts(cinna))
      .toContainEqual({ kind: 'tool_result', text: 'Allowed once.', toolId: 'per_e2e_rm' })
    await reopenChat(cinna, PERMISSION_PROMPT)
    const replay = cinna.page
    await expect(replay.getByText('Permission to run a command', { exact: true })).toBeVisible()
    await expect(replay.getByText('rm -rf build', { exact: true })).toBeVisible()
    await expect(replay.getByText('Allowed once.', { exact: true })).toBeVisible()
    await expect(replay.getByText('Done, the folder is gone.', { exact: true })).toBeVisible()
    await expect(replay.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
  })
})

test('a folder agent asks a question mid-turn, the user answers it, and the answer is recorded with the turn', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  await sendToAgent(cinna, QUESTION_PROMPT)
  const page = cinna.page
  const answer = page.getByRole('button', { name: 'Answer', exact: true })

  await test.step('the question arrives as a live block while the turn is parked', async () => {
    await expect(page.getByText('The agent is asking a question', { exact: true })).toBeVisible({
      timeout: 30_000
    })
    await expect(page.getByText('Which colour should the report use?', { exact: true })).toBeVisible()
    await expect(answer).toBeEnabled()
    expect(replies(cinna)).toEqual([])
  })

  await test.step('the chosen option reaches the engine as its own answer matrix, and the turn finishes', async () => {
    await answer.click()
    const send = page.getByRole('button', { name: 'Send answer', exact: true })
    await expect(send).toBeDisabled()
    await page.getByRole('button', { name: /^Teal/ }).click()
    await send.click()
    await expect(send).toHaveCount(0)
    await expect(page.getByText('A question asked', { exact: true })).toBeVisible()
    await expect(answer).toHaveCount(0)
    await expect
      .poll(() => replies(cinna))
      .toEqual([
        { path: '/api/session/ses_e2e_1/question/que_e2e_colour/reply', body: { answers: [['Teal']] } }
      ])
    await expect(page.getByText('Thanks, the report is updated.', { exact: true })).toBeVisible()
  })

  await test.step('the answer is in the transcript, and the replayed block is read-only', async () => {
    await expect
      .poll(() => persistedParts(cinna))
      .toContainEqual({ kind: 'tool_result', text: 'Answered: Teal.', toolId: 'que_e2e_colour' })
    await reopenChat(cinna, QUESTION_PROMPT)
    const replay = cinna.page
    await expect(replay.getByText('A question asked', { exact: true })).toBeVisible()
    await expect(replay.getByText('Thanks, the report is updated.', { exact: true })).toBeVisible()
    await expect(replay.getByRole('button', { name: 'Answer', exact: true })).toHaveCount(0)
  })
})

/**
 * **Expected to fail: a product defect, and not a phase 1 regression** — the
 * two render sites involved are identical at `HEAD`.
 *
 * The runner records the answer as a `tool_result` part on the question's own
 * id (`Answered: Teal.`, which the test above reads back from the database),
 * and nothing draws it. `pairCommandTools` in `MessageStream.tsx` consumes a
 * `tool_result` paired with any `per_` / `que_` ask so it is not rendered
 * standalone, and only `PermissionRequestBlock` is then handed that text as
 * `decision`; `AskUserQuestionBlock` takes no such prop. A replayed permission
 * reads "Allowed once."; a replayed question reads "A question asked" and never
 * says what the user chose — nor does the live block once answered.
 *
 * Its prerequisites are asserted by the test above, so a failure there is
 * reported there. The run fails here the day the answer is shown.
 */
test('the replayed question block shows the answer the user gave', async ({ cinna }) => {
  test.fail()
  test.setTimeout(120_000)
  await arrange(cinna)
  await sendToAgent(cinna, QUESTION_PROMPT)
  const page = cinna.page
  await page.getByRole('button', { name: 'Answer', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: /^Teal/ }).click()
  await page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect
    .poll(() => persistedParts(cinna))
    .toContainEqual({ kind: 'tool_result', text: 'Answered: Teal.', toolId: 'que_e2e_colour' })
  await reopenChat(cinna, QUESTION_PROMPT)
  await expect(cinna.page.getByText('A question asked', { exact: true })).toBeVisible()
  // Nothing else on this screen says "Teal": not the prompt, not the question,
  // not the agent's closing line.
  await expect(cinna.page.locator('body')).toContainText('Teal')
})
