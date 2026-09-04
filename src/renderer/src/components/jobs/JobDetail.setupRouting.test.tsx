import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { JobDependencyStatus } from '../../../../shared/sync'

/**
 * Where the "Finish setup on this device" list sends the user, and when it
 * offers to send them anywhere at all.
 *
 * `JobDependencyStatus.kind` is `'agent'` for three sources that live on three
 * different settings pages, and it is the only thing the row rendered on. That
 * was right while every `'agent'` was a local A2A row: `resolveLocalAgent`
 * auto-creates a disabled shell with `source: 'local'`, and Settings → Agents
 * renders exactly `source === 'local' && protocol === 'a2a'`. A folder agent is
 * `source: 'folder'` and appears there under no circumstances, so the button
 * opened a page that could not contain the row it was about.
 *
 * `localId` is what tells them apart, and it was already on the DTO — a folder
 * agent's row id is `folder:<manifest id>`. It also answers the second
 * question: when nothing resolved there is no row on any page, so there is
 * nothing to open. That is the missing-workshop case, whose repair is copying a
 * directory onto this machine.
 *
 * The state side of this is settled separately, in `folderAgentApply.test.ts`:
 * a **missing** folder agent is `unavailable` (nothing in the app resolves a
 * directory that is not on the machine) and a **disabled** one is
 * `needs-setup`. That removes the dead button for the missing case at the
 * produce site. It does not remove it for the disabled case, which is what the
 * routing here is for — that row has a real id, renders amber, and was being
 * sent to a page it cannot appear on.
 */

const deps = vi.hoisted(() => ({ current: [] as JobDependencyStatus[] }))
const ui = vi.hoisted(() => ({ view: '' as string, menu: '' as string }))

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
  render(createElement(JobDetail))
}

beforeEach(() => {
  deps.current = []
})

describe('the "Set up" button on a pending dependency', () => {
  it('sends a folder agent to Local Agents, not to Agents', () => {
    renderWith([dep({ localId: 'folder:6f1a-uuid' })])
    fireEvent.click(screen.getByRole('button', { name: /set up/i }))
    // The destination first: Settings → Agents filters to
    // `source === 'local' && protocol === 'a2a'`, so routing a folder agent
    // there opens a list it is guaranteed not to be in.
    expect(ui.menu).toBe('local-agents')
    expect(ui.view).toBe('settings')
  })

  it('still sends an auto-created local A2A shell to Agents', () => {
    // The other arm's miss: `resolveLocalAgent` really does create this row, it
    // really is on that page, and the route must not move with the folder one.
    renderWith([dep({ localId: 'nanoid123', label: 'Synced agent' })])
    fireEvent.click(screen.getByRole('button', { name: /set up/i }))
    expect(ui.menu).toBe('agents')
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
