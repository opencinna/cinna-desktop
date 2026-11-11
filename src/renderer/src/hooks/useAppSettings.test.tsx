import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppSettingsWatch, useSetAppSetting } from './useAppSettings'
import { useDeleteProvider, useUpsertProvider } from './useProviders'
import { SPEECH_STATUS_QUERY_KEY } from '../components/chat/voice/useSpeechStatus'

type Auth = { state: string; authMethod: string | null }

let answers: Array<{ resolve: (auth: Auth) => void }>
let loginRunning: { claude: string | null; codex: null; antigravity: null }

beforeEach(() => {
  answers = []
  loginRunning = { claude: 'waiting', codex: null, antigravity: null }
  vi.stubGlobal('window', Object.assign(window, {
    api: {
      settings: { set: vi.fn(async () => ({ success: true })) },
      localTools: {
        claudeAuth: () => new Promise<Auth>((resolve) => answers.push({ resolve })),
        engineLoginRunning: vi.fn(async () => ({ ...loginRunning }))
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

  it('re-reads the running login when the auth mode changes, which main cancels on API Token', async () => {
    // Mutation: drop the `engine-login-running` invalidation and the flag keeps
    // its pre-switch `waiting` (staleTime, no poll in this test) after main
    // cancelled the login.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(
      () => ({
        running: useQuery({ queryKey: ['engine-login-running'], queryFn: () => window.api.localTools.engineLoginRunning() }),
        set: useSetAppSetting()
      }),
      { wrapper }
    )
    await waitFor(() => expect(result.current.running.data?.claude).toBe('waiting'))

    // Main cancelled the login while saving the mode.
    loginRunning = { claude: null, codex: null, antigravity: null }
    await act(async () => {
      await result.current.set.mutateAsync({ key: 'claudeAuthMode', value: 'api_key' })
    })
    await waitFor(() => expect(result.current.running.data?.claude).toBeNull())
  })
})

describe('the speech status follows the cloud transcription settings and the providers', () => {
  function harness() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const speechStatus = vi.fn(async () => ({ supported: false }))
    return { client, wrapper, speechStatus }
  }

  it('refetches after the window itself saves a voice cloud setting, and not for an unrelated one', async () => {
    const { wrapper, speechStatus } = harness()
    const { result } = renderHook(
      () => ({ speech: useQuery({ queryKey: SPEECH_STATUS_QUERY_KEY, queryFn: speechStatus }), set: useSetAppSetting() }),
      { wrapper }
    )
    await waitFor(() => expect(speechStatus).toHaveBeenCalledTimes(1))
    await act(async () => { await result.current.set.mutateAsync({ key: 'showHints', value: false }) })
    expect(speechStatus).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.set.mutateAsync({ key: 'voiceCloudTranscription', value: 'always' }) })
    await waitFor(() => expect(speechStatus).toHaveBeenCalledTimes(2))
    await act(async () => { await result.current.set.mutateAsync({ key: 'voiceCloudProviderId', value: 'g2' }) })
    await waitFor(() => expect(speechStatus).toHaveBeenCalledTimes(3))
  })

  it('refetches when main announces a voice cloud setting saved elsewhere', async () => {
    let announce: ((payload: { key: string }) => void) | null = null
    ;(window.api as unknown as { settings: Record<string, unknown> }).settings.onChanged = (handler: (payload: { key: string }) => void) => {
      announce = handler
      return () => { announce = null }
    }
    const { wrapper, speechStatus } = harness()
    renderHook(() => { useAppSettingsWatch(); return useQuery({ queryKey: SPEECH_STATUS_QUERY_KEY, queryFn: speechStatus }) }, { wrapper })
    await waitFor(() => expect(speechStatus).toHaveBeenCalledTimes(1))
    act(() => announce?.({ key: 'voiceCloudTranscription' }))
    await waitFor(() => expect(speechStatus).toHaveBeenCalledTimes(2))
  })

  it('refetches after a provider is saved or deleted', async () => {
    const api = window.api as unknown as { providers: Record<string, unknown> }
    api.providers = { upsert: vi.fn(async () => ({ success: true })), delete: vi.fn(async () => ({ success: true })) }
    const { wrapper, speechStatus } = harness()
    const { result } = renderHook(
      () => ({ speech: useQuery({ queryKey: SPEECH_STATUS_QUERY_KEY, queryFn: speechStatus }), upsert: useUpsertProvider(), remove: useDeleteProvider() }),
      { wrapper }
    )
    await waitFor(() => expect(speechStatus).toHaveBeenCalledTimes(1))
    await act(async () => { await result.current.upsert.mutateAsync({ type: 'gemini', name: 'Gemini', apiKey: 'k' }) })
    await waitFor(() => expect(speechStatus).toHaveBeenCalledTimes(2))
    await act(async () => { await result.current.remove.mutateAsync('g1') })
    await waitFor(() => expect(speechStatus).toHaveBeenCalledTimes(3))
  })
})
