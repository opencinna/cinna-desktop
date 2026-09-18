import { describe, expect, it } from 'vitest'
import { commaSeparatedItems, linkifySegments, splitFrontmatter } from './frontmatter'

const doc = (fm: string, body = '# Title\n'): string => `---\n${fm}\n---\n${body}`

describe('splitFrontmatter', () => {
  it('splits scalars, quoted strings and the body', () => {
    const result = splitFrontmatter(doc("name: x\ntitle: \"A: b\" # note\nsays: 'it''s'\nurl: https://a.b/c#frag"))
    expect(result.body).toBe('# Title\n')
    expect(result.frontmatter?.entries).toEqual([
      { key: 'name', value: { kind: 'text', text: 'x' } },
      { key: 'title', value: { kind: 'text', text: 'A: b' } },
      { key: 'says', value: { kind: 'text', text: "it's" } },
      { key: 'url', value: { kind: 'text', text: 'https://a.b/c#frag' } }
    ])
  })

  it('reads block lists, flow lists and block scalars', () => {
    const fm = [
      'tags:',
      '  - one',
      '  - "two, three"',
      'top:',
      '- a',
      'flow: [x, "y, z", w]',
      'literal: |',
      '  line 1',
      '  line 2',
      'folded: >-',
      '  one',
      '  two'
    ].join('\n')
    expect(splitFrontmatter(doc(fm)).frontmatter?.entries).toEqual([
      { key: 'tags', value: { kind: 'list', items: ['one', 'two, three'] } },
      { key: 'top', value: { kind: 'list', items: ['a'] } },
      { key: 'flow', value: { kind: 'list', items: ['x', 'y, z', 'w'] } },
      { key: 'literal', value: { kind: 'text', text: 'line 1\nline 2' } },
      { key: 'folded', value: { kind: 'text', text: 'one two' } }
    ])
  })

  it('keeps nested structures as their source text', () => {
    const fm = 'owner:\n  name: A\n  team: B\nitems:\n  - id: 1\n    ok: true'
    expect(splitFrontmatter(doc(fm)).frontmatter?.entries).toEqual([
      { key: 'owner', value: { kind: 'raw', text: 'name: A\nteam: B' } },
      { key: 'items', value: { kind: 'raw', text: '- id: 1\n  ok: true' } }
    ])
  })

  it('handles CRLF, a BOM and an empty block', () => {
    expect(splitFrontmatter('﻿---\r\na: 1\r\n---\r\nbody').frontmatter?.entries).toEqual([
      { key: 'a', value: { kind: 'text', text: '1' } }
    ])
    expect(splitFrontmatter('---\n---\nbody')).toEqual({ frontmatter: { entries: [] }, body: 'body' })
  })

  it('leaves documents without frontmatter alone', () => {
    for (const text of [
      '# No frontmatter\n',
      '---\nA paragraph between rules\n---\n',
      '---\nname: unclosed\n',
      'intro\n---\na: 1\n---\n',
      // A chat reply that opens with a separator, not a metadata block.
      '---\n**Summary**: fixed the bug.\n\n- item one\n\n## Details\nMore prose.\n---\nEnd.',
      '---\nThe fix: retry once\n---\nrest',
      '---\n# Title\nauthor: me\n---\nbody',
      '---\nname: x\njust words\n---\nbody'
    ]) {
      expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text })
    }
  })
})

describe('commaSeparatedItems', () => {
  it('splits a spaceless comma list only', () => {
    expect(commaSeparatedItems('a-(A),b.c-(M)')).toEqual(['a-(A)', 'b.c-(M)'])
    expect(commaSeparatedItems('one, two')).toBeNull()
    expect(commaSeparatedItems('single')).toBeNull()
    expect(commaSeparatedItems('a,,b')).toBeNull()
  })
})

describe('linkifySegments', () => {
  it('links http(s) URLs and leaves trailing punctuation as prose', () => {
    expect(linkifySegments('See https://x.io/a_(b). and (http://y.io).')).toEqual([
      { text: 'See ' },
      { text: 'https://x.io/a_(b)', href: 'https://x.io/a_(b)' },
      { text: '. and (' },
      { text: 'http://y.io', href: 'http://y.io' },
      { text: ').' }
    ])
    expect(linkifySegments('no links')).toEqual([{ text: 'no links' }])
    expect(linkifySegments('**https://y.io**').map((s) => s.href).filter(Boolean)).toEqual(['https://y.io'])
    expect(linkifySegments('https://a.io,https://b.io').map((s) => s.href).filter(Boolean)).toEqual([
      'https://a.io',
      'https://b.io'
    ])
  })
})
