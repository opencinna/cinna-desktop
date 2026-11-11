import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedAgentFile } from '../../../shared/agentFiles'
import { pinnedFilesKey, useIsFilePinned, useMovePinnedFile, useTogglePinnedFile } from './usePinnedFiles'

const pin = (path: string, rank: number, more: Partial<PinnedAgentFile> = {}): PinnedAgentFile => ({
  path, displayPath: path.split('/').pop()!, inside: true, rank, exists: true, ...more
})

const listPins = vi.fn()
const setPin = vi.fn()
const movePin = vi.fn()
let client: QueryClient

beforeEach(() => {
  listPins.mockReset().mockResolvedValue({ success: true, pins: [] })
  setPin.mockReset()
  movePin.mockReset()
  window.api = { agentFiles: { listPins, setPin, movePin } } as never
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

/** A promise the test settles by hand, to look at the list while main is still answering. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('usePinnedFiles', () => {
  it('answers whether a path is pinned once the list has loaded, and reads a failure as no pins', async () => {
    listPins.mockResolvedValue({ success: true, pins: [pin('/a/x.md', 1)] })
    const { result } = renderHook(() => [useIsFilePinned('folder:a', '/a/x.md'), useIsFilePinned('folder:a', '/a/y.md')], { wrapper })
    expect(result.current).toEqual([undefined, undefined])
    await waitFor(() => expect(result.current).toEqual([true, false]))

    listPins.mockResolvedValue({ success: false, code: 'agent_not_found', error: 'gone' })
    const gone = renderHook(() => useIsFilePinned('folder:b', '/b/x.md'), { wrapper })
    await waitFor(() => expect(gone.result.current).toBe(false))
  })

  it('asks nothing for no agent', () => {
    renderHook(() => useIsFilePinned(null, '/a/x.md'), { wrapper })
    expect(listPins).not.toHaveBeenCalled()
  })
})

describe('useTogglePinnedFile', () => {
  it('appends a new pin at once, and invalidates the list once main answers', async () => {
    client.setQueryData(pinnedFilesKey('folder:a'), [pin('/a/x.md', 1)])
    const answer = deferred<unknown>()
    setPin.mockReturnValue(answer.promise)
    const { result } = renderHook(() => useTogglePinnedFile(), { wrapper })
    act(() => result.current.mutate({ agentId: 'folder:a', path: '/a/y.md', displayPath: 'y.md', inside: true, pinned: true }))
    await waitFor(() => expect(client.getQueryData(pinnedFilesKey('folder:a'))).toEqual([pin('/a/x.md', 1), pin('/a/y.md', 2)]))
    expect(client.getQueryState(pinnedFilesKey('folder:a'))?.isInvalidated).toBe(false)
    await act(async () => answer.resolve({ success: true, pinned: true }))
    await waitFor(() => expect(client.getQueryState(pinnedFilesKey('folder:a'))?.isInvalidated).toBe(true))
  })

  it('takes a pinned file out at once, and puts it back when main refuses', async () => {
    client.setQueryData(pinnedFilesKey('folder:a'), [pin('/a/x.md', 1), pin('/a/y.md', 2)])
    const answer = deferred<unknown>()
    setPin.mockReturnValue(answer.promise)
    listPins.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useTogglePinnedFile(), { wrapper })
    act(() => result.current.mutate({ agentId: 'folder:a', path: '/a/x.md', displayPath: 'x.md', inside: true, pinned: false }))
    await waitFor(() => expect(client.getQueryData(pinnedFilesKey('folder:a'))).toEqual([pin('/a/y.md', 2)]))
    await act(async () => answer.resolve({ success: false, code: 'agent_not_found', error: 'gone' }))
    await waitFor(() => expect(client.getQueryData(pinnedFilesKey('folder:a'))).toEqual([pin('/a/x.md', 1), pin('/a/y.md', 2)]))
  })

  it('follows the intent: a pin of a listed file leaves the list as it is and sends pinned: true', async () => {
    client.setQueryData(pinnedFilesKey('folder:a'), [pin('/a/x.md', 1), pin('/a/y.md', 2)])
    const answer = deferred<unknown>()
    setPin.mockReturnValue(answer.promise)
    listPins.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useTogglePinnedFile(), { wrapper })
    act(() => result.current.mutate({ agentId: 'folder:a', path: '/a/x.md', displayPath: 'x.md', inside: true, pinned: true }))
    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/a/x.md', pinned: true }))
    expect(client.getQueryData(pinnedFilesKey('folder:a'))).toEqual([pin('/a/x.md', 1), pin('/a/y.md', 2)])
    await act(async () => answer.resolve({ success: true, pinned: true }))
  })
})

describe('useMovePinnedFile', () => {
  it('reorders at once, and puts the order back when main refuses', async () => {
    client.setQueryData(pinnedFilesKey('folder:a'), [pin('/a/x.md', 1), pin('/a/y.md', 2)])
    const answer = deferred<unknown>()
    movePin.mockReturnValue(answer.promise)
    listPins.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useMovePinnedFile(), { wrapper })
    act(() => result.current.mutate({ agentId: 'folder:a', path: '/a/y.md', rank: 0.5 }))
    await waitFor(() => expect(client.getQueryData<PinnedAgentFile[]>(pinnedFilesKey('folder:a'))?.map((p) => p.path)).toEqual(['/a/y.md', '/a/x.md']))
    await act(async () => answer.resolve({ success: false, code: 'not_found', error: 'That file is not pinned.' }))
    await waitFor(() => expect(client.getQueryData<PinnedAgentFile[]>(pinnedFilesKey('folder:a'))?.map((p) => p.path)).toEqual(['/a/x.md', '/a/y.md']))
  })
})
