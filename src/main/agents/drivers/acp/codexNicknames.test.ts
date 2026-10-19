import { describe, expect, it } from 'vitest'
import { codexNickname } from './codexNicknames'

const SHAPE = /^[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+$/

describe('codexNickname', () => {
  it('is "Adjective Colour Animal", the same for the same thread id every time', () => {
    const id = '01a15429-b7f3-7f80-b352-ef963ba9f782'
    expect(codexNickname(id)).toMatch(SHAPE)
    expect(codexNickname(id)).toBe(codexNickname(id))
    // Pinned: a later build must name a subagent the way an earlier one did,
    // so reordering or editing the word lists is a visible change.
    expect(codexNickname(id)).toBe('Curious Turquoise Yak')
  })

  it('does not depend on anything but the id', () => {
    const before = codexNickname('thread-a')
    codexNickname('thread-b')
    expect(codexNickname('thread-a')).toBe(before)
  })

  it('spreads thread ids over the names: siblings rarely share one', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `01a15433-72d6-7d31-a125-${String(i).padStart(12, '0')}`)
    const names = ids.map(codexNickname)
    for (const name of names) expect(name).toMatch(SHAPE)
    expect(new Set(names).size).toBeGreaterThanOrEqual(195)
    // Every word position varies.
    for (const position of [0, 1, 2]) expect(new Set(names.map((n) => n.split(' ')[position])).size).toBeGreaterThan(20)
  })
})
