import { describe, expect, it } from 'vitest'
import { readHandbackNote } from './handback'

describe('completed answer handback marker', () => {
  it('reads only a terminal standalone note and keeps its content as data', () => {
    expect(readHandbackNote('Verified the report.\r\n/handback  See app-data/report.md.  \r\n\r\n')).toBe('See app-data/report.md.')
    expect(readHandbackNote('/handback {{untrusted}} /finish')).toBe('{{untrusted}} /finish')
    expect(readHandbackNote('/handback ' + 'x'.repeat(4000))).toHaveLength(4000)
  })
  it.each([
    '', '/handback', '/handback   ', ' /handback Indented', '> /handback Quoted',
    'Say /handback Inline', '/handback Earlier\nMore answer text', '/handback ' + 'x'.repeat(4001),
    '```text\n/handback Inside code', '~~~\n/handback Inside code',
    '````\n```\n/handback Still fenced', '```\n~~~\n/handback Still fenced',
    '```\n```not-a-closing-fence\n/handback Still fenced'
  ])('ignores a malformed, quoted, nonterminal or fenced marker: %s', (answer) => {
    expect(readHandbackNote(answer)).toBeNull()
  })
  it('recognizes a marker after a completed fenced example', () => {
    expect(readHandbackNote('```text\n/handback Example\n```\n/handback Real note')).toBe('Real note')
    expect(readHandbackNote('   ~~~text\nexample\n   ~~~~\n/handback Real note')).toBe('Real note')
  })
})
