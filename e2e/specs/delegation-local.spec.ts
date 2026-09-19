import { test, expect } from '../fixtures/app'
import { addAgentRoot, createFolderAgent, seedChatTask } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpHeld } from '../fixtures/scriptAcpEngine'

function result(held: ScriptAcpHeld): any {
  const responses = held.params.results as { result: { isError?: boolean; content: { type: string; text?: string }[] } }[]
  expect(responses[0].result.isError).not.toBe(true)
  return JSON.parse(responses[0].result.content.find((item) => item.type === 'text')!.text!)
}

test('a folder delegates to a kit through MCP, reports, and wakes its requester', async ({ cinna }) => {
  test.setTimeout(180_000)
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
    const requester = await createFolderAgent(cinna, root, 'Delegation requester')
    const executor = await createFolderAgent(cinna, root, 'Delegation executor')
    const chatId = await cinna.page.evaluate(async (agentId) => {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { agentId, router: 'direct', title: 'Coordinate delivery' })
      return chat.id
    }, requester.id)
    const originTaskId = await seedChatTask(cinna, { chatId, title: 'Original task' })
    await cinna.page.evaluate((chatId) => window.api.run.start({ chatId, content: 'Delegate the implementation.' }), chatId)
    await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(1)
    fake.calls[0].release({ tools: [{ name: 'handover_create', args: { target: { kind: 'kit', agentId: executor.id }, id: 'kit-feature-work', title: 'Implement quartz feature', brief: 'Implement quartz-9531.' } }] })
    await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(1)
    const created = result(fake.tools[0])
    expect(created).toMatchObject({ state: 'gated', depth: 1, originTaskId, targetAgentId: executor.id })
    expect(fake.calls).toHaveLength(1)
    fake.tools[0].release({ text: 'Delegated. I will wait for the return packet.' })
    const inbox = await cinna.page.evaluate(() => window.api.inbox.list())
    const gate = inbox.entries.find((entry) => entry.taskId === created.taskId)!
    expect(gate.deliveryOwner).toBe('handover')
    expect(await cinna.page.evaluate((requestId) => window.api.inbox.answer({ requestId, answers: [['Run']] }), gate.requestId)).toMatchObject({ ok: true })
    await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(2)
    expect(fake.calls[1].text).toContain('- handover depth: 1')
    expect(fake.calls[1].text).toContain('quartz-9531')
    fake.calls[1].release({ tools: [{ name: 'handover_report', args: { status: 'blocked', summary: 'Choose a quartz format.', question: 'Should quartz be exported as JSON?' } }] })
    await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(2)
    expect(result(fake.tools[1])).toMatchObject({ delegationId: created.id, status: 'blocked' })
    expect(fake.tools[1].params.offered).toContain('handover_report')
    fake.tools[1].release({ text: 'Waiting for the requester.' })
    await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(3)
    expect(fake.calls[2].text).toContain('Should quartz be exported as JSON?')
    fake.calls[2].release({ tools: [{ name: 'handover_reply', args: { id: created.id, message: 'Use JSON with the quartz-9531 key.' } }] })
    await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(3)
    expect(result(fake.tools[2])).toMatchObject({ delegationId: created.id, state: 'queued' })
    fake.tools[2].release({ text: 'The executor has the requested format.' })
    await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(4)
    expect(fake.calls[3].text).toContain('Use JSON with the quartz-9531 key.')
    fake.calls[3].release({ tools: [{ name: 'handover_report', args: { status: 'done', summary: 'Quartz feature implemented.' } }] })
    await expect.poll(() => fake.tools.length, { timeout: 60_000 }).toBe(4)
    expect(result(fake.tools[3])).toMatchObject({ delegationId: created.id, status: 'done' })
    fake.tools[3].release({ text: 'Finished.' })
    await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(5)
    expect(fake.calls[4].text).toContain('Quartz feature implemented.')
    fake.calls[4].release('The delegated implementation is complete.')
    const child = await cinna.page.evaluate((id) => window.api.tasks.get(id), created.taskId)
    expect(child).toMatchObject({ status: 'completed', parentTaskId: null })
    expect(await cinna.page.evaluate((id) => window.api.tasks.get(id), originTaskId)).toMatchObject({ executor: 'desktop', status: 'completed' })
    const links = await cinna.page.evaluate((id) => window.api.delegations.forTask(id), originTaskId)
    expect(JSON.stringify(links)).toContain(created.id)
    expect(fake.unexpected).toEqual([])
  } finally { await fake.close() }
})
