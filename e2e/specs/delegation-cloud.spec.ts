import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from '../fixtures/app'
import { addAgentRoot, createFolderAgent, seedChatTask } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL } from '../fixtures/scriptAcpEngine'
import { linkSandboxAccount } from '../fixtures/jobRemoteService'
import { createFakeCinnaServer } from '../../src/main/tasks/adapters/testSupport/fakeCinnaServer'

test('an outbound cloud delegation preserves the requester and returns its structured result', async ({ cinna }) => {
  test.setTimeout(300_000)
  const fake = await scriptAcpEngine()
  const remote = createFakeCinnaServer({ delegations: true })
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url === '/api/v1/agents/') {
      res.end(JSON.stringify({ data: [{ id: 'cloud-writer', name: 'Cloud Writer' }], count: 1 }))
      return
    }
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const value = await remote.world.request('profile', req.url!, { method: req.method, body: raw ? JSON.parse(raw) : undefined })
      res.end(JSON.stringify(value))
    } catch (error) {
      res.statusCode = (error as { status?: number }).status ?? 404
      res.end(JSON.stringify({ detail: String(error) }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await cinna.skipOnboarding()
    await fake.install(cinna)
    await cinna.page.evaluate(async ({ host, model }) => {
      await window.api.settings.set('autoChatTitles', false)
      const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Cloud delegation fixture', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
    }, { host: fake.host, model: SCRIPT_MODEL })
    const root = await addAgentRoot(cinna)
    const requester = await createFolderAgent(cinna, root, 'Cloud requester')
    const chatId = await cinna.page.evaluate(async (agentId) => {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { agentId, router: 'direct', title: 'Cloud coordination' })
      return chat.id
    }, requester.id)
    const originTaskId = await seedChatTask(cinna, { chatId, title: 'Keep this task local' })
    await linkSandboxAccount(cinna, host)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await cinna.page.evaluate((chatId) => window.api.run.start({ chatId, content: 'Delegate to the cloud.' }), chatId)
    await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(1)
    fake.calls[0].release({ tools: [{ name: 'handover_targets' }] })
    await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(1)
    const outputs = fake.tools[0].params.results as { result: { content: { text: string }[]; isError?: boolean } }[]
    expect(outputs[0].result.isError).not.toBe(true)
    const targets = JSON.parse(outputs[0].result.content[0].text) as { target: { kind: string; agentId: string; adapter?: string } }[]
    const cloudTarget = targets.find((entry) => entry.target.kind === 'cloud')
    expect(cloudTarget).toBeTruthy()
    const target = cloudTarget!.target
    fake.tools[0].release({ tools: [{ name: 'handover_create', args: { target, id: 'cloud-feature-work', title: 'Cloud quartz feature', brief: 'Build quartz-cloud-5031.' } }] })
    await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(2)
    const createdOutput = fake.tools[1].params.results as typeof outputs
    expect(createdOutput[0].result.isError).not.toBe(true)
    const created = JSON.parse(createdOutput[0].result.content[0].text)
    expect(created).toMatchObject({ channel: 'cloud', state: 'gated', originTaskId })
    fake.tools[1].release({ text: 'Delegated. I will receive the result later.' })
    const inbox = await cinna.page.evaluate(() => window.api.inbox.list())
    const gate = inbox.entries.find((entry) => entry.taskId === created.taskId)!
    expect(await cinna.page.evaluate((requestId) => window.api.inbox.answer({ requestId, answers: [['Run']] }), gate.requestId)).toMatchObject({ ok: true })
    const createdCall = remote.calls().find((call) => call.method === 'POST' && call.path === '/api/v1/tasks/')!
    expect(createdCall.body).toMatchObject({ external_ref: created.taskId, delegation_metadata: { depth: 1, origin_task_id: originTaskId } })
    const child = await cinna.page.evaluate((id) => window.api.tasks.get(id), created.taskId)
    expect(child.executor).toBe('remote')
    expect(await cinna.page.evaluate((id) => window.api.tasks.get(id), originTaskId)).toMatchObject({ executor: 'desktop', status: 'completed' })
    const remoteId = child.remote!.id
    // A repeated question with a fresh server result ID is new work, even when
    // its wording is unchanged. Each answer must clear the local blocked state.
    for (let round = 0; round < 2; round++) {
      remote.touch(remoteId, { status: 'blocked', delegation_result: { id: `quartz-question-${round}`, status: 'blocked', summary: 'Choose the cloud output format.', question: 'Use JSON for quartz?', body: '', artifacts: [], audience: 'requester' } })
      await expect.poll(() => fake.calls.length, { timeout: 90_000 }).toBe(2 + round)
      expect(fake.calls[1 + round].text).toContain('Use JSON for quartz?')
      const waiting = await cinna.page.evaluate(() => window.api.inbox.list())
      expect(waiting.entries.some((entry) => entry.taskId === created.taskId)).toBe(false)
      fake.calls[1 + round].release({ tools: [{ name: 'handover_reply', args: { id: created.id, message: `Use JSON, confirmation ${round + 1}.` } }] })
      await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(3 + round)
      const replyOutput = fake.tools[2 + round].params.results as typeof outputs
      expect(replyOutput[0].result.isError).not.toBe(true)
      expect(JSON.parse(replyOutput[0].result.content[0].text)).toMatchObject({ delivered: true })
      fake.tools[2 + round].release({ text: 'The cloud executor has the format.' })
      await expect.poll(async () => (await cinna.page.evaluate((id) => window.api.delegations.forTask(id), originTaskId)).to[0].state).toBe('running')
    }
    remote.touch(remoteId, { status: 'completed', delegation_result: { id: 'final-quartz', status: 'done', summary: 'Cloud quartz feature complete.', body: 'Verified by the cloud executor.', artifacts: [], audience: 'requester' } })
    await expect.poll(() => fake.calls.length, { timeout: 90_000 }).toBe(4)
    expect(fake.calls[3].text).toContain('Cloud quartz feature complete.')
    fake.calls[3].release('Cloud work is complete.')
    expect(remote.calls().filter((call) => call.method === 'POST' && call.path === '/api/v1/tasks/')).toHaveLength(1)
    expect((await cinna.page.evaluate((id) => window.api.tasks.get(id), created.taskId)).status).toBe('completed')
  } finally {
    await fake.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
