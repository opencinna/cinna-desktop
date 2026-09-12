import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_STATE_FILE } from '../../src/shared/kit/manifest'
import type { AddressInfo } from 'node:net'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * A folder agent that stops mid-turn to ask — permission, then a question —
 * and the user answering from the chat.
 *
 * ## What is real and what is not
 *
 * The **agent** is `src/main/agents/drivers/acp/testSupport/fakeAcpAgent.mjs`,
 * a real ACP agent process spawned by the app through the engine path setting,
 * because a real `opencode` needs a real model to decide to ask. It speaks
 * newline-delimited JSON-RPC over its own stdio and logs what it was sent and
 * what it was answered. Everything else is the product: binary resolution, the
 * launcher's config, the narrowed child environment, the ACP handshake, the
 * process pool, the driver, the pending-request registry, the turn's
 * `MessagePort`, the preload `isRunEvent` guard, `useChatStream`, the chat
 * store and the blocks. The model catalogue is a fake Ollama `/api/tags` on a
 * port this spec owns, so the launcher has a model to give the agent and
 * nothing leaves the machine.
 *
 * ## Which asks are whose
 *
 * The **permission** ask is exactly what a real `opencode acp` sends: the
 * `toolCall.{toolCallId,title,kind,locations,rawInput}` shape with `once` /
 * `always` / `reject` options, copied from
 * `spike/acp/opencode/recordings/q2-permission.ndjson` (the bash ask there is
 * `kind: 'execute'`, `rawInput: {command}`, and its `tool_call` update titles
 * the tool `bash`).
 *
 * The **question** arrives as `elicitation/create`, and over ACP that is
 * **Claude's** path, not OpenCode's: OpenCode's `question` tool is not
 * registered under `OPENCODE_CLIENT=acp`, and its ACP layer bridges nothing to
 * an elicitation. The form below is the Claude adapter's own shape — one
 * `question_<n>` string property with `oneOf` enum options, plus the
 * `question_<n>_custom` free-text companion this build drops (see
 * `acpQuestions.ts`). So this test stands for "an agent that asks a question",
 * not for OpenCode asking one; what it exercises is the desktop's side of the
 * elicitation, which is the same code for both launchers.
 *
 * ## The registry poll is pinned empty, on purpose
 *
 * A block can be made answerable by two sources: the stream's `needs_input`
 * and `useAgentRequests` polling `agent:pending-requests`. Either alone would
 * pass a test that allowed both, so the poll's handler is replaced with one
 * answering `[]` — the only thing left that can make a block live is the
 * `needs_input` that crossed the port. The *answer* path is untouched:
 * `agent:answer-request` resolves against the real registry, and the fake
 * agent's log is the witness that the reply reached it in ACP's own
 * vocabulary. The poll is restored by the restart before the replay step.
 *
 * ## What it proves
 *
 * - The ask is rendered live while the turn is still open, with its controls.
 * - The user's answer reaches the agent as ACP's own outcome
 *   (`{outcome:{outcome:'selected',optionId:'once'}}` for the permission,
 *   `{action:'accept',content:{question_0:'Teal'}}` for the question), and the
 *   turn then finishes.
 * - The block stops offering controls once answered.
 * - The decision is persisted in the transcript, and a replayed block is
 *   read-only after a restart, when no registry entry and no stream exist.
 *
 * ## What it does not
 *
 * The poll path (reload while parked), expiry, and abort. A separate case below
 * now covers Always allow through the actual transcript answer path, on-disk
 * grant, exact durable ask settlement and read-only replay.
 */

const AGENT = 'Report Builder'
const MODEL = 'qwen3:8b'
const SESSION = 'ses_e2e_1'

/** The prompts the user types; the agent's replies never repeat the answer. */
const PERMISSION_PROMPT = 'Delete the build folder.'
const QUESTION_PROMPT = 'Pick a colour for the report.'

/**
 * A turn that asks to run `rm -rf build` and then finishes.
 *
 * The `tool_call` update comes first, as the recording has it: the ask itself
 * carries no tool name, and the desktop reads one from the update that named
 * the same `toolCallId`.
 */
const ASKS_PERMISSION: FakeAcpScript = {
  newSession: { sessionId: SESSION },
  prompt: {
    emit: [
      {
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_e2e_rm',
          title: 'bash',
          kind: 'execute',
          status: 'pending',
          locations: [],
          rawInput: {}
        }
      },
      {
        kind: 'permission',
        toolCall: {
          toolCallId: 'call_e2e_rm',
          title: 'rm -rf build',
          kind: 'execute',
          status: 'pending',
          locations: [],
          rawInput: { command: 'rm -rf build' }
        },
        options: [
          { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
          { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
        ]
      },
      {
        kind: 'update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Done, the folder is gone.' }
        }
      }
    ]
  }
}

/** A turn that asks one single-select question and then finishes. */
const ASKS_QUESTION: FakeAcpScript = {
  newSession: { sessionId: SESSION },
  prompt: {
    emit: [
      {
        kind: 'elicitation',
        params: {
          message: 'Which colour should the report use?',
          requestedSchema: {
            type: 'object',
            properties: {
              question_0: {
                type: 'string',
                title: 'Colour',
                description: 'Which colour should the report use?',
                oneOf: [
                  { const: 'Teal', title: 'Teal', description: 'Calm and readable' },
                  { const: 'Amber', title: 'Amber', description: 'Loud on purpose' }
                ]
              },
              // The adapter's free-text companion, which this build drops
              // rather than rendering as a second question.
              question_0_custom: {
                type: 'string',
                title: 'Other',
                _meta: { _askUserQuestionCustomAnswer: true }
              }
            }
          }
        }
      },
      {
        kind: 'update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Thanks, the report is updated.' }
        }
      }
    ]
  }
}

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
 * A folder agent on a keyless credential, the fake ACP agent, and a restart so
 * the renderer's agent query can see the agent. The registry poll is pinned
 * after the restart, because handlers are per process.
 */
async function arrange(cinna: CinnaApp, script: FakeAcpScript): Promise<FakeAcpEngine> {
  await cinna.skipOnboarding()
  const acp = await installFakeAcpEngine(cinna, script)
  await cinna.page.evaluate(
    async ({ host, model }) => {
      const { id } = await window.api.providers.upsert({
        type: 'ollama',
        name: 'Ollama',
        baseUrl: host,
        enabled: true
      })
      // The Default runtime is the default chat mode's credential and model.
      await window.api.chatModes.upsert({
        name: 'Default',
        providerId: id,
        modelId: model,
        isDefault: true
      })
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
  return acp
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

/**
 * The decisions persisted for the only chat, with the minted request id
 * reduced to its prefix.
 *
 * The id is `per_acp_<time>_<n>` / `que_acp_…` — unpredictable, and load
 * bearing only in its first segment: `isEngineRequestId` gates the renderer's
 * read-only replay rule on exactly that prefix, and the pairing of a decision
 * to its ask is by the same id.
 */
async function decisions(cinna: CinnaApp): Promise<{ text: string; id: string }[]> {
  return cinna.page
    .evaluate(async () => {
      const [chat] = await window.api.chat.list()
      if (!chat) return []
      const detail = await window.api.chat.get(chat.id)
      return (detail?.messages ?? [])
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.parts ?? [])
        .filter((p) => p.kind === 'tool_result')
        .map((p) => ({ text: p.text, id: p.toolId ?? '' }))
    })
    .then((parts) =>
      parts.map(({ text, id }) => ({ text, id: id.replace(/^((?:per|que)_acp)_.*$/, '$1_*') }))
    )
}

/** Read only this fixture's durable reply rows after the agent has immediately ended its turn. */
async function durableReplies(cinna: CinnaApp) {
  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  if (!chat) throw new Error('Fixture chat was not created')
  return cinna.electronApp.evaluate(({ app }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${app.getPath('userData')}/cinna.db`, { readonly: true, fileMustExist: true })
    try {
      return (db.prepare('SELECT id, status, resolution FROM task_input_requests WHERE chat_id = ? ORDER BY created_at')
        .all(input.chatId) as { id: string; status: string; resolution: string | null }[])
        .map(row => ({ ...row, resolution: row.resolution ? JSON.parse(row.resolution) : null }))
    } finally { db.close() }
  }, { userData: cinna.sandbox.userData, chatId: chat.id })
}

/** Restart, and open the chat from the sidebar by its first message. */
async function reopenChat(cinna: CinnaApp, title: string): Promise<void> {
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.getByText(title, { exact: true }).first().click()
}

test('a folder agent asks permission mid-turn, the user allows it, and the transcript keeps the decision', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const acp = await arrange(cinna, ASKS_PERMISSION)
  await sendToAgent(cinna, PERMISSION_PROMPT)
  const page = cinna.page
  const allowOnce = page.getByRole('button', { name: 'Allow once', exact: true })

  await test.step('the ask arrives as a live block while the turn is parked', async () => {
    await expect(
      page.getByText('The agent is asking to run a command', { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('rm -rf build', { exact: true })).toBeVisible()
    await expect(allowOnce).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Always allow', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeEnabled()
    // Parked, not answered: the agent's request is still open, so nothing has
    // been written back to it.
    expect(acp.answers('session/request_permission')).toEqual([])
  })

  await test.step('Allow once reaches the agent as ACP’s own outcome, and the turn finishes', async () => {
    await allowOnce.click()
    await expect(page.getByText('Allowed once.', { exact: true })).toBeVisible()
    await expect(allowOnce).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toHaveCount(0)
    await expect
      .poll(() => acp.answers('session/request_permission').map((entry) => entry.result))
      .toEqual([{ outcome: { outcome: 'selected', optionId: 'once' } }])
    await expect(page.getByText('Done, the folder is gone.', { exact: true })).toBeVisible()
  })

  await test.step('the decision is in the transcript, and the replayed block is read-only', async () => {
    await expect.poll(() => decisions(cinna)).toEqual([{ text: 'Allowed once.', id: 'per_acp_*' }])
    await reopenChat(cinna, PERMISSION_PROMPT)
    const replay = cinna.page
    await expect(replay.getByText('Permission to run a command', { exact: true })).toBeVisible()
    await expect(replay.getByText('rm -rf build', { exact: true })).toBeVisible()
    await expect(replay.getByText('Allowed once.', { exact: true })).toBeVisible()
    await expect(replay.getByText('Done, the folder is gone.', { exact: true })).toBeVisible()
    await expect(replay.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
  })
})

test('Always allow sends ACP once, saves the grant and durable answer before immediate completion, and replays remembered', async ({ cinna }) => {
  const acp = await arrange(cinna, ASKS_PERMISSION)
  const agent = (await cinna.page.evaluate(() => window.api.localAgents.list())).agents.find(row => row.name === AGENT)
  if (!agent) throw new Error('Fixture folder agent was not indexed')
  await sendToAgent(cinna, PERMISSION_PROMPT)
  await expect(cinna.page.getByRole('button', { name: 'Always allow', exact: true })).toBeEnabled()
  expect(acp.answers('session/request_permission')).toEqual([])
  await cinna.page.getByRole('button', { name: 'Always allow', exact: true }).click()
  await expect.poll(() => acp.answers('session/request_permission').map(entry => entry.result))
    .toEqual([{ outcome: { outcome: 'selected', optionId: 'once' } }])
  await expect(cinna.page.getByText('Done, the folder is gone.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByText('Allowed, and remembered for this agent.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect.poll(() => decisions(cinna))
    .toEqual([{ text: 'Allowed, and remembered for this agent.', id: 'per_acp_*' }])
  const grants = JSON.parse(readFileSync(join(agent.path, DESKTOP_STATE_FILE), 'utf8')).permissionGrants
  expect(Object.keys(grants)).toEqual(['bash::rm -rf build'])
  expect(grants['bash::rm -rf build']).toMatchObject({ action: 'bash', pattern: 'rm -rf build', scope: 'exact', decidedAt: expect.any(Number) })
  const rows = await durableReplies(cinna)
  expect(rows).toEqual([{ id: expect.stringMatching(/^per_acp_/), status: 'answered',
    resolution: { kind: 'permission', reply: 'once', remembered: true } }])
  await reopenChat(cinna, PERMISSION_PROMPT)
  await expect(cinna.page.getByText('Allowed, and remembered for this agent.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByText('Done, the folder is gone.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: 'Always allow', exact: true })).toHaveCount(0)
  await expect(cinna.page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
  expect(await durableReplies(cinna)).toEqual(rows)
  expect(acp.answers('session/request_permission')).toHaveLength(1)
})

test('a folder agent asks a question mid-turn, the user answers it, and the answer is recorded with the turn', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const acp = await arrange(cinna, ASKS_QUESTION)
  await sendToAgent(cinna, QUESTION_PROMPT)
  const page = cinna.page
  const answer = page.getByRole('button', { name: 'Answer', exact: true })

  await test.step('the question arrives as a live block while the turn is parked', async () => {
    await expect(page.getByText('The agent is asking a question', { exact: true })).toBeVisible({
      timeout: 30_000
    })
    await expect(
      page.getByText('Which colour should the report use?', { exact: true })
    ).toBeVisible()
    await expect(answer).toBeEnabled()
    expect(acp.answers('elicitation/create')).toEqual([])
  })

  await test.step('the chosen option reaches the agent as an accepted form, and the turn finishes', async () => {
    await answer.click()
    const send = page.getByRole('button', { name: 'Send answer', exact: true })
    await expect(send).toBeDisabled()
    await page.getByRole('button', { name: /^Teal/ }).click()
    await send.click()
    await expect(send).toHaveCount(0)
    await expect(page.getByText('A question asked', { exact: true })).toBeVisible()
    await expect(answer).toHaveCount(0)
    // One field, not two: the adapter's `question_0_custom` companion is
    // dropped rather than answered.
    await expect
      .poll(() => acp.answers('elicitation/create').map((entry) => entry.result))
      .toEqual([{ action: 'accept', content: { question_0: 'Teal' } }])
    await expect(page.getByText('Thanks, the report is updated.', { exact: true })).toBeVisible()
  })

  await test.step('the answer is in the transcript, and the replayed block is read-only', async () => {
    await expect.poll(() => decisions(cinna)).toEqual([{ text: 'Answered: Teal.', id: 'que_acp_*' }])
    await reopenChat(cinna, QUESTION_PROMPT)
    const replay = cinna.page
    await expect(replay.getByText('A question asked', { exact: true })).toBeVisible()
    await expect(replay.getByText('Thanks, the report is updated.', { exact: true })).toBeVisible()
    await expect(replay.getByRole('button', { name: 'Answer', exact: true })).toHaveCount(0)
  })
})

/**
 * **Was `test.fail()` from phase 3 until phase 5 step 5 closed it.** The defect
 * it recorded: the driver writes the answer as a `tool_result` part on the
 * question's own id (`Answered: Teal.`, which the test above reads back from the
 * database), `pairCommandTools` consumes that part so it is not rendered
 * standalone, and the text was then handed only to `PermissionRequestBlock` —
 * `AskUserQuestionBlock` took no `decision` prop. A replayed permission read
 * "Allowed once."; a replayed question read "A question asked" and never said
 * what the user chose.
 *
 * What closed it was the inbox needing the same line for the same reason: a row
 * answered with its chat closed has to say what it settled as. The block gained
 * the prop, the sentence moved into `describeQuestionAnswers` so the runner and
 * both surfaces spell it once, and `MessageStream` passes the `decision` it was
 * already computing at all three call sites.
 *
 * So this asserts the two surfaces agree: what the inbox shows on a row it has
 * just answered is the string this reads back out of the transcript a reopen
 * later.
 */
test('the replayed question block shows the answer the user gave', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna, ASKS_QUESTION)
  await sendToAgent(cinna, QUESTION_PROMPT)
  const page = cinna.page
  await page.getByRole('button', { name: 'Answer', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: /^Teal/ }).click()
  await page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect.poll(() => decisions(cinna)).toEqual([{ text: 'Answered: Teal.', id: 'que_acp_*' }])
  await reopenChat(cinna, QUESTION_PROMPT)
  await expect(cinna.page.getByText('A question asked', { exact: true })).toBeVisible()
  // Nothing else on this screen says "Teal": not the prompt, not the question,
  // not the agent's closing line.
  await expect(cinna.page.locator('body')).toContainText('Teal')
})
