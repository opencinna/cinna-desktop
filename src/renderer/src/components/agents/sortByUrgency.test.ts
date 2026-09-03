import { describe, expect, it } from 'vitest'
import { sortByUrgency } from './statusViews'
import type { AgentStatusSnapshot } from '../../hooks/useAgentStatus'

/**
 * `sortByUrgency`'s handling of a **null** severity, which nothing asserted.
 *
 * The whole justification for introducing `null` as distinct from `'unknown'`
 * was that the two sort differently: `severityFromState` returns `null` for an
 * agent that *claimed nothing* and `'unknown'` for one that claimed a word
 * nobody could read, and the first is a weaker signal than the second. That
 * distinction lives entirely in this function's `: -1`, and flipping it to a
 * high number moves a silent agent from the bottom of the overlay and the tray
 * popup to the **top, above every error** — the exact opposite of the intent,
 * with nothing anywhere noticing.
 *
 * `SEVERITY_RANK` is `error 4, warning 3, info 2, ok 1, unknown 0`, so any rank
 * at or above 0 for a null would reorder something. The tests below pin the
 * ordering itself rather than the constant, so they survive a renumbering of
 * the ranks and still fail the mutation that matters.
 */

function snap(agentId: string, severity: AgentStatusSnapshot['severity']): AgentStatusSnapshot {
  return {
    agentId,
    remoteAgentId: agentId,
    name: agentId,
    environmentId: 'local',
    severity,
    summary: null,
    reportedAt: null,
    reportedAtSource: null,
    fetchedAt: null,
    raw: null,
    body: '',
    hasStructuredMetadata: false,
    prevSeverity: null,
    severityChangedAt: null
  } as AgentStatusSnapshot
}

describe('sortByUrgency — an agent that claimed nothing sorts last', () => {
  it('puts a null severity below every real one, error first', () => {
    const sorted = [
      snap('silent', null),
      snap('ok', 'ok'),
      snap('unknown', 'unknown'),
      snap('error', 'error'),
      snap('warning', 'warning'),
      snap('info', 'info')
    ]
      .sort(sortByUrgency)
      .map((s) => s.agentId)

    // The consequence: the tray icon, the overlay grid and the popup all read
    // this order, so a silent agent must never outrank a real error.
    expect(sorted[0]).toBe('error')
    expect(sorted[sorted.length - 1]).toBe('silent')
    expect(sorted).toEqual(['error', 'warning', 'info', 'ok', 'unknown', 'silent'])
  })

  it('sorts a null below `unknown` specifically — the pair the rule exists for', () => {
    // "Claimed nothing" and "claimed something unreadable" are different facts.
    // If these two tie, `null` may as well not exist as a separate value.
    expect(sortByUrgency(snap('silent', null), snap('unknown', 'unknown'))).toBeGreaterThan(0)
    expect(sortByUrgency(snap('unknown', 'unknown'), snap('silent', null))).toBeLessThan(0)
  })

  it('breaks a tie between two silent agents by recency, not by chance', () => {
    const older = { ...snap('older', null), reportedAt: '2026-01-01T00:00:00Z' }
    const newer = { ...snap('newer', null), reportedAt: '2026-06-01T00:00:00Z' }
    expect([older, newer].sort(sortByUrgency).map((s) => s.agentId)).toEqual(['newer', 'older'])
  })
})
