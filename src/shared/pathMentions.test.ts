import { describe, expect, it } from 'vitest'
import { mentionPathProblem, mergePathRefs, pathRefLine, splitPathRefs, withPathRefs, type ComposerPathRef } from './pathMentions'

const folder: ComposerPathRef = { path: '/Users/me/site', displayPath: '~/site', kind: 'dir' }
const file: ComposerPathRef = { path: '/Users/me/plan.md', displayPath: '~/plan.md', kind: 'file' }

describe('withPathRefs', () => {
  it('returns the text unchanged with no chips', () => {
    expect(withPathRefs('Hello', [])).toBe('Hello')
    expect(withPathRefs('', [])).toBe('')
  })

  it('appends a blank line and one backticked line per chip, folder or file', () => {
    expect(withPathRefs('Look at these', [folder, file])).toBe(
      'Look at these\n\nReferenced folder: `/Users/me/site`\nReferenced file: `/Users/me/plan.md`'
    )
  })

  it('is just the lines when there is no text', () => {
    expect(withPathRefs('', [file])).toBe('Referenced file: `/Users/me/plan.md`')
  })
})

describe('mergePathRefs', () => {
  it('appends in order and skips a path already referenced', () => {
    const renamed = { ...file, displayPath: 'plan.md' }
    expect(mergePathRefs([file], [folder, renamed, folder])).toEqual([file, folder])
  })
})

describe('pathRefLine', () => {
  const ref = (path: string): ComposerPathRef => ({ path, displayPath: path, kind: 'file' })

  it('fences a path with backticks in a longer run than any inside it', () => {
    expect(pathRefLine(ref('/w/a`b.md'))).toBe('Referenced file: ``/w/a`b.md``')
    expect(pathRefLine(ref('/w/a``b/c`d'))).toBe('Referenced file: ```/w/a``b/c`d```')
  })

  it('pads with a space when the path ends with a backtick, so the run does not merge into the fence', () => {
    expect(pathRefLine(ref('/w/odd`'))).toBe('Referenced file: `` /w/odd` ``')
  })

  it('round-trips through splitPathRefs, typed text and all', () => {
    const paths = ['/w/plain.md', '/w/a`b', '/w/odd`', '/w/x``y`']
    const message = withPathRefs('Look\n\nat these', paths.map(ref))
    expect(splitPathRefs(message)).toEqual({ text: 'Look\n\nat these', paths })
  })
})

describe('splitPathRefs', () => {
  it('leaves a message without trailing reference lines as typed', () => {
    expect(splitPathRefs('Hello\n\nworld')).toEqual({ text: 'Hello\n\nworld', paths: [] })
    expect(splitPathRefs('Hello\n\nReferenced file: `/a`\nand more')).toEqual({ text: 'Hello\n\nReferenced file: `/a`\nand more', paths: [] })
  })

  it('is no text and the paths for chips sent alone', () => {
    expect(splitPathRefs('Referenced folder: `/w/site`\nReferenced file: `/w/a.md`')).toEqual({ text: '', paths: ['/w/site', '/w/a.md'] })
  })
})

describe('mentionPathProblem', () => {
  it.each([
    ['a newline', '/w/a\nb'],
    ['a carriage return', '/w/a\rb'],
    ['a line separator (U+2028)', '/w/a\u2028b'],
    ['a paragraph separator (U+2029)', '/w/a\u2029b']
  ])('refuses %s, which would break the line the chip is sent as', (_label, path) => {
    expect(mentionPathProblem(path)).toBe('control characters')
  })

  it('accepts other non-ASCII names', () => {
    expect(mentionPathProblem('/w/résumé — final.md')).toBeNull()
  })
})

describe('a path with a line separator in it', () => {
  // Refused at the door, but the line the chip is sent as must still read back
  // whole if one ever got through: `.` stops at U+2028 and U+2029.
  it.each(['/w/a\u2028b.md', '/w/a\u2029b.md'])('round-trips through splitPathRefs (%#)', (path) => {
    const message = withPathRefs('Look', [{ path, displayPath: path, kind: 'file' }])
    expect(splitPathRefs(message)).toEqual({ text: 'Look', paths: [path] })
  })
})
