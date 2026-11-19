import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeAcpLogEntry, FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { repoRoot } from '../playwright.config'
import type { CinnaApp } from './app'
import { fakeAntigravityScript, FAKE_MODEL_DENIAL, FAKE_PROVIDER_ERROR, type FakeAntigravityMode } from './fakeAntigravityServer'

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
 * `stopReason: 'cancelled'`. `authenticate` (a vault's `gemini-api-key`) is
 * answered at once. On the host the app still checks the login before
 * spawning, so pair it there with {@link signInAntigravityHome} and
 * {@link writeFakeSecurity}; in a fake vault (agent-vault V10) the vault's
 * Gemini key secret is the login.
 */
export interface FakeAntigravity {
  /** The executable to set as `localAgentsAntigravityPath`. */
  path: string
  /** Every request the app sent, across every process, in order. */
  received(method?: string): { method: string; params: unknown }[]
  /** Every transcript the fake wrote (`silent-provider-error`), in order. */
  transcripts(): string[]
}

export { FAKE_MODEL_DENIAL, FAKE_PROVIDER_ERROR, type FakeAntigravityMode }

export function writeFakeAntigravity(cinna: CinnaApp, options: { mode?: FakeAntigravityMode } = {}): FakeAntigravity {
  const mode = options.mode ?? 'logged-out'
  const dir = join(cinna.sandbox.root, 'fake-antigravity')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'requests.jsonl')
  const written = join(dir, 'transcripts.jsonl')
  const path = join(dir, 'agy_acp_server.par')
  const script = fakeAntigravityScript({ node: process.execPath, mode, logDir: dir })
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
