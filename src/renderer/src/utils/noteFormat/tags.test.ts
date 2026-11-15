import { describe, expect, it } from 'vitest'
import { extractTags, fencedLineMask, findTagsInLine, findTagsInText, isValidTag, isWordStart, tagKey, tagMatchesFilter } from './tags'

// Ported from cinna-mobile src/notes/tags.test.ts (read side), one case per rule.

const keys = (body: string): string[] => extractTags(body).map((t) => t.key)
const displays = (body: string): string[] => extractTags(body).map((t) => t.display)

describe('tag format (Obsidian rules)', () => {
  it('reads letters, numbers, _, - and / and stops at anything else', () => {
    expect(displays('see #home-repairs, #snake_case and #camelCase. Also #PascalCase!')).toEqual([
      'home-repairs',
      'snake_case',
      'camelCase',
      'PascalCase'
    ])
  })

  it('ends a tag at a space: no multi-word tags', () => {
    expect(displays('#home repairs')).toEqual(['home'])
  })

  it('accepts other Unicode letters and emoji', () => {
    expect(displays('#café #задачи #日本語 #🔥 #idea💡 #👨‍👩‍👧')).toEqual(['café', 'задачи', '日本語', '🔥', 'idea💡', '👨‍👩‍👧'])
  })

  it('needs at least one non-numeric character', () => {
    expect(keys('#1984 #y1984 #1984y #2024')).toEqual(['y1984', '1984y'])
    expect(isValidTag('1984')).toBe(false)
    expect(isValidTag('y1984')).toBe(true)
  })

  it('is case-insensitive: one key, the first-seen casing for display', () => {
    expect(extractTags('#Bills then #bills then #BILLS')).toEqual([{ key: 'bills', display: 'Bills' }])
    expect(tagKey('Inbox/To-Read')).toBe('inbox/to-read')
  })

  it('reads nested tags whole', () => {
    expect(extractTags('#inbox/to-read')).toEqual([{ key: 'inbox/to-read', display: 'inbox/to-read' }])
  })

  it('drops a trailing slash', () => {
    expect(keys('#inbox/ x')).toEqual(['inbox'])
    expect(isValidTag('inbox/')).toBe(true)
    expect(isValidTag('/')).toBe(false)
  })

  it('matches a parent filter to itself and its nested tags only', () => {
    expect(tagMatchesFilter('inbox', 'inbox')).toBe(true)
    expect(tagMatchesFilter('inbox/to-read', 'inbox')).toBe(true)
    expect(tagMatchesFilter('inbox/to-read/later', 'inbox/to-read')).toBe(true)
    expect(tagMatchesFilter('inboxes', 'inbox')).toBe(false)
    expect(tagMatchesFilter('inbox', 'inbox/to-read')).toBe(false)
  })

  it('needs the # to start a word', () => {
    expect(keys('foo#bar a#b')).toEqual([])
    expect(keys('#start\n  #indented\tafter\t#tab')).toEqual(['start', 'indented', 'tab'])
    expect(isWordStart(undefined)).toBe(true)
    expect(isWordStart(' ')).toBe(true)
    expect(isWordStart('a')).toBe(false)
  })

  it('ignores URL fragments', () => {
    expect(keys('https://example.com/page#section and [doc](https://x.io/#frag) and <https://y.io/a#b>')).toEqual([])
  })

  it('does not read headings as tags', () => {
    expect(keys('# Heading\n## Sub heading\n###### Six')).toEqual([])
  })

  it('reads a tag right after a heading marker', () => {
    expect(keys('## Plans #q4')).toEqual(['q4'])
  })

  it('ignores inline code spans, including double-backtick spans', () => {
    expect(keys('run `git log #main` then ``a ` #b`` and #real')).toEqual(['real'])
  })

  it('ignores fenced code blocks (``` and ~~~), resuming after the fence', () => {
    const body = ['#before', '```sh', 'echo #nope', '```', '~~~', '#nope2', '~~~', '#after'].join('\n')
    expect(keys(body)).toEqual(['before', 'after'])
    expect(fencedLineMask(body.split('\n'))).toEqual([false, true, true, true, true, true, true, false])
  })

  it('treats an unclosed fence as code to the end', () => {
    expect(keys('#a\n```\n#b\n#c')).toEqual(['a'])
  })

  it('reads tags on task lines', () => {
    expect(keys('- [ ] pay rent #bills due:2026-11-15')).toEqual(['bills'])
  })

  it('reports offsets of each occurrence on a line', () => {
    expect(findTagsInLine('x #a `#b` #c')).toEqual([
      { start: 2, end: 4, display: 'a', key: 'a' },
      { start: 10, end: 12, display: 'c', key: 'c' }
    ])
  })

  it('skips a backslash-escaped \\#tag', () => {
    expect(keys('\\#notatag and #real')).toEqual(['real'])
  })
})

describe('emphasis and links (index matches the rendered spans)', () => {
  it('sees through emphasis markers before the #', () => {
    expect(keys('**#urgent** call bob')).toEqual(['urgent'])
    expect(keys('~~#old~~ and *#a*')).toEqual(['old', 'a'])
    expect(keys('_#x_ and __#y__')).toEqual(['x', 'y'])
    expect(keys('x**#y**')).toEqual([])
  })

  it('takes the character before a span as its word start', () => {
    expect(findTagsInText('#bar', 'o')).toEqual([])
    expect(findTagsInText('#bar', ' ')).toEqual([{ start: 0, end: 4, display: 'bar', key: 'bar' }])
  })

  it('ignores tags in link text and URLs', () => {
    expect(keys('see [a #b](https://x.y/#c) and #d')).toEqual(['d'])
  })
})
