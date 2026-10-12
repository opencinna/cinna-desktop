import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileRef, FileRefEntry, ResolveAgentFileRefsResult } from '../../../shared/agentFiles'

const api = vi.hoisted(() => {
  const resolve = vi.fn()
  Object.assign(window, { api: { agentFiles: { resolve } } })
  return { resolve }
})

import { useAgentFileRefs } from './useAgentFileRefs'

const ref = (text: string): AgentFileRef => ({ text, path: `/agent/${text}`, displayPath: text, kind: 'file', inside: true })

function answer(candidates: string[]): ResolveAgentFileRefsResult {
  return { success: true, refs: candidates.map(ref) }
}

/** Every entry resolves, as a ref of its own source. */
async function echo({ entries }: { entries: FileRefEntry[] }): Promise<ResolveAgentFileRefsResult> {
  return { success: true, refs: entries.map((entry) => ({ ...ref(entry.text), source: entry.source })) }
}
const span = (text: string): FileRefEntry => ({ text, source: 'span' })
const link = (text: string): FileRefEntry => ({ text, source: 'link' })

function setup(initial: Map<string, string[]>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(({ sources }) => useAgentFileRefs(sources), { initialProps: { sources: initial }, wrapper })
}

beforeEach(() => {
  api.resolve.mockReset()
})

describe('useAgentFileRefs', () => {
  it('keeps the old links while a new span is resolving, and swaps when the answer lands', async () => {
    api.resolve.mockImplementationOnce(echo)
    const { result, rerender } = setup(new Map([['folder:a', ['Wrote `a.csv`']]]))
    await waitFor(() => expect(result.current.get('folder:a')?.refs.has('a.csv')).toBe(true))

    let land: (value: ResolveAgentFileRefsResult) => void = () => {}
    api.resolve.mockImplementationOnce(() => new Promise<ResolveAgentFileRefsResult>((resolve) => (land = resolve)))
    rerender({ sources: new Map([['folder:a', ['Wrote `a.csv`', 'Then `b.csv`']]]) })

    await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2))
    expect(api.resolve).toHaveBeenLastCalledWith({ agentId: 'folder:a', entries: [span('a.csv'), span('b.csv')] })
    // The turn added a span: the link that was there stays there.
    expect(result.current.get('folder:a')?.refs.has('a.csv')).toBe(true)
    expect(result.current.get('folder:a')?.refs.has('b.csv')).toBe(false)

    land(answer(['a.csv', 'b.csv']))
    await waitFor(() => expect(result.current.get('folder:a')?.refs.has('b.csv')).toBe(true))
    expect(result.current.get('folder:a')?.refs.has('a.csv')).toBe(true)
  })

  it('keeps the scopes identical while nothing changed', async () => {
    api.resolve.mockImplementation(echo)
    const sources = new Map([['folder:a', ['Wrote `a.csv`']]])
    const { result, rerender } = setup(sources)
    await waitFor(() => expect(result.current.size).toBe(1))
    const first = result.current
    rerender({ sources })
    expect(result.current).toBe(first)
  })

  it('resolves link hrefs beside spans and scopes them apart, re-resolving when a link is added', async () => {
    api.resolve.mockImplementation(echo)
    const { result, rerender } = setup(new Map([['folder:a', ['Wrote `a.csv`, see [A](a.csv) and [B](</x y.md>) [w](https://x.dev)']]]))
    await waitFor(() => expect(result.current.get('folder:a')?.links.size).toBe(2))
    expect(api.resolve).toHaveBeenLastCalledWith({ agentId: 'folder:a', entries: [span('a.csv'), link('a.csv'), link('/x%20y.md')] })
    const scope = result.current.get('folder:a')!
    expect([...scope.refs.keys()]).toEqual(['a.csv'])
    expect([...scope.links.keys()]).toEqual(['a.csv', '/x%20y.md'])
    expect(scope.links.get('a.csv')?.source).toBe('link')

    // Only a link changes: the query key changes too.
    rerender({ sources: new Map([['folder:a', ['Wrote `a.csv`, see [A](a.csv) and [B](</x y.md>)', '[C](c.md)']]]) })
    await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2))
    expect(api.resolve).toHaveBeenLastCalledWith({
      agentId: 'folder:a',
      entries: [span('a.csv'), link('a.csv'), link('/x%20y.md'), link('c.md')]
    })
    await waitFor(() => expect(result.current.get('folder:a')?.links.has('c.md')).toBe(true))
  })

  it('asks about a transcript with links but no spans', async () => {
    api.resolve.mockImplementation(echo)
    const { result } = setup(new Map([['folder:a', ['Only [a link](report.md)']]]))
    await waitFor(() => expect(result.current.get('folder:a')?.links.has('report.md')).toBe(true))
    expect(result.current.get('folder:a')?.refs.size).toBe(0)
  })

  it('sends spans and links interleaved in transcript order, and re-keys when only the order changes', async () => {
    api.resolve.mockImplementation(echo)
    const { rerender } = setup(new Map([['folder:a', ['[A](a.md) then `b/c.md`', '`d.md` and [E](e.md)']]]))
    await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(1))
    expect(api.resolve).toHaveBeenLastCalledWith({ agentId: 'folder:a', entries: [link('a.md'), span('b/c.md'), span('d.md'), link('e.md')] })
    rerender({ sources: new Map([['folder:a', ['`b/c.md` then [A](a.md)', '`d.md` and [E](e.md)']]]) })
    await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2))
    expect(api.resolve).toHaveBeenLastCalledWith({ agentId: 'folder:a', entries: [span('b/c.md'), link('a.md'), span('d.md'), link('e.md')] })
  })

  it('links nothing for an agent whose resolve failed', async () => {
    api.resolve.mockResolvedValue({ success: false, code: 'agent_not_found', error: 'x' })
    const { result } = setup(new Map([['folder:a', ['Wrote `a.csv`']]]))
    await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.size).toBe(0))
  })
})
