/**
 * An engine login spoken over ACP — what Antigravity has instead of a login
 * CLI. Its server answers `initialize`, then `authenticate {methodId}` opens
 * the browser sign-in itself and **answers when the sign-in is done** (or has
 * failed). Nothing else is asked: no session is created, so nothing can run.
 *
 * Newline-delimited JSON-RPC 2.0 on the child's stdio, as every ACP launcher
 * here speaks it. Each stdout line is parsed only to match an answer to its
 * request and is then dropped — never kept, never logged: an error's message
 * can carry account details. A request the server sends (none is expected
 * before a session) is answered "method not found" so it cannot wedge the
 * exchange.
 */

import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { EngineLoginProtocol } from './engineLogin'

/** The ACP protocol version this login speaks; the same one the launchers do. */
const ACP_PROTOCOL_VERSION = 1

type Answer = 'result' | 'error'

export function acpAuthenticateLogin(input: { args: readonly string[]; methodId: string }): EngineLoginProtocol {
  return {
    args: input.args,
    converse: (child) => converse(child, input.methodId)
  }
}

function converse(child: ChildProcess, methodId: string): Promise<'answered' | 'refused'> {
  const stdin = child.stdin
  const stdout = child.stdout
  if (!stdin || !stdout) return Promise.reject(new Error('the login child has no stdio'))
  // A child that died before reading stdin makes a write fail with EPIPE;
  // its `exit` decides the login, so the stream error is only swallowed.
  stdin.on('error', () => undefined)

  let nextId = 1
  const pending = new Map<number, (answer: Answer) => void>()
  let ended: (() => void) | null = null
  const gone = new Promise<never>((_resolve, reject) => {
    ended = () => reject(new Error('the login child closed its output'))
  })
  // Observed, so a child that exits first does not leave an unhandled rejection.
  gone.catch(() => undefined)

  const lines = createInterface({ input: stdout, crlfDelay: Infinity })
  lines.on('line', (line) => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    const { id, method, error } = message as { id?: unknown; method?: unknown; error?: unknown }
    if (typeof method === 'string') {
      if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
      return
    }
    if (typeof id !== 'number') return
    const settle = pending.get(id)
    if (!settle) return
    pending.delete(id)
    settle(error === undefined || error === null ? 'result' : 'error')
  })
  lines.on('close', () => ended?.())

  function write(message: unknown): void {
    try {
      stdin!.write(`${JSON.stringify(message)}\n`)
    } catch {
      /* the child is gone; its exit decides */
    }
  }

  function request(method: string, params: unknown): Promise<Answer> {
    const id = nextId++
    const answer = new Promise<Answer>((resolve) => pending.set(id, resolve))
    write({ jsonrpc: '2.0', id, method, params })
    return Promise.race([answer, gone])
  }

  return (async () => {
    const init = await request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    })
    if (init === 'error') return 'refused'
    const auth = await request('authenticate', { methodId })
    return auth === 'result' ? 'answered' : 'refused'
  })()
}
