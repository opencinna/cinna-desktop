import type { execFile } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityAuthProbe, parseAntigravityAuthType, probeAntigravityAuth, type AntigravityAuthProbeInput } from './antigravityAuth'
import { antigravityServerArgs, buildAntigravityEnv } from './antigravityEnv'

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../../logger/logger', () => ({ createLogger: () => log }))

afterEach(() => vi.clearAllMocks())

/**
 * The Antigravity login probe never starts the server (with no token it would
 * open a browser by itself). It reads `auth.type` from the home's settings and
 * asks the token store: the macOS keychain by attributes, or the token file.
 */

const HOME = '/Users/test'
const SETTINGS = join(HOME, '.gemini', 'antigravity-acp', 'settings.json')
const SIGNED_IN_SETTINGS = JSON.stringify({ auth: { type: 'oauth-personal' } })

/** A fake `security`: exit code by verdict, attributes on stdout that must never be read. */
function security(outcome: 0 | 44 | 'killed' | 1) {
  const calls: { file: string; args: readonly string[] }[] = []
  const exec = ((file: string, args: readonly string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
    calls.push({ file, args })
    const stdout = 'keychain: "/Users/test/Library/Keychains/login.keychain-db"\n"acct"<blob>="antigravity-acp"'
    if (outcome === 0) callback(null, stdout, '')
    else if (outcome === 'killed') callback(Object.assign(new Error('killed'), { killed: true, code: null }), '', '')
    else callback(Object.assign(new Error('not found'), { code: outcome }), '', 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.')
    return {} as never
  }) as unknown as typeof execFile
  return { exec, calls }
}

function input(overrides: Partial<AntigravityAuthProbeInput> = {}): AntigravityAuthProbeInput {
  return {
    env: {},
    homeDir: HOME,
    platform: 'darwin',
    readFile: async (path) => {
      if (path === SETTINGS) return SIGNED_IN_SETTINGS
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    ...overrides
  }
}

describe('parseAntigravityAuthType', () => {
  it('reads auth.type, null when absent or blank, undefined when not JSON', () => {
    expect(parseAntigravityAuthType(SIGNED_IN_SETTINGS)).toBe('oauth-personal')
    expect(parseAntigravityAuthType('{}')).toBeNull()
    expect(parseAntigravityAuthType('{"auth":{"type":"  "}}')).toBeNull()
    expect(parseAntigravityAuthType('{"auth":{}}')).toBeNull()
    expect(parseAntigravityAuthType('not json')).toBeUndefined()
  })
})

describe('probeAntigravityAuth on macOS', () => {
  it('is logged in when auth.type is set and the keychain item exists — asked by attributes only, never -w', async () => {
    const { exec, calls } = security(0)
    expect(await probeAntigravityAuth(input({ exec }))).toEqual({ state: 'logged_in' })
    expect(calls).toEqual([{ file: 'security', args: ['find-generic-password', '-s', 'gemini', '-a', 'antigravity-acp'] }])
    expect(calls[0].args).not.toContain('-w')
    expect(calls[0].args).not.toContain('-g')
    // What `security` printed is not in any log line.
    expect(JSON.stringify([...log.debug.mock.calls, ...log.warn.mock.calls])).not.toContain('keychain-db')
  })

  it('is logged out when the keychain has no item (exit 44)', async () => {
    expect(await probeAntigravityAuth(input({ exec: security(44).exec }))).toEqual({ state: 'logged_out' })
  })

  it('cannot tell when security fails otherwise or is killed', async () => {
    expect(await probeAntigravityAuth(input({ exec: security(1).exec }))).toEqual({ state: 'unknown' })
    expect(await probeAntigravityAuth(input({ exec: security('killed').exec }))).toEqual({ state: 'unknown' })
  })

  it('is logged out without asking the keychain when the home has no settings or no auth.type', async () => {
    const none = security(0)
    expect(await probeAntigravityAuth(input({ exec: none.exec, readFile: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } })))
      .toEqual({ state: 'logged_out' })
    expect(await probeAntigravityAuth(input({ exec: none.exec, readFile: async () => '{"auth":{}}' }))).toEqual({ state: 'logged_out' })
    expect(none.calls).toEqual([])
  })

  it('cannot tell from a settings file it cannot read or parse', async () => {
    expect(await probeAntigravityAuth(input({ exec: security(0).exec, readFile: async () => '{oops' }))).toEqual({ state: 'unknown' })
    expect(await probeAntigravityAuth(input({
      exec: security(0).exec,
      readFile: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) }
    }))).toEqual({ state: 'unknown' })
  })

  it('reads the GEMINI_HOME the child environment names instead of ~/.gemini', async () => {
    const read: string[] = []
    await probeAntigravityAuth(input({
      env: { GEMINI_HOME: '/srv/agy' },
      exec: security(0).exec,
      readFile: async (path) => {
        read.push(path)
        return SIGNED_IN_SETTINGS
      }
    }))
    expect(read).toEqual(['/srv/agy/antigravity-acp/settings.json'])
  })
})

describe('probeAntigravityAuth on Linux', () => {
  it('asks the home’s token file, never the keychain', async () => {
    const { exec, calls } = security(0)
    const asked: string[] = []
    const fileExists = async (path: string): Promise<boolean> => {
      asked.push(path)
      return true
    }
    expect(await probeAntigravityAuth(input({ platform: 'linux', exec, fileExists }))).toEqual({ state: 'logged_in' })
    expect(asked).toEqual([join(HOME, '.gemini', 'antigravity-acp', 'acp_token.json')])
    expect(calls).toEqual([])
    expect(await probeAntigravityAuth(input({ platform: 'linux', exec, fileExists: async () => false }))).toEqual({ state: 'logged_out' })
  })

  it('cannot tell on a platform with no known token store', async () => {
    expect(await probeAntigravityAuth(input({ platform: 'win32' }))).toEqual({ state: 'unknown' })
  })
})

describe('AntigravityAuthProbe', () => {
  it('shares one answer for thirty seconds, and asks again after refresh or invalidate', async () => {
    let now = 0
    const probe = vi.fn(async () => ({ state: 'logged_out' as const }))
    const auth = new AntigravityAuthProbe({ env: async () => ({}), probe, now: () => now })
    await Promise.all([auth.status(), auth.status()])
    expect(probe).toHaveBeenCalledTimes(1)
    now = 29_000
    await auth.status()
    expect(probe).toHaveBeenCalledTimes(1)
    now = 31_000
    await auth.status()
    expect(probe).toHaveBeenCalledTimes(2)
    await auth.refresh()
    expect(probe).toHaveBeenCalledTimes(3)
    auth.invalidate()
    await auth.status()
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('does not keep an answer asked before an invalidate', async () => {
    let release!: () => void
    const probe = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ state: 'logged_out' }) }))
      .mockImplementation(async () => ({ state: 'logged_in' }))
    const auth = new AntigravityAuthProbe({ env: async () => ({}), probe })
    const stale = auth.status()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    auth.invalidate()
    release()
    expect(await stale).toEqual({ state: 'logged_out' })
    expect(await auth.status()).toEqual({ state: 'logged_in' })
  })

  it('answers unknown when its environment cannot be built', async () => {
    const auth = new AntigravityAuthProbe({ env: async () => { throw new Error('no shell') } })
    expect(await auth.status()).toEqual({ state: 'unknown' })
  })
})

describe('the Antigravity child environment and arguments', () => {
  it('keeps a GEMINI_HOME the user set, and adds none otherwise', () => {
    expect(buildAntigravityEnv({ shellEnv: { PATH: '/usr/bin', GEMINI_HOME: '/srv/agy' }, processEnv: {} }).GEMINI_HOME).toBe('/srv/agy')
    const before = process.env.GEMINI_HOME
    delete process.env.GEMINI_HOME
    try {
      expect(buildAntigravityEnv({ shellEnv: { PATH: '/usr/bin' }, processEnv: {} }).GEMINI_HOME).toBeUndefined()
    } finally {
      if (before !== undefined) process.env.GEMINI_HOME = before
    }
  })

  it('starts the server with no flags on macOS (an unknown flag is fatal there) and --uid= on Linux', () => {
    expect(antigravityServerArgs('darwin')).toEqual([])
    expect(antigravityServerArgs('linux')).toEqual(['--uid='])
  })
})
