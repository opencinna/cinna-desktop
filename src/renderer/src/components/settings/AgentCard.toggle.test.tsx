import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

/**
 * The agent card's on/off switch is a switch to assistive tech, and a failed
 * toggle says why in a status line last in the card — not only in a hover
 * title — and only while the error stands (ux_rules rules 1 and 6).
 */

const api = vi.hoisted(() => ({
  setEnabled: vi.fn(async () => ({ success: false, error: 'The agent is busy.' }))
}))

;(window as unknown as { api: unknown }).api = {
  agents: {
    test: async () => ({ success: true }),
    checkReadiness: async () => null,
    list: async () => [],
    upsert: async () => ({ success: true }),
    delete: async () => ({ success: true }),
    setEnabled: api.setEnabled,
    applyBundleUpdate: async () => ({ success: true }),
    syncRemote: async () => ({ success: true })
  }
}

const { AgentCard } = await import('./AgentCard')

const agent = {
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
  createdAt: new Date('2026-01-01T00:00:00Z')
}

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

describe('AgentCard switch', () => {
  it('is a switch with its state, and a failed toggle shows its reason last in the card', async () => {
    const { container } = render(createElement(AgentCard, { agent: agent as never }), { wrapper })
    const toggle = screen.getByRole('switch', { name: 'Turn off Invoices' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    // Healthy: no status line, nothing reserved.
    expect(screen.queryByRole('status')).toBeNull()

    fireEvent.click(toggle)
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe('The agent is busy.')
    expect(api.setEnabled).toHaveBeenCalledWith('agent-1', false)
    // The ring stays on the switch.
    expect(toggle.className).toContain('ring-[var(--color-danger)]')
    // Last in the card, after the header and its controls.
    const card = container.firstElementChild as HTMLElement
    expect(card.lastElementChild).toBe(status)
    expect(toggle.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
