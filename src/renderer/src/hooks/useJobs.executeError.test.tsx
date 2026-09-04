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
 *
 * Which is also why the rejection is injected in its wire form. The log overlay
 * is the *only* surface a refused sidebar run reaches, so what lands in it is
 * read by a person — and `ipcMain.handle` rewrites the message while `_wrap.ts`
 * sets `outbound.name`, so `error.message` arrives as `Error invoking remote
 * method 'job:execute': JobError: …`. This test previously injected the clean
 * sentence and asserted it came back, which is true of any code at all: it
 * could not distinguish a log that carried the explanation from one that
 * carried our channel name first.
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

/*
  `REFUSAL` is the sentence `jobService.executeLocal` writes. What the tests
  inject is the WIRE form below — prefix, class name and all. Keep that split.

  An earlier version of this file injected `REFUSAL` directly and passed. A
  fixture is the one part of a test nobody mutates: a mutation campaign
  perturbs the code under test, never the input that decides what the test is
  *about*. So a wrong fixture survives a rigorous campaign untouched, with
  every mutation firing correctly against a string that never crosses the wire.
  Both tests here were written that way, the same morning, by a process that
  was mutation-checking every assertion it wrote.

  Inject the clean sentence and these tests still pass — while the app shows
  `Error invoking remote method 'job:execute': JobError: …`.
*/
/*
  Same family, one line down: the log assertion below was a bare
  `toMatchObject({error: REFUSAL})`, which would have passed on the wrapped
  string too. The assertion that "proved" the log carried the message was as
  blind as the fixture feeding it. It is an exact match plus explicit absence
  checks now.
*/
const REFUSAL =
  "This job can't run on this device. It needs an agent that isn't " +
  'available here: Invoice Checker.'

/** What `window.api.jobs.execute` actually rejects with, after the wire. */
const WIRE = "Error invoking remote method 'job:execute': JobError: " + REFUSAL

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
    execute.mockRejectedValue(new Error(WIRE))
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
    execute.mockRejectedValue(new Error(WIRE))
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
    })

    const { result } = renderHook(() => useExecuteJob(), { wrapper: wrapper(client) })
    result.current.mutate({ jobId: 'job-1', navigate: false })

    await waitFor(() => expect(logged).toHaveLength(1))
    // The agent's name has to be in here. "A dependency is missing" leaves the
    // user with nothing to do next, which is how this failure stayed invisible.
    // And it has to be the sentence alone — an exact match, because a
    // `toContain` would pass on the wrapped string that started this.
    expect(logged[0].data).toMatchObject({ jobId: 'job-1', error: REFUSAL })
    const logged0 = (logged[0].data as { error: string }).error
    expect(logged0).not.toContain('invoking remote method')
    expect(logged0).not.toContain('JobError')
  })

  it('logs a failure that never crossed IPC unchanged', async () => {
    // The over-correction guard: unwrapping strips the transport, not the
    // message. A rejection raised renderer-side has no prefix to remove, and
    // the log is the only place its text is ever seen.
    execute.mockRejectedValue(new Error('Network request timed out.'))
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
    })

    const { result } = renderHook(() => useExecuteJob(), { wrapper: wrapper(client) })
    result.current.mutate({ jobId: 'job-1', navigate: false })

    await waitFor(() => expect(logged).toHaveLength(1))
    expect(logged[0].data).toMatchObject({ error: 'Network request timed out.' })
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
