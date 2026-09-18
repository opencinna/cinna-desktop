// Deterministic CLI/app-server peer behind the real, pinned Codex ACP adapter.
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
if (process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0) }
if (process.argv.slice(-2).join(' ') === 'login status') { console.error('Logged in using ChatGPT'); process.exit(0) }
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
const log = process.env.FAKE_CODEX_LOG ?? join(process.env.CODEX_HOME ?? process.env.HOME, 'codex-requests.jsonl')
const thread = { id: 'codex-session', turns: [], preview: '', createdAt: 1, updatedAt: 1,
  path: '/tmp/session.jsonl', cwd: process.cwd(), modelProvider: 'openai', source: 'cli',
  status: { type: 'idle' }, historyMode: 'inline' }
let config = {}
let sequence = 0
const responses = new Map()
const active = new Map()
const ask = (method, params) => new Promise((resolve) => {
  const id = `ask-${++sequence}`
  responses.set(id, resolve)
  send({ jsonrpc: '2.0', id, method, params })
})
function complete(threadId, turn, text, status = 'completed') {
  if (!active.delete(turn.id)) return
  if (text) {
    const item = { type: 'agentMessage', id: `message-${turn.id}`, text: '' }
    notify('item/started', { threadId, turnId: turn.id, item })
    notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: item.id, delta: text })
    notify('item/completed', { threadId, turnId: turn.id, item: { ...item, text } })
  }
  notify('turn/completed', { threadId, turn: { ...turn, status } })
}
async function runTurn(params, turn) {
  const threadId = params.threadId
  notify('turn/started', { threadId, turn })
  // Fresh-session replay precedes the current prompt in separate ACP blocks.
  // Fixture commands address the current message, not the replayed transcript.
  const text = (params.input?.filter((part) => part.type === 'text').at(-1)?.text ?? '')
    .replace(/^Turn context from Cinna Desktop, not part of the conversation:\n[\s\S]*?\n\n/, '')
  if (text === 'Wait until stopped') return
  if (text === 'Ask for permission') {
    const result = await ask('item/commandExecution/requestApproval', {
      threadId, turnId: turn.id, itemId: `command-${turn.id}`, command: 'echo approved',
      cwd: process.cwd(), commandActions: [], reason: 'Test command approval',
      availableDecisions: ['accept', 'decline', 'cancel']
    })
    complete(threadId, turn, `Codex approval: ${result.decision}.`)
    return
  }
  if (text === 'Ask a question') {
    const result = await ask('item/tool/requestUserInput', {
      threadId, turnId: turn.id, itemId: `question-${turn.id}`, autoResolutionMs: null,
      questions: [{ id: 'target', header: 'Target', question: 'Which target?', isOther: true,
        isSecret: false, options: [{ label: 'Staging', description: 'Preview deployment' }, { label: 'Production', description: 'Live deployment' }] }]
    })
    complete(threadId, turn, `Codex answer: ${result.answers?.target?.answers?.join(', ')}.`)
    return
  }
  complete(threadId, turn, threadId === 'title-session' ? 'Test conversation' : 'Hello from Codex.')
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  appendFileSync(log, `${line}\n`)
  if (responses.has(request.id)) {
    responses.get(request.id)(request.result)
    responses.delete(request.id)
    return
  }
  if (request.id === undefined || !request.method) return
  let result = {}
  switch (request.method) {
    case 'initialize': result = { userAgent: 'fake-codex', codexHome: process.cwd() }; break
    case 'account/read': result = { account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true }; break
    case 'config/read': result = { config: { model_provider: 'openai' }, layers: [] }; break
    case 'skills/list': result = { data: [{ cwd: process.cwd(), skills: [], errors: [] }] }; break
    case 'model/list': result = { data: [{ id: 'test-model', model: 'test-model', displayName: 'Test model', description: '', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }], inputModalities: ['text'] }], nextCursor: null }; break
    case 'thread/start':
    case 'thread/resume':
      config = request.params.config ?? config
      result = { thread: request.params.ephemeral ? { ...thread, id: 'title-session' } : thread, model: config.model ?? 'test-model', modelProvider: 'openai', reasoningEffort: config.model_reasoning_effort, serviceTier: null, cwd: process.cwd() }; break
    case 'thread/turns/list': result = { data: [], nextCursor: null }; break
    case 'thread/read': result = { thread }; break
    case 'thread/goal/get': result = { goal: null }; break
    case 'thread/asyncTasks/list': result = { data: [], tasks: [] }; break
    case 'mcpServerStatus/list': result = { data: [], nextCursor: null }; break
    case 'collaborationMode/list': result = { data: [] }; break
    case 'turn/start': {
      const turn = { id: `turn-${++sequence}`, status: 'inProgress', items: [], error: null }
      active.set(turn.id, { threadId: request.params.threadId, turn })
      send({ jsonrpc: '2.0', id: request.id, result: { turn } })
      setTimeout(() => void runTurn(request.params, turn), 20)
      return
    }
    case 'turn/interrupt': {
      const pending = active.get(request.params.turnId)
      if (pending) complete(pending.threadId, pending.turn, '', 'interrupted')
      break
    }
    default: break
  }
  send({ jsonrpc: '2.0', id: request.id, result })
})
