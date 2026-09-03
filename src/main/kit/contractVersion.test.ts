import { describe, it, expect } from 'vitest'
import {
  checkContractCompatibility,
  compareSemver,
  compareVersionStrings,
  parseSemver
} from '../../shared/kit/contractVersion'

/**
 * The gate that decides whether this build may operate a folder. Its four
 * outcomes are what the Agents page renders, so each one is pinned here.
 */
describe('parseSemver', () => {
  it('parses a release version', () => {
    expect(parseSemver('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, raw: '1.2.3' })
  })

  it('parses a pre-release', () => {
    expect(parseSemver('2.0.0-rc.1')).toMatchObject({ major: 2, prerelease: 'rc.1' })
  })

  it('rejects anything that is not a semver', () => {
    for (const value of ['1', '1.2', 'v1.2.3', '01.2.3', '', null, undefined, 3, {}]) {
      expect(parseSemver(value)).toBeNull()
    }
  })
})

describe('compareSemver', () => {
  const v = (s: string) => parseSemver(s)!

  it('orders by major, minor, then patch', () => {
    expect(compareSemver(v('1.0.0'), v('2.0.0'))).toBe(-1)
    expect(compareSemver(v('1.2.0'), v('1.1.9'))).toBe(1)
    expect(compareSemver(v('1.1.1'), v('1.1.1'))).toBe(0)
  })

  it('sorts a pre-release before its release', () => {
    expect(compareSemver(v('1.1.0-rc.1'), v('1.1.0'))).toBe(-1)
    expect(compareSemver(v('1.1.0'), v('1.1.0-rc.1'))).toBe(1)
  })

  it('sorts an unparseable version first', () => {
    expect(compareVersionStrings('nonsense', '1.0.0')).toBe(-1)
    expect(compareVersionStrings('1.0.1', '1.0.0')).toBe(1)
    expect(compareVersionStrings(undefined, null)).toBe(0)
  })
})

describe('checkContractCompatibility', () => {
  it('runs a folder on the same major, whatever the minor', () => {
    expect(checkContractCompatibility('1.0.0', '1.4.2').status).toBe('ok')
    expect(checkContractCompatibility('1.9.0', '1.0.0').status).toBe('ok')
  })

  it('refuses a folder built against a newer major', () => {
    const result = checkContractCompatibility('2.0.0', '1.3.0')
    expect(result.status).toBe('app_too_old')
    expect(result.reason).toMatch(/Update the app/i)
  })

  it('offers migration for a folder built against an older major', () => {
    expect(checkContractCompatibility('1.5.0', '2.0.0').status).toBe('migratable')
  })

  it('reports unknown when the folder records no version', () => {
    const result = checkContractCompatibility(undefined, '1.0.0')
    expect(result.status).toBe('unknown')
    expect(result.agent).toBeNull()
    expect(result.tool).not.toBeNull()
  })

  it('reports unknown when the tool version is unusable', () => {
    expect(checkContractCompatibility('1.0.0', 'not-a-version').status).toBe('unknown')
  })
})
