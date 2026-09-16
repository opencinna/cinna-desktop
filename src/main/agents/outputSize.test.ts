import { describe, expect, it } from 'vitest'
import { isAtLeastAsRich, NO_OUTPUT, outputSizeOf } from './outputSize'

describe('outputSizeOf', () => {
  it('sums the parts’ text lengths and counts the parts, empty ones included', () => {
    expect(outputSizeOf([{ text: 'Hello' }, { text: '' }, { text: 'Using tool: bash' }])).toEqual({ textLength: 21, parts: 3 })
    expect(outputSizeOf([])).toEqual(NO_OUTPUT)
  })
})

describe('isAtLeastAsRich', () => {
  it('compares text length first', () => {
    expect(isAtLeastAsRich({ textLength: 11, parts: 1 }, { textLength: 10, parts: 5 })).toBe(true)
    expect(isAtLeastAsRich({ textLength: 9, parts: 5 }, { textLength: 10, parts: 1 })).toBe(false)
  })

  it('breaks a tie by part count, and an exact tie counts as at least as rich', () => {
    expect(isAtLeastAsRich({ textLength: 10, parts: 2 }, { textLength: 10, parts: 1 })).toBe(true)
    expect(isAtLeastAsRich({ textLength: 10, parts: 1 }, { textLength: 10, parts: 2 })).toBe(false)
    expect(isAtLeastAsRich({ textLength: 10, parts: 2 }, { textLength: 10, parts: 2 })).toBe(true)
    expect(isAtLeastAsRich(NO_OUTPUT, NO_OUTPUT)).toBe(true)
  })
})
