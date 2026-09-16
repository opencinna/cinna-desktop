import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'

const AGENT = 'Status Report Agent'
const INITIAL = 'Initial status: cedar-2417'
const BATCH = 'File changed before batch: maple-5632'
const MANUAL = 'Status command completed: birch-8924'
const AFTER_TURN = 'File changed during the turn: juniper-4371'
const PASSIVE = 'File changed before passive read: spruce-1629'
const DESCRIPTION = 'Run this agent’s status refresh command and re-read STATUS.md'
const TITLE = 'Status intent conversation'
const PROMPT = 'Verify the status report.'
const REPLY = 'The report was verified: hazel-7913.'
const COMMAND = 'inspect status report'

function writeStatus(agentPath: string, summary: string): void {
  writeFileSync(join(agentPath, 'app-data/storage/STATUS.md'), `---\nstatus: ok\nsummary: ${JSON.stringify(summary)}\n---\n${summary}\n`)
}

function commandCalls(agentPath: string): string[] {
  const path = join(agentPath, 'app-data/status-refresh-calls')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : []
}

/** Real catalog command and subprocess. No status or execution handler is replaced. */
async function createStatusAgent(cinna: CinnaApp) {
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  mkdirSync(join(agent.path, 'app-data/storage'), { recursive: true })
  mkdirSync(join(agent.path, 'scripts'), { recursive: true })
  writeFileSync(join(agent.path, 'scripts/e2e-status-refresh.sh'), [
    '#!/bin/sh', 'set -eu',
    "printf '%s\\n' refreshed >> app-data/status-refresh-calls",
    "cat > app-data/storage/STATUS.md <<'STATUS_EOF'",
    '---', 'status: ok', `summary: ${MANUAL}`, '---', MANUAL, 'STATUS_EOF', ''
  ].join('\n'))
  writeFileSync(join(agent.path, 'docs/CLI_COMMANDS.yaml'),
    'commands:\n  - name: status\n    description: Refresh the fixture status\n    command: /bin/sh scripts/e2e-status-refresh.sh\n')
  await cinna.page.evaluate(async (id) => {
    const current = await window.api.localAgents.get(id)
    if (!current.ok) throw new Error(current.message)
    const stamp = current.value.stamps['cinna-agent.json']
    if (!stamp) throw new Error('Fixture manifest has no stamp')
    const changed = await window.api.localAgents.updateField({ agentId: id,
      update: { field: 'status_refresh_command', value: '/run:status' },
      expectedStamp: stamp })
    if (!changed.ok) throw new Error(changed.message)
  }, agent.id)
  writeStatus(agent.path, INITIAL)
  return agent
}

async function restart(cinna: CinnaApp): Promise<void> {
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
}

async function openStatus(cinna: CinnaApp, summary: string): Promise<void> {
  await cinna.page.getByRole('button', { name: /^Agent status(?: —|$)/ }).click()
  await expect(cinna.page.getByText(summary, { exact: true })).toBeVisible()
}

async function passiveRead(cinna: CinnaApp, agentId: string, intent: 'read' | 'after_turn' | 'batch', summary: string): Promise<void> {
  const result = await cinna.page.evaluate((input) => window.api.agentStatus.get(input), { agentId, intent })
  expect(result).toMatchObject({ success: true, item: { agentId, summary, refreshDescription: DESCRIPTION } })
}

test('only manual folder status refresh executes its catalog command; batch and passive reads reread the file', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const agent = await createStatusAgent(cinna)
  await restart(cinna)
  await passiveRead(cinna, agent.id, 'read', INITIAL)
  expect(commandCalls(agent.path)).toEqual([])
  await openStatus(cinna, INITIAL)
  const refresh = cinna.page.getByRole('button', { name: DESCRIPTION, exact: true })
  await expect(refresh).toHaveAttribute('title', DESCRIPTION)

  writeStatus(agent.path, BATCH)
  await cinna.page.getByRole('button', { name: /^Refresh all/ }).click()
  await expect(cinna.page.getByText(BATCH, { exact: true })).toBeVisible()
  expect(commandCalls(agent.path)).toEqual([])

  await refresh.click()
  await expect(cinna.page.getByText(MANUAL, { exact: true })).toBeVisible()
  await expect(refresh).toBeEnabled()
  expect(commandCalls(agent.path)).toEqual(['refreshed'])

  writeStatus(agent.path, PASSIVE)
  for (const intent of ['read', 'batch', 'after_turn'] as const) {
    await passiveRead(cinna, agent.id, intent, PASSIVE)
    expect(commandCalls(agent.path)).toEqual(['refreshed'])
  }
  await cinna.page.getByRole('button', { name: /^Refresh all/ }).click()
  await expect(cinna.page.getByText(PASSIVE, { exact: true })).toBeVisible()
  expect(commandCalls(agent.path)).toEqual(['refreshed'])
  await restart(cinna)
  await openStatus(cinna, PASSIVE)
  await passiveRead(cinna, agent.id, 'read', PASSIVE)
  expect(commandCalls(agent.path)).toEqual(['refreshed'])
})

const PERMISSION: FakeAcpScript = { newSession: { sessionId: 'status-intent-session' }, prompt: { emit: [
  { kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'status-check-tool', title: 'bash',
    kind: 'execute', status: 'pending', locations: [], rawInput: {} } },
  { kind: 'permission', toolCall: { toolCallId: 'status-check-tool', title: COMMAND, kind: 'execute',
    status: 'pending', locations: [], rawInput: { command: COMMAND } },
    options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] },
  { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }
] } }

async function serveModels(): Promise<{ server: Server; host: string }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'qwen3:8b', model: 'qwen3:8b',
        details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } }] }))
    } else if (req.url === '/api/version') res.end(JSON.stringify({ version: '0.6.2' }))
    else { res.writeHead(404); res.end('{}') }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve)
  })
  return { server, host: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

test('a real ACP turn and saved tool replay never run the folder status command', async ({ cinna }) => {
  const fake = await serveModels()
  try {
    await cinna.skipOnboarding()
    const acp = await installFakeAcpEngine(cinna, PERMISSION)
    const agent = await createStatusAgent(cinna)
    const chatId = await cinna.page.evaluate(async ({ host, agentId, title }) => {
      await window.api.settings.set('autoChatTitles', false)
      const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Status fixture Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: 'qwen3:8b', isDefault: true })
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { title, agentId, router: 'direct' })
      await window.api.chat.showInList(chat.id)
      return chat.id
    }, { host: fake.host, agentId: agent.id, title: TITLE })
    await restart(cinna)
    await cinna.page.getByText(TITLE, { exact: true }).click()
    await openStatus(cinna, INITIAL)
    await cinna.page.getByRole('button', { name: 'Close', exact: true }).click()
    await cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true }).fill(PROMPT)
    await cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true }).press('Enter')
    const allow = cinna.page.getByRole('button', { name: 'Allow once', exact: true })
    await expect(allow).toBeEnabled()
    expect(acp.answers('session/request_permission')).toEqual([])
    expect(commandCalls(agent.path)).toEqual([])

    // An external file change while the real turn is held; the fake ACP does not claim to write it.
    writeStatus(agent.path, AFTER_TURN)
    await allow.click()
    await expect(cinna.page.getByText(REPLY, { exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await expect.poll(() => acp.answers('session/request_permission').map((row) => row.result))
      .toEqual([{ outcome: { outcome: 'selected', optionId: 'once' } }])
    // No test-side status read after the file change. List polling can also expose the file,
    // so exact after_turn dispatch belongs to the live-watch unit test, not this assertion.
    await openStatus(cinna, AFTER_TURN)
    expect(commandCalls(agent.path)).toEqual([])
    await cinna.page.getByRole('button', { name: 'Close', exact: true }).click()

    await expect.poll(async () => {
      const chat = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
      return chat?.messages.filter((row) => row.role === 'assistant').flatMap((row) => row.parts ?? [])
        .filter((part) => part.kind === 'tool_result').map((part) => part.text)
    }).toEqual(['Allowed once.'])
    const saved = await cinna.page.evaluate((id) => window.api.chat.get(id), chatId)
    const assistant = saved!.messages.find((row) => row.role === 'assistant')!
    expect(assistant.sourceAgentId).toBe(agent.id)
    const tool = assistant.parts!.filter((part) => part.kind === 'tool')
    const result = assistant.parts!.filter((part) => part.kind === 'tool_result')
    expect(tool).toHaveLength(2)
    expect(tool[0]).toMatchObject({ toolId: 'status-check-tool', toolName: 'bash' })
    expect(tool[1]).toMatchObject({ toolName: 'cinna_permission_request', toolInput: { callId: 'status-check-tool' } })
    expect(result).toHaveLength(1)
    expect(tool[1].toolId).toMatch(/^per_acp_/)
    expect(result[0].toolId).toBe(tool[1].toolId)
    expect(result[0].text).toBe('Allowed once.')
    expect(saved!.messages[0]).toMatchObject({ role: 'user', content: PROMPT, addressedAgentId: agent.id })

    await restart(cinna)
    await cinna.page.getByText(TITLE, { exact: true }).click()
    await expect(cinna.page.getByText('Permission to run a command', { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(COMMAND, { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByRole('button', { name: 'Tool: bash', exact: true })).toHaveCount(1)
    await expect(cinna.page.getByText('Allowed once.', { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByText(REPLY, { exact: true })).toHaveCount(1)
    await expect(cinna.page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
    expect((await cinna.page.evaluate((id) => window.api.chat.get(id), chatId))?.messages).toEqual(saved?.messages)
    await openStatus(cinna, AFTER_TURN)
    expect(commandCalls(agent.path)).toEqual([])
    expect(acp.received('session/prompt')).toHaveLength(1)
  } finally {
    fake.server.closeAllConnections()
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})
