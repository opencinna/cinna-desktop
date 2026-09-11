import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import type { TaskStatus } from '../../src/shared/taskStatus'

/**
 * The Inbox: a job run parks on a permission ask, the user walks away from the
 * chat, and answers it from a list that belongs to no conversation.
 *
 * ## What is real and what is not
 *
 * The **agent** is the scriptable fake ACP agent
 * (`src/main/agents/drivers/acp/testSupport/fakeAcpAgent.mjs`), spawned by the
 * app through the engine-path setting exactly as it would spawn `opencode acp`
 * — a real `opencode` needs a real model to decide to ask for permission. Its
 * model catalogue is a fake Ollama `/api/tags` on a port this spec owns, so
 * nothing leaves the machine. Everything else is the product: `job:execute`,
 * the task it creates, the renderer's `startRun`, the ACP driver, the parked
 * request registry, `inboxService`'s mirror of it into `task_input_requests`,
 * the five-second `inbox:list` poll, the sidebar badge, `InboxView`,
 * `inbox:answer`, and the transcript the turn persists afterwards.
 *
 * ## The run is started through the UI, and that is load bearing
 *
 * `window.api.jobs.execute(jobId)` from `page.evaluate` creates the chat, the
 * run row and the task and returns — the *renderer* is what opens the turn's
 * MessagePort (`useJobs`' `startRun`). Called over IPC nothing streams, no
 * `needs_input` ever reaches `observeAsks`, no row is written and the inbox
 * stays empty for ever. So the arrange stops at the job and the run is started
 * from the job screen's **Run** button, like a user.
 *
 * ## Why the fake agent pauses twice
 *
 * The script sleeps ~2.5s before it asks and ~2.5s after it is answered. Not a
 * sleep in the test — every wait below is a web-first assertion — but the
 * agent doing the work either side of the ask, which is what makes the task's
 * middle two statuses observable rather than raced: `in_progress` is a real
 * interval on both sides of `blocked` rather than a value that has to be caught
 * between two IPC calls. The whole trail
 * `in_progress → blocked → in_progress → completed` is asserted below.
 *
 * ## What it proves
 *
 * - An ask raised by a job run appears in the sidebar badge's accessible name
 *   and in the Inbox list, with its task's title and the agent that raised it.
 * - The row carries the ask's own `PermissionRequestBlock` and **no way back to
 *   the conversation** — the three permission buttons are the only controls on
 *   the card.
 * - Answering from the Inbox, with the chat closed, reaches the agent as ACP's
 *   own outcome and settles the row and the badge.
 * - The run row opens the **task**, whose page names the work and leads to the
 *   conversation; the transcript of the chat the user left holds the decision
 *   when it is reopened, read-only.
 * - The task walks `in_progress → blocked → in_progress → completed`.
 *
 * ## What it does not
 *
 * The error branches (`Inbox — could not be read`, the retry line), the
 * question ask in the inbox (`AnswerQuestionsModal` / "Send answer"), the
 * refusals `inbox:answer` returns as data (`no_longer_waiting` and friends),
 * *Always allow* and its grant file (`agent-permissions.spec.ts`), and the
 * retention rule that keeps an answered row until the view is left.
 */

const AGENT = 'Report Builder'
const JOB_TITLE = 'Nightly cleanup'
const JOB_PROMPT = 'Clear the build folder.'
const MODEL = 'qwen3:8b'
const SESSION = 'ses_e2e_inbox'

/** How long the fake agent works either side of the ask. See the header. */
const WORK_MS = 2_500

/**
 * A turn that works, asks to run `rm -rf build`, works again, and reports.
 *
 * The shape is a real `opencode acp` permission — the `tool_call` update first
 * (the ask itself carries no tool name), then the request with OpenCode's
 * `once` / `always` / `reject` options.
 */
const PARKS_ON_PERMISSION: FakeAcpScript = {
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
      { kind: 'delay', ms: WORK_MS },
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
      { kind: 'delay', ms: WORK_MS },
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

interface Arranged {
  acp: FakeAcpEngine
  jobId: string
}

/**
 * A folder agent on a keyless credential, the fake ACP agent, a job bound to
 * the agent, and the restart that lets the renderer's agent query see it.
 */
async function arrange(cinna: CinnaApp): Promise<Arranged> {
  await cinna.skipOnboarding()
  const acp = await installFakeAcpEngine(cinna, PARKS_ON_PERMISSION)
  await cinna.page.evaluate(
    async ({ host, model }) => {
      const { id } = await window.api.providers.upsert({
        type: 'ollama',
        name: 'Ollama',
        baseUrl: host,
        enabled: true
      })
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
  // Description equal to the name, so nothing downstream reads a sub-line.
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  const jobId = await cinna.page.evaluate(
    async ({ agentId, title, prompt }) => {
      const job = await window.api.jobs.create({ type: 'local', title, prompt })
      // `agentId` on create is ignored; the binding is its own call.
      await window.api.jobs.setAgents(job.id, [agentId])
      return job.id
    },
    { agentId: agent.id, title: JOB_TITLE, prompt: JOB_PROMPT }
  )
  await cinna.relaunch()
  await cinna.skipOnboarding()
  // Startup does not scan: without this the job reads as incomplete setup and
  // its Run button is disabled.
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { acp, jobId }
}

/** The task this job's run created, or null before `job:execute` has made one. */
async function jobTask(
  cinna: CinnaApp,
  jobId: string
): Promise<{ id: string; status: TaskStatus; chatId: string | null; jobRunId: string | null } | null> {
  return cinna.page.evaluate(async (id) => {
    const tasks = await window.api.tasks.list()
    const task = tasks.find((t) => t.jobId === id)
    return task
      ? { id: task.id, status: task.status, chatId: task.chatId, jobRunId: task.jobRunId }
      : null
  }, jobId)
}

/**
 * Wait for the task to reach `status`.
 *
 * Polled at 50ms rather than the default ramp, because two of the four
 * statuses in the trail are intervals of a couple of seconds rather than
 * resting states.
 */
async function expectTaskStatus(
  cinna: CinnaApp,
  jobId: string,
  status: TaskStatus,
  timeout = 30_000
): Promise<void> {
  await expect
    .poll(async () => (await jobTask(cinna, jobId))?.status ?? null, { intervals: [50], timeout })
    .toBe(status)
}

test('a job parks on a permission ask, the user answers it in the Inbox, and the task ends completed', async ({
  cinna
}) => {
  test.setTimeout(180_000)
  const { acp, jobId } = await arrange(cinna)
  // `cinna.page` is read at each use, never held across the relaunch above.
  const inboxButton = () => cinna.page.getByRole('button', { name: /^Inbox/ })

  await test.step('nothing is waiting before the run', async () => {
    await expect(inboxButton()).toHaveAccessibleName('Inbox')
  })

  await test.step('the job is run from its own screen, and the turn parks on the ask', async () => {
    await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
    await cinna.page.getByText(JOB_TITLE, { exact: true }).click()
    const run = cinna.page.getByRole('button', { name: 'Run', exact: true })
    await expect(run).toBeEnabled()
    await run.click()

    // The run navigates into the chat it spawned, which is where the user is
    // when the agent stops to ask.
    await expect(cinna.page.getByText(JOB_PROMPT, { exact: true }).first()).toBeVisible({
      timeout: 30_000
    })
    // Work first: the task is `in_progress` while the agent is running, before
    // anything has been asked of anybody.
    await expectTaskStatus(cinna, jobId, 'in_progress')
    await expect(
      cinna.page.getByText('The agent is asking to run a command', { exact: true })
    ).toBeVisible({ timeout: 60_000 })
    // Parked, not answered: the agent's request is still open.
    expect(acp.answers('session/request_permission')).toEqual([])
    await expectTaskStatus(cinna, jobId, 'blocked')
  })

  await test.step('the user leaves the chat, and the ask is in the Inbox', async () => {
    // Up to five seconds for the poll that feeds both the badge and the list.
    await expect(inboxButton()).toHaveAccessibleName('Inbox — 1 waiting', { timeout: 20_000 })
    await inboxButton().click()
    await expect(cinna.page.getByRole('heading', { name: 'Inbox' })).toBeVisible()
    // The chat is gone from the screen — this is the ask standing on its own.
    await expect(cinna.page.getByPlaceholder('Type a message...')).toHaveCount(0)

    const rows = cinna.page.getByRole('article')
    await expect(rows).toHaveCount(1)
    const row = rows.first()
    // The task's title, then who is asking and how long ago.
    await expect(row.getByText(JOB_TITLE, { exact: true })).toBeVisible()
    await expect(row.getByText(`${AGENT} · just now`, { exact: true })).toBeVisible()
    // The transcript's own block, with the ask's own words.
    await expect(row.getByText('The agent is asking to run a command', { exact: true })).toBeVisible()
    await expect(row.getByText('rm -rf build', { exact: true })).toBeVisible()
    // **Still no link back to the conversation**, and that is the point: a
    // parked ask is a turn that has not resolved, so the transcript holds the
    // job's prompt and nothing else. The one way back out of the row is the
    // *task*, which is the screen that does have something to show.
    await expect(row.getByRole('button')).toHaveText([
      'Open the task',
      'Allow once',
      'Always allow',
      'Deny'
    ])
    await expect(row.getByRole('link')).toHaveCount(0)
  })

  await test.step('answering from the Inbox reaches the agent, and the row settles', async () => {
    const row = cinna.page.getByRole('article').first()
    await row.getByRole('button', { name: 'Allow once', exact: true }).click()

    // The witness that the answer really travelled: the fake agent's own log of
    // what the client replied to the request it sent.
    await expect
      .poll(() => acp.answers('session/request_permission').map((entry) => entry.result))
      .toEqual([{ outcome: { outcome: 'selected', optionId: 'once' } }])

    await expect(row.getByText('Allowed once.', { exact: true })).toBeVisible()
    // The ask's own controls are gone; the way to the task is not an answer and
    // outlives the decision.
    await expect(row.getByRole('button')).toHaveText(['Open the task'])
    await expect(inboxButton()).toHaveAccessibleName('Inbox')

    // Back to work — a real interval, because the agent is finishing what it
    // was allowed to do — and then finished.
    await expectTaskStatus(cinna, jobId, 'in_progress')
    await expectTaskStatus(cinna, jobId, 'completed')
  })

  await test.step('the run row opens the task, and the task leads to the transcript', async () => {
    // Back to Jobs: the tab is still the selected one, so this is the Inbox
    // handing the centre back to the job the ask came from.
    await cinna.page.getByRole('button', { name: 'Jobs', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: JOB_TITLE })).toBeVisible()
    // **The row's target is the task now**, not the chat — the task is what
    // outlives a conversation that is hidden from the Chats list and is deleted
    // with the run. The conversation is still one click away, from the task.
    const runRow = cinna.page.getByTitle('Open the task')
    await expect(runRow).toContainText('Succeeded')
    await runRow.click()

    const page = cinna.page
    await expect(page.getByRole('heading', { level: 1, name: JOB_TITLE })).toBeVisible()
    await expect(page.getByText('completed', { exact: true })).toBeVisible()
    await expect(page.getByText(JOB_PROMPT, { exact: true })).toBeVisible()
    // A finished task needs no banner (`ux_rules.md` §2).
    await expect(page.getByRole('status')).toHaveCount(0)

    await page.getByRole('button', { name: 'Open the conversation' }).click()
    await expect(page.getByText('Permission to run a command', { exact: true })).toBeVisible()
    await expect(page.getByText('rm -rf build', { exact: true })).toBeVisible()
    await expect(page.getByText('Allowed once.', { exact: true })).toBeVisible()
    await expect(page.getByText('Done, the folder is gone.', { exact: true })).toBeVisible()
    // Replayed, so read-only.
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
  })

  await test.step('the task is the job run’s own, and it is finished', async () => {
    const task = await jobTask(cinna, jobId)
    expect(task).not.toBeNull()
    expect(task?.status).toBe('completed')
    expect(task?.jobRunId).not.toBeNull()
    const run = await cinna.page.evaluate(async (id) => {
      const [first] = await window.api.jobs.listRuns(id)
      return first ? { id: first.id, status: first.status, chatId: first.localChatId } : null
    }, jobId)
    expect(run?.status).toBe('succeeded')
    // The chat the ask came from is the chat the run spawned.
    expect(task?.chatId).toBe(run?.chatId)
    expect(task?.jobRunId).toBe(run?.id)
  })
})
