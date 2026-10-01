import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * The agent's Addons tab over the real attach modal: attached connectors draw
 * with Settings' own card, attaching from the picker and creating a new
 * connector both link it to this agent, and Detach only removes the link.
 */

const provider = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, transportType: 'streamable-http', url: `https://${id}.example.com/mcp`, enabled: true,
  hasAuth: false, authType: 'oauth', status: 'connected', tools: [], ...extra
})
let providers = [provider('jira', 'Atlassian'), provider('gh', 'GitHub', { status: 'error', error: 'HTTP 401' })]
let attached: string[] = []
const listMcpProviders = vi.fn(async () => [...attached])
const attachMcpProvider = vi.fn(async (_agent: string, id: string) => { attached = [...attached, id]; return { success: true as const } })
const detachMcpProvider = vi.fn(async (_agent: string, id: string) => { attached = attached.filter((a) => a !== id); return { success: true as const } })
const upsert = vi.fn(async (data: { name: string }) => {
  providers = [...providers, provider('new', data.name, { status: 'awaiting-auth' })]
  return { id: 'new', success: true }
})
window.api = {
  localAgents: { listMcpProviders, attachMcpProvider, detachMcpProvider },
  mcp: { list: async () => providers, onStatusChanged: () => () => {}, upsert, agentsUsing: async () => [] }
} as never

const { AgentAddonsTab } = await import('./AgentAddonsTab')

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const agent = { id: 'folder:a', kind: 'kit' } as unknown as LocalAgentDto
  return render(createElement(QueryClientProvider, { client }, createElement(AgentAddonsTab, { agent })))
}

beforeEach(() => {
  providers = [provider('jira', 'Atlassian'), provider('gh', 'GitHub', { status: 'error', error: 'HTTP 401' })]
  attached = []
  vi.clearAllMocks()
})

describe('AgentAddonsTab', () => {
  it('attaches an existing connector from the picker and keeps the picker open', async () => {
    renderTab()
    await screen.findByText('No connectors attached.')
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    const dialog = await screen.findByRole('dialog', { name: 'Attach MCP connector' })
    // Only a problem wears a glyph on a picker card (ux_rules rule 13).
    expect(within(dialog).getByRole('img', { name: 'HTTP 401' })).toBeTruthy()
    expect(within(dialog).queryAllByRole('img')).toHaveLength(1)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach Atlassian' }))
    await within(dialog).findByRole('button', { name: 'Atlassian attached' })
    expect(attachMcpProvider).toHaveBeenCalledWith('folder:a', 'jira')
    // Drawn with Settings' card, which carries the row's Detach.
    await screen.findByRole('button', { name: 'Detach Atlassian from this agent' })
  })

  it('attaches a connector created from the picker, then closes on it', async () => {
    // Mutation: drop `onCreated` from AddCustomMcpForm and the new connector
    // lands in Settings → MCP without ever reaching this agent.
    renderTab()
    await screen.findByText('No connectors attached.')
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    const dialog = await screen.findByRole('dialog', { name: 'Attach MCP connector' })
    fireEvent.click(within(dialog).getByRole('button', { name: /custom mcp/i }))
    fireEvent.change(within(dialog).getByPlaceholderText('e.g., My MCP Server'), { target: { value: 'Jira Cloud' } })
    fireEvent.change(within(dialog).getByPlaceholderText('https://mcp.example.com'), { target: { value: 'https://mcp.atlassian.com/v1/sse' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(attachMcpProvider).toHaveBeenCalledWith('folder:a', 'new'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await screen.findByRole('button', { name: 'Detach Jira Cloud from this agent' })
  })

  it('keeps an open form when the user clicks outside the picker', async () => {
    renderTab()
    await screen.findByText('No connectors attached.')
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    const dialog = await screen.findByRole('dialog', { name: 'Attach MCP connector' })
    fireEvent.click(within(dialog).getByRole('button', { name: /custom mcp/i }))
    fireEvent.change(within(dialog).getByPlaceholderText('e.g., My MCP Server'), { target: { value: 'Half typed' } })
    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect((screen.getByPlaceholderText('e.g., My MCP Server') as HTMLInputElement).value).toBe('Half typed')
    // The header button is the form's way back to the list, never a close.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to connectors' }))
    expect(screen.getByRole('dialog', { name: 'Attach MCP connector' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('e.g., My MCP Server')).toBeNull()
  })

  it('still attaches a connector whose create finishes after the picker closed', async () => {
    // TanStack drops mutate-level callbacks of an unmounted form; the attach
    // has to ride the promise. Mutation: go back to `mutate(…, { onSuccess })`
    // in AddCustomMcpForm and this fails.
    let finish!: () => void
    upsert.mockImplementationOnce(async (data: { name: string }) => {
      await new Promise<void>((resolve) => { finish = resolve })
      providers = [...providers, provider('new', data.name, { status: 'awaiting-auth' })]
      return { id: 'new', success: true }
    })
    const view = renderTab()
    await screen.findByText('No connectors attached.')
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    const dialog = await screen.findByRole('dialog', { name: 'Attach MCP connector' })
    fireEvent.click(within(dialog).getByRole('button', { name: /custom mcp/i }))
    fireEvent.change(within(dialog).getByPlaceholderText('e.g., My MCP Server'), { target: { value: 'Slow' } })
    fireEvent.change(within(dialog).getByPlaceholderText('https://mcp.example.com'), { target: { value: 'https://slow.example.com' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(upsert).toHaveBeenCalled())
    view.unmount()
    finish()
    await waitFor(() => expect(attachMcpProvider).toHaveBeenCalledWith('folder:a', 'new'))
  })

  it('detaches without deleting the connector', async () => {
    attached = ['jira']
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Detach Atlassian from this agent' }))
    await screen.findByText('No connectors attached.')
    expect(detachMcpProvider).toHaveBeenCalledWith('folder:a', 'jira')
    expect(providers.map((p) => p.id)).toContain('jira')
  })
})
