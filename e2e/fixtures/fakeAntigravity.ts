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
 */
export interface FakeAntigravity {
  /** The executable to set as `localAgentsAntigravityPath`. */
  path: string
  /** Every request the app sent, across every process, in order. */
  received(method?: string): { method: string; params: unknown }[]
}

export function writeFakeAntigravity(cinna: CinnaApp): FakeAntigravity {
  const dir = join(cinna.sandbox.root, 'fake-antigravity')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'requests.jsonl')
  const path = join(dir, 'agy_acp_server.par')
  const script = `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const { createInterface } = require('node:readline')
const LOG = ${JSON.stringify(log)}
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (typeof message.method !== 'string') return
  appendFileSync(LOG, JSON.stringify({ method: message.method, params: message.params ?? null }) + '\\n')
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
