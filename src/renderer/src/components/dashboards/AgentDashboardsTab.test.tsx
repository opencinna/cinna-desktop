import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInfo } from '../../../../shared/dashboards'
import type { LocalAgentDto } from '../../../../shared/localAgents'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { AgentDashboardsTab, CloudAgentDashboardsTab } from './AgentDashboardsTab'
import { useAuthStore } from '../../stores/auth.store'
import { useUIStore } from '../../stores/ui.store'

// Main's app settings, as `useCapabilities` reads them (`'on'` only).
const capabilities = vi.hoisted(() => ({ notesEnabled: true, dashboardsEnabled: true, loaded: true }))
vi.mock('../../hooks/useCapabilities', () => ({ useCapabilities: () => capabilities }))

const BASE: ComponentInfo = {
  agentId: 'folder:sales', manifestId: 'sales', agentName: 'Sales Agent', name: 'deals', skill: null, title: 'Deals',
  description: '', view: 'list', size: 'wide', source: { endpoint: 'e' }, maxAge: '15m', refreshCommand: null,
  refresh: { maxAge: '15m', whileOpenEvery: null, afterTurn: false, onAppStart: false, command: null, schedule: null },
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
  // Notes and Dashboards are optional capabilities, off until turned on.
  Object.assign(capabilities, { notesEnabled: true, dashboardsEnabled: true })
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

  it('with Dashboards off, still lists and previews components but offers no Add to dashboard', async () => {
    capabilities.dashboardsEnabled = false
    show()
    expect(await screen.findByRole('button', { name: 'Preview Deals' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add Deals to a dashboard' })).toBeNull()
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

describe('CloudAgentDashboardsTab (D6.8)', () => {
  const CLOUD: ComponentInfo = { ...BASE, agentId: 'remote-row-1', manifestId: '', agentName: 'Cloud Sales', cloud: { remoteAgentId: 'core-1', server: 'cinna.example.com' } }
  const cloudComponents = vi.fn()

  function showCloud() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={client}>
        <CloudAgentDashboardsTab agent={{ id: 'remote-row-1', name: 'Cloud Sales' }} />
      </QueryClientProvider>
    )
  }

  beforeEach(() => {
    useAuthStore.setState({ currentUser: { id: 'alice', type: 'cinna_user', cinnaServerUrl: 'https://cinna.example.com' } as never })
    cloudComponents.mockReset().mockResolvedValue({ ok: true, components: [CLOUD], placements: [] })
    Object.assign(window.api.dashboards, { cloudComponents })
  })

  it('a refused cloud Add gives the cloud sentence with no Retry beside it: Add is the retry', async () => {
    addTile.mockResolvedValueOnce({ ok: false, code: 'unreachable', message: 'fetch failed' })
    showCloud()
    const row = (await screen.findByRole('heading', { name: 'Deals' })).closest('[data-component]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Add Deals to a dashboard' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Deals to a dashboard' })
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Add' })))
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('Can’t reach cinna.example.com.')
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeTruthy()
  })

  it('lists the cloud agent’s components with Preview and Add; Add sends the remote agent’s row id', async () => {
    showCloud()
    expect(screen.getByText('Loading…')).toBeTruthy()
    const row = (await screen.findByRole('heading', { name: 'Deals' })).closest('[data-component]') as HTMLElement
    expect(cloudComponents).toHaveBeenCalledWith('remote-row-1')
    // No local folder path for a component on the server, and no "needs an id".
    expect(row.textContent).not.toContain('dashboards/deals/')
    expect(row.textContent).not.toContain('needs an id')
    expect(within(row).getByRole('button', { name: 'Preview Deals' })).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Add Deals to a dashboard' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Deals to a dashboard' })
    expect(dialog.textContent).toContain('from Cloud Sales in the cloud')
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Add' })))
    await waitFor(() => expect(addTile).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'remote-row-1', component: 'deals', dashboardId: 'd1' })))
  })

  it('unreachable: names the server, and Retry reads again', async () => {
    cloudComponents.mockResolvedValueOnce({ ok: false, code: 'unreachable', message: 'network down' })
    showCloud()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Can’t reach cinna.example.com.')
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })))
    expect(await screen.findByRole('heading', { name: 'Deals' })).toBeTruthy()
    expect(cloudComponents).toHaveBeenCalledTimes(2)
  })

  it('a session that needs a new sign-in links to the Cinna settings', async () => {
    cloudComponents.mockResolvedValue({ ok: false, code: 'reauth_required', message: '401' })
    showCloud()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Sign in to cinna.example.com again.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Open settings' }))
    expect(useUIStore.getState()).toMatchObject({ activeView: 'settings', settingsTab: 'profile-agents' })
  })

  it('a refused Add says why with the cloud sentence and stays open', async () => {
    addTile.mockResolvedValue({ ok: false, code: 'env_unavailable', message: 'env stopped' })
    showCloud()
    fireEvent.click(await screen.findByRole('button', { name: 'Add Deals to a dashboard' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Deals to a dashboard' })
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Add' })))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Cloud Sales’s environment isn’t running.')
    expect(screen.getByRole('dialog', { name: 'Add Deals to a dashboard' })).toBeTruthy()
  })

  it('the 20-cloud-tiles limit shows main’s sentence', async () => {
    addTile.mockResolvedValue({ ok: false, code: 'limit_reached', message: 'Sales overview already has 20 cloud tiles.' })
    showCloud()
    fireEvent.click(await screen.findByRole('button', { name: 'Add Deals to a dashboard' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Deals to a dashboard' })
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Add' })))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Sales overview already has 20 cloud tiles.')
  })

  it('a refused Preview gives the cloud sentence, and Retry where the server did not answer', async () => {
    const preview = vi.fn().mockResolvedValueOnce({ ok: false, code: 'unreachable', message: 'x' }).mockReturnValue(new Promise(() => {}))
    Object.assign(window.api.dashboards, { preview })
    showCloud()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Deals' }))
    const dialog = await screen.findByRole('dialog', { name: 'Preview of Deals' })
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('Can’t reach cinna.example.com.')
    expect(preview).toHaveBeenCalledWith('remote-row-1', 'deals', null, {})
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })))
    expect(preview).toHaveBeenCalledTimes(2)
  })
})

