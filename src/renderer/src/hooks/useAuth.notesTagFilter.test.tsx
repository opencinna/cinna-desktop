import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { useUIStore } from '../stores/ui.store'

/** The Notes tag filter names a tag of the old profile's notes: a switch drops it. */

vi.hoisted(() => {
  window.api = {
    app: { setTheme: async () => {} },
    auth: { logout: async () => ({ success: true }), getCurrent: async () => null }
  } as never
})

const { useLogout } = await import('./useAuth')

it('clears the Notes tag filter when the profile changes', async () => {
  useUIStore.setState({ notesTagFilter: 'inbox' })
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useLogout(), { wrapper })
  await act(async () => {
    await result.current.mutateAsync()
  })
  await waitFor(() => expect(useUIStore.getState().notesTagFilter).toBeNull())
})
