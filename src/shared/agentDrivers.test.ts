import { describe, it, expect } from 'vitest'
import { readinessBlocksTurn } from './agentDrivers'

describe('readinessBlocksTurn', () => {
  const folder = { cwd: true }
  const remote = { cwd: false }

  it('lets a ready or unchecked agent take a turn', () => {
    for (const caps of [folder, remote]) {
      expect(readinessBlocksTurn(null, caps)).toBe(false)
      expect(readinessBlocksTurn(undefined, caps)).toBe(false)
      expect(readinessBlocksTurn({ state: 'ok', reason: null }, caps)).toBe(false)
    }
  })

  it('only warns about missing credentials on a folder agent', () => {
    const missing = { state: 'credentials_needed', reason: 'Add credentials.' } as const
    expect(readinessBlocksTurn(missing, folder)).toBe(false)
    expect(readinessBlocksTurn(missing, remote)).toBe(true)
  })

  it.each(['invalid', 'contract_too_new', 'not_installed', 'not_logged_in', 'unreachable'] as const)(
    'refuses %s',
    (state) => {
      expect(readinessBlocksTurn({ state, reason: 'no' }, folder)).toBe(true)
      expect(readinessBlocksTurn({ state, reason: 'no' }, remote)).toBe(true)
    }
  )
})
