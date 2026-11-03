import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePickedFolder } from './ComposerReadiness'
import { LOCAL_AGENTS_KEY } from '../../hooks/useLocalAgents'

/**
 * Whether the folder list can answer for the picked agent yet: the guided
 * invitation waits on `pending` instead of painting the ordinary screen first.
 */

const snapshot = (ids: string[]) => ({ roots: [], agents: ids.map((id) => ({ id })), homeAccess: 'ready', homeMissing: false, homePath: '/h' })

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

function setup(list: () => Promise<unknown>, cached?: string[]) {
  ;(window as unknown as { api: unknown }).api = { localAgents: { list: vi.fn(list) } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (cached) client.setQueryData(LOCAL_AGENTS_KEY, snapshot(cached))
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return { client, wrapper }
}

it('is pending for any id while the folder list first loads, then answers', async () => {
  let resolve: (v: unknown) => void = () => {}
  const { wrapper } = setup(() => new Promise((r) => { resolve = r }))
  const { result } = renderHook(() => usePickedFolder('folder:x', true), { wrapper })
  expect(result.current).toEqual({ folder: null, pending: true })
  resolve(snapshot(['folder:x']))
  await waitFor(() => expect(result.current.folder).toEqual({ id: 'folder:x' }))
  expect(result.current.pending).toBe(false)
})

it('while refetching without the agent, is pending only for an id the merged list does not know', async () => {
  const { client, wrapper } = setup(() => new Promise(() => {}), ['folder:a'])
  const unknown = renderHook(() => usePickedFolder('folder:new', false), { wrapper })
  const listed = renderHook(() => usePickedFolder('remote:1', true), { wrapper })
  void client.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
  // Mutation: ignore `listed`, and a remote agent's prompts blink out on every folder rescan.
  await waitFor(() => expect(unknown.result.current.pending).toBe(true))
  expect(listed.result.current.pending).toBe(false)
})

