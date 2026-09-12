import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { JobDependencyStatus } from '../../../../shared/sync'

/** Setup links must reach the dependency's controls after A2A moves to the sidebar. */

const deps = vi.hoisted(() => ({ current: [] as JobDependencyStatus[] }))
const ui = vi.hoisted(() => ({ view: '' as string, menu: '' as string, sidebarTab: '', externalAgentId: null as string | null }))

vi.mock('../../hooks/useJobs', () => ({
  useJob: () => ({
    data: {
      id: 'job-1',
      title: 'Nightly check',
      description: null,
      prompt: 'Check the invoices',
      type: 'local',
      modeId: null,
      agentIds: [],
      mcpProviderIds: [],
      recentRuns: []
    },
    isLoading: false
  }),
  useJobRuns: () => ({ data: [] }),
  useExecuteJob: () => ({ mutate: vi.fn(), isPending: false }),
  useJobDependencyStatus: () => ({ data: deps.current })
}))
vi.mock('../../hooks/useCinnaRunPoll', () => ({ useCinnaRunPoll: () => undefined }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useCinna', () => ({ useCinnaAgents: () => ({ data: [] }) }))
vi.mock('../../stores/ui.store', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      activeJobId: 'job-1',
      setAgentPageMode: vi.fn(),
      setActiveExternalAgentId: (id: string | null) => { ui.externalAgentId = id },
      setSidebarTab: (tab: string) => { ui.sidebarTab = tab },
      setActiveView: (v: string) => {
        ui.view = v
      },
      setSettingsMenu: (m: string) => {
        ui.menu = m
      }
    })
}))

const { JobDetail } = await import('./JobDetail')

function dep(over: Partial<JobDependencyStatus> = {}): JobDependencyStatus {
  return {
    key: 'agent:0',
    kind: 'agent',
    label: 'Invoice Checker',
    state: 'needs-setup',
    localId: null,
    ...over
  } as JobDependencyStatus
}

function renderWith(list: JobDependencyStatus[]): void {
  deps.current = list
  ui.view = ''
  ui.menu = ''
  ui.sidebarTab = ''
  ui.externalAgentId = null
  render(createElement(JobDetail))
}

beforeEach(() => {
  deps.current = []
})

describe('the pending-dependency section heading', () => {
  /*
    `getDependencyStatus` goes to real length to keep `unavailable` apart from
    `needs-setup` — a missing workshop cannot be repaired inside the app, a
    disabled shell can. The section then put a single heading over both:
    "Finish setup on this device", above "These dependencies need attention on
    this device before the job can run as configured." For an `unavailable` row
    that is an instruction the user cannot carry out.

    A mixed list is reachable, which is why this cannot be a flat swap:
    `manifest.ts` builds one flat `deps` array carrying agent and MCP
    descriptors together, and the folder-agent arm and the MCP arm assign
    different states, so one job holds both at once.
  */

  it('offers to finish setup when every pending dependency can be finished here', () => {
    renderWith([dep({ localId: 'nanoid123' })])
    expect(screen.getByText('Finish setup on this device')).toBeTruthy()
  })

  it('does not offer to finish setup for a dependency that cannot be finished here', () => {
    renderWith([dep({ state: 'unavailable', label: 'Missing Workshop' })])
    expect(screen.getByText('Not available on this device')).toBeTruthy()
    expect(screen.queryByText('Finish setup on this device')).toBeNull()
    // The instruction, not just the heading: the lead-in carried the same claim.
    expect(document.body.textContent ?? '').not.toMatch(/need attention on this device/)
  })

  it('claims neither one when the list holds both states at once', () => {
    // The case a flat swap gets wrong. Either fixed heading is false about half
    // of this list, so the chrome states nothing and defers to the rows.
    renderWith([
      dep({ key: 'agent:0', state: 'unavailable', label: 'Missing Workshop' }),
      dep({ key: 'mcp:0', kind: 'mcp', state: 'needs-setup', localId: 'm_1', label: 'Weather' })
    ])
    expect(screen.getByText('Dependencies need attention')).toBeTruthy()
    expect(screen.queryByText('Finish setup on this device')).toBeNull()
    expect(screen.queryByText('Not available on this device')).toBeNull()
    // Both rows are still listed and still labelled individually.
    expect(screen.getByText('Missing Workshop')).toBeTruthy()
    expect(screen.getByText('Weather')).toBeTruthy()
    expect(screen.getByText('unavailable')).toBeTruthy()
    expect(screen.getByText('needs setup')).toBeTruthy()
  })
})

describe('the "Set up" button on a pending dependency', () => {
  it('sends a folder agent to its runtime settings', () => {
    renderWith([dep({ localId: 'folder:6f1a-uuid' })])
    fireEvent.click(screen.getByRole('button', { name: /set up/i }))
    expect(ui.menu).toBe('local-agents')
    expect(ui.view).toBe('settings')
  })

  it('opens an auto-created A2A shell in the Agents sidebar', () => {
    renderWith([dep({ localId: 'nanoid123', label: 'Synced agent' })])
    fireEvent.click(screen.getByRole('button', { name: /set up/i }))
    expect(ui.view).toBe('external-agent')
    expect(ui.sidebarTab).toBe('agents')
    expect(ui.externalAgentId).toBe('nanoid123')
  })

  it('still sends an MCP provider to the connectors page', () => {
    renderWith([dep({ key: 'mcp:0', kind: 'mcp', localId: 'm_1', label: 'Weather' })])
    fireEvent.click(screen.getByRole('button', { name: /set up/i }))
    expect(ui.menu).toBe('mcp')
  })

  it('offers no button when nothing resolved, because no page can show a missing row', () => {
    // Reachable, and not only through folder agents — worth stating, because a
    // reader who knows the folder arm now yields `unavailable` will assume this
    // guard is dead. Both the MCP arm and the local-agent arm of
    // `getDependencyStatus` call a `find*` that does **not** auto-create, and
    // emit `needs-setup` with `localId: null` when the row is gone. That is the
    // shell the sync apply created and the user later deleted: amber, with
    // nothing on any settings page to open. So the gate fixes a pre-existing
    // dead button for the other two sources as well as this one.
    renderWith([dep({ localId: null })])
    expect(screen.getByText('Invoice Checker')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /set up/i })).toBeNull()
  })

  it('offers no button for an MCP whose auto-created shell was deleted', () => {
    // The same hole through the arm that predates this work. `findMcp` has no
    // auto-create, so a deleted provider comes back `needs-setup` with no id.
    renderWith([dep({ key: 'mcp:0', kind: 'mcp', localId: null, label: 'Weather' })])
    expect(screen.getByText('Weather')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /set up/i })).toBeNull()
  })

  it('offers a button for the resolvable row beside an unresolvable one', () => {
    // Both are listed; only the one with somewhere to go is actionable. This is
    // what stops the gate above from being read as "hide the button whenever a
    // folder agent is involved".
    renderWith([
      dep({ key: 'agent:0', localId: null, label: 'Missing Workshop' }),
      dep({ key: 'agent:1', localId: 'folder:6f1a-uuid', label: 'Disabled Workshop' })
    ])
    expect(screen.getAllByRole('button', { name: /set up/i })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /set up/i }))
    expect(ui.menu).toBe('local-agents')
  })
})
