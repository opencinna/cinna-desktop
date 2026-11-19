import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACP_SILENT_TURN_NOTICE_MS, createSilentTurnWatch, silentTurnEngineName, silentTurnNotice } from './acpSilentTurn'

function watch(): { fired: () => number; w: ReturnType<typeof createSilentTurnWatch> } {
  let count = 0
  const w = createSilentTurnWatch({ ms: ACP_SILENT_TURN_NOTICE_MS, onSilent: () => { count++ } })
  return { fired: () => count, w }
}

describe('the silent turn watch', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires once, 90 seconds after the prompt, when nothing was heard', () => {
    const { fired, w } = watch()
    w.start()
    vi.advanceTimersByTime(ACP_SILENT_TURN_NOTICE_MS - 1)
    expect(fired()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(fired()).toBe(1)
    vi.advanceTimersByTime(10 * ACP_SILENT_TURN_NOTICE_MS)
    expect(fired()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is over for the turn at the first thing heard, however long the silence after', () => {
    const { fired, w } = watch()
    w.start()
    vi.advanceTimersByTime(30_000)
    w.heard()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(20 * ACP_SILENT_TURN_NOTICE_MS)
    expect(fired()).toBe(0)
  })

  it('ignores what is heard before the prompt went out, and a second start', () => {
    const { fired, w } = watch()
    w.heard()
    w.start()
    vi.advanceTimersByTime(60_000)
    w.start()
    vi.advanceTimersByTime(30_000)
    expect(fired()).toBe(1)
  })

  it('leaves no timer and never fires after stop', () => {
    const { fired, w } = watch()
    w.start()
    vi.advanceTimersByTime(10_000)
    w.stop()
    expect(vi.getTimerCount()).toBe(0)
    w.start()
    vi.advanceTimersByTime(2 * ACP_SILENT_TURN_NOTICE_MS)
    expect(fired()).toBe(0)
  })
})

describe('the silent turn notice', () => {
  it('names the engine and the span from the constant', () => {
    expect(silentTurnNotice('Antigravity')).toBe(
      'No reply from Antigravity after 90 seconds. It may not be reaching its provider.'
    )
    expect(silentTurnNotice('Codex', 120_000)).toContain('after 2 minutes.')
  })

  it('uses the runtime names, a vault agent’s engine, and a custom agent’s own name', () => {
    expect(silentTurnEngineName('claude', undefined, 'Pineapple')).toBe('Claude Agent')
    expect(silentTurnEngineName('codex', undefined, null)).toBe('Codex')
    expect(silentTurnEngineName('opencode', undefined, null)).toBe('OpenCode')
    expect(silentTurnEngineName('antigravity', undefined, null)).toBe('Antigravity')
    // The folder's launcher may say one thing; the vault row's engine is what runs.
    expect(silentTurnEngineName('claude', 'antigravity', null)).toBe('Antigravity')
    expect(silentTurnEngineName('custom', undefined, 'My Remote Agent')).toBe('My Remote Agent')
    expect(silentTurnEngineName('custom', undefined, '  ')).toBe('the agent')
  })
})
