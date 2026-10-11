import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acpAuthenticateLogin } from './acpLogin'
import { EngineLogin } from './engineLogin'

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../../logger/logger', () => ({ createLogger: () => log }))

/**
 * Antigravity's login: `initialize`, then `authenticate`, spoken over ACP to a
 * real child process — a tiny Node script standing in for the server. It
 * answers `initialize`, sends a notification and a request of its own first
 * (the login must neither choke on them nor wait for them), and then, by its
 * mode, answers `authenticate` with a result, with an error, or never. On a
 * result it writes a marker file, which the login's `refresh` reads as "the
 * home is now signed in" — so the verdict is the probe's, as for every login.
 * It never exits on its own: ending it is the login's job.
 */
const FAKE_SERVER = String.raw`
const { writeFileSync } = require('node:fs')
const readline = require('node:readline')
const [mode, marker, seen] = process.argv.slice(2)
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const methods = []
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method) methods.push(message.method)
  writeFileSync(seen, JSON.stringify(methods))
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { noise: true } })
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'fs/read_text_file', params: { path: '/etc/hosts' } })
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] } })
  } else if (message.method === 'authenticate') {
    if (message.params.methodId !== 'oauth-personal') return
    if (mode === 'ok') {
      writeFileSync(marker, 'signed in')
      send({ jsonrpc: '2.0', id: message.id, result: {} })
    } else if (mode === 'error') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'secret-account-detail@example.com', data: { reason: 'onboarding_failed' } } })
    }
    // 'hang': the browser sign-in never finishes.
  } else if (message.id !== undefined && message.error) {
    methods.push('answered:' + message.id + ':' + message.error.code)
    writeFileSync(seen, JSON.stringify(methods))
  }
})
process.on('SIGTERM', () => process.exit(143))
setInterval(() => {}, 1000)
`

let dir: string
let script: string
let marker: string
let seen: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-acp-login-'))
  script = join(dir, 'fake-agy.cjs')
  marker = join(dir, 'token')
  seen = join(dir, 'seen.json')
  writeFileSync(script, FAKE_SERVER)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

function antigravityLogin(mode: 'ok' | 'error' | 'hang') {
  const refresh = vi.fn(async () => ({ state: existsSync(marker) ? 'logged_in' : 'logged_out' }))
  const login = new EngineLogin({
    engine: 'antigravity',
    // `node` is the "server"; the script and its mode are the protocol's args.
    binary: async () => ({ path: process.execPath }),
    env: async () => ({ PATH: process.env.PATH ?? '' }),
    refresh,
    protocol: acpAuthenticateLogin({ args: [script, mode, marker, seen], methodId: 'oauth-personal' }),
    killGraceMs: 2_000
  })
  return { login, refresh }
}

const seenMethods = (): string[] => (existsSync(seen) ? (JSON.parse(readFileSync(seen, 'utf8')) as string[]) : [])

describe('the Antigravity login over ACP', () => {
  it('signs in: initialize, then authenticate with oauth-personal, then stops the server and asks the probe', async () => {
    const { login, refresh } = antigravityLogin('ok')
    const result = await login.start()
    expect(result).toEqual({ outcome: 'logged_in', command: null })
    expect(seenMethods().filter((m) => !m.startsWith('answered'))).toEqual(['initialize', 'authenticate'])
    // The server's own request was answered, not left hanging.
    expect(seenMethods()).toContain('answered:srv-1:-32601')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(login.running()).toBeNull()
  })

  it('ends on an authentication error, keeps none of its words, and fails on the probe’s verdict', async () => {
    const { login } = antigravityLogin('error')
    const result = await login.start()
    expect(result).toEqual({ outcome: 'failed', command: null })
    // Nothing the server said reaches a log line or the result.
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.debug.mock.calls])
    expect(logged).not.toContain('secret-account-detail')
    expect(JSON.stringify(result)).not.toContain('secret-account-detail')
    expect(logged).toContain('refused')
  })

  it('cancels a sign-in that is waiting on the browser: the server is stopped and nothing is signed in', async () => {
    const { login, refresh } = antigravityLogin('hang')
    const result = login.start()
    await vi.waitFor(() => expect(seenMethods()).toContain('authenticate'), { timeout: 5_000 })
    expect(login.running()).toBe('waiting')
    expect(login.cancel()).toBe(true)
    expect(await result).toEqual({ outcome: 'cancelled', command: null })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(existsSync(marker)).toBe(false)
  })

  it('times out a sign-in that never answers', async () => {
    const refresh = vi.fn(async () => ({ state: 'logged_out' }))
    const login = new EngineLogin({
      engine: 'antigravity',
      binary: async () => ({ path: process.execPath }),
      env: async () => ({ PATH: process.env.PATH ?? '' }),
      refresh,
      protocol: acpAuthenticateLogin({ args: [script, 'hang', marker, seen], methodId: 'oauth-personal' }),
      timeoutMs: 300,
      killGraceMs: 2_000
    })
    expect(await login.start()).toEqual({ outcome: 'timeout', command: null })
  })
})
