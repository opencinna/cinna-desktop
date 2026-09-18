import { test, expect, type CinnaApp } from '../fixtures/app'
import { scriptAcpEngine, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'

/**
 * A Claude folder agent's subagent works while the agent keeps talking: its
 * tool calls and its report must nest under the Agent call's sub-thread and
 * never cut the agent's own sentence (seen in a real session as
 * "…Rockenhä" [Tool: Bash] "user /" [Output] "Traffective metric)…").
 *
 * The agent is a command-line ACP agent running `scriptAcpAgent.mjs`, which
 * sends Claude-shaped frames (`__fixtures__/claude/subagent_{background,sync}.json`):
 * child frames under the child's own session id, each with
 * `_meta.claudeCode.parentToolUseId` = the Agent call id, routed to the turn by
 * a `subagent_spawned` on the parent. The real driver, translator,
 * accumulator, store and transcript handle them; no model and no `claude`.
 * Each turn is released in stages (`more`) so the live screen is asserted
 * while the prompt is still open, then again after it ends and after a restart.
 */

const AGENT = 'Lane Worker'
const IDLE = 'Type a message...'
const RUNNING = 'Send a follow-up · Esc Esc to stop'
const CHILD = 'sub-e2e-child'
const AGENT_CALL = 'toolu_e2e_agent_call'
const BASH_CALL = 'toolu_e2e_bash_call'
const SUBAGENT = 'Look up the traffic metric'
const TASK = 'Find the Traffective metric for the Florian Rockenhäuser account.'

const composer = (cinna: CinnaApp, name = IDLE) => cinna.page.getByRole('combobox', { name, exact: true })

async function arrange(cinna: CinnaApp, fake: ScriptAcpEngine): Promise<void> {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const saved = await cinna.page.evaluate(async ({ config, name }) => {
    const probe = await window.api.customAgents.test({ config })
    return window.api.customAgents.save({ name, config, testToken: probe.token })
  }, { config: fake.customConfig(cinna), name: AGENT })
  expect(saved.id).toBeTruthy()
  await cinna.relaunch()
  await cinna.skipOnboarding()
}

async function send(cinna: CinnaApp, fake: ScriptAcpEngine, prompt: string): Promise<string> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: AGENT, exact: true }).click()
  const input = composer(cinna)
  await input.fill(prompt)
  await input.press('Enter')
  await expect.poll(() => fake.calls.length, { timeout: 20_000 }).toBe(1)
  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  return chat.id
}

const parent = (update: Record<string, unknown>) => update
const child = (update: Record<string, unknown>) => ({ sessionId: CHILD, update })
const chunk = (text: string) => parent({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId: 'msg_e2e_parent' })

let fake: ScriptAcpEngine
test.beforeEach(async () => { fake = await scriptAcpEngine() })
test.afterEach(async () => {
  await fake.close()
  expect(fake.unexpected).toEqual([])
})

/** The sub-thread's header button, and the thread itself (header row → root). */
const header = (cinna: CinnaApp, name: string) => cinna.page.getByRole('button', { name, exact: true })
const thread = (cinna: CinnaApp, name: string) => header(cinna, name).locator('xpath=../..')

async function savedAssistant(cinna: CinnaApp, chatId: string): Promise<{ content: string; parents: string[] }[]> {
  return cinna.page.evaluate(async (id) => {
    const detail = await window.api.chat.get(id)
    return (detail?.messages ?? []).filter((m) => m.role === 'assistant').map((m) => ({
      content: m.content,
      parents: (m.parts ?? []).map((p) => p.parentToolId ?? '')
    }))
  }, chatId)
}

async function reopen(cinna: CinnaApp, prompt: string): Promise<void> {
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
  await cinna.page.getByText(prompt, { exact: true }).first().click()
}

test('a background subagent working mid-sentence leaves the agent’s sentence whole and its own work in its sub-thread', async ({ cinna }) => {
  test.setTimeout(120_000)
  const PROMPT = 'Summarise the account.'
  const LIVE_SENTENCE = 'Here is the summary (the Florian Rockenhäuser / Traffec'
  const SENTENCE = 'Here is the summary (the Florian Rockenhäuser / Traffective metric) you asked for.'
  const REPORT = 'The subagent found the Traffective metric at 4.2%.'
  const COMMAND = 'grep traffective metrics.csv'
  const OUTPUT = 'traffective,4.2%'
  await arrange(cinna, fake)
  const chatId = await send(cinna, fake, PROMPT)

  /**
   * The subagent's Bash call and its output — the `[Tool: Bash]` / `[Output]`
   * that cut the reported sentence — are in the thread, and nowhere else.
   */
  const expectStepsInside = async (root: ReturnType<typeof thread>): Promise<void> => {
    await expect(root.getByRole('button', { name: 'Tool: Bash', exact: true })).toBeVisible()
    await expect(root.getByRole('button', { name: 'Output', exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: 'Tool: Bash', exact: true })).toHaveCount(1)
    await expect(cinna.page.getByRole('button', { name: 'Output', exact: true })).toHaveCount(1)
    await expect(cinna.page.getByRole('button', { name: /^(Expand|Collapse) \d+ steps?$/ })).toHaveCount(1)
    await root.getByRole('button', { name: 'Tool: Bash', exact: true }).click()
    await expect(root.getByText(COMMAND).first()).toBeVisible()
    await root.getByRole('button', { name: 'Output', exact: true }).click()
    await expect(root.getByText(OUTPUT).first()).toBeVisible()
  }
  const sentence = () => cinna.page.getByRole('paragraph').filter({ hasText: /^Here is the summary/ })
  const report = () => cinna.page.getByRole('paragraph').filter({ hasText: REPORT })

  await test.step('live: the subagent runs a command between two halves of a word', async () => {
    // Recorded shape (`claude/subagent_background.json`): the parent never gets
    // an Agent `tool_call`, only the launch update; the child's frames come
    // under its own session, each naming the Agent call as `parentToolUseId`.
    fake.calls[0].release({ more: true, updates: [
      parent({ sessionUpdate: 'subagent_spawned', subagentSessionId: CHILD, name: SUBAGENT, task: TASK, capabilities: {} }),
      parent({ sessionUpdate: 'tool_call_update', toolCallId: AGENT_CALL,
        _meta: { claudeCode: { toolName: 'Agent', toolResponse: { isAsync: true, status: 'async_launched', agentId: CHILD, description: SUBAGENT, prompt: TASK } } } }),
      chunk('Here is the summary (the Florian Rockenhä'),
      child({ sessionUpdate: 'tool_call', toolCallId: BASH_CALL, status: 'pending', kind: 'execute', title: COMMAND,
        rawInput: { command: COMMAND, description: 'Find the metric row' },
        _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: AGENT_CALL } } }),
      chunk('user / Traffec'),
      child({ sessionUpdate: 'tool_call_update', toolCallId: BASH_CALL, status: 'completed', rawOutput: OUTPUT,
        content: [{ type: 'content', content: { type: 'text', text: `\`\`\`console\n${OUTPUT}\n\`\`\`` } }],
        _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: AGENT_CALL } } })
    ] })
    await expect.poll(() => fake.mores.length).toBe(1)
    await expect(composer(cinna, RUNNING)).toBeVisible()
    await expect(sentence()).toHaveText(LIVE_SENTENCE)
    await expect(sentence()).toHaveCount(1)
    await expect(header(cinna, SUBAGENT)).toHaveAttribute('aria-expanded', 'true')
    const root = thread(cinna, SUBAGENT)
    await expect(root.getByText(TASK, { exact: true })).toBeVisible()
    // The command and its output are the thread's steps, not the agent's.
    await root.getByRole('button', { name: 'Expand 2 steps', exact: true }).click()
    await expectStepsInside(root)
    await expect(root.getByRole('paragraph').filter({ hasText: /^Here is the summary/ })).toHaveCount(0)
  })

  await test.step('live: the subagent reports while the agent finishes its word', async () => {
    fake.mores[0].release({ more: true, updates: [
      child({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPORT },
        messageId: 'msg_e2e_child', _meta: { claudeCode: { parentToolUseId: AGENT_CALL } } }),
      chunk('tive metric) you asked for.')
    ] })
    await expect.poll(() => fake.mores.length).toBe(2)
    await expect(sentence()).toHaveText(SENTENCE)
    await expect(sentence()).toHaveCount(1)
    await expect(report()).toHaveCount(1)
    await expect(thread(cinna, SUBAGENT).getByRole('paragraph').filter({ hasText: REPORT })).toBeVisible()
    await expect(composer(cinna, RUNNING)).toBeVisible()
  })

  await test.step('the turn ends: one sentence, and the saved answer is the agent’s alone', async () => {
    fake.mores[1].release({ updates: [
      parent({ sessionUpdate: 'subagent_state_update', subagentSessionId: CHILD, state: 'completed' })
    ] })
    await expect(composer(cinna)).toBeVisible()
    await expect(sentence()).toHaveText(SENTENCE)
    await expect(sentence()).toHaveCount(1)
    await expect(report()).toHaveCount(1)
    await expect.poll(() => savedAssistant(cinna, chatId).then((rows) => rows.map((row) => row.content)), { timeout: 20_000 })
      .toEqual([SENTENCE])
    const [row] = await savedAssistant(cinna, chatId)
    expect(row.parents).toContain(AGENT_CALL)
    // Compact mode folds a finished thread; opening it shows the subagent's work.
    await expect(header(cinna, SUBAGENT)).toHaveAttribute('aria-expanded', 'false')
    await header(cinna, SUBAGENT).click()
    const root = thread(cinna, SUBAGENT)
    await expect(root.getByRole('paragraph').filter({ hasText: REPORT })).toBeVisible()
    await expect(root.getByRole('button', { name: 'Expand 2 steps', exact: true })).toBeVisible()
    await expect(root.getByRole('paragraph').filter({ hasText: /^Here is the summary/ })).toHaveCount(0)
  })

  await test.step('reopened from the database after a restart: the same', async () => {
    await reopen(cinna, PROMPT)
    await expect(sentence()).toHaveText(SENTENCE)
    await expect(sentence()).toHaveCount(1)
    await expect(report()).toHaveCount(1)
    await header(cinna, SUBAGENT).click()
    const root = thread(cinna, SUBAGENT)
    await expect(root.getByRole('paragraph').filter({ hasText: REPORT })).toBeVisible()
    await root.getByRole('button', { name: 'Expand 2 steps', exact: true }).click()
    await expectStepsInside(root)
  })
})

test('a subagent that fails says "error" in compact mode and its thread stays open', async ({ cinna }) => {
  test.setTimeout(120_000)
  const PROMPT = 'Check the export.'
  const FAILING = 'Check the export file'
  const COMMAND = 'cat export.csv'
  const STDERR = 'cat: export.csv: No such file or directory'
  const SENTENCE = 'The export could not be checked.'
  await arrange(cinna, fake)
  await send(cinna, fake, PROMPT)

  await test.step('live: the subagent’s command fails and the subagent ends failed', async () => {
    // Recorded synchronous shape (`claude/subagent_sync.json`): child frames
    // first; the app writes the Agent call's start, and — on `failed` — its
    // `failed` end, which is a stderr result on the call.
    fake.calls[0].release({ more: true, updates: [
      parent({ sessionUpdate: 'subagent_spawned', subagentSessionId: CHILD, name: FAILING, task: 'Read export.csv and report its first line.', capabilities: {} }),
      child({ sessionUpdate: 'tool_call', toolCallId: BASH_CALL, status: 'pending', kind: 'execute', title: COMMAND,
        rawInput: { command: COMMAND, description: 'Read the export' },
        _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: AGENT_CALL } } }),
      child({ sessionUpdate: 'tool_call_update', toolCallId: BASH_CALL, status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: STDERR } }],
        _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: AGENT_CALL } } }),
      parent({ sessionUpdate: 'subagent_state_update', subagentSessionId: CHILD, state: 'failed' })
    ] })
    await expect.poll(() => fake.mores.length).toBe(1)
    await expect(composer(cinna, RUNNING)).toBeVisible()
    const head = cinna.page.getByRole('button', { name: new RegExp(`^${FAILING}`) })
    await expect(head.getByText('error', { exact: true })).toBeVisible()
    await expect(head).toHaveAttribute('aria-expanded', 'true')
    await expect(head.locator('xpath=../..').getByText('Subagent failed.', { exact: true })).toBeVisible()
  })

  const expectFailedAndOpen = async (): Promise<void> => {
    const head = cinna.page.getByRole('button', { name: new RegExp(`^${FAILING}`) })
    await expect(head).toHaveCount(1)
    await expect(head.getByText('error', { exact: true })).toBeVisible()
    await expect(head).toHaveAttribute('aria-expanded', 'true')
    const root = head.locator('xpath=../..')
    await expect(root.getByText('Subagent failed.', { exact: true })).toBeVisible()
    await expect(root.getByRole('paragraph').filter({ hasText: SENTENCE })).toHaveCount(0)
    await expect(cinna.page.getByRole('paragraph').filter({ hasText: SENTENCE })).toHaveText(SENTENCE)
  }

  await test.step('the turn ends: the thread is still open, still marked "error"', async () => {
    fake.mores[0].release({ updates: [chunk(SENTENCE)] })
    await expect(composer(cinna)).toBeVisible()
    await expectFailedAndOpen()
  })

  await test.step('reopened after a restart: still open, still "error"', async () => {
    await reopen(cinna, PROMPT)
    await expectFailedAndOpen()
  })
})
