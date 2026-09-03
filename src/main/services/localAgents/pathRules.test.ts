import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { assertUsableRoot, isWithin, resolveWithinRoot } = await import('./pathRules')

/**
 * These are the guards standing between a compromised renderer and the user's
 * filesystem, so they are tested for what they *refuse*, not only what they
 * allow. Every case below is a path a hostile caller would actually try.
 */

describe('assertUsableRoot', () => {
  it('accepts a folder in the user’s home', () => {
    const path = join(homedir(), 'Documents', 'CinnaAgents')
    expect(assertUsableRoot(path)).toBe(path)
  })

  it('accepts a folder that does not exist yet — the home is created on demand', () => {
    expect(assertUsableRoot(join(homedir(), 'Documents', 'NotYetCreated'))).toContain(
      'NotYetCreated'
    )
  })

  it('normalises before deciding', () => {
    const messy = join(homedir(), 'Documents', 'x', '..', 'CinnaAgents')
    expect(assertUsableRoot(messy)).toBe(join(homedir(), 'Documents', 'CinnaAgents'))
  })

  it('refuses system locations', () => {
    for (const path of ['/etc', '/usr/bin', '/System/Library', '/']) {
      expect(() => assertUsableRoot(path)).toThrow()
    }
  })

  it('refuses the home directory itself', () => {
    expect(() => assertUsableRoot(homedir())).toThrow(/home directory itself/i)
  })

  it('refuses a relative path, an empty one, and one with a NUL', () => {
    expect(() => assertUsableRoot('Documents/CinnaAgents')).toThrow()
    expect(() => assertUsableRoot('')).toThrow()
    expect(() => assertUsableRoot(`${homedir()}/a\0b`)).toThrow()
  })

  it('refuses a non-string', () => {
    for (const value of [null, undefined, 42, {}, ['/tmp']]) {
      expect(() => assertUsableRoot(value)).toThrow()
    }
  })

  it('refuses a permitted path that is a symlink to a system location', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cinna-pathrules-'))
    const link = join(dir, 'looks-innocent')
    try {
      symlinkSync('/etc', link)
      expect(() => assertUsableRoot(link)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveWithinRoot', () => {
  const agentDir = '/agents/Local/alpha'

  it('returns the folder itself for an empty path', () => {
    expect(resolveWithinRoot(agentDir, undefined)).toBe(agentDir)
    expect(resolveWithinRoot(agentDir, '')).toBe(agentDir)
  })

  it('resolves an agent-relative path', () => {
    expect(resolveWithinRoot(agentDir, 'docs/WORKFLOW_PROMPT.md')).toBe(
      join(agentDir, 'docs/WORKFLOW_PROMPT.md')
    )
  })

  it('refuses anything that climbs out', () => {
    for (const rel of ['../beta', '../../../../etc/passwd', 'docs/../../beta/x']) {
      expect(() => resolveWithinRoot(agentDir, rel)).toThrow(/not inside/i)
    }
  })

  it('refuses an absolute path', () => {
    expect(() => resolveWithinRoot(agentDir, '/etc/passwd')).toThrow(/not inside/i)
  })

  it('refuses a symlink inside the folder that points out of it', () => {
    const workshop = mkdtempSync(join(tmpdir(), 'cinna-agent-'))
    try {
      mkdirSync(join(workshop, 'knowledge'), { recursive: true })
      const secret = join(workshop, 'outside.txt')
      writeFileSync(secret, 'not yours')
      const inner = mkdtempSync(join(tmpdir(), 'cinna-inner-'))
      mkdirSync(join(inner, 'knowledge'), { recursive: true })
      symlinkSync(secret, join(inner, 'knowledge', 'escape.txt'))
      expect(() => resolveWithinRoot(inner, 'knowledge/escape.txt')).toThrow(/not inside/i)
      rmSync(inner, { recursive: true, force: true })
    } finally {
      rmSync(workshop, { recursive: true, force: true })
    }
  })
})

describe('isWithin', () => {
  it('treats a path as within itself', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
  })

  it('does not match a sibling with a shared prefix', () => {
    expect(isWithin('/a/b', '/a/bc')).toBe(false)
    expect(isWithin('/a/b', '/a/b/c')).toBe(true)
  })

  it('never matches on an empty side', () => {
    expect(isWithin('', '/a')).toBe(false)
    expect(isWithin('/a', '')).toBe(false)
  })
})
