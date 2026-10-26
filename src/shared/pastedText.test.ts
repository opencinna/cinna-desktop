import { describe, expect, it } from 'vitest'
import {
  normalizePaste,
  pasteBlock,
  pasteLabel,
  pasteSizeLabel,
  readableUserText,
  shouldChipPaste,
  splitPastes,
  summarizeUserText,
  typedText,
  withPastes
} from './pastedText'
import { withPathRefs } from './pathMentions'
import { deriveTitleFromMessage } from './chatTitle'

const email = 'Hi team,\n\nThe meeting moved to Thursday.\n\n> On Monday, Bob wrote:\n> can we meet?'
const log = 'line 1\nline 2\nline 3'

describe('withPastes', () => {
  it('returns the text unchanged with no pastes', () => {
    expect(withPastes('Hello', [])).toBe('Hello')
  })

  it('puts each paste before the typed text, a blank line between blocks', () => {
    expect(withPastes('decline it', [{ text: log }, { text: 'one' }])).toBe(
      '<pasted_text lines="3">\nline 1\nline 2\nline 3\n</pasted_text>\n\n<pasted_text lines="1">\none\n</pasted_text>\n\ndecline it'
    )
  })

  it('is just the blocks when nothing was typed', () => {
    expect(withPastes('', [{ text: 'one' }])).toBe('<pasted_text lines="1">\none\n</pasted_text>')
  })

  it('composes with path references: pastes, typed text, reference lines', () => {
    const ref = { path: '/w/a.md', displayPath: '~/a.md', kind: 'file' as const }
    expect(withPastes(withPathRefs('look', [ref]), [{ text: 'one' }])).toBe(
      '<pasted_text lines="1">\none\n</pasted_text>\n\nlook\n\nReferenced file: `/w/a.md`'
    )
  })
})

describe('splitPastes', () => {
  it('round-trips pastes and typed text', () => {
    expect(splitPastes(withPastes('reply politely\n\nand briefly', [{ text: email }, { text: log }]))).toEqual([
      { kind: 'paste', text: email, lines: 6 },
      { kind: 'paste', text: log, lines: 3 },
      { kind: 'text', text: 'reply politely\n\nand briefly' }
    ])
  })

  it('is one text segment for a message without blocks, none for an empty one', () => {
    expect(splitPastes('Hello\n\nworld')).toEqual([{ kind: 'text', text: 'Hello\n\nworld' }])
    expect(splitPastes('')).toEqual([])
  })

  it('round-trips a paste holding a closing tag, alone on its line or inline', () => {
    const hostile = 'a\n</pasted_text>\nb </pasted_text> c\n<\\/pasted_text>\n<\\\\/pasted_text>'
    const message = withPastes('x', [{ text: hostile }])
    expect(message.split('\n').filter((line) => line === '</pasted_text>')).toHaveLength(1)
    expect(splitPastes(message)).toEqual([
      { kind: 'paste', text: hostile, lines: 5 },
      { kind: 'text', text: 'x' }
    ])
  })

  it('round-trips a nested block (a message copied out of Cinna)', () => {
    const inner = withPastes('typed inside', [{ text: log }])
    expect(splitPastes(withPastes('outer', [{ text: inner }]))).toEqual([
      { kind: 'paste', text: inner, lines: inner.split('\n').length },
      { kind: 'text', text: 'outer' }
    ])
  })

  it('keeps blank lines inside a paste', () => {
    const text = 'a\n\n\nb'
    expect(splitPastes(withPastes('', [{ text }]))).toEqual([{ kind: 'paste', text, lines: 4 }])
  })

  it('writes CRLF as LF', () => {
    expect(splitPastes(pasteBlock('a\r\nb'))).toEqual([{ kind: 'paste', text: 'a\nb', lines: 2 }])
  })

  it('finds blocks mid-message, as when the queue merges messages', () => {
    const merged = [withPastes('first', [{ text: 'one' }]), withPastes('second', [{ text: log }])].join('\n\n')
    expect(splitPastes(merged)).toEqual([
      { kind: 'paste', text: 'one', lines: 1 },
      { kind: 'text', text: 'first' },
      { kind: 'paste', text: log, lines: 3 },
      { kind: 'text', text: 'second' }
    ])
  })

  it('leaves anything but the exact written shape as text', () => {
    const shapes = [
      'intro\n<pasted_text lines="1">\none\n</pasted_text>', // no blank line before
      '<pasted_text lines="1">\none\n</pasted_text>\nafter', // no blank line after
      '<pasted_text lines="2">\none\n</pasted_text>', // wrong count
      '<pasted_text>\none\n</pasted_text>', // no count
      '<pasted_text lines="1">one</pasted_text>', // one line
      ' <pasted_text lines="1">\none\n</pasted_text>', // indented
      '<pasted_text lines="1">\none' // never closed
    ]
    for (const shape of shapes) expect(splitPastes(shape)).toEqual([{ kind: 'text', text: shape }])
  })

  it('accepts a hand-typed block of the exact shape', () => {
    expect(splitPastes('<pasted_text lines="1">\nhidden\n</pasted_text>\n\nvisible')).toEqual([
      { kind: 'paste', text: 'hidden', lines: 1 },
      { kind: 'text', text: 'visible' }
    ])
  })
})

describe('summarizeUserText, readableUserText, typedText', () => {
  const message = withPastes('decline it', [{ text: log }, { text: 'one' }])

  it('summarizes each block for one-line views', () => {
    expect(summarizeUserText(message)).toBe('[Pasted text · 3 lines]\n\n[Pasted text · 1 line]\n\ndecline it')
    expect(summarizeUserText('plain')).toBe('plain')
  })

  it('reads as the raw pastes then the typed text, no tags', () => {
    expect(readableUserText(message)).toBe(`${log}\n\none\n\ndecline it`)
  })

  it('is the typed text alone', () => {
    expect(typedText(message)).toBe('decline it')
    expect(typedText(withPastes('', [{ text: log }]))).toBe('')
  })
})

describe('normalizePaste and shouldChipPaste', () => {
  it('drops leading and trailing blank lines, keeps the inside and indentation', () => {
    expect(normalizePaste('\r\n  \n  indented\r\n\r\nend  \n\n \n')).toBe('  indented\n\nend  ')
  })

  it('chips at 20 lines or 2,000 characters', () => {
    expect(shouldChipPaste(Array(19).fill('x').join('\n'))).toBe(false)
    expect(shouldChipPaste(Array(20).fill('x').join('\n'))).toBe(true)
    expect(shouldChipPaste('x'.repeat(1999))).toBe(false)
    expect(shouldChipPaste('x'.repeat(2000))).toBe(true)
  })
})

describe('pasteLabel and pasteSizeLabel', () => {
  it('is the first non-empty line, quote markers stripped, cut at 40', () => {
    expect(pasteLabel('\n  \n>> > Re: the meeting\nbody')).toBe('Re: the meeting')
    expect(pasteLabel('y'.repeat(60))).toBe('y'.repeat(40) + '…')
    expect(pasteLabel('>\n \n')).toBe('Pasted text')
  })

  it('counts lines, or characters for a single line', () => {
    expect(pasteSizeLabel(log)).toBe('3 lines')
    expect(pasteSizeLabel('x'.repeat(2500))).toBe('2,500 chars')
  })
})

describe('deriveTitleFromMessage with pastes', () => {
  it('is the typed text, not the blocks', () => {
    expect(deriveTitleFromMessage(withPastes('Decline the meeting', [{ text: email }]))).toBe('Decline the meeting')
  })

  it('is the first paste label when nothing was typed', () => {
    expect(deriveTitleFromMessage(withPastes('', [{ text: email }, { text: log }]))).toBe('Hi team,')
  })

  it('is the typed text with pastes and reference lines both', () => {
    const ref = { path: '/w/a.md', displayPath: '~/a.md', kind: 'file' as const }
    expect(deriveTitleFromMessage(withPastes(withPathRefs('Summarise', [ref]), [{ text: log }]))).toBe('Summarise')
    expect(deriveTitleFromMessage(withPastes(withPathRefs('', [ref]), [{ text: log }]))).toBe('a.md')
  })
})
