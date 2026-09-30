import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { parseXml } from '../../utils/xmlDocument'
import { CHILD_PAGE, EXPAND_ALL_LIMIT } from './JsonTree'
import { XmlTree, type XmlReveal } from './XmlTree'

const DOC = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE feed>',
  '<!-- top -->',
  '<feed xmlns:x="urn:x" lang="en">',
  '  <title>Foo</title>',
  '  <x:entry id="1" kind="a">',
  '    <body>Line one',
  'line two</body>',
  '    <![CDATA[a < b]]>',
  '    <?render fast?>',
  '    <!-- note -->',
  '    <empty/>',
  '    <blank>   </blank>',
  '  </x:entry>',
  '</feed>'
].join('\n')

const tree = (text = DOC) => <XmlTree doc={parseXml(text)!} />
const content = (): string => screen.getByTestId('xml-tree').textContent ?? ''

describe('XmlTree', () => {
  it('renders tags, attributes, inline text, comments, CDATA, PIs and the doctype', () => {
    const { container } = render(tree())
    expect(content()).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(content()).toContain('<!DOCTYPE feed>')
    expect(content()).toContain('<feed xmlns:x="urn:x" lang="en">')
    // Short text inline, with no chevron of its own.
    expect(content()).toContain('<title>Foo</title>')
    expect(screen.queryByRole('button', { name: /title$/ })).toBeNull()
    // Multi-line text gets its own row under a foldable element.
    expect(screen.getByRole('button', { name: 'Collapse body' })).toBeTruthy()
    expect(content()).toContain('<![CDATA[a < b]]>')
    expect(content()).toContain('<?render fast?>')
    expect(content()).toContain('<empty/>')
    // Whitespace-only text is dropped, leaving an empty element.
    expect(content()).toContain('<blank/>')
    expect(container.querySelector('.hljs-comment')?.textContent).toBe('<!-- top -->')
    expect(container.querySelector('.hljs-attr')?.textContent).toBe('xmlns:x')
    expect(container.querySelector('.hljs-string')?.textContent).toBe('"urn:x"')
    expect([...container.querySelectorAll('.hljs-name')].map((n) => n.textContent)).toContain('x:entry')
  })

  it('folds an element on its chevron, with a child count, and unfolds it again', () => {
    render(tree())
    fireEvent.click(screen.getByRole('button', { name: 'Collapse x:entry' }))
    expect(content()).not.toContain('<empty/>')
    expect(content()).toContain('<x:entry id="1" kind="a">…</x:entry>6 children')
    const chevron = screen.getByRole('button', { name: 'Expand x:entry' })
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chevron)
    expect(content()).toContain('<empty/>')
  })

  it('folds and unfolds a whole branch on Alt-click', () => {
    render(tree())
    fireEvent.click(screen.getByRole('button', { name: 'Collapse feed' }), { altKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Expand feed' }))
    expect(screen.getByRole('button', { name: 'Expand x:entry' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse feed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand feed' }), { altKey: true })
    expect(screen.getByRole('button', { name: 'Collapse body' })).toBeTruthy()
  })

  it('keeps the folded ellipsis out of the tab order', () => {
    render(tree())
    fireEvent.click(screen.getByRole('button', { name: 'Collapse x:entry' }))
    const shortcut = screen.getByTestId('xml-tree').querySelector('button[tabindex="-1"]')
    expect(shortcut?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('button', { name: '…' })).toBeNull()
  })

  it('opens a large document with only the root unfolded', () => {
    const rows = Array.from({ length: EXPAND_ALL_LIMIT }, (_, i) => `<row><v>${i}</v><w/></row>`).join('')
    render(tree(`<r><meta><v>1</v><w/></meta>${rows}</r>`))
    expect(screen.getByRole('button', { name: 'Collapse r' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand meta' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Expand row' })).toHaveLength(CHILD_PAGE - 1)
  })

  it('pages a long child list', () => {
    const items = Array.from({ length: CHILD_PAGE + 5 }, (_, i) => `<i n="${i}"/>`).join('')
    render(tree(`<r>${items}</r>`))
    expect(content()).not.toContain(`n="${CHILD_PAGE}"`)
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more of 5' }))
    expect(content()).toContain(`n="${CHILD_PAGE + 4}"`)
  })

  it('marks every element row with its id for the Contents panel', () => {
    render(tree('<r><a><b>x</b></a><c/></r>'))
    const ids = [...screen.getByTestId('xml-tree').querySelectorAll('[data-heading-line]')].map((el) =>
      el.getAttribute('data-heading-line')
    )
    expect(ids).toEqual(['0', '1', '2', '3'])
  })

  it('reveals an element behind folded ancestors and past the paging cutoff', () => {
    const rows = Array.from({ length: EXPAND_ALL_LIMIT }, () => '<row><v>x</v><w/></row>').join('')
    const doc = parseXml(`<r>${rows}<last><deep><leaf/></deep></last></r>`)!
    const revealRef = createRef<XmlReveal | null>() as { current: XmlReveal | null }
    render(<XmlTree doc={doc} revealRef={revealRef} />)
    const leaf = doc.elements.find((el) => el.name === 'leaf')!
    const row = (): Element | null => screen.getByTestId('xml-tree').querySelector(`[data-heading-line="${leaf.id}"]`)
    expect(row()).toBeNull()
    act(() => revealRef.current!(leaf.id))
    expect(row()?.textContent).toBe('<leaf/>')
  })
})
