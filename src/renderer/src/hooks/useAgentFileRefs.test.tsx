import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileRef, ResolveAgentFileRefsResult } from '../../../shared/agentFiles'

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
    api.resolve.mockImplementationOnce(async ({ candidates }: { candidates: string[] }) => answer(candidates))
    const { result, rerender } = setup(new Map([['folder:a', ['Wrote `a.csv`']]]))
    await waitFor(() => expect(result.current.get('folder:a')?.refs.has('a.csv')).toBe(true))

    let land: (value: ResolveAgentFileRefsResult) => void = () => {}
    api.resolve.mockImplementationOnce(() => new Promise<ResolveAgentFileRefsResult>((resolve) => (land = resolve)))
    rerender({ sources: new Map([['folder:a', ['Wrote `a.csv`', 'Then `b.csv`']]]) })

    await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2))
    expect(api.resolve).toHaveBeenLastCalledWith({ agentId: 'folder:a', candidates: ['a.csv', 'b.csv'] })
    // The turn added a span: the link that was there stays there.
    expect(result.current.get('folder:a')?.refs.has('a.csv')).toBe(true)
    expect(result.current.get('folder:a')?.refs.has('b.csv')).toBe(false)

    land(answer(['a.csv', 'b.csv']))
    await waitFor(() => expect(result.current.get('folder:a')?.refs.has('b.csv')).toBe(true))
    expect(result.current.get('folder:a')?.refs.has('a.csv')).toBe(true)
  })

  it('keeps the scopes identical while nothing changed', async () => {
    api.resolve.mockImplementation(async ({ candidates }: { candidates: string[] }) => answer(candidates))
    const sources = new Map([['folder:a', ['Wrote `a.csv`']]])
    const { result, rerender } = setup(sources)
    await waitFor(() => expect(result.current.size).toBe(1))
    const first = result.current
    rerender({ sources })
    expect(result.current).toBe(first)
  })

  it('links nothing for an agent whose resolve failed', async () => {
    api.resolve.mockResolvedValue({ success: false, code: 'agent_not_found', error: 'x' })
    const { result } = setup(new Map([['folder:a', ['Wrote `a.csv`']]]))
    await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.size).toBe(0))
  })
})
