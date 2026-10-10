/**
 * The team-library trust list: which git origins an instance has named, the
 * http rules a token is held to, and where the list is kept — a file under `userData`, or memory only when there is none.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const host = vi.hoisted(() => ({ userData: null as string | null }))
/** Every fs call libraryTrust makes, by name. */
const fsCalls = vi.hoisted(() => ({ names: [] as string[] }))

vi.mock('../host/runtimeHost', () => ({
  runtimeHost: {
    getPath: (name: string) => {
      if (name !== 'userData' || host.userData === null) throw new Error('no userData on this host')
      return host.userData
    }
  }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const watched = ['readFileSync', 'openSync', 'writeSync', 'renameSync', 'mkdirSync'] as const
  const wrapped: Record<string, unknown> = {}
  for (const name of watched) {
    const fn = real[name] as (...args: unknown[]) => unknown
    wrapped[name] = (...args: unknown[]) => {
      fsCalls.names.push(name)
      return fn(...args)
    }
  }
  return { ...real, ...wrapped, default: { ...real, ...wrapped } }
})

const { libraryTrust, acceptableGitOrigin } = await import('./libraryTrust')

const SERVER = 'https://cinna.test'
const GIT = 'https://api.cinna.test'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-trust-test-'))
  host.userData = null
  fsCalls.names = []
  libraryTrust._reset(join(dir, 'trust.json'))
})

afterEach(() => {
  libraryTrust._reset()
  rmSync(dir, { recursive: true, force: true })
})

describe('learn, trusts and serversFor', () => {
  it('trusts an instance\'s own origin without learning anything', () => {
    expect(libraryTrust.trusts(SERVER, SERVER)).toBe(true)
    expect(libraryTrust.learn(SERVER, `${SERVER}/git/r.git`)).toBe(SERVER)
    expect(libraryTrust.serversFor(SERVER)).toEqual([])
    expect(existsSync(join(dir, 'trust.json'))).toBe(false)
  })

  it('trusts another origin only once that instance named it', () => {
    expect(libraryTrust.trusts(SERVER, GIT)).toBe(false)
    expect(libraryTrust.learn(SERVER, `${GIT}/git/r1.git`)).toBe(GIT)
    expect(libraryTrust.trusts(SERVER, GIT)).toBe(true)
    // Named by one instance is not named by another.
    expect(libraryTrust.trusts('https://other.test', GIT)).toBe(false)
    expect(libraryTrust.serversFor(GIT)).toEqual([SERVER])
    // Learning it again records it once.
    libraryTrust.learn(SERVER, `${GIT}/git/r2.git`)
    expect(JSON.parse(readFileSync(join(dir, 'trust.json'), 'utf8')).gitOrigins).toEqual({ [SERVER]: [GIT] })
  })

  it('learns nothing from an address a token may not go to', () => {
    expect(libraryTrust.learn(SERVER, 'http://api.cinna.test/git/r.git')).toBeNull()
    expect(libraryTrust.learn(SERVER, 'file:///tmp/r.git')).toBeNull()
    expect(libraryTrust.learn(SERVER, 'not a url')).toBeNull()
    expect(libraryTrust.serversFor('http://api.cinna.test')).toEqual([])
  })
})

describe('acceptableGitOrigin', () => {
  it('takes https anywhere, and plain http only from an http instance or to this machine', () => {
    expect(acceptableGitOrigin(SERVER, `${GIT}/git/r.git`)).toBe(GIT)
    expect(acceptableGitOrigin(SERVER, 'http://api.cinna.test/git/r.git')).toBeNull()
    expect(acceptableGitOrigin('http://cinna.lan', 'http://git.cinna.lan/git/r.git')).toBe('http://git.cinna.lan')
    expect(acceptableGitOrigin(SERVER, 'http://localhost:8000/git/r.git')).toBe('http://localhost:8000')
    expect(acceptableGitOrigin(SERVER, 'http://127.0.0.1:8000/git/r.git')).toBe('http://127.0.0.1:8000')
    expect(acceptableGitOrigin(SERVER, 'http://[::1]:8000/git/r.git')).toBe('http://[::1]:8000')
    expect(acceptableGitOrigin(SERVER, 'http://cinna.localhost/git/r.git')).toBe('http://cinna.localhost')
    expect(acceptableGitOrigin(SERVER, 'ssh://git@cinna.test/r.git')).toBeNull()
    expect(acceptableGitOrigin(SERVER, 'file:///tmp/r.git')).toBeNull()
  })
})

describe('persistence', () => {
  it('survives a restart through the file', () => {
    const file = join(dir, 'trust.json')
    libraryTrust.learn(SERVER, `${GIT}/git/r1.git`)
    libraryTrust._reset(file)
    expect(libraryTrust.trusts(SERVER, GIT)).toBe(true)
  })

  it('starts empty from a file that is not JSON', () => {
    const file = join(dir, 'trust.json')
    writeFileSync(file, 'not json')
    libraryTrust._reset(file)
    expect(libraryTrust.trusts(SERVER, GIT)).toBe(false)
  })

  it('uses the userData file when no path is given', () => {
    host.userData = dir
    libraryTrust._reset()
    libraryTrust.learn(SERVER, `${GIT}/git/r1.git`)
    expect(existsSync(join(dir, 'team-library-trust.json'))).toBe(true)
  })

  it('keeps the list in memory only, touching no file, when the host has no userData', () => {
    host.userData = null
    libraryTrust._reset()
    fsCalls.names = []
    expect(libraryTrust.trusts(SERVER, GIT)).toBe(false)
    libraryTrust.learn(SERVER, `${GIT}/git/r1.git`)
    expect(libraryTrust.trusts(SERVER, GIT)).toBe(true)
    expect(fsCalls.names).toEqual([])
  })
})
