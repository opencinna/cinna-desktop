import { describe, expect, it } from 'vitest'
import { keepLineEndings, toTextareaValue } from './lineEndings'

describe('toTextareaValue', () => {
  it('normalises CRLF and lone CR to LF', () => {
    expect(toTextareaValue('a\r\nb\rc\n')).toBe('a\nb\nc\n')
    expect(toTextareaValue('plain\n')).toBe('plain\n')
  })
})

describe('keepLineEndings', () => {
  const crlf = '---\r\nkind: assistant-memory\r\n---\r\nTea.\r\n'

  it('returns an LF body as typed', () => {
    expect(keepLineEndings('a\nb', 'a\nbc')).toBe('a\nbc')
  })

  it('keeps CRLF outside the edit and uses CRLF for typed newlines', () => {
    expect(keepLineEndings(crlf, '---\nkind: assistant-memory\n---\nTea.\nMore.\nYes')).toBe(`${crlf}More.\r\nYes`)
  })

  it('edits in the middle without touching either side', () => {
    expect(keepLineEndings(crlf, '---\nkind: assistant-memory\n---\nGreen tea.\n')).toBe('---\r\nkind: assistant-memory\r\n---\r\nGreen tea.\r\n')
  })

  it('deletes a newline as a whole CRLF', () => {
    expect(keepLineEndings('a\r\nb', 'ab')).toBe('ab')
  })

  it('keeps mixed endings outside the edit', () => {
    expect(keepLineEndings('a\r\nb\nc', 'a\nb\ncd')).toBe('a\r\nb\ncd')
  })

  it('is unchanged when the textarea value is unchanged', () => {
    expect(keepLineEndings(crlf, toTextareaValue(crlf))).toBe(crlf)
  })

  it('always reads back as the textarea value', () => {
    const prev = 'x\r\ny\r\n\r\nz'
    for (const next of ['', 'x', 'x\ny\n\nz!', '!x\ny\n\nz', 'x\n\nz', 'q\nq']) {
      expect(toTextareaValue(keepLineEndings(prev, next))).toBe(next)
    }
  })

  it('never joins a kept lone CR to a following LF', () => {
    expect(toTextareaValue(keepLineEndings('a\rb', 'a\n\nb'))).toBe('a\n\nb')
    expect(toTextareaValue(keepLineEndings('a\rX\nb', 'a\n\nb'))).toBe('a\n\nb')
  })
})

describe('keepLineEndings over bodies × edits', () => {
  const bodies = ['ab\ncd\n\nef', 'ab\r\ncd\r\n\r\nef', 'ab\rcd\r\ref', 'ab\r\ncd\nef\r\rgh', '\r\n\r\n', '\r\r\n\n']

  /** Where normalised character k begins in `raw`. */
  const starts = (raw: string): number[] => {
    const out: number[] = []
    for (let i = 0; i < raw.length; i++) {
      out.push(i)
      if (raw[i] === '\r' && raw[i + 1] === '\n') i++
    }
    out.push(raw.length)
    return out
  }

  /** Every single-position edit of `text`: a deletion, and an insertion of `x` and of a newline. */
  const edits = (text: string): string[] => {
    const out: string[] = []
    for (let i = 0; i <= text.length; i++) {
      out.push(text.slice(0, i) + 'x' + text.slice(i), text.slice(0, i) + '\n' + text.slice(i))
      if (i < text.length) out.push(text.slice(0, i) + text.slice(i + 1))
    }
    return out
  }

  it('reads back as the textarea value and keeps the bytes around the edit', () => {
    for (const prev of bodies) {
      const norm = toTextareaValue(prev)
      const at = starts(prev)
      for (const next of edits(norm)) {
        const result = keepLineEndings(prev, next)
        expect(toTextareaValue(result), JSON.stringify([prev, next])).toBe(next)
        // Common prefix / suffix of the two textarea values, one character of
        // slack each for a widened edit.
        let p = 0
        while (p < Math.min(norm.length, next.length) && norm[p] === next[p]) p++
        let s = 0
        while (s < Math.min(norm.length, next.length) - p && norm[norm.length - 1 - s] === next[next.length - 1 - s]) s++
        const keptHead = prev.slice(0, at[Math.max(0, p - 2)])
        const keptTail = prev.slice(at[Math.min(norm.length, norm.length - s + 1)])
        expect(result.startsWith(keptHead), JSON.stringify([prev, next])).toBe(true)
        expect(result.endsWith(keptTail), JSON.stringify([prev, next])).toBe(true)
      }
    }
  })
})
