import { describe, expect, it } from 'vitest'
import { markdownToc } from './markdownToc'
import { splitFrontmatter } from './frontmatter'

const doc = (...lines: string[]): string => lines.join('\n')

describe('markdownToc', () => {
  it('shows a single H1 with several H2s, and leaves the H1 out as the title', () => {
    const toc = markdownToc(doc('# Spec', '', '## Goal', '', 'text', '', '## Design', '', '### Parsing'))
    expect(toc.show).toBe(true)
    expect(toc.entries).toEqual([
      { depth: 2, text: 'Goal', line: 3 },
      { depth: 2, text: 'Design', line: 7 },
      { depth: 3, text: 'Parsing', line: 9 }
    ])
  })

  it('shows two H1s, and lists both', () => {
    const toc = markdownToc(doc('# One', '', '# Two'))
    expect(toc.show).toBe(true)
    expect(toc.entries.map((e) => [e.depth, e.text])).toEqual([
      [1, 'One'],
      [1, 'Two']
    ])
  })

  it('shows several H2s with no H1 in front of them', () => {
    expect(markdownToc(doc('## A', '', '## B')).show).toBe(true)
  })

  it('hides one H1 with one H2', () => {
    expect(markdownToc(doc('# Title', '', '## Only', '', '### Sub', '', '### Sub 2')).show).toBe(false)
  })

  it('hides a file with no headings', () => {
    const toc = markdownToc('just a paragraph\n\n- and a list\n')
    expect(toc).toEqual({ entries: [], show: false })
  })

  it('ignores # inside a code fence', () => {
    const toc = markdownToc(doc('## Real', '', '```bash', '# not a heading', '## nor this', '```'))
    expect(toc.show).toBe(false)
    expect(toc.entries.map((e) => e.text)).toEqual(['Real'])
  })

  it('counts setext headings', () => {
    const toc = markdownToc(doc('First', '=====', '', 'Second', '======', '', 'Third', '-----'))
    expect(toc.show).toBe(true)
    expect(toc.entries).toEqual([
      { depth: 1, text: 'First', line: 1 },
      { depth: 1, text: 'Second', line: 4 },
      { depth: 2, text: 'Third', line: 7 }
    ])
  })

  it('never yields entries from frontmatter once the body is split off', () => {
    const text = doc('---', 'name: spec', 'title: Heading-looking', '---', '', '## A', '', '## B')
    const toc = markdownToc(splitFrontmatter(text).body)
    expect(toc.entries.map((e) => e.text)).toEqual(['A', 'B'])
    // Unsplit, the closing `---` would turn the keys into a setext heading.
    expect(markdownToc(text).entries.map((e) => e.text)).not.toEqual(['A', 'B'])
  })

  it('excludes H5 and H6', () => {
    const toc = markdownToc(doc('## A', '#### Four', '##### Five', '###### Six', '## B'))
    expect(toc.entries.map((e) => e.depth)).toEqual([2, 4, 2])
  })

  it('gives duplicate heading texts distinct lines', () => {
    const toc = markdownToc(doc('## Edge Cases', '', 'x', '', '## Edge Cases'))
    expect(toc.entries).toEqual([
      { depth: 2, text: 'Edge Cases', line: 1 },
      { depth: 2, text: 'Edge Cases', line: 5 }
    ])
  })

  it('flattens inline markup', () => {
    const toc = markdownToc(
      doc('## Fields *(mandatory)*', '## The `run` **command** and [a link](https://x.y)', '## Logo ![alt text](x.png)')
    )
    expect(toc.entries.map((e) => e.text)).toEqual([
      'Fields (mandatory)',
      'The run command and a link',
      'Logo alt text'
    ])
  })
})
