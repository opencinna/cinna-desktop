import { createRequire } from 'node:module'
/** Offline Phase 0 experiment, not a daemon or production Node host. */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { installRuntimeHost } from '../../src/main/host/runtimeHost'
import { adaptDatabase } from '../../src/main/db/testSupport/nodeSqlite'
import { initializeHubCore, shutdownHubCore, userActivation, runExecutionService, liveRunHub, inboxService } from '../../src/main/hub/core'
import { closeDatabase, getRawSqlite } from '../../src/main/db/client'
import { agentRepo } from '../../src/main/db/agents'
import { chatRepo } from '../../src/main/db/chats'
import { DEFAULT_USER_ID } from '../../src/shared/userIds'
import type { RunWatchMessage } from '../../src/shared/runWatch'
import type { RunEvent } from '../../src/shared/runEvents'

const root = process.argv[2]
const repo = process.argv[3]
assert(root && repo, 'Usage: spike <temporary data directory> <repository>')
mkdirSync(root, { recursive: true })
const unavailable = (): never => { throw new Error('Desktop capability unavailable in Node spike') }
const shutdown: (() => void)[] = []
installRuntimeHost({
  getPath: () => root,
  getVersion: () => 'phase-0-spike',
  getAppPath: () => repo,
  isPackaged: false,
  resourcesPath: join(repo, 'resources'),
  http: { fetch: async () => { throw new Error('Network is forbidden in the offline spike') } },
  // No secrets are used. Refuse encryption rather than inventing a production keystore.
  keystore: { isEncryptionAvailable: () => true, encryptString: unavailable, decryptString: unavailable },
  resolveProxy: async () => 'DIRECT',
  resolvePackageFile: (specifier) => createRequire(import.meta.url).resolve(specifier),
  nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }),
  onShutdown: listener => { shutdown.push(listener) },
  shell: { openExternal: unavailable, openPath: unavailable, showItemInFolder: unavailable, trashItem: unavailable }
})
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const script = join(root, 'fixture.json')
const shim = join(root, 'fixture-acp')
writeFileSync(script, JSON.stringify({ prompt: { emit: [
  { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Before detach. ' } } },
  { kind: 'permission', toolCall: { toolCallId: 'fixture-edit', title: 'Fixture edit', kind: 'edit', status: 'pending', rawInput: { filepath: join(root, 'result.txt') } } },
  { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished without the first viewer.' } } }
] } }))
writeFileSync(shim, `#!/bin/sh\nexport FAKE_ACP_SCRIPT=${quote(script)}\nexport FAKE_ACP_LOG=${quote(join(root, 'fixture-log.jsonl'))}\nexec ${quote(process.execPath)} ${quote(join(repo, 'src/main/agents/drivers/acp/testSupport/fakeAcpAgent.mjs'))} "$@"\n`, { mode: 0o700 })
const events: RunEvent[] = []
let cancel: (() => void) | undefined
try {
  initializeHubCore(path => adaptDatabase(new DatabaseSync(path)))
  await userActivation.activate(DEFAULT_USER_ID)
  userActivation.requireActivated()
  const agent = agentRepo.createRuntime(DEFAULT_USER_ID, {
    name: 'Offline hub fixture', driver: 'acp', config: { launcher: 'custom', command: [shim], cwd: root, localCwd: root }
  })
  const chat = chatRepo.create(DEFAULT_USER_ID, { title: 'Hub spike', router: 'direct', agentId: agent.id })
  const first: RunWatchMessage[] = []
  const detach = liveRunHub.watch(DEFAULT_USER_ID, chat.id, event => first.push(event))
  const run = runExecutionService.start({ profileUserId: DEFAULT_USER_ID, settingsUserId: DEFAULT_USER_ID },
    { chatId: chat.id, content: 'Exercise a headless turn.' },
    { observe: (ctx, event) => { events.push(event); inboxService.recordRunEvent(ctx, event) } })
  cancel = () => run.cancel()
  await run.accepted
  detach()
  const detachedCount = first.length
  const deadline = Date.now() + 15_000
  while (!events.some(e => e.type === 'needs_input')) {
    assert(Date.now() < deadline, `No permission ask: ${JSON.stringify(events)}`)
    await delay(20)
  }
  const ask = events.find((e): e is Extract<RunEvent, { type: 'needs_input' }> => e.type === 'needs_input')!
  // Keep it parked with no viewer attached, then reattach and answer through Inbox.
  await delay(100)
  assert(runExecutionService.isRunning(chat.id))
  assert.equal(first.length, detachedCount)
  assert.equal((getRawSqlite().prepare('SELECT status FROM task_input_requests WHERE id = ?').get(ask.requestId) as { status: string }).status, 'open')
  const replay: RunWatchMessage[] = []
  const detachSecond = liveRunHub.watch(DEFAULT_USER_ID, chat.id, event => replay.push(event))
  assert.equal(replay[0].type, 'snapshot')
  const answer = await inboxService.answerFromTranscript(DEFAULT_USER_ID, ask.requestId, { kind: 'permission', reply: 'once' })
  assert.equal(answer.ok, true, 'Inbox accepted answer')
  detachSecond()
  const outcome = await run.completed
  assert.equal(outcome.state, 'completed', JSON.stringify(outcome))
  const rows = getRawSqlite().prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at').all(chat.id) as { role: string; content: string }[]
  assert(rows.some(row => row.role === 'assistant' && row.content.includes('Finished without the first viewer.')))
  assert.deepEqual(getRawSqlite().prepare('PRAGMA foreign_key_check').all(), [])
  // Reopen durable data after shutting down; it is not merely a live replay buffer.
  console.log(JSON.stringify({ ok: true, profile: DEFAULT_USER_ID, turn: outcome.state, detachedViewer: true,
    permissionReattached: true, durableMessages: rows.length, database: 'node:sqlite via diagnostic adapter' }))
} finally {
  cancel?.()
  await userActivation.deactivate()
  for (const listener of shutdown) listener()
  await shutdownHubCore('Offline spike finished.')
  closeDatabase()
}
const reopened = new DatabaseSync(join(root, 'cinna.db'))
assert((reopened.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant'").get() as { n: number }).n > 0)
reopened.close()
console.log('Hub spike: durable transcript readable after closing and reopening the database.')
