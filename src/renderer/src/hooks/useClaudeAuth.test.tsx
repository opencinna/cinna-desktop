import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useClaudeAuth, CLAUDE_AUTH_POLL_MS } from './useLocalTools'

/**
 * When the panel's logged-out alarm gets to go away.
 *
 * This is the one query in the app whose answer changes *because the app told
 * the user to go and change it*: the panel says "run `claude` in a terminal",
 * so the user leaves, does it, and comes back. Nothing else re-asks while the
 * agent page stays mounted — the app-wide default is `refetchOnWindowFocus:
 * false` (`App.tsx`), and the Settings Refresh button lives on a screen this
 * hook is not mounted on — so without a trigger the red alarm outlives the
 * login it asked for, on a machine that is now fine.
 *
 * **Why the trigger is an interval and not focus**, which is the whole reason
 * this file drives the real one. `refetchOnWindowFocus` is served by
 * `focusManager`, and `@tanstack/query-core@5.99.0` registers exactly one
 * listener for it — `visibilitychange`. That fires on hide, occlude and
 * minimize; it does **not** fire when another app takes the foreground over a
 * still-visible Electron window, which is the ⌘-Tab-to-Terminal-and-back this
 * exists for. Driven through the built app, the line was unchanged after
 * `blur/focus`, `hide/show` and `minimize/restore`, with `visibilityState`
 * never leaving `"visible"`.
 *
 * That is a trap a test can walk straight into: calling
 * `focusManager.setFocused()` directly makes a `refetchOnWindowFocus` assertion
 * pass while the option is inert in the shipped app — the option pinned, the
 * behaviour not. So the first two tests below drive `visibilitychange` on
 * `window`, the event the library actually subscribes to, and the interval is
 * exercised on its own clock.
 *
 * The client mirrors `App.tsx`'s defaults deliberately: the point is that this
 * query's own options beat them.
 */

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5000, refetchOnWindowFocus: false } }
  })
  return createElement(QueryClientProvider, { client }, children)
}

const claudeAuth = vi.fn()

function answer(state: 'logged_in' | 'logged_out' | 'unknown'): void {
  claudeAuth.mockResolvedValue({
    state,
    authMethod: state === 'logged_in' ? 'claude.ai' : 'none',
    subscriptionType: state === 'logged_in' ? 'max' : null
  })
}

beforeEach(() => {
  claudeAuth.mockReset()
  answer('logged_out')
  ;(window as unknown as { api: { localTools: { claudeAuth: typeof claudeAuth } } }).api = {
    localTools: { claudeAuth }
  }
})

afterEach(() => {
  vi.useRealTimers()
  focusManager.setFocused(undefined)
})

describe('useClaudeAuth — clearing a logged-out alarm', () => {
  it('keeps asking while the answer is logged out, which is the only trigger that reaches ⌘-Tab', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { result } = renderHook(() => useClaudeAuth(), { wrapper })
    await waitFor(() => expect(result.current.data?.state).toBe('logged_out'))
    expect(claudeAuth).toHaveBeenCalledTimes(1)

    // The user goes to a terminal and runs `claude`. No focus event of any kind
    // reaches the renderer; the window never stopped being visible.
    answer('logged_in')
    await vi.advanceTimersByTimeAsync(CLAUDE_AUTH_POLL_MS + 100)

    await waitFor(() => expect(result.current.data?.state).toBe('logged_in'))
  })

  it('stops polling once the answer is one nobody is waiting to change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    answer('logged_in')
    const { result } = renderHook(() => useClaudeAuth(), { wrapper })
    await waitFor(() => expect(result.current.data?.state).toBe('logged_in'))
    expect(claudeAuth).toHaveBeenCalledTimes(1)

    // A healthy machine must not spawn a child process every ten seconds for
    // the life of the page.
    await vi.advanceTimersByTimeAsync(CLAUDE_AUTH_POLL_MS * 4)
    expect(claudeAuth).toHaveBeenCalledTimes(1)
  })

  it('does not poll on an answer of unknown either', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    answer('unknown')
    const { result } = renderHook(() => useClaudeAuth(), { wrapper })
    await waitFor(() => expect(result.current.data?.state).toBe('unknown'))

    await vi.advanceTimersByTimeAsync(CLAUDE_AUTH_POLL_MS * 4)
    expect(claudeAuth).toHaveBeenCalledTimes(1)
  })

  it('also re-asks on the events `visibilitychange` really does cover, ignoring its own freshness window', async () => {
    // Minimize, occlude, switch Space. Driven through the event the library
    // subscribes to rather than through `focusManager.setFocused`, which would
    // pass even if the option were removed from the query.
    const { result } = renderHook(() => useClaudeAuth(), { wrapper })
    await waitFor(() => expect(claudeAuth).toHaveBeenCalledTimes(1))

    answer('logged_in')
    window.dispatchEvent(new Event('visibilitychange'))

    // `'always'` and not `true`: the query was fetched milliseconds ago and is
    // well inside `staleTime`, where plain `true` defers and the user keeps
    // reading an alarm they have already dealt with.
    await waitFor(() => expect(result.current.data?.state).toBe('logged_in'))
    expect(claudeAuth).toHaveBeenCalledTimes(2)
  })
})
