import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The composer's guided-build row, and where its notice panel sits: on the
 * empty screens it is anchored out of the flow at the box's top edge, so it
 * appearing or going moves nothing; in an open chat it stays in the flow.
 */

const agentList = { current: [] as unknown[] }
const chatDetail = { current: null as unknown }

/** A namespace with named methods, every other method a harmless default. */
function namespace(methods: Record<string, unknown>): unknown {
  return new Proxy(methods, {
    get: (target, method: string) =>
      method in target ? target[method] : method.startsWith('on') ? () => () => undefined : async () => []
  })
}

;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (ns === 'agents') {
        return namespace({ list: async () => agentList.current, checkReadiness: async () => null, listCliCommands: async () => [] })
      }
      if (ns === 'chat') return namespace({ get: async () => chatDetail.current })
      if (ns === 'localAgents') return namespace({ list: async () => ({ agents: [], errors: [] }) })
      if (ns === 'engine') return namespace({ defaultRuntime: async () => ({ engine: 'opencode' }) })
      if (ns === 'sessionTelemetry') return namespace({ get: async () => ({ ok: true, telemetry: null }) })
      return namespace({})
    }
  }
)

Element.prototype.scrollIntoView = function scrollIntoView(): void {}

const { ChatInput } = await import('./ChatInput')

function agent(readiness: unknown): Record<string, unknown> {
  return {
    id: 'agent-1', name: 'Invoices', description: null, protocol: 'a2a', cardUrl: 'http://127.0.0.1:9/card',
    endpointUrl: null, protocolInterfaceUrl: null, protocolInterfaceVersion: null, hasAccessToken: false,
    cardData: null, skills: null, enabled: true, source: 'local', remoteTargetType: null, remoteTargetId: null,
    remoteMetadata: null, localPath: null, localRootId: null, driver: 'a2a',
    capabilities: { attachments: 'none', commands: 'card', auth: 'none' },
    readiness, createdAt: new Date('2026-01-01T00:00:00Z')
  }
}

function mount(chatId: string | null, props: Record<string, unknown> = {}, readiness: unknown = null): void {
  agentList.current = [agent(readiness)]
  chatDetail.current = { id: 'chat-1', agentId: 'agent-1', router: 'direct', modeId: null, providerId: null, modelId: null, messages: [] }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], agentList.current)
  client.setQueryData(['chat', 'chat-1'], chatDetail.current)
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => createElement(QueryClientProvider, { client }, children)
  render(createElement(ChatInput, { chatId, ...props }), { wrapper })
}

const UNREACHABLE = { state: 'unreachable', reason: 'Could not reach the agent.' }

beforeEach(() => {
  agentList.current = []
})

describe('the composer’s guided-build row', () => {
  it('is the first row on the new-chat screen, in a panel anchored at the box’s top edge, out of the flow', () => {
    mount(null, { guidedBuildAgentId: 'folder:a' })
    const panel = screen.getByRole('status', { name: 'Guidance' })
    expect(panel.textContent).toContain('New agent — this chat starts with guidance')
    // Mutation: render it in the flow, and the panel appearing or going moves the composer.
    const anchor = panel.parentElement as HTMLElement
    expect(anchor.dataset.testid).toBe('composer-notice-anchor')
    expect(anchor.className.split(' ')).toEqual(expect.arrayContaining(['absolute', 'inset-x-4', 'bottom-full']))
    // The panel keeps its own width and its tuck behind the box's top edge.
    expect(panel.className.split(' ')).toEqual(expect.arrayContaining(['mx-3', '-mb-3', 'pb-3']))
    // The anchor comes before the input card, which paints over the tuck.
    const card = screen.getByRole('combobox').parentElement as HTMLElement
    expect(card.className).toContain('z-[1]')
    expect(anchor.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('anchors a readiness-only panel on the new-chat screen too, and reports how far it reaches up', async () => {
    const reach = vi.fn()
    mount(null, { selectedAgent: agent(UNREACHABLE), pendingAgentIds: ['agent-1'], routerInfo: { router: 'direct', agentName: 'Invoices', answererName: 'Invoices' }, onNoticePanelHeight: reach }, UNREACHABLE)
    const panel = await screen.findByRole('status', { name: 'Agent status' })
    expect((panel.parentElement as HTMLElement).dataset.testid).toBe('composer-notice-anchor')
    // Reported from the anchor (0 here: jsdom has no layout), and 0 first while there was no panel.
    expect(reach).toHaveBeenCalledWith(0)
  })

  it('is never shown in an open chat, whose panel stays in the flow', async () => {
    mount('chat-1', { guidedBuildAgentId: 'folder:a' }, UNREACHABLE)
    const panel = await screen.findByRole('status', { name: 'Agent status' })
    await waitFor(() => expect(screen.getByText('Could not reach the agent.')).toBeTruthy())
    expect(panel.textContent).not.toContain('guidance')
    expect(screen.queryByTestId('composer-notice-anchor')).toBeNull()
  })
})
