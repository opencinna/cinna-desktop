import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectIntent } from '../../../../shared/connectIntent'

/**
 * A `cinna://connect` link pasted into the Server URL field — the install
 * handoff's manual path. The link must never land in the field (it is not a
 * server URL, and Connect would send it to discovery as one); main parses it,
 * and the confirm step takes over. Everything else pastes as it always has.
 */
vi.mock('../../hooks/useAuth', () => ({
  useRegister: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCinnaOAuthAbort: () => ({ mutate: vi.fn() })
}))
vi.mock('../../hooks/useProviders', () => ({
  useTestProviderKey: () => ({ reset: vi.fn(), mutate: vi.fn(), data: undefined }),
  useUpsertProvider: () => ({ mutateAsync: vi.fn() })
}))
vi.mock('../../hooks/useChatModes', () => ({
  useUpsertChatMode: () => ({ mutateAsync: vi.fn() })
}))
vi.mock('./ConnectIntentPanel', () => ({
  ConnectIntentPanel: ({ intent }: { intent: ConnectIntent }) => <div>confirm {intent.serverUrl}</div>
}))

const deliverPasted = vi.fn<(text: string) => Promise<ConnectIntent | null>>()

;(window as unknown as { api: Record<string, unknown> }).api = {
  connect: { deliverPasted, consume: async () => ({ success: true }) }
}

const { OnboardingScreen } = await import('./OnboardingScreen')
const { useConnectIntentStore } = await import('../../stores/connectIntent.store')

/** The gate's wiring, without the gate: the screen reads the store's intent. */
function Harness(): React.JSX.Element {
  const intent = useConnectIntentStore((s) => s.intent)
  return <OnboardingScreen connectIntent={intent} onComplete={vi.fn()} />
}

const LINK = 'cinna://connect?server=https://cinna.example.com'

function openServerStep(): HTMLInputElement {
  render(<Harness />)
  fireEvent.click(screen.getByText('Cinna Server'))
  return screen.getByPlaceholderText('https://your-server.com') as HTMLInputElement
}

const paste = (input: HTMLInputElement, text: string): boolean =>
  fireEvent.paste(input, { clipboardData: { getData: () => text } })

beforeEach(() => {
  deliverPasted.mockReset()
  useConnectIntentStore.setState({ intent: null, subscribed: true })
  localStorage.clear()
})

describe('OnboardingScreen Server URL paste', () => {
  it('routes a pasted connect link to main and opens the confirm step, without inserting it', async () => {
    deliverPasted.mockResolvedValue({ serverUrl: 'https://cinna.example.com', receivedAt: 5 } as ConnectIntent)
    const input = openServerStep()
    const notPrevented = paste(input, `  ${LINK.replace('cinna', 'CINNA')} `)
    expect(notPrevented).toBe(false)
    expect(deliverPasted).toHaveBeenCalledWith(LINK.replace('cinna', 'CINNA'))
    expect(await screen.findByText('confirm https://cinna.example.com')).toBeTruthy()
  })

  it('lets a plain URL paste normally', () => {
    const input = openServerStep()
    const notPrevented = paste(input, 'https://cinna.example.com')
    expect(notPrevented).toBe(true)
    expect(deliverPasted).not.toHaveBeenCalled()
  })

  it('shows an error and leaves the field alone when main refuses the link', async () => {
    deliverPasted.mockResolvedValue(null)
    const input = openServerStep()
    fireEvent.change(input, { target: { value: 'https://typed.example' } })
    expect(paste(input, 'cinna://connect?server=http://cinna.example.com')).toBe(false)
    await waitFor(() =>
      expect(screen.getByText('That link has no server Cinna can use.')).toBeTruthy()
    )
    expect(input.value).toBe('https://typed.example')
  })
})

/**
 * The page's note says "paste it", and the first screen a new user sees is
 * Welcome, which has no field. A paste anywhere on it counts.
 */
describe('OnboardingScreen Welcome paste', () => {
  it('opens the confirm step for a connect link pasted on Welcome', async () => {
    deliverPasted.mockResolvedValue({ serverUrl: 'https://cinna.example.com', receivedAt: 7 } as ConnectIntent)
    render(<Harness />)
    expect(fireEvent.paste(document.body, { clipboardData: { getData: () => LINK } })).toBe(false)
    expect(deliverPasted).toHaveBeenCalledWith(LINK)
    expect(await screen.findByText('confirm https://cinna.example.com')).toBeTruthy()
  })

  it('takes a refused link to the Server URL step and says why', async () => {
    deliverPasted.mockResolvedValue(null)
    render(<Harness />)
    fireEvent.paste(document.body, { clipboardData: { getData: () => 'cinna://connect?server=http://x.example' } })
    await waitFor(() => expect(screen.getByText('That link has no server Cinna can use.')).toBeTruthy())
    expect(screen.getByPlaceholderText('https://your-server.com')).toBeTruthy()
  })

  it('ignores other text, and stops listening once Welcome is left', () => {
    render(<Harness />)
    expect(fireEvent.paste(document.body, { clipboardData: { getData: () => 'hello' } })).toBe(true)
    fireEvent.click(screen.getByText('Cinna Server'))
    expect(fireEvent.paste(document.body, { clipboardData: { getData: () => LINK } })).toBe(true)
    expect(deliverPasted).not.toHaveBeenCalled()
  })
})
