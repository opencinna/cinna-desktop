import { describe, expect, it, vi } from 'vitest'

vi.mock('../../cinna-http', () => ({ cinnaSend: vi.fn() }))
vi.mock('../../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const { toOutcome } = await import('./coreDashboardsClient')

/** Core's answers → outcomes: coded refusals pass, the rest by status; never thrown. */
describe('toOutcome', () => {
  it('passes a success through as its value', () => {
    expect(toOutcome(200, true, { id: 'b1' })).toEqual({ ok: true, value: { id: 'b1' } })
  })

  it('keeps core’s component-route code, sentence, retry and field', () => {
    expect(toOutcome(429, false, { error: { code: 'rate_limited', message: 'Too many runs', retry_after_s: 12 } })).toEqual({
      ok: false, code: 'rate_limited', message: 'Too many runs', status: 429, retryAfterS: 12
    })
    expect(toOutcome(422, false, { error: { code: 'invalid_input', message: 'bad month', field: 'month' } })).toMatchObject({ code: 'invalid_input', field: 'month' })
    expect(toOutcome(503, false, { error: { code: 'env_unavailable', message: 'asleep' } })).toMatchObject({ code: 'env_unavailable', message: 'asleep' })
    // The Retry-After header stands in when the body has no retry.
    expect(toOutcome(429, false, { error: { code: 'rate_limited', message: 'x' } }, '30')).toMatchObject({ retryAfterS: 30 })
  })

  it('maps an unknown code or a `{detail}` body by status', () => {
    expect(toOutcome(403, false, { detail: 'Not your agent' })).toEqual({ ok: false, code: 'not_owner', message: 'Not your agent', status: 403 })
    expect(toOutcome(404, false, { detail: { message: 'gone' } })).toMatchObject({ code: 'not_found', message: 'gone' })
    expect(toOutcome(409, false, { error: { code: 'something_new', message: 'x' } })).toMatchObject({ code: 'limit_reached' })
    expect(toOutcome(502, false, null)).toEqual({ ok: false, code: 'unreachable', message: 'Cinna answered 502.', status: 502 })
    expect(toOutcome(500, false, 'oops')).toMatchObject({ code: 'call_failed' })
  })
})
