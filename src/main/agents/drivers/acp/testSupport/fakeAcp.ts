/**
 * Building, running and reading back the scriptable fake ACP agent.
 *
 * The fake is a real child process (`fakeAcpAgent.mjs`); this file is the
 * typed door to it — it writes the script, builds the {@link AcpLaunchSpec}
 * that starts it and reads the JSONL log of everything the client sent. The
 * connection tests, the driver's contract suite and (later) the e2e run all
 * drive the same binary, so the script format is documented here rather than
 * in any one of them.
 *
 * ## The script
 *
 * One JSON object. Every field is optional; an empty script is an agent that
 * initializes, opens a session and answers a prompt with `end_turn`.
 *
 * ```jsonc
 * {
 *   "stderr": ["cannot find adapter"],   // written to stderr before serving
 *   "exitOnStart": { "code": 3, "afterMs": 5 },  // die instead of serving
 *   "ignoreSigterm": true,               // only SIGKILL will stop it
 *   "exitOnClose": 0,                    // exit code when the client hangs up
 *
 *   // One entry per request the client can send. `emit` runs *before* the
 *   // response is written, `delayMs` delays the response, `hang` never sends
 *   // one, and `response` is merged over the default answer.
 *   "initialize":      { "emit": [], "response": { "authMethods": [] } },
 *   "newSession":      { "sessionId": "ses_1", "emit": [] },
 *   "loadSession":     { "emit": [] },
 *   "setMode":         { "emit": [] },
 *   "setConfigOption": { "emit": [] },
 *   "prompt":          { "emit": [], "response": { "stopReason": "end_turn" } }
 *   "steer":           { "response": { "outcome": "injected" } }   // _session/steering
 *
 *   // `error` replaces the response, after whatever `emit` streamed:
 *   // "prompt":       { "error": { "code": -32603, "message": "model not found" } }
 * }
 * ```
 *
 * ## The steps an `emit` list can hold
 *
 * `sessionId` defaults to the session the request named, or the last one
 * created. The three that send a *request* block until the client answers, and
 * log what it answered — which is how a test sees a `cancelled` outcome or a
 * `-32601`.
 *
 * ```jsonc
 * { "kind": "update", "update": { "sessionUpdate": "agent_message_chunk", … } }
 * { "kind": "notify", "method": "_auth/status_update", "params": {} }
 * { "kind": "request", "method": "fs/write_text_file", "params": {} }
 * { "kind": "permission", "toolCall": {}, "options": [] }
 * { "kind": "elicitation", "params": {} }
 * { "kind": "delay", "ms": 20 }
 * { "kind": "stderr", "text": "…" }
 * { "kind": "awaitCancel" }            // block until session/cancel arrives
 * { "kind": "awaitSteer", "after": 0 } // block until more than `after` steering requests arrived
 * { "kind": "exit", "code": 1 }
 * ```
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AcpLaunchSpec } from '../types'

const here = dirname(fileURLToPath(import.meta.url))

/** The fake agent script, as `fakeAcpAgent.mjs` reads it. Loosely typed on purpose. */
export interface FakeAcpScript {
  stderr?: string[]
  stderrOnTermination?: string
  exitOnStart?: { code?: number; afterMs?: number }
  ignoreSigterm?: boolean
  exitOnClose?: number
  initialize?: FakeAcpHandlerScript
  /** Explicitly log attempted authentication; probes must not invoke it. */
  authenticate?: FakeAcpHandlerScript
  newSession?: FakeAcpHandlerScript & { sessionId?: string }
  loadSession?: FakeAcpHandlerScript
  setMode?: FakeAcpHandlerScript
  setConfigOption?: FakeAcpHandlerScript
  prompt?: FakeAcpHandlerScript
  /** `_session/steering`; answers `{ outcome: 'injected' }` unless `response` overrides it. */
  steer?: FakeAcpHandlerScript
}

export interface FakeAcpHandlerScript {
  /** Sent before the response. */
  emit?: FakeAcpStep[]
  /** Delay between the emits and the response. */
  delayMs?: number
  /** Never answer. */
  hang?: boolean
  /** Merged over the default response. */
  response?: Record<string, unknown>
  /**
   * Answer with a JSON-RPC error instead of a result, after `emit`/`delayMs`.
   *
   * The failure a real agent has: OpenCode fails `session/prompt` with
   * `-32603 "Internal error: model 'x' not found"` when the session's model is
   * gone, and `session/load` fails for a session it no longer has.
   */
  error?: { code?: number; message: string; data?: Record<string, unknown> }
}

export type FakeAcpStep =
  | { kind: 'update'; sessionId?: string; update: Record<string, unknown> }
  | { kind: 'notify'; method: string; params?: Record<string, unknown> }
  | { kind: 'request'; method: string; params?: Record<string, unknown> }
  | {
      kind: 'permission'
      sessionId?: string
      toolCall?: Record<string, unknown>
      options?: Record<string, unknown>[]
      params?: Record<string, unknown>
    }
  | { kind: 'elicitation'; sessionId?: string; params?: Record<string, unknown> }
  | { kind: 'delay'; ms: number }
  | { kind: 'stderr'; text: string }
  | { kind: 'awaitCancel'; sessionId?: string }
  | { kind: 'awaitSteer'; after?: number }
  | { kind: 'exit'; code?: number }

/** One line of the fake's log: what it received, and what it was answered. */
export interface FakeAcpLogEntry {
  t: number
  dir: 'start' | 'in' | 'answer' | 'signal' | 'exit'
  kind?: 'request' | 'notification'
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number | null; message: string }
  /** On `start`: the environment the process actually got. */
  env?: Record<string, string>
  cwd?: string
  pid?: number
  argv?: string[]
  signal?: string
  code?: number
}

export interface FakeAcp {
  /** The sandbox the script, the log and the process's cwd live in. */
  dir: string
  spec: AcpLaunchSpec
  logPath: string
  /** Everything the fake has recorded so far. Safe to call before it starts. */
  log(): FakeAcpLogEntry[]
  /** Entries for one ACP method (`session/prompt`, …), in arrival order. */
  received(method: string): FakeAcpLogEntry[]
  /** What the client answered a request the fake sent. */
  answers(method: string): FakeAcpLogEntry[]
  cleanup(): void
}

/**
 * Write a script and return the spec that runs it.
 *
 * The environment is *only* what the fake needs — no `PATH`, no `HOME`, nothing
 * from this process. That is not tidiness: it is the assertion that
 * `startAcpConnection` passes `spec.env` verbatim, and the fake logs what it
 * received so a test can check it.
 */
export function createFakeAcp(
  script: FakeAcpScript = {},
  overrides: Partial<AcpLaunchSpec> = {}
): FakeAcp {
  const dir = mkdtempSync(join(tmpdir(), 'cinna-fake-acp-'))
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'log.jsonl')
  writeFileSync(scriptPath, JSON.stringify(script, null, 2))
  writeFileSync(logPath, '')

  const env = { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath, ...(overrides.env ?? {}) }
  const spec: AcpLaunchSpec = {
    command: process.execPath,
    args: [join(here, 'fakeAcpAgent.mjs')],
    cwd: dir,
    key: 'fake-acp-v1',
    ...overrides,
    env
  }

  const log = (): FakeAcpLogEntry[] => {
    let raw: string
    try {
      raw = readFileSync(logPath, 'utf8')
    } catch {
      return []
    }
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as FakeAcpLogEntry)
  }

  return {
    dir,
    spec,
    logPath,
    log,
    received: (method) => log().filter((e) => e.dir === 'in' && e.method === method),
    answers: (method) => log().filter((e) => e.dir === 'answer' && e.method === method),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

/** Poll `check` until it returns something truthy, or fail after `timeoutMs`. */
export async function waitFor<T>(
  check: () => T | undefined | false | null,
  what: string,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Let everything already read off the wire finish being dispatched.
 *
 * The SDK processes incoming messages concurrently, so "has arrived" and "has
 * been routed" are different moments; a test that wants to bind *after* traffic
 * was routed has to give the event loop a real turn, not a microtask.
 */
export function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
