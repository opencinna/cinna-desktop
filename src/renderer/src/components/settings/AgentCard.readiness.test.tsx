import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * The Settings card of a hand-added A2A agent shows what its driver last said
 * about whether it can take a turn: the status dot takes the state's colour,
 * the reason sits beside Test, and Test re-asks. The healthy card is unchanged
 * — a green dot and no line (ux_rules §2: no banner in the healthy state).
 */

const api = vi.hoisted(() => ({
  test: vi.fn(async () => ({ success: true })),
  checkReadiness: vi.fn(async () => null)
}))

;(window as unknown as { api: unknown }).api = {
  agents: {
    test: api.test,
    checkReadiness: api.checkReadiness,
    list: async () => [],
    upsert: async () => ({ success: true }),
    delete: async () => ({ success: true }),
    setEnabled: async () => ({ success: true }),
    applyBundleUpdate: async () => ({ success: true }),
    syncRemote: async () => ({ success: true })
  }
}

const { AgentCard } = await import('./AgentCard')

function agent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'agent-1',
    name: 'Invoices',
    description: null,
    protocol: 'a2a',
    cardUrl: 'http://127.0.0.1:9/.well-known/agent-card.json',
    endpointUrl: null,
    protocolInterfaceUrl: null,
    protocolInterfaceVersion: null,
    hasAccessToken: false,
    cardData: null,
    skills: null,
    enabled: true,
    source: 'local',
    remoteTargetType: null,
    remoteTargetId: null,
    remoteMetadata: null,
    driver: 'a2a',
    capabilities: { attachments: 'none', commands: 'card', auth: 'none' },
    readiness: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  }
}

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

function mount(data: Record<string, unknown>): HTMLElement {
  const { container } = render(createElement(AgentCard, { agent: data as never }), { wrapper })
  // Expand: the header row is the card's first clickable child.
  fireEvent.click(screen.getByText('Invoices'))
  return container
}

const dot = (container: HTMLElement): string =>
  container.querySelector('svg.fill-current')?.getAttribute('class') ?? ''

beforeEach(() => {
  api.test.mockClear()
  api.checkReadiness.mockClear()
})

describe('AgentCard readiness', () => {
  it('colours the dot and shows the reason for an agent that cannot be reached', () => {
    const container = mount(
      agent({ readiness: { state: 'unreachable', reason: 'Could not reach the agent.' } })
    )
    expect(dot(container)).toContain('--color-danger')
    expect(screen.getByText('Could not reach the agent.')).toBeTruthy()
  })

  it('shows a fixable state as a warning, with a warning glyph', () => {
    const container = mount(
      agent({ readiness: { state: 'credentials_needed', reason: 'The agent rejected its token.' } })
    )
    expect(dot(container)).toContain('--color-warning')
    expect(screen.getByText('The agent rejected its token.')).toBeTruthy()
    expect(container.querySelector('[data-readiness-icon]')?.getAttribute('data-readiness-icon')).toBe(
      'warning'
    )
    expect(container.querySelector('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).toBeTruthy()
  })

  it('keeps the cross for an agent that cannot be reached', () => {
    const container = mount(
      agent({ readiness: { state: 'unreachable', reason: 'Could not reach the agent.' } })
    )
    expect(container.querySelector('[data-readiness-icon]')?.getAttribute('data-readiness-icon')).toBe(
      'danger'
    )
    expect(container.querySelector('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).toBeNull()
  })

  it('shows the raw error as the reason’s tooltip when the driver kept one', () => {
    mount(
      agent({
        readiness: {
          state: 'unreachable',
          reason: 'Could not reach the agent.',
          detail: 'connect ECONNREFUSED 127.0.0.1:9'
        }
      })
    )
    expect(screen.getByText('Could not reach the agent.').getAttribute('title')).toBe(
      'connect ECONNREFUSED 127.0.0.1:9'
    )
  })

  it('reserves Test Connection’s width so Testing... does not slide the reason', () => {
    mount(agent({ readiness: { state: 'unreachable', reason: 'Could not reach the agent.' } }))
    expect(screen.getByText('Test Connection').className).toContain('min-w-[6.5rem]')
  })

  it('leaves a healthy card as it was: green dot, no line', () => {
    const container = mount(agent({ readiness: { state: 'ok', reason: null } }))
    expect(dot(container)).toContain('--color-success')
    expect(screen.queryByText('Could not reach the agent.')).toBeNull()
  })

  it('says nothing about readiness for a switched-off agent', () => {
    const container = mount(
      agent({
        enabled: false,
        readiness: { state: 'unreachable', reason: 'Could not reach the agent.' }
      })
    )
    expect(dot(container)).toContain('--color-text-muted')
    expect(screen.queryByText('Could not reach the agent.')).toBeNull()
  })

  it('keeps the reason, not the raw error, when Test fails on a refused agent', async () => {
    api.test.mockResolvedValueOnce({ success: false, error: 'fetch failed' } as never)
    mount(agent({ readiness: { state: 'unreachable', reason: 'Could not reach the agent.' } }))
    fireEvent.click(screen.getByText('Test Connection'))
    await waitFor(() => expect(api.test).toHaveBeenCalled())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByText('Testing...')).toBeNull()
    expect(screen.queryByText('fetch failed')).toBeNull()
    expect(screen.getByText('Could not reach the agent.')).toBeTruthy()
  })

  it('shows a failed test’s error, as its own tooltip too, when readiness has nothing to say', async () => {
    api.test.mockResolvedValueOnce({ success: false, error: 'fetch failed' } as never)
    mount(agent({ readiness: null }))
    fireEvent.click(screen.getByText('Test Connection'))
    const error = await screen.findByText('fetch failed')
    expect(error.getAttribute('title')).toBe('fetch failed')
  })

  it('says Connected when Test passes, over a reason the re-check has not cleared yet', async () => {
    mount(agent({ readiness: { state: 'unreachable', reason: 'Could not reach the agent.' } }))
    fireEvent.click(screen.getByText('Test Connection'))
    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(screen.queryByText('Could not reach the agent.')).toBeNull()
  })

  it('re-asks readiness when Test is pressed', async () => {
    mount(agent({ readiness: { state: 'unreachable', reason: 'Could not reach the agent.' } }))
    fireEvent.click(screen.getByText('Test Connection'))
    // A mutation runs its function on the next tick, not inside the click.
    await waitFor(() => expect(api.checkReadiness).toHaveBeenCalledWith('agent-1'))
    expect(api.test).toHaveBeenCalledWith('agent-1')
  })
})
