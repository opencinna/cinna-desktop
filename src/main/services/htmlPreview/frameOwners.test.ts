import { describe, expect, it, vi } from 'vitest'
import { createFrameOwners } from './frameOwners'

describe('frameOwners', () => {
  it('releases every token a gone renderer still holds, once, and none of another renderer', () => {
    const release = vi.fn()
    const owners = createFrameOwners(release)
    owners.own(1, 'a')
    owners.own(1, 'b')
    owners.own(2, 'c')
    expect(owners.releaseOwner(1)).toBe(2)
    expect(release.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b'])
    expect(owners.releaseOwner(1)).toBe(0)
    expect(release).toHaveBeenCalledTimes(2)
    expect(owners.tokensOf(2)).toEqual(['c'])
  })

  it('does not release a token its renderer already released', () => {
    const release = vi.fn()
    const owners = createFrameOwners(release)
    owners.own(1, 'a')
    owners.own(1, 'b')
    owners.forget('a')
    owners.forget(42)
    owners.releaseOwner(1)
    expect(release.mock.calls.map((c) => c[0])).toEqual(['b'])
  })

  it('moves a token to its newest owner', () => {
    const release = vi.fn()
    const owners = createFrameOwners(release)
    owners.own(1, 'a')
    owners.own(2, 'a')
    expect(owners.releaseOwner(1)).toBe(0)
    expect(owners.releaseOwner(2)).toBe(1)
  })
})
