import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractFileRefEntries, extractLinkDestinations, type AgentFileRef } from '../../../../shared/agentFiles'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from './MessageBubble'
import { FileRefContext, chatMarkdownComponents, collectFileRefSources, type FileRefScope } from './fileRefs'
import { useFilePreviewStore } from '../../stores/filePreview.store'

const ref = (text: string, over: Partial<AgentFileRef> = {}): AgentFileRef => ({
  text,
  path: `/agent/${text}`,
  displayPath: text,
  kind: 'file',
  inside: true,
  ...over
})

const csv = ref('data/omp.csv')
const folder = ref('pulled', { kind: 'dir' })
const csvLink = ref('data/omp.csv', { source: 'link' })
const spacedLink = ref('/agent/app%20data/index%20file.csv', { source: 'link', path: '/agent/app data/index file.csv', displayPath: 'app data/index file.csv' })
const folderLink = ref('pulled/', { source: 'link', kind: 'dir', displayPath: 'pulled' })
const scope: FileRefScope = {
  agentId: 'folder:a',
  refs: new Map([
    [csv.text, csv],
    [folder.text, folder]
  ]),
  links: new Map([
    [csvLink.text, csvLink],
    [spacedLink.text, spacedLink],
    [folderLink.text, folderLink]
  ])
}

const openAgentFile = vi.fn(async () => {})

beforeEach(() => {
  openAgentFile.mockClear()
  useFilePreviewStore.setState({ openAgentFile })
})

function renderBubble(
  content: string,
  { value = scope, isStreaming = false, role = 'assistant' }: { value?: FileRefScope | null; isStreaming?: boolean; role?: 'user' | 'assistant' } = {}
) {
  return render(
    <FileRefContext.Provider value={value}>
      <MessageBubble role={role} content={content} isStreaming={isStreaming} />
    </FileRefContext.Provider>
  )
}

describe('the inline code override', () => {
  it('links inline code that resolved, and only that', () => {
    renderBubble('Wrote `data/omp.csv` next to `other.csv`.')
    const link = screen.getByRole('button', { name: 'Preview data/omp.csv' })
    expect(link.tagName).toBe('CODE')
    expect(link.className).toContain('file-ref')
    expect(link.getAttribute('tabindex')).toBe('0')
    expect(link.getAttribute('title')).toBe('data/omp.csv')
    expect(screen.getByText('other.csv').getAttribute('role')).toBeNull()
  })

  it('never links code inside a fenced block, even when its text resolved', () => {
    renderBubble('```\ndata/omp.csv\n```')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('data/omp.csv').closest('pre')).not.toBeNull()
  })

  it('never links a code element inside pre, even when its text matches exactly', () => {
    // Markdown gives a fenced block's code a trailing newline, so the case above
    // cannot tell whether the pre guard works; this renders the pair directly.
    const Pre = chatMarkdownComponents.pre as React.ComponentType<React.ComponentProps<'pre'>>
    const Code = chatMarkdownComponents.code as React.ComponentType<React.ComponentProps<'code'>>
    render(
      <FileRefContext.Provider value={scope}>
        <Pre>
          <Code>data/omp.csv</Code>
        </Pre>
        <p>
          <Code>data/omp.csv</Code>
        </p>
      </FileRefContext.Provider>
    )
    expect(screen.getAllByRole('button', { name: 'Preview data/omp.csv' })).toHaveLength(1)
    expect(screen.getAllByText('data/omp.csv')[0].getAttribute('role')).toBeNull()
  })

  it('links nothing without a scope', () => {
    renderBubble('Wrote `data/omp.csv`.', { value: null })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('data/omp.csv').tagName).toBe('CODE')
  })

  it('links nothing while the bubble is streaming', () => {
    renderBubble('Wrote `data/omp.csv`.', { isStreaming: true })
    expect(screen.queryByRole('button', { name: /data\/omp\.csv/ })).toBeNull()
  })

  it('links user bubbles too', () => {
    renderBubble('Open `data/omp.csv` please', { role: 'user' })
    expect(screen.getByRole('button', { name: 'Preview data/omp.csv' })).toBeTruthy()
  })

  it('a click opens the preview from the click point', () => {
    renderBubble('Wrote `data/omp.csv`.')
    fireEvent.click(screen.getByRole('button', { name: 'Preview data/omp.csv' }), {
      detail: 1,
      clientX: 40,
      clientY: 50
    })
    expect(openAgentFile).toHaveBeenCalledWith('folder:a', csv, { x: 40, y: 50 })
  })

  it('the second click of a double-click opens nothing more', () => {
    renderBubble('Wrote `data/omp.csv`.')
    const link = screen.getByRole('button', { name: 'Preview data/omp.csv' })
    fireEvent.click(link, { detail: 1, clientX: 40, clientY: 50 })
    fireEvent.click(link, { detail: 2, clientX: 40, clientY: 50 })
    fireEvent.click(link, { detail: 3, clientX: 40, clientY: 50 })
    expect(openAgentFile).toHaveBeenCalledTimes(1)
  })

  it('Enter and Space open it from the centre', () => {
    renderBubble('Wrote `data/omp.csv`.')
    const link = screen.getByRole('button', { name: 'Preview data/omp.csv' })
    fireEvent.keyDown(link, { key: 'Enter' })
    fireEvent.keyDown(link, { key: ' ' })
    fireEvent.keyDown(link, { key: 'a' })
    expect(openAgentFile.mock.calls).toEqual([
      ['folder:a', csv, null],
      ['folder:a', csv, null]
    ])
  })

  it('names a folder by what a click does', () => {
    renderBubble('See `pulled`.')
    const link = screen.getByRole('button', { name: 'Show pulled in its folder' })
    // A trailing slash tells a folder from a file of the same name.
    expect(link.getAttribute('title')).toBe('pulled/')
    fireEvent.click(link, { detail: 1 })
    expect(openAgentFile).toHaveBeenCalledWith('folder:a', folder, { x: 0, y: 0 })
  })
})

describe('the link override', () => {
  it('a resolved link opens the preview from the click point and never navigates', () => {
    renderBubble('See [the omp file](data/omp.csv).')
    const link = screen.getByRole('button', { name: 'Preview the omp file' })
    expect(link.tagName).toBe('A')
    expect(link.className).toBe('file-link')
    expect(link.getAttribute('target')).toBeNull()
    expect(link.getAttribute('title')).toBe('data/omp.csv')
    const event = createEvent.click(link, { detail: 1, clientX: 40, clientY: 50 })
    fireEvent(link, event)
    expect(event.defaultPrevented).toBe(true)
    expect(openAgentFile).toHaveBeenCalledWith('folder:a', csvLink, { x: 40, y: 50 })
  })

  it('looks a <…> destination with spaces up by its percent-encoded href', () => {
    renderBubble('[Index CSV](</agent/app data/index file.csv>)')
    const link = screen.getByRole('button', { name: 'Preview Index CSV' })
    expect(link.getAttribute('title')).toBe('app data/index file.csv')
  })

  it('Enter (a click with no detail) and Space open it from the centre, once each', () => {
    renderBubble('See [the omp file](data/omp.csv).')
    const link = screen.getByRole('button', { name: 'Preview the omp file' })
    fireEvent.keyDown(link, { key: 'Enter' })
    fireEvent.click(link, { detail: 0 })
    fireEvent.keyDown(link, { key: ' ' })
    expect(openAgentFile.mock.calls).toEqual([
      ['folder:a', csvLink, null],
      ['folder:a', csvLink, null]
    ])
  })

  it('ignores the second click of a double-click and a click that ends a selection, still without navigating', () => {
    renderBubble('See [the omp file](data/omp.csv).')
    const link = screen.getByRole('button', { name: 'Preview the omp file' })
    const second = createEvent.click(link, { detail: 2 })
    fireEvent(link, second)
    expect(second.defaultPrevented).toBe(true)
    const range = document.createRange()
    range.selectNodeContents(link)
    window.getSelection()!.addRange(range)
    fireEvent.click(link, { detail: 1 })
    window.getSelection()!.removeAllRanges()
    expect(openAgentFile).not.toHaveBeenCalled()
  })

  it('a code span inside a resolved link is plain code: click and Space open the link once each', () => {
    renderBubble('See [`data/omp.csv`](data/omp.csv).')
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].tagName).toBe('A')
    const code = screen.getByText('data/omp.csv')
    expect(code.tagName).toBe('CODE')
    expect(code.className).not.toContain('file-ref')
    expect(code.getAttribute('tabindex')).toBeNull()
    fireEvent.click(code, { detail: 1, clientX: 4, clientY: 5 })
    fireEvent.keyDown(code, { key: ' ' })
    expect(openAgentFile.mock.calls).toEqual([
      ['folder:a', csvLink, { x: 4, y: 5 }],
      ['folder:a', csvLink, null]
    ])
  })

  it('a code span inside an external link is plain code; inside an unresolved link it is still a reference', () => {
    renderBubble('[`data/omp.csv`](https://example.com/x) and [`data/omp.csv`](missing.md)')
    const [external, unresolved] = screen.getAllByText('data/omp.csv')
    expect(external.closest('a')?.getAttribute('target')).toBe('_blank')
    expect(external.getAttribute('role')).toBeNull()
    expect(unresolved.closest('span[title="missing.md"]')).not.toBeNull()
    expect(unresolved.getAttribute('role')).toBe('button')
    fireEvent.click(external, { detail: 1 })
    expect(openAgentFile).not.toHaveBeenCalled()
  })

  it('names a folder link by what a click does', () => {
    renderBubble('See [the pulled folder](pulled/).')
    const link = screen.getByRole('button', { name: 'Show the pulled folder in its folder' })
    expect(link.getAttribute('title')).toBe('pulled/')
  })

  it('renders an unresolved local link as text with its href as a tooltip', () => {
    renderBubble('See [lost](missing.md) and [mail](mailto:a@b.dev).')
    const lost = screen.getByText('lost')
    expect(lost.tagName).toBe('SPAN')
    expect(lost.getAttribute('title')).toBe('missing.md')
    expect(screen.getByText('mail').tagName).toBe('SPAN')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders a local link as text without a scope and while streaming', () => {
    renderBubble('See [the omp file](data/omp.csv).', { value: null })
    expect(screen.getByText('the omp file').tagName).toBe('SPAN')
    renderBubble('See [streamed](data/omp.csv).', { isStreaming: true })
    expect(screen.getByText('streamed').tagName).toBe('SPAN')
  })

  it('keeps http(s) links as external anchors, with or without a scope', () => {
    renderBubble('[docs](https://example.com/data/omp.csv)')
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('href')).toBe('https://example.com/data/omp.csv')
  })

  it('extracts exactly the hrefs react-markdown renders', () => {
    // The lookup key is the href: a scanner that disagrees would leave the
    // link unlinked, so this pins the two together over awkward destinations.
    const md = [
      'A [x](</Users/me/My Files/é.csv>) and [y](docs/a\\(1\\).md) and [z](a&amp;b.md "t").',
      '- item [p](a(b)c.md) [q](%20x.md) [r](src/app.py#L12) [s](a\'b[c].md)',
      '> quoted [t](~/notes/today.md) and [`code`](c.md)',
      '',
      '| col | [u](u.md) |',
      '|-----|----------|',
      '| v | [w](<w w.md>) |',
      '',
      '# Head [h](h.md)',
      'Not `[n](n.md)` and \\[m](m.md) and [e](&#65;&#x42;.md).'
    ].join('\n')
    const rendered: string[] = []
    const Probe = ({ href }: { href?: string }) => {
      rendered.push(href ?? '')
      return null
    }
    render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: Probe }}>
        {md}
      </ReactMarkdown>
    )
    expect(extractLinkDestinations(md)).toEqual(rendered)
    expect(rendered).toHaveLength(13)
  })
})

describe('collectFileRefSources', () => {
  const agents = [
    { id: 'folder:a', capabilities: { cwd: true } },
    { id: 'folder:b', capabilities: { cwd: true } },
    { id: 'remote:r', capabilities: { cwd: false } }
  ]

  it('groups persisted bubble text by the agent each row belongs to, in order', () => {
    const messages = [
      { role: 'user', content: 'check `u.md`', addressedAgentId: null },
      {
        role: 'assistant',
        content: '',
        sourceAgentId: null,
        parts: [
          { kind: 'text', text: 'wrote `x.md`<cinna_attach>/tmp/a.csv</cinna_attach>' },
          { kind: 'tool', text: 'Read `t.md`' },
          { kind: 'thinking', text: '`think.md`' }
        ]
      },
      { role: 'assistant', content: 'from b `b.md`', sourceAgentId: 'folder:b' },
      { role: 'user', content: 'to remote `r.md`', addressedAgentId: 'remote:r' },
      { role: 'tool_call', content: '`tool.md`' },
      { role: 'user', content: 'to b `b2.md`', addressedAgentId: 'folder:b' }
    ]
    const sources = collectFileRefSources(messages, agents, 'folder:a')
    expect([...sources.keys()]).toEqual(['folder:a', 'folder:b'])
    expect(sources.get('folder:a')).toEqual(['check `u.md`', 'wrote `x.md`'])
    expect(sources.get('folder:b')).toEqual(['from b `b.md`', 'to b `b2.md`'])
  })

  it('resolves over the repaired text, so prose after a nested block still yields its paths', () => {
    // Unrepaired, the outer closer opens a block that swallows the prose after it.
    const nested = ['```markdown', '### Step', '```bash', 'uv run x', '```', 'Read-only.', '```', '', 'Then open `data/omp.csv`.'].join('\n')
    const messages = [
      { role: 'user', content: nested.replace('data/omp.csv', 'u.md'), addressedAgentId: null },
      { role: 'assistant', content: '', sourceAgentId: null, parts: [{ kind: 'text', text: nested }] }
    ]
    const markdowns = collectFileRefSources(messages, agents, 'folder:a').get('folder:a') ?? []
    expect(extractFileRefEntries(markdowns).map((entry) => entry.text)).toEqual(['u.md', 'data/omp.csv'])
  })

  it('is empty when no agent runs in a folder', () => {
    expect(collectFileRefSources([{ role: 'user', content: '`u.md`' }], agents.slice(2), 'remote:r').size).toBe(0)
  })
})
