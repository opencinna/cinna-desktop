import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { JobDetailData } from '../../../../shared/jobs'

/**
 * A folder agent is offered in the Jobs agent picker.
 *
 * This replaces the `canBeCounterparty` suite that used to live in
 * `src/shared/localAgents.test.ts`. That function was a temporary exclusion —
 * `agent.source !== 'folder'` — applied identically in this picker and in the
 * composer's `@`-mention picker, because a folder agent had no runner. Phase 6
 * landed the runner, the function is gone, and the claim worth pinning is the
 * opposite one. It is pinned *here* rather than in `shared/` because after the
 * deletion there is no shared function left to test: what remains is a `filter`
 * in each picker, and a picker is the only place the behaviour is observable.
 *
 * The load-bearing case is the third one. Deleting the whole predicate — not
 * just the `canBeCounterparty` half — also makes a folder agent appear, so a
 * test that only asserts "it shows up" cannot tell the intended change from
 * losing the user's own on/off toggle with it.
 */

const agents = vi.hoisted(() => ({ current: [] as unknown[] }))

vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ data: agents.current })
}))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useCinna', () => ({ useCinnaAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useJobs', () => ({
  useUpdateJob: () => ({ mutate: vi.fn() }),
  useSetJobMcps: () => ({ mutate: vi.fn() }),
  useSetJobAgents: () => ({ mutate: vi.fn() })
}))

const { JobEditForm } = await import('./JobEditForm')

function agent(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'agent-1',
    name: 'Agent',
    description: null,
    protocol: 'a2a',
    cardUrl: null,
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
    localPath: null,
    localRootId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  }
}

const folderAgent = agent({
  id: 'folder:alpha',
  name: 'Invoice Checker',
  source: 'folder',
  protocol: 'local-folder',
  localPath: '/w/Local/invoice-checker',
  localRootId: 'r1'
})

const job: JobDetailData = {
  id: 'job-1',
  userId: 'u1',
  type: 'local',
  title: 'Nightly check',
  description: null,
  prompt: 'Check the invoices',
  agentId: null,
  modeId: null,
  cinnaAgentId: null,
  cinnaPriority: null,
  colorPreset: null,
  iconName: null,
  folderId: null,
  position: 0,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  inProgressRunsCount: 0,
  needsSetup: false,
  agentIds: [],
  mcpProviderIds: [],
  recentRuns: []
} as unknown as JobDetailData

function openPicker(list: unknown[]): void {
  agents.current = list
  render(createElement(JobEditForm, { job }))
  fireEvent.click(screen.getByRole('button', { name: /add/i }))
}

describe('Jobs agent picker', () => {
  it('offers a folder agent', () => {
    openPicker([folderAgent])
    expect(screen.getByText('Invoice Checker')).toBeTruthy()
  })

  it('files a folder agent under "Local", beside hand-added local agents', () => {
    // `source === 'remote' ? (remoteTargetType ?? 'agent') : 'local'` — a folder
    // agent falls to the `else`, which is the right home: like a hand-added A2A
    // agent it is a property of this machine, not of the signed-in account.
    openPicker([folderAgent, agent({ id: 'local-1', name: 'Hand Added' })])
    const local = screen.getByText('Local')
    expect(local).toBeTruthy()
    expect(screen.getByText('Invoice Checker')).toBeTruthy()
    expect(screen.getByText('Hand Added')).toBeTruthy()
    expect(screen.queryByText('My Agents')).toBeNull()
  })

  it('still withholds a folder agent the user has switched off', () => {
    // The predicate lost `canBeCounterparty` and kept `a.enabled`. They mean
    // different things: one was a capability gap the whole app had, the other
    // is this user's own choice about this agent, and it survives a rescan.
    openPicker([{ ...folderAgent, enabled: false }])
    expect(screen.queryByText('Invoice Checker')).toBeNull()
    expect(screen.getByText('Nothing to add')).toBeTruthy()
  })

  it('still withholds a disabled agent of every other source', () => {
    openPicker([
      { ...folderAgent, enabled: false },
      agent({ id: 'local-1', name: 'Hand Added', enabled: false }),
      agent({ id: 'remote:agent:1', name: 'Remote One', source: 'remote', enabled: false })
    ])
    expect(screen.queryByText('Invoice Checker')).toBeNull()
    expect(screen.queryByText('Hand Added')).toBeNull()
    expect(screen.queryByText('Remote One')).toBeNull()
  })
})
