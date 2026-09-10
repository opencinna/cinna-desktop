/**
 * A real ACP agent process that does exactly what a JSON file tells it to.
 *
 * Everything the connection and the pool promise is a fact about a *process*:
 * that the environment it was handed is the one it sees, that killing it kills
 * its children, that a response and the notifications behind it race, that a
 * request nobody answers blocks the agent. None of that survives being faked
 * in-process with a pair of streams, so this is a child process speaking real
 * newline-delimited JSON-RPC over real pipes, driven by a script so that a test
 * can ask for the one behaviour it cares about.
 *
 * It is deliberately dumb: it never decides anything. The script says what to
 * emit and when; the log says what arrived. See `fakeAcp.ts` for the format and
 * the helpers that write one.
 *
 *   FAKE_ACP_SCRIPT  path to the JSON script (required)
 *   FAKE_ACP_LOG     path to the JSONL log of everything received (required)
 *
 * Node ESM, run as `process.execPath <this file>`. Do not import anything from
 * `src/main` here: this runs in a plain Node process, not in Electron.
 */

import { appendFileSync, readFileSync, writeSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { RequestError, agent, ndJsonStream } from '@agentclientprotocol/sdk'

/**
 * Every stderr line goes out with `writeSync`.
 *
 * `process.stderr` is a pipe here, and writes to a pipe are asynchronous: a
 * script that writes a line and then exits immediately — which is exactly the
 * "the adapter is missing and said so before dying" case — loses the line
 * often enough to make the test that reads it flaky.
 */
const err = (text) => writeSync(2, `${text}\n`)

const scriptPath = process.env.FAKE_ACP_SCRIPT
const logPath = process.env.FAKE_ACP_LOG
if (!scriptPath || !logPath) {
  err('fake-acp: FAKE_ACP_SCRIPT and FAKE_ACP_LOG are required')
  process.exit(64)
}

/** @type {Record<string, any>} */
const script = JSON.parse(readFileSync(scriptPath, 'utf8'))

const started = Date.now()
function log(entry) {
  appendFileSync(logPath, `${JSON.stringify({ t: Date.now() - started, ...entry })}\n`)
}

log({ dir: 'start', pid: process.pid, cwd: process.cwd(), argv: process.argv, env: process.env })

for (const line of script.stderr ?? []) err(line)

if (script.ignoreSigterm) {
  // Proves the SIGTERM → SIGKILL escalation: this process will not go quietly.
  process.on('SIGTERM', () => log({ dir: 'signal', signal: 'SIGTERM' }))
}

if (script.exitOnStart) {
  const { code = 1, afterMs = 0 } = script.exitOnStart
  // Synchronously when no delay is asked for: a `setTimeout(0)` would still
  // lose the race against a client that is already writing `initialize`, and
  // "died before it answered" is exactly what such a test wants to be sure of.
  if (afterMs > 0) setTimeout(() => process.exit(code), afterMs)
  else process.exit(code)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Session ids the client has cancelled, and whoever is waiting to hear it. */
const cancelled = new Set()
const cancelWaiters = new Map()

function noteCancel(sessionId) {
  cancelled.add(sessionId)
  const waiters = cancelWaiters.get(sessionId) ?? []
  cancelWaiters.delete(sessionId)
  for (const resolve of waiters) resolve()
}

function awaitCancel(sessionId) {
  if (cancelled.has(sessionId)) return Promise.resolve()
  return new Promise((resolve) => {
    const waiters = cancelWaiters.get(sessionId) ?? []
    waiters.push(resolve)
    cancelWaiters.set(sessionId, waiters)
  })
}

let lastSessionId = script.newSession?.sessionId ?? 'ses_fake'

const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
]

/**
 * Run one `emit` list against the client.
 *
 * Requests block, exactly as they do for a real agent: the step does not finish
 * until the client answers, and what it answered goes into the log.
 */
async function emit(client, steps, sessionId) {
  for (const step of steps ?? []) {
    const target = step.sessionId ?? sessionId ?? lastSessionId
    switch (step.kind) {
      case 'update':
        await client.notify('session/update', { sessionId: target, update: step.update })
        break
      case 'notify':
        await client.notify(step.method, step.params ?? {})
        break
      case 'request':
      case 'permission':
      case 'elicitation': {
        const method =
          step.kind === 'permission'
            ? 'session/request_permission'
            : step.kind === 'elicitation'
              ? 'elicitation/create'
              : step.method
        const params =
          step.kind === 'permission'
            ? {
                sessionId: target,
                toolCall: step.toolCall ?? {
                  toolCallId: 'call_fake',
                  title: 'write notes.txt',
                  kind: 'edit',
                  status: 'pending'
                },
                options: step.options ?? DEFAULT_PERMISSION_OPTIONS,
                ...(step.params ?? {})
              }
            : step.kind === 'elicitation'
              ? {
                  sessionId: target,
                  mode: 'form',
                  message: 'Pick one',
                  requestedSchema: { type: 'object', properties: {} },
                  ...(step.params ?? {})
                }
              : (step.params ?? {})
        try {
          const result = await client.request(method, params)
          log({ dir: 'answer', method, result })
        } catch (err) {
          log({
            dir: 'answer',
            method,
            error: { code: err?.code ?? null, message: String(err?.message ?? err) }
          })
        }
        break
      }
      case 'delay':
        await delay(step.ms ?? 0)
        break
      case 'stderr':
        err(step.text ?? '')
        break
      case 'awaitCancel':
        await awaitCancel(target)
        break
      case 'exit':
        log({ dir: 'exit', code: step.code ?? 0 })
        process.exit(step.code ?? 0)
        break
      default:
        err(`fake-acp: unknown step ${JSON.stringify(step.kind)}`)
    }
  }
}

/**
 * One scripted request handler: log what arrived, emit what the script says,
 * then answer (after `delayMs`, or never when `hang` is set).
 *
 * `error` comes last on purpose, so a script can stream part of a turn and
 * *then* fail — which is what a real one does. OpenCode answers `session/prompt`
 * with `-32603 "Internal error: model 'x' not found"` when the session's model
 * is gone, and `session/load` errors for a session it has forgotten; both are
 * results the driver has to report, not throws. A thrown `RequestError` is what
 * the SDK's connection layer turns back into that JSON-RPC error verbatim.
 */
function handler(name, method, respond) {
  return async (ctx) => {
    // Logged under the *wire* method, not the script key: a test asserting what
    // the client sent asks for `session/prompt`, the same name it would look
    // for in a recording, and `session/cancel` was always logged that way.
    log({ dir: 'in', kind: 'request', method, params: ctx.params })
    const plan = script[name] ?? {}
    const sessionId = ctx.params?.sessionId ?? lastSessionId
    await emit(ctx.client, plan.emit, sessionId)
    if (plan.hang) await new Promise(() => {})
    if (plan.delayMs) await delay(plan.delayMs)
    if (plan.error) {
      const { code = -32603, message, data } = plan.error
      throw new RequestError(code, message, data)
    }
    return { ...respond(ctx, plan), ...(plan.response ?? {}) }
  }
}

const app = agent({ name: 'fake-acp' })
  .onRequest(
    'initialize',
    handler('initialize', 'initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } },
      authMethods: []
    }))
  )
  .onRequest(
    'session/new',
    handler('newSession', 'session/new', () => {
      lastSessionId = script.newSession?.sessionId ?? lastSessionId
      return { sessionId: lastSessionId }
    })
  )
  .onRequest(
    'session/load',
    handler('loadSession', 'session/load', (ctx) => {
      lastSessionId = ctx.params?.sessionId ?? lastSessionId
      return {}
    })
  )
  .onRequest(
    'session/set_mode',
    handler('setMode', 'session/set_mode', () => ({}))
  )
  .onRequest(
    'session/set_config_option',
    handler('setConfigOption', 'session/set_config_option', () => ({ configOptions: [] }))
  )
  .onRequest(
    'session/prompt',
    handler('prompt', 'session/prompt', () => ({ stopReason: 'end_turn' }))
  )
  .onNotification('session/cancel', (ctx) => {
    log({ dir: 'in', kind: 'notification', method: 'session/cancel', params: ctx.params })
    noteCancel(ctx.params?.sessionId)
  })

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
)

connection.closed.then(() => process.exit(script.exitOnClose ?? 0)).catch(() => process.exit(1))
