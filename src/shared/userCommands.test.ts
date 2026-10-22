import { describe, expect, it } from 'vitest'
import { homeDisplayPath } from './userCommands'

describe('homeDisplayPath', () => {
  it('shortens a path under the home folder to ~ and leaves the rest alone', () => {
    expect(homeDisplayPath('/Users/me/agents/a', '/Users/me')).toBe('~/agents/a')
    expect(homeDisplayPath('/Users/me', '/Users/me/')).toBe('~')
    expect(homeDisplayPath('/Users/meow/a', '/Users/me')).toBe('/Users/meow/a')
    expect(homeDisplayPath('~/agents/a', '/Users/me')).toBe('~/agents/a')
    expect(homeDisplayPath('C:\\Users\\me\\a', 'C:\\Users\\me')).toBe('~\\a')
    expect(homeDisplayPath('/Users/me/a', null)).toBe('/Users/me/a')
  })
})
