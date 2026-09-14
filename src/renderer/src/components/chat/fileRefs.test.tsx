import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileRef } from '../../../../shared/agentFiles'

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
const scope: FileRefScope = {
  agentId: 'folder:a',
  refs: new Map([
    [csv.text, csv],
    [folder.text, folder]
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

  it('is empty when no agent runs in a folder', () => {
    expect(collectFileRefSources([{ role: 'user', content: '`u.md`' }], agents.slice(2), 'remote:r').size).toBe(0)
  })
})
