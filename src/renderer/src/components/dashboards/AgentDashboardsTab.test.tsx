import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInfo } from '../../../../shared/dashboards'
import type { LocalAgentDto } from '../../../../shared/localAgents'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { AgentDashboardsTab } from './AgentDashboardsTab'

const BASE: ComponentInfo = {
  agentId: 'folder:sales', manifestId: 'sales', agentName: 'Sales Agent', name: 'deals', skill: null, title: 'Deals',
  description: '', view: 'list', size: 'wide', source: { endpoint: 'e' }, maxAge: '15m', refreshCommand: null,
  params: {}, prompts: [], valid: true, findings: [], missingCredentials: []
}
const BROKEN: ComponentInfo = {
  ...BASE, name: 'broken', title: 'Broken feed', valid: false,
  findings: [{ path: 'dashboards/broken/component.json', code: 'script_missing', field: null, severity: 'error', message: 'api/feed.py does not exist.' }]
}

const addTile = vi.fn()

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AgentDashboardsTab agent={{ id: 'folder:sales', name: 'Sales Agent', manifestId: 'sales' } as LocalAgentDto} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  addTile.mockReset().mockResolvedValue({ ok: true, tile: {} })
  window.api = {
    dashboards: {
      components: async () => [BASE, BROKEN],
      placements: async () => [],
      list: async () => [{ id: 'd1', name: 'Sales overview', sortOrder: 0, tileCount: 0, createdAt: 0, updatedAt: 0 }],
      preview: () => new Promise(() => {}),
      addTile
    },
    localAgents: { openPath: async () => ({ ok: true }) }
  } as never
})

describe('AgentDashboardsTab', () => {
  it('offers Preview and Add only for a component that can run, like its chat card', async () => {
    show()
    const broken = (await screen.findByRole('heading', { name: 'Broken feed' })).closest('[data-component]') as HTMLElement
    expect(within(broken).queryByRole('button', { name: 'Preview Broken feed' })).toBeNull()
    expect(within(broken).queryByRole('button', { name: 'Add Broken feed to a dashboard' })).toBeNull()
    expect(within(broken).getByRole('list', { name: 'Problems with Broken feed' })).toBeTruthy()
    // No chat to fill on the agent's Settings tab: no Ask to fix.
    expect(within(broken).queryByRole('button', { name: 'Ask to fix' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Preview Deals' })).toBeTruthy()
  })

  it('Add to dashboard opens with focus on the title, so Enter adds rather than cancels', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Add Deals to a dashboard' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Deals to a dashboard' })
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText('Title')))
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => fireEvent.submit(document.activeElement!.closest('form')!))
    await waitFor(() => expect(addTile).toHaveBeenCalled())
  })
})
