import { describe, expect, it } from 'vitest'
import { matchesMentionQuery } from './mentionMatch'

describe('matchesMentionQuery', () => {
  it('matches across spaces in the name', () => {
    expect(matchesMentionQuery('Ad Creatives Agent', 'adcreat')).toBe(true)
    expect(matchesMentionQuery('Ad Creatives Agent', 'AdCreativesAgent')).toBe(true)
  })

  it('matches across dashes and underscores in the name', () => {
    expect(matchesMentionQuery('Ad-Creatives Agent', 'adcreat')).toBe(true)
    expect(matchesMentionQuery('ad_creatives', 'adcreat')).toBe(true)
  })

  it('ignores separators the user typed', () => {
    expect(matchesMentionQuery('AdCreatives', 'ad-creat')).toBe(true)
  })

  it('keeps plain substring matches and the empty query', () => {
    expect(matchesMentionQuery('Ad Creatives Agent', 'creat')).toBe(true)
    expect(matchesMentionQuery('Ad Creatives Agent', '')).toBe(true)
    expect(matchesMentionQuery('Ad-Creatives', '-')).toBe(true)
  })

  it('does not match unrelated names', () => {
    expect(matchesMentionQuery('Ad Creatives Agent', 'adx')).toBe(false)
    expect(matchesMentionQuery('Research Agent', '-')).toBe(false)
  })
})
