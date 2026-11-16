import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ defaults: {} as Record<string, boolean>, reads: [] as string[] }))

vi.mock('electron', () => ({
  systemPreferences: {
    getUserDefault: (key: string, type: string) => {
      h.reads.push(`${key}:${type}`)
      return h.defaults[key] ?? false
    }
  }
}))

import { currentHourCycle, installHourCycleSource, readSystemHourCycle, type HourCycleDeps } from './hourCycle'

function deps(platform: NodeJS.Platform, defaults: Record<string, boolean>): HourCycleDeps & { reads: string[] } {
  const reads: string[] = []
  return {
    platform,
    reads,
    getUserDefault: (key, type) => {
      reads.push(`${key}:${type}`)
      return defaults[key] ?? false
    }
  }
}

describe('readSystemHourCycle', () => {
  it('macOS "24-hour time" on → h23', () => {
    expect(readSystemHourCycle(deps('darwin', { AppleICUForce24HourTime: true }))).toBe('h23')
  })

  it('macOS forced 12-hour → h12', () => {
    expect(readSystemHourCycle(deps('darwin', { AppleICUForce12HourTime: true }))).toBe('h12')
  })

  it('24-hour wins when both are set', () => {
    expect(readSystemHourCycle(deps('darwin', { AppleICUForce24HourTime: true, AppleICUForce12HourTime: true }))).toBe('h23')
  })

  it('neither set → null (follow the locale), reading both as booleans', () => {
    const d = deps('darwin', {})
    expect(readSystemHourCycle(d)).toBeNull()
    expect(d.reads).toEqual(['AppleICUForce24HourTime:boolean', 'AppleICUForce12HourTime:boolean'])
  })

  it.each(['win32', 'linux'] as const)('%s → null without reading anything', (platform) => {
    const d = deps(platform, { AppleICUForce24HourTime: true })
    expect(readSystemHourCycle(d)).toBeNull()
    expect(d.reads).toEqual([])
  })

  it('a throwing read is an unset one', () => {
    expect(readSystemHourCycle({ platform: 'darwin', getUserDefault: () => { throw new Error('nope') } })).toBeNull()
  })
})

describe('currentHourCycle', () => {
  afterEach(() => {
    installHourCycleSource(() => readSystemHourCycle())
    h.defaults = {}
    h.reads = []
  })

  it('reads the real systemPreferences fresh on every call by default', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      h.defaults = { AppleICUForce24HourTime: true }
      expect(currentHourCycle()).toBe('h23')
      h.defaults = {}
      expect(currentHourCycle()).toBeNull()
      expect(h.reads).toContain('AppleICUForce24HourTime:boolean')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('an installed source replaces the system read', () => {
    h.defaults = { AppleICUForce24HourTime: true }
    installHourCycleSource(() => 'h12')
    expect(currentHourCycle()).toBe('h12')
    expect(h.reads).toEqual([])
  })
})
