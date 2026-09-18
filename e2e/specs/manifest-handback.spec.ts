import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { installConductorAcpEngine } from '../fixtures/conductorAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'

/**
 * The folder manifest and real ACP driver decide whether terminal answer text
 * carries a typed handback note. A scripted ACP coordinator issues handoff /
 * finish calls over authenticated Cinna MCP. The durable transcript and runner
 * are the real application implementations.
 * A sibling whose slug happens to be coordinator must remain a sibling.
 */
const MODEL = 'qwen3:8b'
const CHAT = 'Manifest handback workspace'
const AGENT = 'Manifest Report Verifier'
const GOAL = 'Verify the quarterly report and return the verified result.'
const HANDOFF = 'Check the report and return your findings.'
const NOTE = 'Verified "app-data/report.md"; open items: none. juniper-6382'
const OUTPUT = `Report verification is complete.\n/handback ${NOTE}`
const SUMMARY = 'Quarterly report verified and complete: cedar-4197.'
const AUTO_NOTICE = `${AGENT} handed the task back to the coordinator.`
interface RuntimeStep { sessionId: string; tools: string[]; history: { prompt?: { type: string; text?: string }[] }[] }

async function coordinator() {
  const requests: RuntimeStep[] = []
  const violations: string[] = []
  let first = (): void => { throw new Error('Coordinator request is not ready') }
  let final = (): void => { throw new Error('Coordinator return request is not ready') }
  const server = createServer((req, res) => {
    const send = (body: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
    if (req.url === '/api/tags') { send({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] }); return }
    if (req.url === '/api/version') { send({ version: '0.6.2' }); return }
    if (req.method !== 'POST' || req.url !== '/runtime/step') {
      violations.push(`${req.method} ${req.url}`); res.statusCode = 404; send({}); return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw) as RuntimeStep
      requests.push(body)
      const index = requests.length
      if (!['handoff', 'finish'].every((name) => body.tools.filter((tool) => tool === name).length === 1)) {
        violations.push(`Coordinator request ${index} lacks runtime controls`)
      }
      const control = (name: string, args: unknown): void => send({ name, args, id: `manifest-call-${index}` })
      if (index === 1) first = () => control('handoff', { agent: AGENT, note: HANDOFF })
      else if (index === 2) final = () => control('finish', { summary: SUMMARY })
      else { violations.push(`Unexpected extra runtime request ${index}`); control('finish', { summary: 'Unexpected continuation.' }) }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, violations,
    releaseFirst: () => first(), releaseFinish: () => final(),
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) } }
}

async function arrange(cinna: CinnaApp, host: string, typed: boolean) {
  await cinna.skipOnboarding()
  const acp = await installFakeAcpEngine(cinna, { prompt: { emit: [{ kind: 'update', update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: OUTPUT }
  } }] } })
  await installConductorAcpEngine(cinna, host, acp.shim)
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  // Manifest authoring is a filesystem operation. Preserve the real scaffold;
  // only write this sandbox folder's declared handover, then use a real rescan.
  const path = join(agent.path, MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  manifest.handovers = [typed ? { target_slug: 'coordinator', target_kind: 'coordinator' } : { target_slug: 'coordinator' }]
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  const chatId = await cinna.page.evaluate(async ({ host, model, agentId, title }) => {
    await window.api.settings.set('autoChatTitles', false)
    const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Manifest handback model', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, engine: 'opencode', toolPolicy: 'connectors', isDefault: true })
    await window.api.localAgents.rescan()
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title, providerId: provider.id, modelId: model, router: 'coordinator' })
    await window.api.chat.addOnDemandAgent(chat.id, agentId)
    await window.api.chat.showInList(chat.id)
    return chat.id
  }, { host, model: MODEL, agentId: agent.id, title: CHAT })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  const loaded = await cinna.page.evaluate((id) => window.api.localAgents.get(id), agent.id)
  expect(loaded.ok).toBe(true)
  if (!loaded.ok) throw new Error(loaded.message)
  expect(loaded.value.manifest.handovers).toEqual(manifest.handovers)
  await cinna.page.getByText(CHAT, { exact: true }).click()
  return { acp, chatId, agentId: agent.id }
}

for (const typed of [true, false]) {
  test(typed ? 'an explicit coordinator manifest handover carries a typed note into the next owner turn' :
    'a sibling named coordinator leaves the handback marker as transcript data', async ({ cinna }) => {
    test.setTimeout(90_000)
    const fake = await coordinator()
    try {
      const { acp, chatId, agentId } = await arrange(cinna, fake.host, typed)
      await cinna.page.getByRole('button', { name: 'Add to chat', exact: true }).click()
      await cinna.page.getByRole('menuitem', { name: 'Run on its own…', exact: true }).click()
      const dialog = cinna.page.getByRole('dialog', { name: 'Run on its own', exact: true })
      await dialog.getByRole('textbox', { name: 'Goal', exact: true }).fill(GOAL)
      await dialog.getByRole('button', { name: 'Start task', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => fake.requests.length).toBe(1)
      const coordinatorId = (await cinna.page.evaluate((id) => window.api.chat.get(id), chatId))?.agentId
      expect(coordinatorId).toBeTruthy()
      expect(coordinatorId).not.toBe(agentId)
      await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
      await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
      await expect(cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveCount(0)
      fake.releaseFirst()
      await expect.poll(() => fake.requests.length).toBe(2)
      expect(acp.received('session/prompt')).toHaveLength(1)
      const wire = acp.received('session/prompt')[0].params?.prompt as { type: string; text: string }[]
      expect(wire.map((part) => part.text).join('')).toContain(GOAL)
      expect(wire.map((part) => part.text).join('')).toContain(HANDOFF)
      const notice = typed ? `${AUTO_NOTICE}\nAgent-provided handback note: ${JSON.stringify(NOTE)}` : AUTO_NOTICE
      const history = fake.requests[1].history
      expect(history.some((entry) => entry.prompt?.some((part) => part.type === 'text' && part.text?.includes(notice)))).toBe(true)
      expect(JSON.stringify(history)).toContain('/handback')
      if (!typed) expect(JSON.stringify(history)).not.toContain('Agent-provided handback note:')
      const [task] = await cinna.page.evaluate(() => window.api.tasks.list({ rootOnly: true }))
      expect(task).toMatchObject({ chatId, status: 'in_progress', assignee: { kind: 'agent', agentId: coordinatorId }, runtime: { ownerTurns: 3 } })
      const during = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
      expect(during?.messages.filter((message) => message.role === 'agent_transition').map((message) => message.content))
        .toEqual([`Task handed to ${AGENT}.\n${HANDOFF}`, notice])
      expect(during?.messages.filter((message) => message.role === 'assistant' && message.content === OUTPUT)).toHaveLength(1)
      expect(during?.messages.find((message) => message.role === 'agent_transition' && message.content === notice)?.sourceAgentId).toBe(agentId)
      fake.releaseFinish()
      await expect.poll(() => cinna.page.evaluate((id) => window.api.tasks.get(id), task.id))
        .toMatchObject({ status: 'completed', runtime: { state: 'completed', ownerTurns: 3 } })
      await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
      await cinna.page.getByRole('region', { name: 'Recent tasks', exact: true }).getByRole('button', { name: GOAL }).click()
      await cinna.page.getByRole('button', { name: 'Open the chat', exact: true }).click()
      await expect(cinna.page.getByText(SUMMARY, { exact: true })).toHaveCount(1)
      await expect(cinna.page.getByText(`/handback ${NOTE}`, { exact: false })).toHaveCount(1)
      const preview = notice.length > 120 ? `${notice.slice(0, 117)}…` : notice
      await cinna.page.getByRole('button', { name: 'Show agent notice', exact: true }).and(cinna.page.getByTitle(preview, { exact: true })).click()
      await expect(cinna.page.getByRole('button', { name: 'Hide agent notice', exact: true })).toHaveText(notice)
      const finished = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
      expect(finished?.messages.filter((message) => message.role === 'error')).toEqual([])
      expect(finished?.messages.filter((message) => message.role === 'assistant' && message.content === SUMMARY)).toHaveLength(1)
      expect(finished?.messages.filter((message) => message.role === 'tool_call').map((message) => message.toolCallId)).toEqual(['manifest-call-1', 'manifest-call-2'])
      expect(fake.requests).toHaveLength(2)
      expect(acp.received('session/prompt')).toHaveLength(1)
      expect(fake.violations).toEqual([])
      expect(await cinna.page.evaluate(() => window.api.jobs.list())).toEqual([])
    } finally { await fake.close() }
  })
}
