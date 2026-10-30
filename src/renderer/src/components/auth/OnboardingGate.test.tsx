import { act, render, screen } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectIntent } from '../../../../shared/connectIntent'

/**
 * The install handoff's first-run clipboard check, as the gate runs it. What is
 * asserted is the no-jump rule (ux_rules.md rule 1): the check either answers
 * before the first screen paints, or its answer is dropped — never a welcome
 * step that turns into a confirm step under the user's pointer.
 */
let providers: { id: string }[] = []
let forced = false
let dismissed = false

vi.mock('../../hooks/useProviders', () => ({
  useProviders: () => ({ data: providers, isLoading: false })
}))

vi.mock('../../constants/onboarding', () => ({
  consumeForceOnboarding: () => forced,
  isOnboardingDismissed: () => dismissed,
  markOnboardingDismissed: () => undefined
}))

// The real screen starts on `cinna-confirm` exactly when an intent is set at
// mount; the stub keeps that property and nothing else.
vi.mock('./OnboardingScreen', () => ({
  OnboardingScreen: ({ connectIntent }: { connectIntent: ConnectIntent | null }) => {
    const [initial] = useState(connectIntent)
    return <div>{initial ? `confirm ${initial.serverUrl}` : 'welcome'}</div>
  }
}))

const INTENT: ConnectIntent = { serverUrl: 'https://cinna.example.com', receivedAt: 7 } as ConnectIntent

const checkClipboard = vi.fn<() => Promise<ConnectIntent | null>>()
const consume = vi.fn(async () => ({ success: true as const }))

;(window as unknown as { api: Record<string, unknown> }).api = {
  connect: {
    checkClipboard,
    consume,
    getPending: async () => null,
    onIntent: () => () => undefined
  },
  logger: { log: vi.fn() }
}

const { OnboardingGate, CLIPBOARD_WAIT_MS } = await import('./OnboardingGate')
const { useConnectIntentStore } = await import('../../stores/connectIntent.store')

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const renderGate = (): void => {
  render(
    <OnboardingGate>
      <div>the app</div>
    </OnboardingGate>
  )
}

/** Let resolved promises run their callbacks. */
const flush = (): Promise<void> => act(async () => {})

beforeEach(() => {
  providers = []
  forced = false
  dismissed = false
  checkClipboard.mockReset()
  consume.mockClear()
  useConnectIntentStore.setState({ intent: null, subscribed: false })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OnboardingGate clipboard check', () => {
  it('opens on the confirm step when the clipboard check returns an intent', async () => {
    checkClipboard.mockResolvedValue(INTENT)
    renderGate()
    await flush()
    expect(screen.getByText('confirm https://cinna.example.com')).toBeTruthy()
    expect(checkClipboard).toHaveBeenCalledTimes(1)
  })

  it('asks once and still settles under StrictMode', async () => {
    checkClipboard.mockResolvedValue(INTENT)
    render(
      <StrictMode>
        <OnboardingGate>
          <div>the app</div>
        </OnboardingGate>
      </StrictMode>
    )
    await flush()
    expect(checkClipboard).toHaveBeenCalledTimes(1)
    expect(screen.getByText('confirm https://cinna.example.com')).toBeTruthy()
  })

  it('keeps the blank placeholder while the check is in flight', async () => {
    const answer = deferred<ConnectIntent | null>()
    checkClipboard.mockReturnValue(answer.promise)
    renderGate()
    expect(screen.queryByText('welcome')).toBeNull()
    expect(screen.queryByText(/confirm/)).toBeNull()
    answer.resolve(null)
    await flush()
    expect(screen.getByText('welcome')).toBeTruthy()
  })

  it('shows welcome when the clipboard holds no link', async () => {
    checkClipboard.mockResolvedValue(null)
    renderGate()
    await flush()
    expect(screen.getByText('welcome')).toBeTruthy()
    expect(consume).not.toHaveBeenCalled()
  })

  it('shows welcome when the check fails', async () => {
    checkClipboard.mockRejectedValue(new Error('ipc down'))
    renderGate()
    await flush()
    expect(screen.getByText('welcome')).toBeTruthy()
  })

  it('shows welcome after the cap, drops a late answer, and clears it in main', async () => {
    vi.useFakeTimers()
    const answer = deferred<ConnectIntent | null>()
    checkClipboard.mockReturnValue(answer.promise)
    renderGate()
    expect(screen.queryByText('welcome')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(CLIPBOARD_WAIT_MS)
    })
    expect(screen.getByText('welcome')).toBeTruthy()

    answer.resolve(INTENT)
    await flush()
    expect(screen.getByText('welcome')).toBeTruthy()
    expect(useConnectIntentStore.getState().intent).toBeNull()
    expect(consume).toHaveBeenCalledTimes(1)
    expect(consume).toHaveBeenCalledWith(INTENT.receivedAt)
  })

  it('does not clear main on a late answer when a link reached the store meanwhile', async () => {
    vi.useFakeTimers()
    const answer = deferred<ConnectIntent | null>()
    checkClipboard.mockReturnValue(answer.promise)
    renderGate()
    act(() => {
      vi.advanceTimersByTime(CLIPBOARD_WAIT_MS)
    })
    const clicked = { serverUrl: 'https://clicked.example', receivedAt: 9 } as ConnectIntent
    act(() => useConnectIntentStore.setState({ intent: clicked }))
    answer.resolve(INTENT)
    await flush()
    expect(consume).not.toHaveBeenCalled()
    expect(useConnectIntentStore.getState().intent).toEqual(clicked)
  })

  it('does not check on forced onboarding', async () => {
    forced = true
    providers = [{ id: 'p' }]
    renderGate()
    await flush()
    expect(screen.getByText('welcome')).toBeTruthy()
    expect(checkClipboard).not.toHaveBeenCalled()
  })

  it('does not check past first run (providers exist)', async () => {
    providers = [{ id: 'p' }]
    renderGate()
    await flush()
    expect(screen.getByText('the app')).toBeTruthy()
    expect(checkClipboard).not.toHaveBeenCalled()
  })

  it('does not check past first run (onboarding dismissed)', async () => {
    dismissed = true
    renderGate()
    await flush()
    expect(screen.getByText('the app')).toBeTruthy()
    expect(checkClipboard).not.toHaveBeenCalled()
  })

  it('does not check when the store already holds a link', async () => {
    useConnectIntentStore.setState({ intent: INTENT })
    renderGate()
    await flush()
    expect(screen.getByText('confirm https://cinna.example.com')).toBeTruthy()
    expect(checkClipboard).not.toHaveBeenCalled()
  })
})
