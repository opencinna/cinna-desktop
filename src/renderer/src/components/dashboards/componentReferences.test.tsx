import { render } from '@testing-library/react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { describe, expect, it } from 'vitest'
import { COMPONENT_REFS_TAG, chatUrlTransform, componentRefItems, remarkComponentReferences, type ComponentRefItem } from './componentReferences'

const ID = '2f6c3a1e-9b7d-4c2a-8e1f-0a1b2c3d4e5f'
const DEALS = `cinna://component/id:${ID}/deals-pipeline`
const REVENUE = `cinna://component/id:${ID}/revenue`
const SKILLED = `cinna://component/bundle:io.example.cinna.ab12cd34/gmail-triage/inbox`

/** The card list as data: each item one `li`, its reference and label. */
const components = {
  [COMPONENT_REFS_TAG]: ({ node }: { node?: { properties?: { dataRefs?: unknown } } }) => (
    <ul data-testid="cards">
      {componentRefItems(node?.properties?.dataRefs).map((item: ComponentRefItem) => (
        <li key={item.reference} data-reference={item.reference} data-label={item.label ?? ''} />
      ))}
    </ul>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <a data-href={href}>{children}</a>
} as unknown as Components

function md(text: string, options: { holdTail?: boolean; breaks?: boolean } = {}) {
  const plugins = [remarkGfm, ...(options.breaks ? [remarkBreaks] : []), [remarkComponentReferences, { holdTail: options.holdTail }]] as never
  return render(
    <div>
      <Markdown remarkPlugins={plugins} components={components} urlTransform={chatUrlTransform}>{text}</Markdown>
    </div>
  )
}

function cards(container: HTMLElement): { reference: string | null; label: string | null }[] {
  return [...container.querySelectorAll('[data-testid="cards"] li')].map((li) => ({ reference: li.getAttribute('data-reference'), label: li.getAttribute('data-label') }))
}

describe('remarkComponentReferences', () => {
  it('turns a reference alone on its line into a card and removes the line', () => {
    const { container } = md(`Built it.\n\n${DEALS}\n\nPress Add.`)
    expect(cards(container)).toEqual([{ reference: DEALS, label: '' }])
    expect(container.textContent).not.toContain('cinna://')
    expect(container.textContent).toContain('Built it.')
    expect(container.textContent).toContain('Press Add.')
    // In place: between the two paragraphs.
    const order = [...container.firstElementChild!.children].map((el) => el.tagName)
    expect(order).toEqual(['P', 'UL', 'P'])
  })

  it('takes a reference line out of a paragraph and keeps the lines around it', () => {
    const { container } = md(`Here it is:\n${DEALS}`)
    expect(cards(container)).toHaveLength(1)
    expect(container.querySelector('p')?.textContent).toBe('Here it is:')
  })

  it('reads a skill component and an angle autolink', () => {
    const { container } = md(`<${SKILLED}>`)
    expect(cards(container)).toEqual([{ reference: SKILLED, label: '' }])
  })

  it('makes a link to a reference a card whose subtitle is the link text', () => {
    const { container } = md(`[Deals pipeline](${DEALS})`)
    expect(cards(container)).toEqual([{ reference: DEALS, label: 'Deals pipeline' }])
    expect(container.querySelector('p')).toBeNull()
  })

  it('keeps a reference link in prose as its text, with its href, and lists its card', () => {
    const { container } = md(`I updated [the pipeline](${DEALS}) for you.`)
    expect(container.querySelector('p')?.textContent).toBe('I updated the pipeline for you.')
    // react-markdown's default urlTransform would have emptied it.
    expect(container.querySelector('a')?.getAttribute('data-href')).toBe(DEALS)
    expect(cards(container)).toEqual([{ reference: DEALS, label: 'the pipeline' }])
  })

  it('leaves a reference in a code span or a code block as text', () => {
    const { container } = md(`\`${DEALS}\`\n\n\`\`\`\n${REVENUE}\n\`\`\``)
    expect(container.querySelector('[data-testid="cards"]')).toBeNull()
    expect(container.querySelector('p code')?.textContent).toBe(DEALS)
    expect(container.querySelector('pre code')?.textContent).toContain(REVENUE)
  })

  it('draws several references as one list, at the first one, in order', () => {
    const { container } = md(`Two views:\n\n${DEALS}\n${REVENUE}\n\nAnd later:\n\n- [Inbox](${SKILLED})`)
    expect(container.querySelectorAll('[data-testid="cards"]')).toHaveLength(1)
    expect(cards(container)).toEqual([
      { reference: DEALS, label: '' },
      { reference: REVENUE, label: '' },
      { reference: SKILLED, label: 'Inbox' }
    ])
    // The emptied list item and list are gone.
    expect(container.querySelector('li:not([data-reference])')).toBeNull()
  })

  it('draws one card per component, keeping link text from a later mention', () => {
    const { container } = md(`${DEALS}\n\n${DEALS}\n\nSee [Deals](${DEALS}).`)
    expect(cards(container)).toEqual([{ reference: DEALS, label: 'Deals' }])
  })

  it('reads the user’s hard line breaks as lines', () => {
    const { container } = md(`look at\n${DEALS}`, { breaks: true })
    expect(cards(container)).toHaveLength(1)
    expect(container.querySelector('p')?.textContent).toBe('look at')
  })

  it('leaves text that is not exactly a reference alone', () => {
    const { container } = md(`Sales: ${DEALS}\n\ncinna://component/Not_A_Slug/x\n\n${DEALS}/`)
    expect(container.querySelector('[data-testid="cards"]')).toBeNull()
  })

  it('holds a streaming reply’s last line until it ends', () => {
    const partial = `Done.\n\n${DEALS}`
    expect(cards(md(partial, { holdTail: true }).container)).toHaveLength(0)
    const ended = `Done.\n\n${DEALS}\n\nNext`
    expect(cards(md(ended, { holdTail: true }).container)).toHaveLength(1)
  })
})
