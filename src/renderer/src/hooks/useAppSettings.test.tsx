import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSetAppSetting } from './useAppSettings'

type Auth = { state: string; authMethod: string | null }

let answers: Array<{ resolve: (auth: Auth) => void }>

beforeEach(() => {
  answers = []
  vi.stubGlobal('window', Object.assign(window, {
    api: {
      settings: { set: vi.fn(async () => ({ success: true })) },
      localTools: {
        claudeAuth: () => new Promise<Auth>((resolve) => answers.push({ resolve }))
      }
    }
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useSetAppSetting and the Claude login answer', () => {
  it('drops a login probe already in flight when the auth mode changes, so its stale answer is never shown', async () => {
    // Mutation: go back to invalidateQueries and the in-flight `logged_out`
    // lands after the switch, is stored as fresh, and the agent page reads
    // "Claude Code is not logged in." in API Token mode.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(
      () => ({
        auth: useQuery({ queryKey: ['claude-auth'], queryFn: () => window.api.localTools.claudeAuth() }),
        set: useSetAppSetting()
      }),
      { wrapper }
    )
    // The pre-switch probe is still running.
    await waitFor(() => expect(answers).toHaveLength(1))

    await act(async () => {
      await result.current.set.mutateAsync({ key: 'claudeAuthMode', value: 'api_key' })
    })
    // The reset asks again; the old probe now answers late.
    await waitFor(() => expect(answers).toHaveLength(2))
    await act(async () => {
      answers[0].resolve({ state: 'logged_out', authMethod: 'none' })
    })
    expect(result.current.auth.data).toBeUndefined()

    await act(async () => {
      answers[1].resolve({ state: 'logged_in', authMethod: 'api_key' })
    })
    await waitFor(() => expect(result.current.auth.data).toEqual({ state: 'logged_in', authMethod: 'api_key' }))
  })
})
