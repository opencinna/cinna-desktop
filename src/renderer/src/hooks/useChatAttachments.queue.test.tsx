import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useComposerDraftStore } from '../stores/composerDraft.store'
import { useChatAttachments } from './useChatAttachments'

/** Paths arriving during an upload wait for it; clearing the draft drops them. */

const resolvePaths = vi.fn()
const pending = (path: string) => ({ id: path, filename: path.slice(1), size: 1, mimeType: 'text/plain', source: 'pending' })
let finish: Array<() => void>

beforeEach(() => {
  useComposerDraftStore.setState({ drafts: {} })
  finish = []
  resolvePaths.mockReset().mockImplementation(
    ({ paths }: { paths: string[] }) => new Promise((resolve) => finish.push(() => resolve({ success: true, files: paths.map(pending) })))
  )
  window.api = { files: { resolvePaths } } as never
})

it('uploads paths that arrive mid-upload once it ends, in one batch', async () => {
  const { result } = renderHook(() => useChatAttachments(null, 'local', 'queue-a'))
  act(() => void result.current.pickFromPaths(['/a']))
  act(() => void result.current.pickFromPaths(['/b']))
  act(() => void result.current.pickFromPaths(['/c']))
  expect(resolvePaths).toHaveBeenCalledTimes(1)
  await act(async () => finish.shift()!())
  await waitFor(() => expect(resolvePaths).toHaveBeenLastCalledWith({ paths: ['/b', '/c'] }))
  await act(async () => finish.shift()!())
  expect(result.current.attachments.map((a) => a.id)).toEqual(['/a', '/b', '/c'])
})

it('drops the queue with the draft', async () => {
  const { result } = renderHook(() => useChatAttachments(null, 'local', 'queue-b'))
  act(() => void result.current.pickFromPaths(['/a']))
  act(() => void result.current.pickFromPaths(['/b']))
  act(() => result.current.clear())
  await act(async () => finish.shift()!())
  expect(resolvePaths).toHaveBeenCalledTimes(1)
  expect(result.current.attachments).toEqual([])
})

it('leaves the queue of a draft cleared mid-upload to the upload started after it', async () => {
  const { result } = renderHook(() => useChatAttachments(null, 'local', 'queue-c'))
  act(() => void result.current.pickFromPaths(['/a']))
  act(() => void result.current.pickFromPaths(['/b']))
  act(() => result.current.clear())
  act(() => void result.current.pickFromPaths(['/c']))
  act(() => void result.current.pickFromPaths(['/d']))
  expect(resolvePaths).toHaveBeenCalledTimes(2)
  // The pre-clear upload ends first: it must not take `/d` while `/c` is still uploading.
  await act(async () => {
    finish.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(resolvePaths).toHaveBeenCalledTimes(2)
  await act(async () => finish.shift()!())
  await waitFor(() => expect(resolvePaths).toHaveBeenLastCalledWith({ paths: ['/d'] }))
  await act(async () => finish.shift()!())
  expect(result.current.attachments.map((a) => a.id)).toEqual(['/c', '/d'])
})
