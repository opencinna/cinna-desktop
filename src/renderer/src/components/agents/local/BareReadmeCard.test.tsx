import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto, LocalAgentDocDto } from '../../../../../shared/localAgents'
import { BareReadmeCard } from './BareAgentCards'

/**
 * A bare folder's `README.md`, on Overview.
 *
 * Two claims worth pinning: the card is *absent* where the folder has no
 * README — a card that can only say "there is no README here" repeats a Folder
 * finding and pushes the one control Overview has down the page — and what it
 * shows is the rendered document, not its source. The README is the only prose
 * most adopted folders have about themselves, and reading `## Heading` in it is
 * how the old raw view failed the user.
 */

const readDoc = vi.fn<() => Promise<LocalAgentDocDto>>()
const openPath = vi.fn()
;(window as unknown as { api: unknown }).api = { localAgents: { readDoc, openPath } }

const agent = { id: 'folder:alpha', name: 'Alpha' } as LocalAgentDto

const doc = (over: Partial<LocalAgentDocDto> = {}): LocalAgentDocDto => ({
  relPath: 'README.md',
  text: '# Alpha\n\nWatches the alpha feed.',
  stamp: { mtimeMs: 1, size: 34, hash: 'abc' },
  ...over
})

function renderCard(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    createElement(QueryClientProvider, { client }, createElement(BareReadmeCard, { agent }))
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('BareReadmeCard', () => {
  it('renders the README as markdown, not as its source text', async () => {
    // Mutation: render `doc.text` in a `<pre>` and the heading arrives as
    // "# Alpha", which is what this replaced.
    readDoc.mockResolvedValue(doc())
    renderCard()
    const heading = await screen.findByRole('heading', { name: 'Alpha' })
    expect(heading).toBeTruthy()
    expect(screen.queryByText(/# Alpha/)).toBeNull()
  })

  it('starts the document’s headings below the page’s, rather than at h1', async () => {
    // The page title is the only `h1` on the screen and a card title is an
    // `h2`. A README opening with `# Alpha` — the ordinary shape — used to put
    // a second `h1` under it, which is both a broken outline for a screen
    // reader and a strict-mode ambiguity for every `heading level 1` query in
    // the E2E suite. Mutation: pass `markdownComponents` here and this fails.
    readDoc.mockResolvedValue(doc())
    renderCard()
    await screen.findByRole('heading', { name: 'Alpha' })
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0)
    expect(screen.getByRole('heading', { level: 3, name: 'Alpha' })).toBeTruthy()
  })

  it('hides raw HTML instead of printing it as prose', async () => {
    // react-markdown escapes what it will not run, so an unfiltered README
    // showed its badge block and its comments as visible markup — at the top of
    // Overview, where a repository README keeps exactly those.
    readDoc.mockResolvedValue(
      doc({
        text: '<!-- generated -->\n\n<p align="center">Badges</p>\n\nReal prose.\n\n```\n<kept/>\n```'
      })
    )
    renderCard()
    await screen.findByText('Real prose.')
    expect(screen.queryByText(/generated/)).toBeNull()
    expect(screen.queryByText(/align="center"/)).toBeNull()
    // A fenced block is one code node, so nothing inside one is filtered.
    expect(screen.getByText(/<kept\/>/)).toBeTruthy()
  })

  it('renders an image as its alt text — the card cannot load one', async () => {
    // `img-src 'self' data:`, and the card is not served from the folder, so a
    // README's logo could only ever be a broken-image glyph.
    readDoc.mockResolvedValue(doc({ text: '![Build status](https://img.shields.io/x.svg)' }))
    renderCard()
    expect(await screen.findByText('[Build status]')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })

  it('names the file it reads and reveals it', async () => {
    readDoc.mockResolvedValue(doc())
    renderCard()
    // The button *is* the filename — the card is a viewer over a file and says
    // which one — so that is the name it answers to.
    const reveal = await screen.findByRole('button', { name: 'README.md' })
    fireEvent.click(reveal)
    await waitFor(() =>
      expect(openPath).toHaveBeenCalledWith({ agentId: 'folder:alpha', relPath: 'README.md' })
    )
  })

  it('renders nothing at all when the folder has no README', async () => {
    // `stamp: null` is main's "not there". The Folder tab already carries that
    // finding with the explanation attached; a second, emptier statement of it
    // on Overview is not information.
    readDoc.mockResolvedValue(doc({ text: '', stamp: null }))
    const { container } = renderCard()
    await waitFor(() => expect(readDoc).toHaveBeenCalled())
    expect(container.querySelector('section')).toBeNull()
  })

  it('renders the whole file — no clamp, no Show more to press first', async () => {
    // A viewer over a document, on a page that already scrolls. The clamp this
    // replaces hid the second half of every real README behind a control that
    // was itself hard to see as one.
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n\n')
    readDoc.mockResolvedValue(doc({ text: long }))
    renderCard()
    expect(await screen.findByText('line 59')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /show (more|less)/i })).toBeNull()
  })
})
