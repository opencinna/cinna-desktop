import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { requireLiveKey, seedOpenAiDefaultMode } from '../fixtures/live'
import { coreApi, linkLiveCinnaProfile, liveCoreSession } from '../fixtures/liveCinnaLink'
import type { LiveCinnaConfig } from '../fixtures/liveCinna'

/**
 * @live — delegation between REAL agents. Folder agents run on the real pinned
 * OpenCode engine (`engine: true`) against OpenAI with the key from `.env`
 * (the first of `PREFERRED_MODELS` the app lists, normally `gpt-4.1-mini`);
 * the cloud test also drives the developer's running cinna-core
 * (`CINNA_E2E_SERVER_URL` / `_EMAIL` / `_PASSWORD`) and its "Hello Testing
 * Agent". Skipped without the key; the cloud test also without the core.
 *
 * Cost per full run (estimated from token volume, not billed-measured): about
 * twenty-two OpenCode turns on gpt-4.1-mini, each a few requests carrying a large
 * system prompt — roughly US$0.10–0.30 of OpenAI — plus one turn of the cloud
 * agent on the core's own model account. About 3–3.5 minutes wall time when green.
 * Run it deliberately: `make e2e-one SPEC=live-delegation.spec.ts`.
 *
 * Every assertion is about outcomes — files on disk, delegation rows
 * (`window.api.delegations.forTask`), task DTOs, chat rows, the Inbox, the
 * core's task API — never about what the model wrote in prose. The words the
 * executors put into files live only in *their* prompts, so a coordinator that
 * writes them into `summary.txt` can only have learnt them from the return
 * packet.
 */

test.use({ engine: true })
test.beforeEach(() => requireLiveKey())

const TURN = 6 * 60_000

type Msg = { role: string; content: string; at: number; parts: string }

// ─── arrange helpers ────────────────────────────────────────────────────────

async function arrange(cinna: CinnaApp): Promise<{ root: Awaited<ReturnType<typeof addAgentRoot>>; model: string }> {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const model = await seedOpenAiDefaultMode(cinna)
  const root = await addAgentRoot(cinna)
  return { root, model }
}

/** The agent's system prompt: the kit assembles it from the workflow and entrypoint documents. */
async function setPrompt(cinna: CinnaApp, agentId: string, text: string): Promise<void> {
  for (const prompt of ['workflow', 'entrypoint'] as const) {
    const outcome = await cinna.page.evaluate(async ({ agentId, prompt, text }) => {
      const doc = await window.api.localAgents.readDoc({ agentId, prompt })
      if (!doc.stamp) throw new Error(`${doc.relPath} does not exist`)
      return window.api.localAgents.updateField({ agentId, update: { field: 'prompt', prompt, value: text }, expectedStamp: doc.stamp })
    }, { agentId, prompt, text })
    expect(outcome.ok, `${prompt} prompt saved`).toBe(true)
  }
}

/** Adopt a bare folder over the `folder-pick` → `folder-add` pair (`delegation-bare.spec.ts`). */
async function adoptFolder(cinna: CinnaApp, dir: string): Promise<string> {
  await cinna.stubDirectoryPicker(dir)
  const pick = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled) throw new Error('the stubbed directory picker reported cancelled')
  if (pick.refusal !== null) throw new Error(`the folder was refused: ${pick.refusal}`)
  const added = await cinna.page.evaluate((input) => window.api.localAgents.folderAdd(input),
    { path: pick.path, relPaths: pick.found.map((entry) => entry.relPath) })
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)
  const agents = await cinna.page.evaluate(() => window.api.localAgents.list())
  const real = realpathSync(dir)
  const agent = agents.agents.find((row) => row.path !== null && realpathSync(row.path) === real)
  if (!agent) throw new Error(`no agent row for ${dir}`)
  return agent.id
}

async function createReadyTask(cinna: CinnaApp, title: string, goal: string, agentId: string): Promise<string> {
  const task = await cinna.page.evaluate((input) => window.api.tasks.create(input),
    { title, goal, status: 'open' as const, assignee: { kind: 'agent' as const, agentId } })
  return task.id
}

/** The user starts the task from its page: Tasks → the row → Continue with the agent → Continue. */
async function startTaskThroughUi(cinna: CinnaApp, title: string, agentName: string): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('region', { name: 'Ready', exact: true }).getByRole('button', { name: `${title} — Ready`, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
  const controls = page.getByRole('region', { name: 'Continue this task', exact: true })
  await controls.getByRole('combobox', { name: 'Continue with', exact: true }).selectOption({ label: agentName })
  await controls.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(controls).toHaveCount(0, { timeout: 30_000 })
}

/** Answer the first open gate card in the Inbox with Run, through the real UI. */
async function answerGateWithRun(cinna: CinnaApp, question: string): Promise<void> {
  const page = cinna.page
  if (!(await page.getByRole('heading', { name: 'Inbox', exact: true }).isVisible())) {
    await page.getByRole('button', { name: /^Inbox/ }).click()
  }
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  const card = page.getByRole('article').filter({ hasText: question })
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card.getByText('Cinna Desktop is asking a question', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Answer', exact: true }).click()
  const modal = page.getByLabel('Question', { exact: true })
  await modal.getByRole('button', { name: 'Run', exact: true }).click()
  await modal.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(modal).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Answer', exact: true })).toHaveCount(0)
}

/**
 * The agent's file named `name`, wherever in its folder the agent put it. A kit
 * agent's own prompt sends written files to `app-data/storage/`, a bare one
 * writes at the top; where is the kit's convention, not what is under test.
 */
function findFile(dir: string, name: string): string | null {
  const hit = (readdirSync(dir, { recursive: true }) as string[])
    .find((rel) => basename(rel) === name && !rel.split('/').some((seg) => seg === 'node_modules' || seg === '.git'))
  return hit ? join(dir, hit) : null
}
const readAgentFile = (dir: string, name: string): string => {
  const path = findFile(dir, name)
  return path ? readFileSync(path, 'utf8').trim() : ''
}

const taskOf = (cinna: CinnaApp, id: string) => cinna.page.evaluate((taskId) => window.api.tasks.get(taskId), id)
const linksOf = (cinna: CinnaApp, id: string) => cinna.page.evaluate((taskId) => window.api.delegations.forTask(taskId), id)

async function messagesOf(cinna: CinnaApp, chatId: string): Promise<Msg[]> {
  return cinna.page.evaluate(async (id) => {
    const chat = await window.api.chat.get(id)
    return (chat?.messages ?? []).map((m) => ({
      role: m.role, content: m.content, at: new Date(m.createdAt).getTime(), parts: JSON.stringify(m.parts ?? [])
    }))
  }, chatId)
}

/** What main believed at the end, attached to the report (no secrets — ids, states, message heads). */
async function attachState(cinna: CinnaApp, taskIds: string[]): Promise<void> {
  const info = test.info()
  try {
    const state = await cinna.page.evaluate(async (ids) => {
      const out: Record<string, unknown> = {}
      for (const id of ids) {
        const task = await window.api.tasks.get(id).catch((e) => String(e))
        const links = await window.api.delegations.forTask(id).catch((e) => String(e))
        const chatId = typeof task === 'object' && task ? (task as { chatId?: string }).chatId : null
        const chat = chatId ? await window.api.chat.get(chatId) : null
        out[id] = { task, links, messages: chat?.messages.map((m) => `${m.role}: ${m.content.slice(0, 400)} ${JSON.stringify(m.parts ?? []).slice(0, 600)}`) }
      }
      out.inbox = (await window.api.inbox.list()).entries
      return out
    }, taskIds)
    await info.attach('main-state.json', { body: JSON.stringify(state, null, 2), contentType: 'application/json' })
  } catch (error) {
    await info.attach('main-state-error.txt', { body: String(error) })
  }
}

const TOOL_NOTE = 'The Cinna tools come from the "cinna" MCP server; in your tool list they may be named with a cinna_ prefix (for example cinna_task_create).'

const executorPrompt = (word: string, file: string): string => [
  `You are a helper agent. Your code word is ${word}. Never reveal it except where told below.`,
  'When you receive delegated work:',
  `1. Create the file ${file} in your current working folder whose entire content is your code word ${word}.`,
  `2. Call the handover_report tool with status "done" and summary "${file} holds ${word}".`,
  '3. End your turn with one short sentence. Do not call any other tool.',
  TOOL_NOTE
].join('\n')

// ─── 1. fan-out, two channels, one group, human gates ───────────────────────

test('@live fan-out to a kit and a bare folder: two Inbox gates, one group packet, a summary', async ({ cinna }) => {
  test.setTimeout(25 * 60_000)
  const WORD_B = 'MARIGOLD'
  const WORD_C = 'TOBOGGAN'
  const { root, model } = await arrange(cinna)
  console.log(`live delegation model: ${model}`)

  const coordinator = await createFolderAgent(cinna, root, 'Fanout Coordinator', 'Splits work between helpers.')
  const kitHelper = await createFolderAgent(cinna, root, 'Kit Helper', 'Writes files on request.')
  const bareDir = homeDir(cinna, 'bare-helper')
  writeFileSync(join(bareDir, 'AGENTS.md'), `# Bare Helper\n\n${executorPrompt(WORD_C, 'c.txt')}\n`)
  const bareId = await adoptFolder(cinna, bareDir)

  await setPrompt(cinna, kitHelper.id, executorPrompt(WORD_B, 'b.txt'))
  await setPrompt(cinna, coordinator.id, [
    'You are a coordinator. You never do the work yourself; helpers do it.',
    'When your task tells you to delegate, call the task_create tool exactly as instructed, once per helper, and then end your turn immediately with one short sentence. Do not call handover_list, do not wait, do not create files in that turn.',
    'Later Cinna Desktop will send you a message that starts with "Handover group". Only then: create the file summary.txt in your current working folder with one line per helper, each line holding the code word that helper reported in that message. Then end your turn with one short sentence.',
    TOOL_NOTE
  ].join('\n'))

  const TITLE = 'Fan out the two files'
  const goal = [
    'Delegate two pieces of work, then end your turn.',
    `1. Call task_create with exactly: ${JSON.stringify({ assignee: { kind: 'kit', agentId: kitHelper.id }, id: 'fanout-b', title: 'Write b.txt', description: 'Create b.txt in your folder containing only your code word, then call handover_report with status done and a summary naming your code word.', group: 'fanout' })}`,
    `2. Call task_create with exactly: ${JSON.stringify({ assignee: { kind: 'bare', agentId: bareId }, id: 'fanout-c', title: 'Write c.txt', description: 'Create c.txt in your folder containing only your code word, then call handover_report with status done and a summary naming your code word.', group: 'fanout' })}`,
    '3. End your turn now. The results come back later on their own.'
  ].join('\n')
  const taskId = await createReadyTask(cinna, TITLE, goal, coordinator.id)

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  try {
    await test.step('the user starts the coordinator task from its page', async () => {
      await startTaskThroughUi(cinna, TITLE, 'Fanout Coordinator')
    })

    const pending = await test.step('the coordinator opens two delegations in one group, both gated', async () => {
      await expect.poll(async () => (await linksOf(cinna, taskId)).to.length, { timeout: TURN, intervals: [3_000] }).toBe(2)
      const to = (await linksOf(cinna, taskId)).to
      expect(to.map((d) => [d.channel, d.targetAgentId, d.groupId, d.depth, d.execution]).sort()).toEqual([
        ['file', bareId, 'fanout', 1, 'receiver'],
        ['local', kitHelper.id, 'fanout', 1, 'receiver']
      ])
      return to
    })
    const kit = pending.find((d) => d.channel === 'local')!
    const file = pending.find((d) => d.channel === 'file')!

    await test.step('both Inbox gates answered with Run through the UI', async () => {
      await answerGateWithRun(cinna, `Run “${kit.title}” on Kit Helper, requested by Fanout Coordinator?`)
      await answerGateWithRun(cinna, `Run the handover “${file.title}” in ${basename(bareDir)}?`)
    })

    const childIds = await test.step('both child tasks reach Done and the files hold the right words', async () => {
      await expect.poll(async () => {
        const to = (await linksOf(cinna, taskId)).to
        return to.map((d) => d.taskId === null ? 'no task' : 'linked')
      }, { timeout: 60_000 }).toEqual(['linked', 'linked'])
      const to = (await linksOf(cinna, taskId)).to
      const ids = to.map((d) => d.taskId!)
      for (const id of ids) {
        await expect.poll(async () => (await taskOf(cinna, id)).status, { timeout: TURN, intervals: [5_000] }).toBe('completed')
      }
      expect(readAgentFile(kitHelper.path, 'b.txt')).toBe(WORD_B)
      expect(readAgentFile(bareDir, 'c.txt')).toBe(WORD_C)
      return ids
    })

    const chatId = (await taskOf(cinna, taskId)).chatId!
    const packetAt = await test.step('the group return packet arrives in the coordinator chat as a system turn', async () => {
      await expect.poll(async () => (await messagesOf(cinna, chatId)).filter((m) => m.role === 'system' && m.content.startsWith('Handover group `fanout` has finished — 2 handovers:')).length,
        { timeout: TURN, intervals: [5_000] }).toBe(1)
      const packet = (await messagesOf(cinna, chatId)).find((m) => m.role === 'system')!
      expect(packet.content).toContain('`fanout-b` — done')
      expect(packet.content).toContain('`fanout-c` — done')
      return packet.at
    })

    await test.step('the follow-up turn writes summary.txt with both words, after the packet', async () => {
      await expect.poll(() => readAgentFile(coordinator.path, 'summary.txt'), { timeout: TURN, intervals: [5_000] })
        .toMatch(new RegExp(`(?=[\\s\\S]*${WORD_B})(?=[\\s\\S]*${WORD_C})`))
      expect(statSync(findFile(coordinator.path, 'summary.txt')!).mtimeMs).toBeGreaterThanOrEqual(Math.floor(packetAt / 1000) * 1000)
    })

    await test.step('the coordinator task ends Done', async () => {
      await expect.poll(async () => (await taskOf(cinna, taskId)).status, { timeout: TURN, intervals: [5_000] }).toBe('completed')
      expect((await linksOf(cinna, taskId)).to.map((d) => d.state)).toEqual(['done', 'done'])
    })

    await test.step('Details link both ways: Delegated to on the coordinator, Delegated from on a child', async () => {
      const page = cinna.page
      await page.getByRole('button', { name: 'Tasks', exact: true }).click()
      await page.getByRole('button', { name: new RegExp(`^${TITLE} — `) }).first().click()
      const details = page.getByRole('complementary', { name: 'Details' })
      const delegatedTo = details.locator('dt').filter({ hasText: /^Delegated to$/ }).locator('xpath=following-sibling::dd[1]')
      await expect(delegatedTo.getByRole('button')).toHaveText(pending.map((d) => d.title))
      await delegatedTo.getByRole('button', { name: kit.title, exact: true }).click()
      await expect(page.getByRole('heading', { level: 1, name: kit.title, exact: true })).toBeVisible()
      const from = page.getByRole('complementary', { name: 'Details' }).locator('dt').filter({ hasText: /^Delegated from$/ }).locator('xpath=following-sibling::dd[1]')
      await expect(from.getByRole('button')).toHaveText(TITLE)
      expect((await linksOf(cinna, childIds[0])).from?.originTaskId ?? (await linksOf(cinna, childIds[1])).from?.originTaskId).toBe(taskId)
    })
  } finally {
    await attachState(cinna, [taskId])
  }
})

// ─── 2. standing grants and the depth cap ───────────────────────────────────

const WORD_D = 'LANTERN'

/**
 * Lead → Middle (depth 1) → Last (depth 2) → Middle (depth 3, refused).
 * Middle and Last hold the receiving Delegations grant and every request says
 * `execution: auto`, so nothing should ask. Last's code word lives only in its
 * own prompt. Returns once the user has started the lead's task.
 */
async function arrangeChain(cinna: CinnaApp, options: { relayInPlainText?: boolean } = {}) {
  const { root } = await arrange(cinna)
  const lead = await createFolderAgent(cinna, root, 'Chain Lead', 'Starts the chain.')
  const middle = await createFolderAgent(cinna, root, 'Chain Middle', 'Passes work on.')
  const last = await createFolderAgent(cinna, root, 'Chain Last', 'Does the work.')

  for (const id of [middle.id, last.id]) {
    const set = await cinna.page.evaluate((agentId) => window.api.localAgents.setDelegationPermission(agentId, 'delegations', 'auto'), id)
    expect(set.ok).toBe(true)
  }

  await setPrompt(cinna, lead.id, [
    'You are the chain lead. When your task tells you to delegate, call task_create exactly as instructed and end your turn immediately with one short sentence.',
    'When Cinna Desktop later sends you a message starting with "Handover", reply with one short sentence and end your turn. Do not call any tool then.',
    TOOL_NOTE
  ].join('\n'))
  await setPrompt(cinna, middle.id, [
    'You are a relay. When you receive delegated work, do NOT do it yourself. Call task_create once with exactly:',
    JSON.stringify({ assignee: { kind: 'kit', agentId: last.id }, id: 'chain-last', title: 'Do the chain work', description: 'Write d.txt in your folder containing only your code word, then call handover_report with status done and a summary naming your code word.', execution: 'auto' }),
    'Then end your turn immediately with one short sentence.',
    options.relayInPlainText
      ? 'When Cinna Desktop later sends you a message starting with "Delegation" or "Handover", do not call any tool. Answer in plain text with one sentence: "Relayed: " followed by the summary that message gives. Then end your turn.'
      : 'When Cinna Desktop later sends you a message starting with "Handover", call handover_report with status "done" and summary "relayed: " followed by the summary that message gives, then end your turn.',
    TOOL_NOTE
  ].join('\n'))
  await setPrompt(cinna, last.id, [
    `You are the last helper. Your code word is ${WORD_D}.`,
    'When you receive delegated work, do these steps in order:',
    `1. Call task_create once with exactly: ${JSON.stringify({ assignee: { kind: 'kit', agentId: middle.id }, id: 'chain-too-deep', title: 'One hop too many', description: 'Check the work.', execution: 'auto' })}. It is expected to fail; that is fine. Do not retry it.`,
    `2. Create the file d.txt in your current working folder whose entire content is ${WORD_D}.`,
    `3. Call handover_report with status "done" and summary "d.txt holds ${WORD_D}".`,
    '4. End your turn with one short sentence.',
    TOOL_NOTE
  ].join('\n'))

  const TITLE = 'Start the delegation chain'
  const taskId = await createReadyTask(cinna, TITLE, [
    'Delegate this work and end your turn.',
    `Call task_create with exactly: ${JSON.stringify({ assignee: { kind: 'kit', agentId: middle.id }, id: 'chain-middle', title: 'Relay the chain work', description: 'Get d.txt written by the next helper.', execution: 'auto' })}`,
    'Then end your turn now.'
  ].join('\n'), lead.id)

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await startTaskThroughUi(cinna, TITLE, 'Chain Lead')
  return { taskId, lead, middle, last }
}

test('@live auto-run under standing grants; the third hop is refused and nothing runs for it', async ({ cinna }) => {
  test.setTimeout(20 * 60_000)
  const { taskId, middle, last } = await arrangeChain(cinna)
  const tracked = [taskId]
  try {

    const first = await test.step('depth 1 runs without a gate', async () => {
      await expect.poll(async () => (await linksOf(cinna, taskId)).to.length, { timeout: TURN, intervals: [3_000] }).toBe(1)
      const [d] = (await linksOf(cinna, taskId)).to
      expect([d.channel, d.targetAgentId, d.depth, d.execution]).toEqual(['local', middle.id, 1, 'auto'])
      expect(d.state).not.toBe('gated')
      expect(d.waitingOnUser).toBe(false)
      tracked.push(d.taskId!)
      return d
    })

    const second = await test.step('depth 2 also runs without a gate', async () => {
      await expect.poll(async () => (await linksOf(cinna, first.taskId!)).to.length, { timeout: TURN, intervals: [3_000] }).toBe(1)
      const [d] = (await linksOf(cinna, first.taskId!)).to
      expect([d.channel, d.targetAgentId, d.depth, d.execution, d.rootDelegationId]).toEqual(['local', last.id, 2, 'auto', first.id])
      expect(d.waitingOnUser).toBe(false)
      tracked.push(d.taskId!)
      return d
    })

    await test.step('the depth-2 work completes and the third hop was refused with its reason', async () => {
      await expect.poll(async () => (await taskOf(cinna, second.taskId!)).status, { timeout: TURN, intervals: [5_000] }).toBe('completed')
      expect(readAgentFile(last.path, 'd.txt')).toBe(WORD_D)
      // Nothing was created for the refused request: no delegation from the last task, no task with its title.
      expect((await linksOf(cinna, second.taskId!)).to).toEqual([])
      const all = await cinna.page.evaluate(() => window.api.tasks.list({}))
      expect(all.filter((t) => t.title === 'One hop too many')).toEqual([])
      // The refusal is in the executor's own transcript, as the tool's answer.
      const lastChat = (await taskOf(cinna, second.taskId!)).chatId!
      const transcript = (await messagesOf(cinna, lastChat)).map((m) => m.content + m.parts).join('\n')
      expect(transcript).toContain('Delegations are limited to depth 2.')
    })

    await test.step('results travel back up and nothing ever waited on the user', async () => {
      await expect.poll(async () => (await taskOf(cinna, first.taskId!)).status, { timeout: TURN, intervals: [5_000] }).toBe('completed')
      await expect.poll(async () => (await linksOf(cinna, taskId)).to[0].state, { timeout: TURN, intervals: [5_000] }).toBe('done')
      const leadChat = (await taskOf(cinna, taskId)).chatId!
      // The relayed summary carries Last's code word, which the lead's prompt never had.
      await expect.poll(async () => (await messagesOf(cinna, leadChat)).some((m) => m.role === 'system' &&
        m.content.startsWith('Delegation chain-middle done:') && m.content.includes(WORD_D)),
      { timeout: TURN, intervals: [5_000] }).toBe(true)
      expect((await cinna.page.evaluate(() => window.api.inbox.list())).entries).toEqual([])
    })
  } finally {
    await attachState(cinna, tracked)
  }
})

/**
 * A relay that delegated onward and ended its turn — which is what
 * `task_create` tells it to do — is waiting on its own delegation, not
 * finished. Its row stays running until Last has reported and Middle has relayed
 * the answer, so the lead hears about chain-middle exactly once, with Last's
 * code word in it. (Before the fix, the turn-ending fallback settled it `done`
 * with `report_missing` while Last was still working, and the lead got a second
 * packet when Middle relayed.)
 */
test('@live a relay waiting on its own delegation is not reported done early', async ({ cinna }) => {
  test.setTimeout(20 * 60_000)
  const { taskId } = await arrangeChain(cinna)
  try {
    await expect.poll(async () => (await linksOf(cinna, taskId)).to[0]?.state ?? 'none', { timeout: 2 * TURN, intervals: [3_000] }).toBe('done')
    const [middle] = (await linksOf(cinna, taskId)).to
    const middleChildren = (await linksOf(cinna, middle.taskId!)).to
    // When the lead's delegation settled, Middle's own delegation was already over.
    expect(middleChildren.map((d) => d.state)).toEqual(['done'])
    expect(middle.warning ?? null).toBeNull()
    const leadChat = (await taskOf(cinna, taskId)).chatId!
    const packets = async () => (await messagesOf(cinna, leadChat))
      .filter((m) => m.role === 'system' && m.content.startsWith('Delegation chain-middle')).map((m) => m.content)
    await expect.poll(async () => (await packets()).length, { timeout: TURN, intervals: [3_000] }).toBeGreaterThan(0)
    // A late second packet would follow within the lead's own turn; give it time to show up.
    await cinna.page.waitForTimeout(20_000)
    const received = await packets()
    expect(received).toHaveLength(1)
    expect(received[0]).toContain('Delegation chain-middle done:')
    expect(received[0]).not.toContain('without a structured report')
    expect(received[0]).toContain(WORD_D)
  } finally {
    await attachState(cinna, [taskId])
  }
})

/**
 * The same relay, answering the return packet in plain text instead of calling
 * `handover_report`. The turn that packet opens in Middle's chat is watched, so
 * its text settles Middle `done` with `report_missing` — after Last is done, not
 * when Middle's first turn ended — and the lead hears about chain-middle once,
 * with Last's code word in the relayed text.
 */
test('@live a relay that answers its child in plain text settles once, after the child', async ({ cinna }) => {
  test.setTimeout(20 * 60_000)
  const { taskId } = await arrangeChain(cinna, { relayInPlainText: true })
  try {
    await expect.poll(async () => (await linksOf(cinna, taskId)).to[0]?.state ?? 'none', { timeout: 2 * TURN, intervals: [3_000] }).toBe('done')
    const [middle] = (await linksOf(cinna, taskId)).to
    const middleChildren = (await linksOf(cinna, middle.taskId!)).to
    expect(middleChildren.map((d) => d.state)).toEqual(['done'])
    // Last's row last changed when its packet reached Middle; Middle settled on the turn that opened.
    expect(middle.updatedAt).toBeGreaterThanOrEqual(middleChildren[0].updatedAt)
    expect(middle.warning).toBe('report_missing')
    const leadChat = (await taskOf(cinna, taskId)).chatId!
    const packets = async () => (await messagesOf(cinna, leadChat))
      .filter((m) => m.role === 'system' && m.content.startsWith('Delegation chain-middle')).map((m) => m.content)
    await expect.poll(async () => (await packets()).length, { timeout: TURN, intervals: [3_000] }).toBeGreaterThan(0)
    await cinna.page.waitForTimeout(20_000)
    const received = await packets()
    expect(received).toHaveLength(1)
    expect(received[0]).toContain('Delegation chain-middle done:')
    expect(received[0]).toContain(WORD_D)
  } finally {
    await attachState(cinna, [taskId])
  }
})

// ─── 3. cloud: a real cinna-core agent ──────────────────────────────────────

test.describe('against the running cinna-core', () => {
  let core: { config: LiveCinnaConfig; token: string } | null = null
  const marker = `e2e-live-${Date.now().toString(36)}`

  test.beforeEach(async () => {
    const session = await liveCoreSession()
    test.skip(!session.ok, session.ok ? '' : session.reason)
    if (session.ok) core = { config: session.config, token: session.token }
  })

  test.afterEach(async () => {
    if (!core) return
    // Every core task this run created carries the marker in its title.
    const listed = await coreApi(core.config, core.token, '/tasks/?limit=200')
    for (const task of (listed.body?.data ?? []) as { id: string; title: string }[]) {
      if (task.title?.includes(marker)) await coreApi(core.config, core.token, `/tasks/${task.id}`, { method: 'DELETE' })
    }
  })

  test('@live cloud delegation to a real cinna-core agent returns its result', async ({ cinna }) => {
    test.setTimeout(20 * 60_000)
    const { config, token } = core!
    const agents = await coreApi(config, token, '/agents/?limit=200')
    const remote = (agents.body?.data ?? []).find((a: { name: string }) => a.name === 'Hello Testing Agent') as { id: string } | undefined
    test.skip(!remote, 'the core has no "Hello Testing Agent"')

    const { root } = await arrange(cinna)
    const requester = await createFolderAgent(cinna, root, 'Cloud Requester', 'Asks a cloud agent.')
    await setPrompt(cinna, requester.id, [
      'You are a requester. When your task tells you to delegate, call task_create exactly as instructed and end your turn immediately with one short sentence.',
      'When Cinna Desktop later sends you a message starting with "Handover", reply with one short sentence and end your turn. Do not call any tool then.',
      TOOL_NOTE
    ].join('\n'))
    const TITLE = `Ask the cloud for a greeting ${marker}`
    const remoteTitle = `Greeting ${marker}`
    const taskId = await createReadyTask(cinna, TITLE, [
      'Delegate this work and end your turn.',
      `Call task_create with exactly: ${JSON.stringify({ assignee: { kind: 'cloud', agentId: remote!.id, adapter: 'cinna' }, id: 'cloud-hello', title: remoteTitle, description: 'Automated test. Reply with one short friendly greeting sentence. If a handover_report tool is available, call it once with status done and a one-line summary.' })}`,
      'Then end your turn now.'
    ].join('\n'), requester.id)

    await linkLiveCinnaProfile(cinna, config, token)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())

    try {
      await startTaskThroughUi(cinna, TITLE, 'Cloud Requester')

      const gated = await test.step('the requester opens a cloud delegation, gated', async () => {
        await expect.poll(async () => (await linksOf(cinna, taskId)).to.length, { timeout: TURN, intervals: [3_000] }).toBe(1)
        const [d] = (await linksOf(cinna, taskId)).to
        expect([d.channel, d.targetKind, d.targetAgentId, d.depth]).toEqual(['cloud', 'cloud', remote!.id, 1])
        return d
      })

      await test.step('the gate is answered with Run in the Inbox', async () => {
        const page = cinna.page
        await page.getByRole('button', { name: /^Inbox/ }).click()
        const card = page.getByRole('article').filter({ hasText: `Send “${gated.title}” to ` })
        await expect(card).toBeVisible({ timeout: 60_000 })
        await card.getByRole('button', { name: 'Answer', exact: true }).click()
        const modal = page.getByLabel('Question', { exact: true })
        await modal.getByRole('button', { name: 'Run', exact: true }).click()
        await modal.getByRole('button', { name: 'Send answer', exact: true }).click()
        await expect(modal).toHaveCount(0)
      })

      const remoteId = await test.step('a task exists on the core and its agent runs', async () => {
        await expect.poll(async () => (await taskOf(cinna, gated.taskId!)).remote?.id ?? null, { timeout: 120_000, intervals: [2_000] }).not.toBeNull()
        const child = await taskOf(cinna, gated.taskId!)
        expect(child.executor).toBe('remote')
        const id = child.remote!.id
        const detail = await coreApi(config, token, `/tasks/${id}/detail`)
        expect(detail.status).toBe(200)
        expect(detail.body.title).toBe(remoteTitle)
        expect(detail.body.selected_agent_id).toBe(remote!.id)
        await expect.poll(async () => ((await coreApi(config, token, `/tasks/${id}/sessions`)).body?.data ?? []).length,
          { timeout: 300_000, intervals: [5_000] }).toBeGreaterThan(0)
        return id
      })

      await test.step('the result returns to the requester chat and the desktop task is Done', async () => {
        await expect.poll(async () => (await coreApi(config, token, `/tasks/${remoteId}/detail`)).body?.status,
          { timeout: TURN, intervals: [5_000] }).toBe('completed')
        await expect.poll(async () => (await taskOf(cinna, gated.taskId!)).status, { timeout: TURN, intervals: [5_000] }).toBe('completed')
        const chatId = (await taskOf(cinna, taskId)).chatId!
        // The single packet names the remote task by the key the core gave it.
        const shortCode = (await coreApi(config, token, `/tasks/${remoteId}/detail`)).body.short_code as string
        await expect.poll(async () => (await messagesOf(cinna, chatId)).some((m) => m.role === 'system' &&
          m.content.startsWith('Delegation cloud-hello done:') && m.content.includes(`Remote task: ${shortCode}`)),
        { timeout: TURN, intervals: [5_000] }).toBe(true)
        expect((await linksOf(cinna, taskId)).to.map((d) => d.state)).toEqual(['done'])
        expect((await coreApi(config, token, '/tasks/?limit=200')).body.data.filter((t: { title: string }) => t.title === remoteTitle)).toHaveLength(1)
      })
    } finally {
      await attachState(cinna, [taskId])
    }
  })
})
