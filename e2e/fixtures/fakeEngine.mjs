// A stand-in for `opencode serve`, for specs that need a folder agent to ask
// something mid-turn and wait for the answer — deterministically, with no model.
//
// Started by the app itself: `installFakeEngine` (fakeEngine.ts) points the
// `localAgentsEnginePath` setting at a shell shim that execs this file, so the
// real engine manager spawns it, health-checks it and hands it the config it
// generated. Everything above the HTTP boundary — the runner, the event bus,
// the pending-request registry, the MessagePort, the preload guard, the
// renderer — is the product's own code.
//
// What it serves is the slice of the OpenCode 1.18.27 API the turn runner
// calls, answered from the config main wrote (`OPENCODE_CONFIG`), so the agent
// key and model the runner asks about are the ones main generated:
//
//   GET  /api/health                         {healthy: true}
//   GET  /api/event                          the global SSE stream
//   GET  /api/agent, /api/model              from the config's `agent` block
//   POST /api/session                        a fresh `ses_*`
//   POST /api/session/:id/prompt             admits, then plays a script
//   POST /api/session/:id/permission/:rid/reply
//   POST /api/session/:id/question/:rid/reply | reject
//   POST /api/session/:id/interrupt
//
// The script is chosen by the prompt's words (see SCRIPTS). Frames are the
// engine's own event shapes, the same ones the golden fixtures under
// `src/main/services/agentTurn/__golden__/opencode/` carry.
//
// Every request is appended to `<dir of OPENCODE_CONFIG>/fake-engine-calls.jsonl`
// — never its headers, which carry the engine password — so a spec can assert
// what the answer path actually posted, which no screen shows.

import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const hostname = args.includes('--hostname') ? args[args.indexOf('--hostname') + 1] : '127.0.0.1'
const configPath = process.env.OPENCODE_CONFIG ?? ''
const callLog = join(dirname(configPath), 'fake-engine-calls.jsonl')

/** `{agentKey: {providerID, id}}` from the config main generated. */
function agentsFromConfig() {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const out = {}
  for (const [key, entry] of Object.entries(config.agent ?? {})) {
    const model = typeof entry?.model === 'string' ? entry.model : ''
    const slash = model.indexOf('/')
    out[key] = { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
  }
  return out
}

/** Open `/api/event` responses. */
const streams = new Set()
let seq = 0

function push(type, data) {
  seq += 1
  const frame = `data: ${JSON.stringify({ id: `evt_${seq}`, type, data })}\n\n`
  for (const res of streams) res.write(frame)
}

function stepEnded(sessionID) {
  push('session.next.step.ended', {
    sessionID,
    assistantMessageID: 'msg_e2e',
    finish: 'stop',
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
  })
}

function say(sessionID, text) {
  push('session.next.text.delta', {
    sessionID,
    assistantMessageID: 'msg_e2e',
    textID: `txt_${seq}`,
    delta: text
  })
}

/**
 * What the agent does for a prompt. Each script raises one ask and says what
 * happens once it is answered; the closing sentence deliberately never repeats
 * the answer, so anything on screen naming it came from the desktop's own
 * record of the decision rather than from the agent.
 */
const SCRIPTS = [
  {
    match: /build folder/i,
    start(sessionID) {
      push('session.next.tool.called', {
        sessionID,
        assistantMessageID: 'msg_e2e',
        callID: 'call_rm',
        tool: 'bash',
        input: { command: 'rm -rf build' },
        provider: { executed: true }
      })
      push('permission.v2.asked', {
        sessionID,
        id: 'per_e2e_rm',
        action: 'bash',
        resources: ['rm -rf build'],
        save: ['*'],
        source: { type: 'tool', messageID: 'msg_e2e', callID: 'call_rm' }
      })
    }
  },
  {
    match: /colour/i,
    start(sessionID) {
      push('question.v2.asked', {
        sessionID,
        id: 'que_e2e_colour',
        questions: [
          {
            question: 'Which colour should the report use?',
            header: 'Colour',
            options: [
              { label: 'Teal', description: 'Calm and readable' },
              { label: 'Amber', description: 'Loud on purpose' }
            ]
          }
        ],
        tool: { messageID: 'msg_e2e', callID: 'call_ask' }
      })
    }
  }
]

/** Request id → session, so a reply knows where to push. */
const parkedIn = new Map()

function onPermissionReply(sessionID, requestID, body) {
  push('permission.v2.replied', { sessionID, requestID, reply: body?.reply })
  if (body?.reply === 'reject') {
    say(sessionID, 'Understood, nothing was touched.')
  } else {
    push('session.next.tool.success', {
      sessionID,
      assistantMessageID: 'msg_e2e',
      callID: 'call_rm',
      structured: {},
      content: [{ type: 'text', text: 'removed build/' }],
      provider: { executed: true }
    })
    say(sessionID, 'Done, the folder is gone.')
  }
  stepEnded(sessionID)
}

function onQuestionReply(sessionID, requestID, body) {
  push('question.v2.replied', { sessionID, requestID, answers: body?.answers })
  say(sessionID, 'Thanks, the report is updated.')
  stepEnded(sessionID)
}

function onQuestionReject(sessionID, requestID) {
  push('question.v2.rejected', { sessionID, requestID })
  stepEnded(sessionID)
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

let sessions = 0

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${hostname}`)
  const path = url.pathname
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    let body
    try {
      body = raw ? JSON.parse(raw) : undefined
    } catch {
      body = raw
    }
    appendFileSync(callLog, `${JSON.stringify({ method: req.method, path, ...(body === undefined ? {} : { body }) })}\n`)

    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { healthy: true })

    if (req.method === 'GET' && path === '/api/event') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.flushHeaders()
      streams.add(res)
      // `res`, not `req`: a GET's request emits `close` as soon as its (empty)
      // body has been read, which would drop the subscriber before the first
      // frame. The response closes when the socket does.
      res.on('close', () => streams.delete(res))
      return
    }

    if (req.method === 'GET' && path === '/api/agent') {
      return json(res, 200, { data: Object.keys(agentsFromConfig()).map((id) => ({ id })) })
    }
    if (req.method === 'GET' && path === '/api/model') {
      return json(res, 200, { data: Object.values(agentsFromConfig()) })
    }

    if (req.method === 'POST' && path === '/api/session') {
      sessions += 1
      return json(res, 200, { data: { id: `ses_e2e_${sessions}` } })
    }

    const session = path.match(/^\/api\/session\/(ses[^/]+)(?:\/(.*))?$/)
    if (!session) return json(res, 404, { message: `the fake engine does not serve ${path}` })
    const [, sessionID, rest = ''] = session

    if (req.method === 'GET' && rest === '') return json(res, 200, { data: { id: sessionID } })
    if (req.method === 'POST' && (rest === 'agent' || rest === 'model')) return json(res, 200, {})

    if (req.method === 'POST' && rest === 'prompt') {
      json(res, 200, { data: { admittedSeq: seq } })
      const text = typeof body?.prompt?.text === 'string' ? body.prompt.text : ''
      const script = SCRIPTS.find((s) => s.match.test(text))
      // After the admission ack has left, as the real engine's loop does.
      setImmediate(() => {
        if (script) script.start(sessionID)
        else {
          say(sessionID, 'Nothing to do.')
          stepEnded(sessionID)
        }
      })
      return
    }

    const ask = rest.match(/^(permission|question)\/([^/]+)\/(reply|reject)$/)
    if (req.method === 'POST' && ask) {
      const [, kind, requestID, verb] = ask
      if (parkedIn.get(requestID) === 'settled') {
        return json(res, 404, { message: `${requestID} is not waiting` })
      }
      parkedIn.set(requestID, 'settled')
      json(res, 200, {})
      setImmediate(() => {
        if (kind === 'permission') onPermissionReply(sessionID, requestID, body)
        else if (verb === 'reply') onQuestionReply(sessionID, requestID, body)
        else onQuestionReject(sessionID, requestID)
      })
      return
    }

    if (req.method === 'POST' && rest === 'interrupt') {
      json(res, 200, {})
      setImmediate(() => stepEnded(sessionID))
      return
    }

    return json(res, 404, { message: `the fake engine does not serve ${req.method} ${path}` })
  })
})

server.listen(port, hostname)

// Never outlive the app. `stopEngineNow` SIGTERMs this process on quit, but a
// crashed or force-killed Electron sends nothing, and an orphaned server
// holding a port is the kind of leftover a suite must not leave behind.
const parent = process.ppid
setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    process.exit(0)
  }
}, 1_000).unref()
process.on('SIGTERM', () => process.exit(0))
