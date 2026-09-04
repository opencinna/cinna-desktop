import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * What happens when a job run is refused.
 *
 * `useExecuteJob` had an `onSuccess` and nothing else. `JobDetail` renders
 * `executeJob.error.message` and so shows something, but `JobItem` calls
 * `mutate()` from the sidebar and had no error path at all — so the one run the
 * main process now refuses was also the one whose refusal disappeared without
 * a trace. A block the user cannot see is not a block.
 *
 * Two effects, and the test insists on both. The refetch is what the user
 * sees: the usual way to get here is a stale job list (the agent's folder was
 * removed after the list was fetched), so re-running the list query is what
 * makes the row acquire its marker and the dead click explain itself. The log
 * is what carries the reason, since the message is the only part of the error
 * that survives `ipcMain.handle` + `contextBridge`.
 */

const execute = vi.hoisted(() => vi.fn())
const logged = vi.hoisted(() => [] as Array<{ message: string; data?: unknown }>)

vi.mock('../stores/logger.store', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message: string, data?: unknown) => logged.push({ message, data })
  })
}))
vi.mock('../stores/ui.store', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ setActiveView: () => undefined })
}))
vi.mock('../stores/chat.store', () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ setActiveChatId: () => undefined })
}))
vi.mock('./useChatStream', () => ({
  useChatStream: () => ({ startLlm: vi.fn(), startAgent: vi.fn() })
}))
vi.mock('./useChatModes', () => ({ useChatModes: () => ({ data: [] }) }))
vi.mock('./useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('./useModels', () => ({ useModels: () => ({ data: [] }) }))
vi.mock('./useAppSettings', () => ({ useAppSettings: () => ({ data: {} }) }))

const { useExecuteJob } = await import('./useJobs')

const REFUSAL =
  "This job can't run on this device. It needs an agent that isn't " +
  'available here: Invoice Checker.'

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  logged.length = 0
  execute.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    jobs: { execute }
  }
})

describe('a job run the main process refuses', () => {
  it('refetches the job list, so the row can show why the click did nothing', async () => {
    execute.mockRejectedValue(new Error(REFUSAL))
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
    })
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    const { result } = renderHook(() => useExecuteJob(), { wrapper: wrapper(client) })
    result.current.mutate({ jobId: 'job-1', navigate: false })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['jobs'] })
  })

  it('records the refusal, message and all, where the user can read it', async () => {
    execute.mockRejectedValue(new Error(REFUSAL))
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
    })

    const { result } = renderHook(() => useExecuteJob(), { wrapper: wrapper(client) })
    result.current.mutate({ jobId: 'job-1', navigate: false })

    await waitFor(() => expect(logged).toHaveLength(1))
    // The agent's name has to be in here. "A dependency is missing" leaves the
    // user with nothing to do next, which is how this failure stayed invisible.
    expect(logged[0].data).toMatchObject({ jobId: 'job-1', error: REFUSAL })
  })

  it('leaves the successful run alone', async () => {
    execute.mockResolvedValue({
      type: 'local',
      chatId: 'chat-1',
      runId: 'run-1',
      prompt: 'Check the invoices',
      agentId: 'folder:6f1a-uuid',
      modeId: null
    })
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
    })

    const { result } = renderHook(() => useExecuteJob(), { wrapper: wrapper(client) })
    result.current.mutate({ jobId: 'job-1', navigate: false })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(logged).toHaveLength(0)
  })
})
