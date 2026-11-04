import { describe, expect, it } from 'vitest'
import { checkCallParams, checkParamValue, effectiveRefresh, normalizeTileParams, MAX_TEXT_PARAM_LENGTH } from './tileParams'
import type { ComponentSpec } from './componentScanner'
import type { ComponentParamSpec } from '../../../shared/dashboards'

/** Params as a tile keeps them, a page's call arguments, and the effective refresh rule (README D4). */

const specs: Record<string, ComponentParamSpec> = {
  stage: { type: 'enum', label: 'Stage', values: ['lead', 'won'] },
  month: { type: 'month', default: 'current' },
  day: { type: 'date' },
  range: { type: 'date_range' },
  min: { type: 'number' },
  open: { type: 'boolean' },
  q: { type: 'text' }
}

describe('checkParamValue', () => {
  it('takes each type’s values and words, and refuses anything else with a sentence naming the param', () => {
    const ok = (name: string, value: unknown) => checkParamValue(name, specs[name], value).ok
    expect(ok('stage', 'won')).toBe(true)
    expect(checkParamValue('stage', specs.stage, 'lost')).toEqual({ ok: false, message: 'Stage must be one of lead, won.' })
    expect([ok('month', 'current'), ok('month', '2026-09'), ok('month', '2026-13'), ok('month', 'today')]).toEqual([true, true, false, false])
    expect([ok('day', 'today'), ok('day', '2026-09-30'), ok('day', '2026-9-30'), ok('day', 'current')]).toEqual([true, true, false, false])
    expect([ok('range', { from: '2026-09-01', to: '2026-09-30' }), ok('range', { from: '2026-10-01', to: '2026-09-30' }), ok('range', '2026-09'), ok('range', { from: 'today', to: '2026-09-30' })]).toEqual([true, false, false, false])
    // Either end may be "": open on that side.
    expect([ok('range', { from: '', to: '2026-09-30' }), ok('range', { from: '2026-09-01', to: '' }), ok('range', { from: '', to: '' }), ok('range', { from: '2026-09-01' })]).toEqual([true, true, true, false])
    expect([ok('min', 3.5), ok('min', '3'), ok('min', Number.NaN)]).toEqual([true, false, false])
    expect([ok('open', false), ok('open', 'false')]).toEqual([true, false])
    expect([ok('q', 'x'.repeat(MAX_TEXT_PARAM_LENGTH)), ok('q', 'x'.repeat(MAX_TEXT_PARAM_LENGTH + 1)), ok('q', 3)]).toEqual([true, false, false])
    // A range keeps only from and to.
    expect(checkParamValue('range', specs.range, { from: '2026-09-01', to: '2026-09-02', extra: 1 })).toEqual({ ok: true, value: { from: '2026-09-01', to: '2026-09-02' } })
  })
})

describe('normalizeTileParams', () => {
  it('takes the whole set: names the component does not declare and null values drop, defaults are not written in', () => {
    expect(normalizeTileParams({ stage: 'won', other: 'x', month: null, q: 'acme' }, specs)).toEqual({ ok: true, params: { stage: 'won', q: 'acme' } })
    expect(normalizeTileParams({ month: 'current' }, specs)).toEqual({ ok: true, params: { month: 'current' } })
  })

  it('refuses the whole change when one value is bad', () => {
    expect(normalizeTileParams({ q: 'fine', min: 'many' }, specs)).toEqual({ ok: false, message: 'min must be a number.' })
    expect(normalizeTileParams(['stage'], specs)).toMatchObject({ ok: false })
  })
})

describe('checkCallParams', () => {
  it('checks declared params like a tile’s and passes an endpoint’s own drill-down arguments through', () => {
    expect(checkCallParams({ stage: 'won', deal_id: 'd-1', filters: { a: [1] } }, specs)).toEqual({ ok: true, params: { stage: 'won', deal_id: 'd-1', filters: { a: [1] } } })
    expect(checkCallParams(undefined, specs)).toEqual({ ok: true, params: {} })
    expect(checkCallParams({ stage: 'lost' }, specs)).toMatchObject({ ok: false, message: 'Stage must be one of lead, won.' })
  })

  it('refuses a key that is not a param name, a non-object and anything over 64 KB', () => {
    expect(checkCallParams({ 'deal-id': 1 }, specs)).toMatchObject({ ok: false })
    expect(checkCallParams('x', specs)).toMatchObject({ ok: false })
    expect(checkCallParams({ blob: 'x'.repeat(70 * 1024) }, specs)).toMatchObject({ ok: false, message: 'The call’s params are too large (over 64 KB).' })
  })
})

describe('effectiveRefresh', () => {
  const spec = { maxAgeMs: 5 * 60_000, whileOpenEvery: '2m', afterTurn: true, onAppStart: false, refreshCommand: null, schedule: 'nightly' } as unknown as ComponentSpec

  it('is the component’s rule when the tile overrides nothing', () => {
    expect(effectiveRefresh(spec, null)).toEqual({ maxAgeMs: 300_000, manual: false, whileOpenEveryMs: 120_000, afterTurn: true, onAppStart: false, command: null, schedule: 'nightly' })
  })

  it('takes every override field over the component’s, null turning the interval off and false a flag', () => {
    expect(effectiveRefresh(spec, { maxAge: '1h', manual: true, whileOpenEvery: null, afterTurn: false, onAppStart: true })).toMatchObject({
      maxAgeMs: 3_600_000, manual: true, whileOpenEveryMs: null, afterTurn: false, onAppStart: true
    })
    expect(effectiveRefresh(spec, { whileOpenEvery: '10m' }).whileOpenEveryMs).toBe(600_000)
    // Never shorter than 1m, whatever reached it.
    expect(effectiveRefresh(spec, { whileOpenEvery: '30s' }).whileOpenEveryMs).toBeNull()
    expect(effectiveRefresh(null, null)).toMatchObject({ maxAgeMs: 15 * 60_000, whileOpenEveryMs: null, afterTurn: false })
  })
})
