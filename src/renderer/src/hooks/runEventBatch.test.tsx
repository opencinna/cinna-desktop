import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunWatchMessage } from '../../../shared/runWatch'
import type { RunEvent } from '../../../shared/runEvents'
;(window as unknown as { api: unknown }).api = { app: { setTheme: async () => {} } }
const { useLiveRunWatch } = await import('./useLiveRunWatch')
const { useChatStore } = await import('../stores/chat.store')
const { useAuthStore } = await import('../stores/auth.store')
const { RUN_EVENT_FLUSH_FALLBACK_MS } = await import('./runEventBatch')

/**
 * Streamed run events reach the store once a frame, in one task, so the
 * transcript renders once per frame rather than once per port message — and
 * in arrival order, with whatever must not wait applied after what is queued.
 */

const delta = (text: string): RunEvent => ({ type: 'delta', kind: 'text', text })
let watcher: (message: RunWatchMessage) => void
let frames: FrameRequestCallback[]
let sequence: number
let renders: number

function runFrames(): void {
  const due = frames
  frames = []
  act(() => due.forEach((frame) => frame(0)))
}
/** One port message, in a task of its own. */
function emit(event: RunEvent): void {
  sequence += 1
  act(() => watcher({ type: 'event', runId: 'r', sequence, agentId: null, event }))
}
const text = (): string => useChatStore.getState().streamingBlocks.map((b) => (b.type === 'text' ? b.content : '')).join('')

function Transcript(): null {
  useLiveRunWatch()
  useChatStore((state) => state.streamingBlocks)
  renders += 1
  return null
}

beforeEach(() => {
  frames = []
  sequence = 0
  renders = 0
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  ;(window as unknown as { api: unknown }).api = {
    app: { setTheme: async () => {} },
    run: { watch: vi.fn((_chatId: string, cb: (m: RunWatchMessage) => void) => { watcher = cb; return () => {} }), cancel: vi.fn() },
    chat: { get: vi.fn().mockResolvedValue({ messages: [], activeRunId: 'r' }) },
    agentStatus: { get: vi.fn(), list: vi.fn() },
    agents: { checkReadiness: vi.fn().mockResolvedValue(null) }
  }
  useChatStore.getState().reset()
  useChatStore.getState().setActiveChatId('a')
  useAuthStore.setState({ currentUser: { id: 'u', type: 'local_user' } as never })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function mount(): () => void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><Transcript /></QueryClientProvider>)
  act(() => watcher({ type: 'snapshot', runId: 'r', sequence: 0, active: true, agentId: null, replayAvailable: true,
    baselineMessageIds: [], events: [{ type: 'request-id', requestId: 'req' }] }))
  return () => view.unmount()
}

describe('streamed run events', () => {
  it('render once per frame, however many arrive in it, in arrival order', () => {
    // Mutation: apply each event as it arrives → one render per delta.
    const unmount = mount()
    const before = renders
    for (const chunk of ['one ', 'two ', 'three ', 'four']) emit(delta(chunk))
    expect(text()).toBe('')
    expect(renders).toBe(before)

    runFrames()
    expect(text()).toBe('one two three four')
    expect(renders).toBe(before + 1)
    unmount()
  })

  it('apply what is queued before a turn’s end, and the end at once', () => {
    // Mutation: queue `done` like a delta, or apply it before the queue → still streaming, or text missing when it ends.
    const unmount = mount()
    const seen: string[] = []
    const stop = useChatStore.subscribe((state, prev) => {
      if (state.isStreaming !== prev.isStreaming) seen.push(`streaming=${state.isStreaming} text=${text()}`)
    })
    emit(delta('last '))
    emit({ type: 'tool_use', id: 'tc', name: 'search', input: {} })
    emit(delta('words'))
    emit({ type: 'done' })
    // No frame has run: `done` flushed the queue first, then ended the turn.
    expect(seen).toEqual(['streaming=false text=last words'])
    expect(useChatStore.getState().streamingBlocks.map((b) => b.type)).toEqual(['text', 'tool_call', 'text'])
    stop()
    unmount()
  })

  it('apply an ask at once, after the output that came before it', () => {
    const unmount = mount()
    emit(delta('Need to run a command.'))
    emit({ type: 'needs_input', requestId: 'per_1', resume: 'reply', request: { kind: 'permission' } as never })
    expect(text()).toBe('Need to run a command.')
    expect(useChatStore.getState().inputRequests.map((r) => r.requestId)).toEqual(['per_1'])
    unmount()
  })

  it('still land in a hidden window, where no frame runs', () => {
    vi.useFakeTimers()
    // A hidden window runs no frames: requestAnimationFrame never calls back.
    vi.stubGlobal('requestAnimationFrame', () => 1)
    const unmount = mount()
    emit(delta('while hidden'))
    expect(text()).toBe('')
    act(() => { vi.advanceTimersByTime(RUN_EVENT_FLUSH_FALLBACK_MS) })
    expect(text()).toBe('while hidden')
    unmount()
  })
})

describe('the watcher’s owner', () => {
  it('does not render for a store write it does not read', () => {
    // Mutation: `useChatStore()` with no selector in useRunEventHandler → MainArea renders on every chunk.
    let ownerRenders = 0
    function Owner(): null {
      useLiveRunWatch()
      ownerRenders += 1
      return null
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><Owner /></QueryClientProvider>)
    const before = ownerRenders
    act(() => useChatStore.getState().appendDelta('chunk'))
    act(() => useChatStore.getState().appendDelta(' more'))
    expect(ownerRenders).toBe(before)
    view.unmount()
  })
})
