import { describe, it, expect } from 'vitest'
import {
  executableCandidates,
  findExecutable,
  isBareBinaryName,
  splitPathEntries
} from './pathWalk'

describe('splitPathEntries', () => {
  it('splits on the platform delimiter and trims', () => {
    expect(splitPathEntries('/usr/bin: /bin :/opt/homebrew/bin', 'posix')).toEqual([
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin'
    ])
    expect(splitPathEntries('C:\\Windows;C:\\Windows\\System32', 'win32')).toEqual([
      'C:\\Windows',
      'C:\\Windows\\System32'
    ])
  })

  it('drops empty entries — an empty entry means cwd, which we refuse to search', () => {
    expect(splitPathEntries('/usr/bin::/bin:', 'posix')).toEqual(['/usr/bin', '/bin'])
  })

  it('de-duplicates while preserving precedence', () => {
    expect(splitPathEntries('/a:/b:/a', 'posix')).toEqual(['/a', '/b'])
  })

  it('strips the quotes Windows PATH entries sometimes carry', () => {
    expect(splitPathEntries('"C:\\Program Files\\Git\\cmd";C:\\Windows', 'win32')).toEqual([
      'C:\\Program Files\\Git\\cmd',
      'C:\\Windows'
    ])
  })

  it('handles an absent PATH', () => {
    expect(splitPathEntries(undefined, 'posix')).toEqual([])
    expect(splitPathEntries('', 'posix')).toEqual([])
  })
})

describe('isBareBinaryName', () => {
  it('accepts plain tool names', () => {
    for (const name of ['claude', 'python3', 'x-terminal-emulator', 'uv', 'node.exe']) {
      expect(isBareBinaryName(name), name).toBe(true)
    }
  })

  it('rejects anything carrying a path or traversal', () => {
    for (const name of ['../claude', '/bin/sh', 'a\\b', '..', '.', '', 'a b', 'a;b', 'a$b']) {
      expect(isBareBinaryName(name), name).toBe(false)
    }
  })
})

describe('executableCandidates', () => {
  it('walks PATH in order', () => {
    expect(
      executableCandidates('claude', ['/opt/homebrew/bin', '/usr/bin'], { platform: 'posix' })
    ).toEqual(['/opt/homebrew/bin/claude', '/usr/bin/claude'])
  })

  it('ignores relative PATH entries', () => {
    expect(
      executableCandidates('claude', ['node_modules/.bin', '/usr/bin'], { platform: 'posix' })
    ).toEqual(['/usr/bin/claude'])
  })

  it('appends PATHEXT variants on Windows', () => {
    expect(
      executableCandidates('claude', ['C:\\bin'], {
        platform: 'win32',
        pathExt: '.EXE;.CMD'
      })
    ).toEqual(['C:\\bin\\claude', 'C:\\bin\\claude.EXE', 'C:\\bin\\claude.CMD'])
  })

  it('does not double an extension the name already has', () => {
    expect(
      executableCandidates('node.exe', ['C:\\bin'], { platform: 'win32', pathExt: '.EXE;.CMD' })
    ).toEqual(['C:\\bin\\node.exe'])
  })

  it('produces nothing for a non-bare name', () => {
    expect(executableCandidates('../evil', ['/usr/bin'], { platform: 'posix' })).toEqual([])
  })
})

describe('findExecutable', () => {
  it('returns the first candidate the probe accepts', async () => {
    const probed: string[] = []
    const found = await findExecutable(
      'claude',
      ['/a', '/b', '/c'],
      async (candidate) => {
        probed.push(candidate)
        return candidate === '/b/claude'
      },
      { platform: 'posix' }
    )
    expect(found).toBe('/b/claude')
    // Stopped as soon as it hit — /c was never probed.
    expect(probed).toEqual(['/a/claude', '/b/claude'])
  })

  it('returns null when nothing on PATH is executable', async () => {
    expect(
      await findExecutable('claude', ['/a'], async () => false, { platform: 'posix' })
    ).toBeNull()
  })

  it('returns null for an empty PATH', async () => {
    expect(await findExecutable('claude', [], async () => true, { platform: 'posix' })).toBeNull()
  })
})
