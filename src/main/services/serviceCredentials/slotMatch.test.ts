import { describe, expect, it } from 'vitest'
import { autoMatch, slotCandidates } from './slotMatch'

type Rec = { id: string; name: string; type: string; serviceUri: string | null; relation: 'owned' | 'shared'; localUseAllowed: boolean; keyStatus: string | null }
const rec = (id: string, over: Partial<Rec> = {}): Rec =>
  ({ id, name: id, type: 'api_token', serviceUri: null, relation: 'shared', localUseAllowed: true, keyStatus: null, ...over })
const ids = (list: Rec[]) => list.map((r) => r.id)

describe('matching cloud credentials to a slot', () => {
  const byUri = { name: 'acme', type: 'api_token', serviceUri: 'acme-api' }
  const byName = { name: 'weather', type: 'api_token', serviceUri: null }

  it('attaches the one record with the slot service_uri, and nothing when there is none', () => {
    expect(autoMatch(byUri, [rec('a', { serviceUri: 'acme-api' }), rec('b', { serviceUri: 'other' })])?.id).toBe('a')
    expect(autoMatch(byUri, [rec('b', { serviceUri: 'other' }), rec('acme')])).toBeNull()
  })

  it('leaves the slot when the winning sub-tier holds two records', () => {
    const two = [rec('a', { serviceUri: 'acme-api' }), rec('b', { serviceUri: 'acme-api' })]
    expect(autoMatch(byUri, two)).toBeNull()
    expect(ids(slotCandidates(byUri, two))).toEqual(['a', 'b'])
  })

  it('prefers the one owned record over shared ones, and gives up on two owned', () => {
    const shared = [rec('s1', { serviceUri: 'acme-api' }), rec('s2', { serviceUri: 'acme-api' })]
    expect(autoMatch(byUri, [...shared, rec('o', { serviceUri: 'acme-api', relation: 'owned' })])?.id).toBe('o')
    expect(autoMatch(byUri, [rec('s', { serviceUri: 'acme-api' }), rec('o1', { serviceUri: 'acme-api', relation: 'owned' }), rec('o2', { serviceUri: 'acme-api', relation: 'owned' })])).toBeNull()
  })

  it('matches a slot without service_uri by name first, then by service_uri equal to the name', () => {
    const named = rec('n', { name: 'weather' })
    const uri = rec('u', { name: 'Weather Co', serviceUri: 'weather', relation: 'owned' })
    expect(autoMatch(byName, [uri, named])?.id).toBe('n')
    expect(autoMatch(byName, [uri])?.id).toBe('u')
    expect(ids(slotCandidates(byName, [uri, named]))).toEqual(['n', 'u'])
    // A service_uri slot never falls back to names.
    expect(autoMatch(byUri, [rec('acme')])).toBeNull()
  })

  it('skips other types, records kept off this computer and dead issued keys', () => {
    const offLocal = rec('off', { serviceUri: 'acme-api', localUseAllowed: false })
    const otherType = rec('imap', { serviceUri: 'acme-api', type: 'email_imap' })
    expect(autoMatch(byUri, [offLocal, otherType])).toBeNull()
    expect(autoMatch(byUri, [offLocal, rec('ok', { serviceUri: 'acme-api' })])?.id).toBe('ok')

    const keySlot = { name: 'producer', type: 'agent_api', serviceUri: 'producer' }
    const key = (id: string, keyStatus: string) => rec(id, { type: 'agent_api', serviceUri: 'producer', relation: 'owned', keyStatus })
    expect(autoMatch(keySlot, [key('dead', 'revoked_by_issuer'), key('live', 'active')])?.id).toBe('live')
    expect(autoMatch(keySlot, [key('dead', 'expired'), key('unknown', 'mystery')])).toBeNull()
    // Paused keys recover by themselves, so they still count.
    expect(autoMatch(keySlot, [key('paused', 'api_disabled')])?.id).toBe('paused')
  })
})
