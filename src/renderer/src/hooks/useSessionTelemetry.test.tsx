import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionTelemetry,
  SessionTelemetryChangedPayload,
  SessionTelemetryGetResult,
  SessionTelemetryMeasureResult
} from '../../../shared/sessionTelemetry'

const listeners: Array<(payload: SessionTelemetryChangedPayload) => void> = []
const get = vi.fn<(chatId: string) => Promise<SessionTelemetryGetResult>>()
const measureContext = vi.fn<(chatId: string) => Promise<SessionTelemetryMeasureResult>>()

;(window as unknown as { api: unknown }).api = {
  sessionTelemetry: {
    get,
    measureContext,
    onChanged: (handler: (payload: SessionTelemetryChangedPayload) => void) => {
      listeners.push(handler)
      return () => listeners.splice(listeners.indexOf(handler), 1)
    }
  }
}

const { useSessionTelemetry } = await import('./useSessionTelemetry')

const telemetry = (model: string): SessionTelemetry => ({ chatId: 'c1', model: { resolved: model } }) as unknown as SessionTelemetry

beforeEach(() => {
  get.mockReset()
  measureContext.mockReset()
  listeners.length = 0
})

describe('useSessionTelemetry', () => {
  it('hands back the query unspread, so a caller reading only its data is not re-rendered by a refetch', async () => {
    get.mockResolvedValue({ ok: true, telemetry: telemetry('opus') })
    measureContext.mockResolvedValue({ ok: true })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
      createElement(QueryClientProvider, { client }, children)
    let renders = 0
    const { result } = renderHook(() => { renders += 1; return useSessionTelemetry('c1') }, { wrapper })
    await waitFor(() => expect(result.current.query.data).toEqual(telemetry('opus')))

    const before = renders
    // The same answer again: `isFetching` flips twice, `data` keeps its reference.
    await act(async () => {
      await client.refetchQueries({ queryKey: ['sessionTelemetry', 'c1'] })
      // TanStack notifies on a later tick.
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(get).toHaveBeenCalledTimes(2)
    // Mutation: spread the query into the result and the refetch re-renders it.
    expect(renders).toBe(before)

    await expect(result.current.measureContext()).resolves.toEqual({ ok: true })
    expect(measureContext).toHaveBeenCalledWith('c1')
  })
})
