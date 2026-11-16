import { render } from '@testing-library/react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { remarkNoteFormat } from './remarkNoteFormat'

const TODAY = '2026-11-15'

function view(markdown: string, tagLinks = false, timeZone = 'UTC'): HTMLElement {
  const { container } = render(
    <Markdown remarkPlugins={[remarkGfm, [remarkNoteFormat, { today: TODAY, tagLinks, timeZone }]]}>{markdown}</Markdown>
  )
  return container
}

const chips = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-note-due]')]
const pills = (el: HTMLElement): string[] => [...el.querySelectorAll<HTMLElement>('[data-note-tag]')].map((p) => p.getAttribute('data-note-tag') ?? '')

describe('remarkNoteFormat due chips', () => {
  it('draws a Today chip for due: and strips the token', () => {
    const el = view('- [ ] buy milk due:2026-11-15')
    expect(chips(el).map((c) => c.textContent)).toEqual(['Today'])
    expect(chips(el)[0].getAttribute('data-note-due')).toBe('2026-11-15')
    expect(el.textContent).not.toContain('due:')
    expect(el.querySelector('li')?.textContent).toContain('buy milk')
  })

  it('reads the 📅 form', () => {
    const el = view('- [ ] call 📅 2026-11-16')
    expect(chips(el).map((c) => c.textContent)).toEqual(['Tomorrow'])
    expect(el.textContent).not.toContain('📅')
  })

  it('marks an overdue open task with the warning tone', () => {
    const [chip] = chips(view('- [ ] pay rent due:2026-11-10'))
    expect(chip.textContent).toBe('Nov 10')
    expect(chip.getAttribute('data-tone')).toBe('overdue')
    expect(chip.className).toContain('--color-severity-warning-strong-text')
  })

  it('quiets the chip of a checked task, overdue or not, without going below secondary text', () => {
    const [chip] = chips(view('- [x] pay rent due:2026-11-10'))
    expect(chip.getAttribute('data-tone')).toBe('done')
    expect(chip.className).toContain('--color-text-secondary')
    expect(chip.getAttribute('title')).toBe('Done · due Nov 10')
  })

  it('says the tone in words, not colour alone', () => {
    expect(chips(view('- [ ] a due:2026-11-12'))[0].getAttribute('aria-label')).toBe('Overdue · Nov 12')
    expect(chips(view('- [ ] a due:2026-11-20'))[0].getAttribute('title')).toBe('Due Nov 20')
    expect(chips(view('- [ ] a due:2026-11-15'))[0].getAttribute('title')).toBe('Due today')
  })

  it('names the chip as an image, so a screen reader hears the tone', () => {
    const [chip] = chips(view('- [ ] a due:2026-11-12'))
    expect(chip.getAttribute('role')).toBe('img')
    expect(chip.getAttribute('aria-label')).toBe('Overdue · Nov 12')
    expect(chip.textContent).toBe('Nov 12')
  })

  it('keeps an upcoming open task neutral', () => {
    expect(chips(view('- [ ] later due:2026-12-01'))[0].getAttribute('data-tone')).toBe('upcoming')
  })

  it('strips the ✅ done date', () => {
    const el = view('- [x] call mom 📅 2026-11-14 ✅ 2026-11-14')
    expect(el.textContent).not.toContain('✅')
    expect(el.textContent).not.toContain('2026-11-14')
    expect(chips(el).map((c) => c.textContent)).toEqual(['Yesterday'])
  })

  it('takes the first token when both forms are present, and strips both', () => {
    const el = view('- [ ] a 📅 2026-11-16 b due:2026-11-20')
    expect(chips(el).map((c) => c.textContent)).toEqual(['Tomorrow'])
    expect(el.textContent).not.toContain('due:')
    expect(el.textContent).not.toContain('📅')
  })

  it('does not read a token wrapped in emphasis', () => {
    const el = view('- [ ] x **due:2026-11-15**')
    expect(chips(el)).toEqual([])
    expect(el.querySelector('strong')?.textContent).toBe('due:2026-11-15')
  })

  it('draws no chip for an invalid date', () => {
    expect(chips(view('- [ ] x due:2026-02-30'))).toEqual([])
  })

  it('leaves a token inside a fenced code block alone', () => {
    const el = view('```\n- [ ] x due:2026-11-15 #tag\n```')
    expect(chips(el)).toEqual([])
    expect(pills(el)).toEqual([])
    expect(el.querySelector('code')?.textContent).toContain('due:2026-11-15 #tag')
  })

  it('leaves a token on a plain list item (not a task) alone', () => {
    const el = view('- x due:2026-11-15')
    expect(chips(el)).toEqual([])
    expect(el.textContent).toContain('due:2026-11-15')
  })

  it('strips the token and pills the tag past a character reference', () => {
    const el = view('- [ ] Tom &amp; Jerry due:2026-11-15 #x')
    expect(el.textContent).not.toContain('due:')
    expect(el.textContent).toContain('Tom & Jerry')
    expect(chips(el).map((c) => c.textContent)).toEqual(['Today'])
    expect(pills(el)).toEqual(['x'])
  })

  it('strips the token of a task whose text wraps onto an indented line', () => {
    const el = view('- [ ] first due:2026-11-15 #a\n  second')
    expect(el.textContent).not.toContain('due:')
    expect(chips(el).map((c) => c.textContent)).toEqual(['Today'])
    expect(pills(el)).toEqual(['a'])
    expect(el.textContent).toContain('second')
  })

  it('draws no chip when its token could not be taken out of the text', () => {
    // The parser reads the token (it only looks at the line); remark draws it as code.
    const el = view('- [ ] run `x due:2026-11-15 y`')
    expect(el.querySelector('code')?.textContent).toBe('x due:2026-11-15 y')
    expect(chips(el)).toEqual([])
  })

  it('reads CRLF bodies', () => {
    const el = view('- [ ] a due:2026-11-15\r\n- [ ] b #home\r\n')
    expect(chips(el).map((c) => c.textContent)).toEqual(['Today'])
    expect(pills(el)).toEqual(['home'])
  })
})

describe('remarkNoteFormat timed due chips', () => {
  it('draws a floating chip with its wall time and strips the token', () => {
    const el = view('- [ ] standup due:2026-11-15T09:00 #work', false, 'Pacific/Auckland')
    const [chip] = chips(el)
    expect(chip.textContent).toBe('Today 09:00')
    expect(chip.getAttribute('data-due-kind')).toBe('floating')
    expect(chip.getAttribute('data-tone')).toBe('upcoming')
    expect(chip.getAttribute('title')).toBe('Due today 09:00 · due:2026-11-15T09:00')
    expect(chip.getAttribute('aria-label')).toBe('Due today 09:00')
    expect(el.textContent).not.toContain('due:')
    expect(pills(el)).toEqual(['work'])
  })

  it('draws a pinned chip in the device zone with its origin, stripping the whole zoned token', () => {
    const token = 'due:2026-11-15T09:00-05:00[America/New_York]'
    const el = view(`- [ ] call Ann ${token}`, false, 'Europe/Berlin')
    const [chip] = chips(el)
    expect(chip.textContent).toBe('Today 15:00 (09:00 New York)')
    expect(chip.getAttribute('data-note-due')).toBe('2026-11-15')
    expect(chip.getAttribute('data-due-kind')).toBe('pinned')
    expect(chip.getAttribute('title')).toBe(`Due today 15:00 (09:00 New York) · ${token}`)
    expect(chip.className).toContain('leading-none')
    expect(chip.className).toContain('whitespace-nowrap')
    expect(el.textContent).not.toContain('due:')
    expect(el.textContent).not.toContain('America/New_York')
    expect(el.querySelector('li')?.textContent).toContain('call Ann')
  })

  it('buckets a pinned chip by its day in the device zone', () => {
    // 20:00Z on the 14th is the 15th in Auckland, the 14th in Los Angeles.
    const auckland = chips(view('- [ ] a due:2026-11-14T20:00Z', false, 'Pacific/Auckland'))[0]
    expect(auckland.textContent).toBe('Today 09:00 (Sat 20:00 UTC)')
    expect(auckland.getAttribute('data-tone')).toBe('upcoming')
    const la = chips(view('- [ ] a due:2026-11-14T20:00Z', false, 'America/Los_Angeles'))[0]
    expect(la.textContent).toBe('Yesterday 12:00 (20:00 UTC)')
    expect(la.getAttribute('data-tone')).toBe('overdue')
  })

  it('leaves an unread timed form as text, without a chip', () => {
    const el = view('- [ ] a due:2026-11-15T09:00[Europe/London]')
    expect(chips(el)).toEqual([])
    expect(el.textContent).toContain('due:2026-11-15T09:00[Europe/London]')
  })
})

describe('remarkNoteFormat tag pills', () => {
  it('turns #tags into pills, as written', () => {
    const el = view('Pay the #Bills today')
    expect(pills(el)).toEqual(['bills'])
    expect(el.querySelector('[data-note-tag]')?.textContent).toBe('#Bills')
    expect(el.textContent).toBe('Pay the #Bills today')
  })

  it('does not pill an all-digit tag', () => {
    expect(pills(view('Read #1984 again'))).toEqual([])
  })

  it('pills a nested tag whole', () => {
    expect(pills(view('Later #inbox/to-read'))).toEqual(['inbox/to-read'])
  })

  it.each([
    ['a word-glued #', 'foo#bar'],
    ['a URL fragment', 'https://example.com/page#section'],
    ['a heading marker', '# Heading'],
    ['inline code', 'run `#code` now'],
    ['link text and URL', '[a #b](https://x/#c)'],
    ['an escaped #', '\\#esc']
  ])('does not pill %s', (_name, markdown) => {
    expect(pills(view(markdown))).toEqual([])
  })

  it('pills a tag inside emphasis', () => {
    const el = view('**#urgent** call bob')
    expect(pills(el)).toEqual(['urgent'])
    expect(el.querySelector('strong [data-note-tag]')).not.toBeNull()
  })

  it('pills a tag in a heading', () => {
    const el = view('## Plan #work')
    expect(pills(el)).toEqual(['work'])
    expect(el.querySelector('h2 [data-note-tag]')?.textContent).toBe('#work')
  })

  it('pills a tag after an escape on the same text node', () => {
    const el = view('1\\. item #x')
    expect(pills(el)).toEqual(['x'])
    expect(el.textContent).toBe('1. item #x')
  })

  it('pills tags across a blockquote line break', () => {
    expect(pills(view('> quote #q\n> more #r'))).toEqual(['q', 'r'])
  })

  it('pills a tag before a soft break with trailing space', () => {
    const el = view('one #s1 \ntwo #s2')
    expect(pills(el)).toEqual(['s1', 's2'])
    expect(el.querySelector('[data-note-tag="s1"]')?.textContent).toBe('#s1')
  })

  it('keeps pills inert by default, and makes them links with tagLinks', () => {
    const inert = view('a #x').querySelector('[data-note-tag]')!
    expect(inert.getAttribute('role')).toBeNull()
    const link = view('a #x', true).querySelector('[data-note-tag]')!
    expect(link.getAttribute('role')).toBe('button')
    expect(link.getAttribute('tabindex')).toBe('0')
    expect(link.getAttribute('title')).toBe('Show notes tagged #x')
  })

  it('pills tags on a task line alongside its chip', () => {
    const el = view('- [ ] pay rent #bills due:2026-11-15')
    expect(pills(el)).toEqual(['bills'])
    expect(chips(el).map((c) => c.textContent)).toEqual(['Today'])
  })
})
