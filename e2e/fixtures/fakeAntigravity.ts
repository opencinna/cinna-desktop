import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeAcpLogEntry, FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { repoRoot } from '../playwright.config'
import type { CinnaApp } from './app'

/**
 * A stand-in for Google's `agy_acp_server.par`, for specs that must never meet
 * the real server or a real Google sign-in.
 *
 * It speaks newline-delimited ACP JSON-RPC on stdio as the real server does,
 * in its **logged-out** shape:
 *
 * - `initialize` answers with the server's one auth method, `oauth-personal`.
 * - `authenticate` is recorded and **never answered** — the real server holds
 *   it until the browser sign-in finishes, so an in-app Log in stays pending
 *   until the user cancels it (which kills this process).
 * - `session/new` / `session/load` refuse with `-32000 Authentication required`,
 *   the real server's answer on a home with no login.
 *
 * Every request is appended to `log` (JSONL, `{ method, params }`), the only
 * witness of what the app asked. The script is written into the sandbox with
 * the test runner's own `node` in its shebang, and a `localharness_external`
 * placeholder beside it, as the real server's directory has.
 *
 * **`mode: 'silent-provider-error'`** is the **logged-in** server meeting a
 * Gemini 503, the way the pinned 1.4.5 behaves: `session/new` opens a session,
 * `session/set_mode` / `session/set_config_option` are answered, and
 * `session/prompt` is **never answered** — no `session/update` is ever sent.
 * About 2 s after the prompt the server's own transcript,
 * `<GEMINI_HOME or $HOME/.gemini>/antigravity-acp/brain/<sessionId>/.system_generated/logs/transcript_full.jsonl`
 * (the home read from the server's own environment, as the real one does),
 * gets the prompt's USER_INPUT step, a `source: MODEL` ERROR_MESSAGE (a tool
 * denial, which is not a provider error) and the `source: SYSTEM` one with
 * `error_code: 503`. `session/cancel` answers the held prompt with
 * `stopReason: 'cancelled'`. The app still checks the login before spawning,
 * so pair it with {@link signInAntigravityHome} and {@link writeFakeSecurity}.
 */
export interface FakeAntigravity {
  /** The executable to set as `localAgentsAntigravityPath`. */
  path: string
  /** Every request the app sent, across every process, in order. */
  received(method?: string): { method: string; params: unknown }[]
  /** Every transcript the fake wrote (`silent-provider-error`), in order. */
  transcripts(): string[]
}

export type FakeAntigravityMode = 'logged-out' | 'silent-provider-error'

/** The SYSTEM error the `silent-provider-error` fake logs, verbatim from a real 1.4.5 transcript. */
export const FAKE_PROVIDER_ERROR = { error: 'The model is currently unreachable.', code: 503 } as const
/** The MODEL error (a tool denial) logged beside it, which must never be surfaced. */
export const FAKE_MODEL_DENIAL = 'Permission to run the command was denied by the user.'

export function writeFakeAntigravity(cinna: CinnaApp, options: { mode?: FakeAntigravityMode } = {}): FakeAntigravity {
  const mode = options.mode ?? 'logged-out'
  const dir = join(cinna.sandbox.root, 'fake-antigravity')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'requests.jsonl')
  const written = join(dir, 'transcripts.jsonl')
  const path = join(dir, 'agy_acp_server.par')
  const script = `#!${process.execPath}
const { appendFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { createInterface } = require('node:readline')
const LOG = ${JSON.stringify(log)}
const WRITTEN = ${JSON.stringify(written)}
const MODE = ${JSON.stringify(mode)}
const PROVIDER_ERROR = ${JSON.stringify(FAKE_PROVIDER_ERROR)}
const MODEL_DENIAL = ${JSON.stringify(FAKE_MODEL_DENIAL)}
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const held = new Map()
let sessions = 0
const stamp = () => new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z')
function logProviderError(sessionId, promptText) {
  const home = (process.env.GEMINI_HOME || '').trim() || join(process.env.HOME || '', '.gemini')
  const logs = join(home, 'antigravity-acp', 'brain', sessionId, '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  const file = join(logs, 'transcript_full.jsonl')
  const steps = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: promptText, created_at: stamp() },
    { step_index: 1, source: 'MODEL', type: 'ERROR_MESSAGE', status: 'DONE', error: MODEL_DENIAL, created_at: stamp() },
    { step_index: 2, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: PROVIDER_ERROR.error, error_code: PROVIDER_ERROR.code, created_at: stamp() }
  ]
  appendFileSync(file, steps.map((step) => JSON.stringify(step)).join('\\n') + '\\n')
  appendFileSync(WRITTEN, JSON.stringify(file) + '\\n')
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (typeof message.method !== 'string') return
  appendFileSync(LOG, JSON.stringify({ method: message.method, params: message.params ?? null }) + '\\n')
  if (MODE === 'silent-provider-error') {
    const params = message.params || {}
    if (message.method === 'session/cancel') {
      const id = held.get(params.sessionId)
      held.delete(params.sessionId)
      if (id !== undefined) send({ id, result: { stopReason: 'cancelled' } })
      return
    }
    if (message.id === undefined || message.id === null) return
    switch (message.method) {
      case 'initialize':
        return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } })
      case 'session/new':
        return send({ id: message.id, result: { sessionId: 'ses-silent-' + process.pid + '-' + (++sessions) } })
      case 'session/load':
        return send({ id: message.id, result: {} })
      case 'session/set_mode':
        return send({ id: message.id, result: {} })
      case 'session/set_config_option':
        return send({ id: message.id, result: { configOptions: [] } })
      case 'session/prompt': {
        held.set(params.sessionId, message.id)
        const text = (params.prompt || []).filter((block) => block && block.type === 'text').map((block) => block.text).join('\\n')
        setTimeout(() => logProviderError(params.sessionId, text), 2000)
        return // never answered: the provider error stays in the transcript
      }
      default:
        return send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
  if (message.id === undefined || message.id === null) return
  switch (message.method) {
    case 'initialize':
      return send({ id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }]
      } })
    case 'authenticate':
      return // held: the real server answers only once the browser sign-in is done
    case 'session/new':
    case 'session/load':
      return send({ id: message.id, error: { code: -32000, message: 'Authentication required' } })
    default:
      return send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
}).on('close', () => process.exit(0))
`
  writeFileSync(path, script, { mode: 0o755 })
  writeFileSync(join(dir, 'localharness_external'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return {
    path,
    received(method?: string) {
      if (!existsSync(log)) return []
      const all = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params: unknown })
      return method ? all.filter((entry) => entry.method === method) : all
    },
    transcripts() {
      if (!existsSync(written)) return []
      return readFileSync(written, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string)
    }
  }
}

const FAKE_AGENT = join(repoRoot, 'src', 'main', 'agents', 'drivers', 'acp', 'testSupport', 'fakeAcpAgent.mjs')

/**
 * A **signed-in** stand-in: the scriptable fake ACP agent (`fakeAcpAgent.mjs`,
 * the one the driver's contract suite drives) behind a `/bin/sh` shim named
 * like the server, so a spec can run whole turns on the Antigravity launcher —
 * its isolated home, its `default` mode, its permission asks.
 *
 * Only the server is faked. The login the launcher checks before spawning is
 * the user home's, so a spec pairs this with {@link signInAntigravityHome}
 * before the app reads it, and on macOS with {@link writeFakeSecurity} on the
 * app's `PATH`.
 */
export interface ScriptedAntigravity {
  /** The executable to set as `localAgentsAntigravityPath`. */
  path: string
  /** What the server was sent, per ACP method. */
  received(method: string): FakeAcpLogEntry[]
  /** What the app answered a request the server sent (`session/request_permission`). */
  answers(method: string): FakeAcpLogEntry[]
}

export function writeScriptedAntigravity(cinna: CinnaApp, script: FakeAcpScript): ScriptedAntigravity {
  const dir = join(cinna.sandbox.root, 'scripted-antigravity')
  mkdirSync(dir, { recursive: true })
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'log.jsonl')
  const path = join(dir, 'agy_acp_server.par')
  writeFileSync(scriptPath, JSON.stringify(script, null, 2))
  // The child gets the launcher's own environment, so the shim names node and the script itself.
  writeFileSync(path, [
    '#!/bin/sh',
    `FAKE_ACP_SCRIPT='${scriptPath}'`,
    `FAKE_ACP_LOG='${logPath}'`,
    'export FAKE_ACP_SCRIPT FAKE_ACP_LOG',
    `exec '${process.execPath}' '${FAKE_AGENT}' "$@"`,
    ''
  ].join('\n'), { mode: 0o755 })
  writeFileSync(join(dir, 'localharness_external'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const log = (): FakeAcpLogEntry[] => existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as FakeAcpLogEntry)
    : []
  return {
    path,
    received: (method) => log().filter((entry) => entry.dir === 'in' && entry.method === method),
    answers: (method) => log().filter((entry) => entry.dir === 'answer' && entry.method === method)
  }
}

/**
 * Make the sandbox home's Antigravity login read as signed in: the home's
 * `settings.json` names the personal Google login, and (Linux) its token file
 * exists. On macOS the token is a keychain item; see {@link writeFakeSecurity}.
 */
export function signInAntigravityHome(home: string): void {
  const dir = join(home, '.gemini', 'antigravity-acp')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify({ auth: { type: 'oauth-personal' } })}\n`)
  writeFileSync(join(dir, 'acp_token.json'), '{}\n', { mode: 0o600 })
}

/**
 * A `security` that finds every item (exit 0, no output), written into `dir`.
 * The macOS login probe asks `security find-generic-password` by name on the
 * main process's `PATH`, so a spec that puts `dir` first there (`test.use({ env })`)
 * reads as signed in without touching any real keychain.
 */
export function writeFakeSecurity(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'security'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}
