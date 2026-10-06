import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot } from '../fixtures/seed'
import { scriptAcpEngine } from '../fixtures/scriptAcpEngine'
import {
  adoptBare, arrangeScripted, createReady, okResult, openInbox, openTasksTab, promptFor, report, setMode, taskStatus
} from '../fixtures/dispatcher'

/**
 * A stored answer: a dispatched turn that ends on a question, answered in the
 * Inbox while another dispatched run holds the folder.
 *
 * **How a folder agent's dispatched turn ends on a `next_message` ask.** An
 * ACP agent's own asks park the turn (`inputResume: 'reply'`); only A2A asks
 * end it. So the task's chat — a direct chat with the folder agent — has an
 * A2A agent attached (`chat.addOnDemandAgent`), and the folder agent calls it
 * through its `cinna` MCP tool: the A2A agent answers `input-required`, the
 * nested turn opens a `next_message` ask on the task, and the folder agent's
 * turn ends on it. The task gets that chat by being dispatched once before
 * (the agent reports it failed, and a person moves it back to Ready), because a dispatched
 * task continues in its own chat.
 *
 * Real: `taskDispatchService` (the ask arm of the report rule, the stored
 * answer's flight and its folder wait), `inboxService.answer` storing it,
 * `startNextMessageTurn`, the nested A2A turn and the Inbox card. Scripted:
 * the folder agent's turns (`scriptAcpAgent.mjs`) and a loopback A2A agent.
 *
 * Not proved: the folder agent reporting after the answer. The answer resumes
 * the A2A agent's nested turn, and in a direct chat its result does not return
 * to the folder agent (`completeNestedContinuation` only continues a
 * coordinator chat), so the turn the answer starts always ends unreported:
 * this proves the report rule settles it (flagged, queue paused), not the
 * reported arm.
 */

const HEADING = 'Delta Ledger'
const SCOUT = 'Delta Scout'
const SCOUT_TOOL = 'delta_scout'
const ASKED = 'Survey the delta-4417 shore'
const OCCUPY = 'Chart the delta-4418 channel'
const BRIEF = 'Survey the delta shore and report which stretch you covered.'
const QUESTION = 'Which stretch of the delta-4417 shore should I survey?'
const ANSWER = 'The northern stretch, up to the delta-4417 lighthouse'
const DONE = 'Surveyed the northern stretch: delta-4417 complete.'
const A2A_TASK = 'delta-scout-task'
const A2A_CONTEXT = 'delta-scout-context'

interface Sent { text: string; contextId?: string; taskId?: string }

/** A loopback A2A agent: its first message asks QUESTION (input-required), the answer completes. */
async function scoutAgent() {
  const sends: Sent[] = []
  let origin = ''
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: SCOUT, description: 'Surveys shores.', url: `${origin}/a2a`, protocolVersion: '0.3.0',
        version: '1.0.0', capabilities: { streaming: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] }))
      return
    }
    if (req.method === 'POST' && req.url === '/a2a') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const rpc = JSON.parse(body) as { id: string | number; params?: { message?: { contextId?: string; taskId?: string; parts?: { kind: string; text?: string }[] } } }
        const message = rpc.params?.message ?? {}
        const text = (message.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text ?? '').join('')
        const index = sends.length
        sends.push({ text, contextId: message.contextId, taskId: message.taskId })
        const asking = index === 0
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'task', id: A2A_TASK, contextId: A2A_CONTEXT,
          status: { state: asking ? 'input-required' : 'completed',
            message: { kind: 'message', messageId: `scout-${index}`, role: 'agent', parts: [{ kind: 'text', text: asking ? QUESTION : DONE }] } } } }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    sends,
    async register(cinna: CinnaApp): Promise<string> {
      const created = await cinna.page.evaluate(({ base, name }) => window.api.agents.upsert({
        name, protocol: 'a2a', cardUrl: `${base}/.well-known/agent-card.json`, endpointUrl: `${base}/a2a` }), { base: origin, name: SCOUT })
      if (!created.success || !created.id) throw new Error(`agents.upsert failed: ${created.error}`)
      return created.id
    },
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

const AGAIN = 'Resurvey the delta-4419 shore'

/**
 * A dispatched start of a task that already has a chat continues in that chat
 * (`continueInChat`): the acceptance re-check does not count the run being
 * accepted as another turn running there. The continued turn is then settled
 * by the report rule like any dispatched turn.
 */
test('a Ready task that already has a conversation continues in it when Run next starts it', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await arrangeScripted(cinna, fake)
    await addAgentRoot(cinna)
    const { agentId } = await adoptBare(cinna, 'delta-again', HEADING)
    await cinna.relaunch()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())

    const task = await createReady(cinna, agentId, AGAIN)
    expect(await cinna.page.evaluate((id) => window.api.taskDispatch.runNext(id), agentId)).toMatchObject({ ok: true, taskId: task })
    const i = await promptFor(fake, AGAIN)
    const toolsBefore = fake.tools.length
    fake.calls[i].release({ tools: [{ name: 'tasks_report', args: { ref: task, status: 'failed', summary: 'The first look failed.' } }] })
    await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(toolsBefore + 1)
    okResult(fake.tools[toolsBefore])
    fake.tools[toolsBefore].release({ text: 'The first look failed.' })
    await expect.poll(() => taskStatus(cinna, task), { timeout: 30_000 }).toBe('error')
    await expect.poll(() => fake.calls[i].closed, { timeout: 30_000 }).toBe(true)
    const chatId = (await cinna.page.evaluate((id) => window.api.tasks.get(id), task)).chatId
    // A person puts it back in Ready (Failed → Backlog → Ready).
    await cinna.page.evaluate(async (id) => {
      await window.api.tasks.setStatus(id, 'new')
      await window.api.tasks.setStatus(id, 'open')
    }, task)

    await openTasksTab(cinna, HEADING)
    await expect(cinna.page.locator('[data-queue-status]')).toHaveText(`Next: ${AGAIN}`, { timeout: 15_000 })
    await cinna.page.getByRole('button', { name: 'Run next', exact: true }).click()
    await expect.poll(() => fake.calls.length, { timeout: 30_000 }).toBe(2)
    expect(fake.calls[1].text).toContain(`Continue this task.\n\nGoal:\n${AGAIN}`)
    expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), task)).chatId).toBe(chatId)
    await expect(cinna.page.getByRole('alert')).toHaveCount(0)
    expect((await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId))?.paused ?? null).toBeNull()
    // The report rule settles the continued turn: the agent reports it done.
    await report(cinna, fake, 1, task, AGAIN)
    expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), task)).chatId).toBe(chatId)
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})

test('an Inbox answer to a dispatched turn’s question waits while another dispatched run holds the folder, then is sent and settled by the report rule', async ({ cinna }) => {
  test.fixme(true, 'No agent kind can reach a next_message ask on a dispatched turn that the folder agent itself can answer. ' +
    'Once one can, it asserts: the folder agent is offered `delta_scout`; the A2A agent asks; the task is `blocked` with no dispatch note and the queue unpaused while ' +
    '"Chart the delta-4418 channel" runs; the Inbox card holds the answer with "Sends when delta-ledger is free." and the A2A agent has one message; ' +
    'after that run reports, the A2A agent receives the answer on context delta-scout-context / task delta-scout-task, and the task ends `blocked` with ' +
    '"Ended without reporting" and the queue paused on it ("Survey the delta-4417 shore ended without reporting").')
  test.setTimeout(300_000)
  const fake = await scriptAcpEngine()
  const scout = await scoutAgent()
  try {
    await arrangeScripted(cinna, fake)
    await addAgentRoot(cinna)
    const { agentId } = await adoptBare(cinna, 'delta-ledger', HEADING)
    const scoutId = await scout.register(cinna)
    await cinna.relaunch()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())

    const asked = await createReady(cinna, agentId, ASKED, 'urgent')
    await test.step('arrange: the task gets its own chat, with the A2A agent attached, and is Ready again', async () => {
      const run = await cinna.page.evaluate((id) => window.api.taskDispatch.runNext(id), agentId)
      expect(run).toMatchObject({ ok: true, taskId: asked })
      const i = await promptFor(fake, ASKED)
      // The agent reports this first attempt failed (a report: no pause), and a person puts it back.
      const toolsBefore = fake.tools.length
      fake.calls[i].release({ tools: [{ name: 'tasks_report', args: { ref: asked, status: 'failed', summary: 'The first look failed.' } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(toolsBefore + 1)
      okResult(fake.tools[toolsBefore])
      fake.tools[toolsBefore].release({ text: 'The first look failed.' })
      await expect.poll(() => taskStatus(cinna, asked), { timeout: 30_000 }).toBe('error')
      const chatId = (await cinna.page.evaluate((id) => window.api.tasks.get(id), asked)).chatId!
      await cinna.page.evaluate(async (input) => {
        await window.api.chat.addOnDemandAgent(input.chatId, input.scoutId)
        await window.api.tasks.setStatus(input.taskId, 'new')
        await window.api.tasks.setStatus(input.taskId, 'open')
      }, { chatId, scoutId, agentId, taskId: asked })
      expect((await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId))?.paused).toBeNull()
      expect(await taskStatus(cinna, asked)).toBe('open')
    })

    const occupy = await createReady(cinna, agentId, OCCUPY, 'low')
    let occupyCall = -1
    await test.step('the dispatched turn ends on the A2A agent’s question; the queue moves on and its next run holds the folder', async () => {
      await setMode(cinna, agentId, 'one')
      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(2)
      expect(fake.calls[1].text).toContain(`Goal:\n${ASKED}`)
      const toolsBefore = fake.tools.length
      fake.calls[1].release({ tools: [{ name: SCOUT_TOOL, args: { message: BRIEF } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(toolsBefore + 1)
      expect(fake.tools[toolsBefore].params.offered).toContain(SCOUT_TOOL)
      expect(scout.sends.map((send) => send.text)).toEqual([BRIEF])
      const result = (fake.tools[toolsBefore].params.results as { result: { content: { text?: string }[] } }[])[0].result
      expect(JSON.stringify(result)).toContain('waiting for a human answer in the Inbox')
      fake.tools[toolsBefore].release({ text: 'Waiting for the scout.' })

      // Waiting on its question, still the queue's; the next Ready task runs.
      occupyCall = await promptFor(fake, OCCUPY)
      const task = await cinna.page.evaluate((id) => window.api.tasks.get(id), asked)
      expect(task.status).toBe('blocked')
      expect(task.dispatchNote ?? null).toBeNull()
      expect((await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId))?.paused).toBeNull()
    })

    await test.step('the Inbox answer is stored: "Sends when delta-ledger is free."', async () => {
      await openInbox(cinna)
      const card = cinna.page.getByRole('article').filter({ hasText: QUESTION })
      await expect(card).toBeVisible({ timeout: 20_000 })
      await card.getByRole('button', { name: 'Answer', exact: true }).click()
      await cinna.page.getByRole('button', { name: 'Other (enter custom answer)', exact: true }).click()
      await cinna.page.getByPlaceholder('Type your answer…').fill(ANSWER)
      await cinna.page.getByRole('button', { name: 'Send answer', exact: true }).click()
      const queued = card.locator('[data-inbox-queued]')
      await expect(queued).toContainText(ANSWER, { timeout: 15_000 })
      await expect(queued).toContainText('Sends when delta-ledger is free.')
      // Not sent: the other dispatched run still holds the folder.
      expect(scout.sends).toHaveLength(1)
      expect(fake.calls[occupyCall].closed || fake.calls[occupyCall].released).toBe(false)
    })

    await test.step('once that run ends the answer is sent, and the turn it starts is settled by the report rule', async () => {
      await report(cinna, fake, occupyCall, occupy, OCCUPY)
      await expect.poll(() => scout.sends.length, { timeout: 30_000 }).toBe(2)
      expect(scout.sends[1]).toMatchObject({ text: ANSWER, contextId: A2A_CONTEXT, taskId: A2A_TASK })
      // The resumed turn ended without the folder agent reporting: flagged, and the queue paused on it.
      await expect.poll(() => taskStatus(cinna, asked), { timeout: 30_000 }).toBe('blocked')
      await expect.poll(async () => (await cinna.page.evaluate((id) => window.api.tasks.get(id), asked)).dispatchNote, { timeout: 30_000 })
        .toBe('Ended without reporting')
      expect((await cinna.page.evaluate((id) => window.api.taskDispatch.get(id), agentId))?.paused)
        .toMatchObject({ reason: 'unreported', taskId: asked })
      const card = cinna.page.getByRole('article', { name: `${HEADING}’s queue is paused`, exact: true })
      await expect(card).toBeVisible({ timeout: 20_000 })
      await expect(card.getByText(`${ASKED} ended without reporting`, { exact: true })).toBeVisible()
      // Exactly the folder agent's three prompts: the answer went to the A2A agent, not to a new folder turn.
      expect(fake.calls).toHaveLength(3)
      expect(fake.unexpected).toEqual([])
    })
  } finally {
    await fake.close()
    await scout.close()
  }
})
