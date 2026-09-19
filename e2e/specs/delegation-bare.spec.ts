import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent, seedChatTask } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpHeld } from '../fixtures/scriptAcpEngine'
import { HANDOVER_GATE_OPTIONS, HANDOVER_HOW_TO_REPORT } from '../../src/shared/handovers'

/**
 * The handover bus over its **file** channel, driven only through the session's
 * `cinna` MCP tools: a kit requester delegates to an adopted bare folder, and
 * neither side ever writes a protocol file itself — `brief.md` and
 * `revisions/001.md` are published by main, and both reports are
 * `handover_report` calls (no `report.md` exists at any point).
 *
 * Real: the loopback MCP server and its session token, `delegationService`,
 * the file publication, the folder scan, the Inbox gate (answered through the
 * UI), `taskExecutionService`, the wake queue. Scripted: what each ACP turn
 * decides to call (`scriptAcpAgent.mjs`).
 *
 * Not proved: that a model would pick these tools, `execution: auto`, groups,
 * and restart recovery.
 */

const HANDOVER_ID = 'bare-feature-work'
const TITLE = 'Implement basalt feature'
const BRIEF = 'Implement basalt-4417 in the exporter.'
const QUESTION = 'Should basalt be exported as CSV?'
const REPLY = 'Use CSV with the basalt-4417 header.'
const DONE_SUMMARY = 'Basalt feature implemented.'

function parsed(held: ScriptAcpHeld): any {
  const responses = held.params.results as { result: { isError?: boolean; content: { type: string; text?: string }[] } }[]
  // The raw result in the message: a product refusal arrives as `isError` text.
  expect(responses[0].result.isError, JSON.stringify(responses[0].result)).not.toBe(true)
  return JSON.parse(responses[0].result.content.find((item) => item.type === 'text')!.text!)
}

/** Adopt `dir` over the `folder-pick` → `folder-add` pair the dialog uses (`handover-flow.spec.ts`). */
async function adoptFolder(cinna: CinnaApp, dir: string): Promise<string> {
  await cinna.stubDirectoryPicker(dir)
  const pick = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled) throw new Error('the stubbed directory picker reported cancelled')
  if (pick.refusal !== null) throw new Error(`the folder was refused: ${pick.refusal}`)
  const added = await cinna.page.evaluate(
    (input) => window.api.localAgents.folderAdd(input),
    { path: pick.path, relPaths: pick.found.map((entry) => entry.relPath) }
  )
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)
  const agents = await cinna.page.evaluate(() => window.api.localAgents.list())
  const real = realpathSync(dir)
  const agent = agents.agents.find((row) => row.path !== null && realpathSync(row.path) === real)
  if (!agent) throw new Error(`no agent row for ${dir}`)
  return agent.id
}

test('a kit delegates to a bare folder through MCP alone: brief, blocked, revision, done', async ({ cinna }) => {
  test.setTimeout(240_000)
  const fake = await scriptAcpEngine()
  try {
    await cinna.skipOnboarding()
    await fake.install(cinna)
    await cinna.page.evaluate(async ({ host, model }) => {
      await window.api.settings.set('autoChatTitles', false)
      const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Delegation fixture', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
    }, { host: fake.host, model: SCRIPT_MODEL })

    const root = await addAgentRoot(cinna)
    const requester = await createFolderAgent(cinna, root, 'Bare delegation requester')
    const folder = homeDir(cinna, 'basalt-exporter')
    writeFileSync(join(folder, 'CLAUDE.md'), '# Basalt Exporter\n\nYou own this project.\n')
    const executorId = await adoptFolder(cinna, folder)
    const handoverDir = join(folder, '.cinna', 'handovers', HANDOVER_ID)
    const briefFile = join(handoverDir, 'brief.md')

    const chatId = await cinna.page.evaluate(async (agentId) => {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { agentId, router: 'direct', title: 'Coordinate basalt' })
      return chat.id
    }, requester.id)
    const originTaskId = await seedChatTask(cinna, { chatId, title: 'Original basalt task' })
    const tasksTitled = async (): Promise<{ id: string; status: string }[]> =>
      (await cinna.page.evaluate(() => window.api.tasks.list({}))).filter((task) => task.title === TITLE)
    const taskOf = (id: string): Promise<any> => cinna.page.evaluate((taskId) => window.api.tasks.get(taskId), id)

    let created: any
    const createArgs = { id: HANDOVER_ID, title: TITLE, brief: BRIEF }

    await test.step('handover_targets lists the bare folder; handover_create publishes the brief', async () => {
      await cinna.page.evaluate((id) => window.api.run.start({ chatId: id, content: 'Delegate the basalt work.' }), chatId)
      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(1)
      fake.calls[0].release({ tools: [{ name: 'handover_targets' }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(1)
      const targets = parsed(fake.tools[0]) as { target: { kind: string; agentId: string }; folder: string | null }[]
      const entry = targets.find((item) => item.target.agentId === executorId)
      expect(entry, JSON.stringify(targets)).toBeDefined()
      expect(entry!.target).toEqual({ kind: 'bare', agentId: executorId })
      expect(realpathSync(entry!.folder!)).toBe(realpathSync(folder))

      // The requester has written nothing: the folder holds no handover yet.
      expect(existsSync(join(folder, '.cinna'))).toBe(false)
      fake.tools[0].release({ tools: [{ name: 'handover_create', args: { target: entry!.target, ...createArgs } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(2)
      created = parsed(fake.tools[1])
      expect(created).toMatchObject({ handoverId: HANDOVER_ID })
      expect(realpathSync(created.briefPath)).toBe(realpathSync(briefFile))
      expect(created.reportPath).toBe(join(created.briefPath, '..', 'report.md'))
      expect(created.revisionsDir).toBe(join(created.briefPath, '..', 'revisions'))
      expect(created.delegationId, JSON.stringify(created)).toEqual(expect.any(String))
      expect(created.taskId, JSON.stringify(created)).toEqual(expect.any(String))

      const brief = readFileSync(briefFile, 'utf8')
      expect(brief).toContain(BRIEF)
      expect(brief).toContain('status: ready')
      expect(brief).toContain(`agent: ${JSON.stringify(requester.id)}`)
      expect(brief).toContain(`chat: ${JSON.stringify(chatId)}`)
      expect(brief).toContain(`task: ${JSON.stringify(originTaskId)}`)
      expect(brief).toContain(HANDOVER_HOW_TO_REPORT)
    })

    await test.step('a repeated handover_create is the same delegation, and rewrites nothing', async () => {
      const before = { text: readFileSync(briefFile, 'utf8'), ino: statSync(briefFile).ino, mtimeMs: statSync(briefFile).mtimeMs }
      fake.tools[1].release({ tools: [{ name: 'handover_create', args: { target: { kind: 'bare', agentId: executorId }, ...createArgs } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(3)
      const again = parsed(fake.tools[2])
      expect(again).toMatchObject({ delegationId: created.delegationId, taskId: created.taskId, handoverId: HANDOVER_ID })
      expect({ text: readFileSync(briefFile, 'utf8'), ino: statSync(briefFile).ino, mtimeMs: statSync(briefFile).mtimeMs }).toEqual(before)
      expect(readdirSync(handoverDir)).toEqual(['brief.md'])
      expect((await tasksTitled()).map((task) => task.id)).toEqual([created.taskId])
      fake.tools[2].release({ text: 'Delegated. I will wait for the return packet.' })
    })

    await test.step('the Inbox gate is the desktop asking; Run starts the bare executor', async () => {
      await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
      await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
      const card = cinna.page.getByRole('article').filter({ hasText: `Run the handover “${TITLE}” in ${basename(folder)}?` })
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card.getByText('Cinna Desktop is asking a question', { exact: true })).toBeVisible()
      const entries = await cinna.page.evaluate(async () => (await window.api.inbox.list()).entries)
      expect(entries.filter((item) => item.deliveryOwner === 'handover').map((item) => item.taskId)).toEqual([created.taskId])

      await card.getByRole('button', { name: 'Answer', exact: true }).click()
      const modal = cinna.page.getByLabel('Question', { exact: true })
      await modal.getByRole('button', { name: HANDOVER_GATE_OPTIONS.run, exact: true }).click()
      await modal.getByRole('button', { name: 'Send answer', exact: true }).click()
      await expect(modal).toHaveCount(0)

      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(2)
      expect(fake.calls[1].text).toContain('basalt-4417')
      expect(realpathSync(fake.calls[1].cwd)).toBe(realpathSync(folder))
    })

    const executorChatId = await test.step('a blocked handover_report survives the executor turn ending', async () => {
      fake.calls[1].release({ tools: [{ name: 'handover_report', args: { status: 'blocked', summary: 'Choose a basalt format.', question: QUESTION } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(4)
      expect(fake.tools[3].params.offered).toContain('handover_report')
      expect(parsed(fake.tools[3])).toMatchObject({ delegationId: created.delegationId, status: 'blocked' })
      fake.tools[3].release({ text: 'Waiting for the requester.' })

      const task = await taskOf(created.taskId)
      expect(task.chatId).toEqual(expect.any(String))
      // The reply is saved when the turn has ended — the moment the regression
      // (itan_scenarios bug 1) turned `blocked` into `completed`.
      await expect.poll(async () => JSON.stringify((await cinna.page.evaluate((id) => window.api.chat.get(id), task.chatId))?.messages ?? []), { timeout: 60_000 })
        .toContain('Waiting for the requester.')
      return task.chatId as string
    })

    await test.step('the requester is woken in its own chat with the question, and replies', async () => {
      await expect.poll(() => fake.calls.length, { timeout: 90_000 }).toBe(3)
      expect(fake.calls[2].sessionId).toBe(fake.calls[0].sessionId)
      expect(fake.calls[2].text).toContain(QUESTION)
      // Read while the requester's turn is held, well after the executor's ended.
      expect(await taskOf(created.taskId)).toMatchObject({ status: 'blocked', chatId: executorChatId })

      fake.calls[2].release({ tools: [{ name: 'handover_reply', args: { id: created.delegationId, message: REPLY } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(5)
      const replied = parsed(fake.tools[4])
      expect(replied).toMatchObject({ delegationId: created.delegationId })
      expect(realpathSync(replied.revisionPath)).toBe(realpathSync(join(handoverDir, 'revisions', '001.md')))
      const revision = readFileSync(join(handoverDir, 'revisions', '001.md'), 'utf8')
      expect(revision).toContain('cinna_handover: 1')
      expect(revision).toContain(REPLY)
      fake.tools[4].release({ text: 'The executor has the requested format.' })
    })

    await test.step('the revision is a new turn in the same executor chat', async () => {
      await expect.poll(() => fake.calls.length, { timeout: 90_000 }).toBe(4)
      expect(fake.calls[3].text).toContain(REPLY)
      expect(fake.calls[3].sessionId).toBe(fake.calls[1].sessionId)
      expect(await taskOf(created.taskId)).toMatchObject({ chatId: executorChatId })
      fake.calls[3].release({ tools: [{ name: 'handover_report', args: { status: 'done', summary: DONE_SUMMARY } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(6)
      expect(parsed(fake.tools[5])).toMatchObject({ delegationId: created.delegationId, status: 'done' })
      fake.tools[5].release({ text: 'Finished.' })
    })

    await test.step('done wakes the requester again and settles one task and one delegation', async () => {
      await expect.poll(() => fake.calls.length, { timeout: 90_000 }).toBe(5)
      expect(fake.calls[4].sessionId).toBe(fake.calls[0].sessionId)
      expect(fake.calls[4].text).toContain(DONE_SUMMARY)
      fake.calls[4].release('The delegated implementation is complete.')

      await expect.poll(() => taskOf(created.taskId), { timeout: 60_000 }).toMatchObject({ status: 'completed', parentTaskId: null })
      const links = await cinna.page.evaluate((id) => window.api.delegations.forTask(id), originTaskId)
      expect(links.to.map((link) => ({ id: link.id, taskId: link.taskId, state: link.state, channel: link.channel })))
        .toEqual([{ id: created.delegationId, taskId: created.taskId, state: 'done', channel: 'file' }])
      expect((await tasksTitled()).map((task) => task.id)).toEqual([created.taskId])
      // Both reports were tool calls: no report.md was ever written by anyone.
      expect(readdirSync(handoverDir).sort()).toEqual(['brief.md', 'revisions'])
      expect(fake.unexpected).toEqual([])
    })
  } finally { await fake.close() }
})
