import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDetailData } from '../../../../shared/jobs'

/**
 * The job page's Details panel: what the job runs with, as the task page's
 * fact rows. An agent is a link to its own page, the way the task page's
 * Assignee is; a row with nothing to say is left out.
 */

const jobState = vi.hoisted(() => ({ current: null as JobDetailData | null }))
const runsState = vi.hoisted(() => ({ current: [] as Array<{ id: string }> }))
vi.hoisted(() => { (window as unknown as { api: unknown }).api = { app: { setTheme: async () => undefined } } })

vi.mock('../../hooks/useJobs', () => ({
  useJob: () => ({ data: jobState.current, isLoading: false }),
  useJobRuns: () => ({ data: runsState.current }),
  useExecuteJob: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useJobDependencyStatus: () => ({ data: [] }),
  useDeleteJob: () => ({ mutate: vi.fn(), isPending: false })
}))
vi.mock('./JobRunRow', () => ({
  JobRunRow: ({ run }: { run: { id: string } }) => <span data-testid="run-row">{run.id}</span>
}))
vi.mock('../../hooks/useCinnaRunPoll', () => ({ useCinnaRunPoll: () => undefined }))
vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({
    data: [
      { id: 'folder:m1', name: 'Ledger Folder', source: 'folder', enabled: true },
      { id: 'hidden', name: 'Hidden Remote', source: 'remote', enabled: false }
    ]
  })
}))
vi.mock('../../hooks/useChatModes', () => ({
  useChatModes: () => ({ data: [{ id: 'm1', name: 'Careful', colorPreset: 'slate' }] })
}))
vi.mock('../../hooks/useMcp', () => ({
  useMcpProviders: () => ({ data: [{ id: 'p1', name: 'Filesystem' }, { id: 'p2', name: 'Browser' }] })
}))
vi.mock('../../hooks/useCinna', () => ({ useCinnaAgents: () => ({ data: [{ id: 'c1', name: 'Cloud Reviewer' }] }) }))

const { JobDetail } = await import('./JobDetail')
const { useUIStore } = await import('../../stores/ui.store')

function job(over: Partial<JobDetailData> = {}): JobDetailData {
  return {
    id: 'job-1', title: 'Nightly check', description: null, prompt: 'Check the invoices', type: 'local',
    modeId: null, needsSetup: false, incompleteSetup: false, agentIds: [], mcpProviderIds: [], recentRuns: [],
    ...over
  } as unknown as JobDetailData
}

function details(): HTMLElement {
  return screen.getByRole('complementary', { name: 'Details' })
}

beforeEach(() => {
  runsState.current = []
  useUIStore.setState({ activeJobId: 'job-1', activeView: 'job-detail', sidebarTab: 'jobs', activeLocalAgentId: null })
})

describe('the job page’s Details panel', () => {
  it('links an agent to its own page, as the task page’s Assignee does', () => {
    jobState.current = job({ agentIds: ['folder:m1'] })
    render(<JobDetail />)
    fireEvent.click(within(details()).getByRole('button', { name: 'Ledger Folder' }))
    const ui = useUIStore.getState()
    expect(ui.activeView).toBe('local-agent')
    expect(ui.activeLocalAgentId).toBe('folder:m1')
    expect(ui.sidebarTab).toBe('agents')
  })

  it('names an agent with no page as plain text', () => {
    jobState.current = job({ agentIds: ['hidden'] })
    render(<JobDetail />)
    expect(within(details()).getByText('Hidden Remote')).toBeTruthy()
    expect(within(details()).queryByRole('button', { name: 'Hidden Remote' })).toBeNull()
  })

  it('shows the type, the chat mode and the tools, and leaves out what is not set', () => {
    jobState.current = job({ agentIds: ['folder:m1'], modeId: 'm1', mcpProviderIds: ['p1', 'p2'] })
    render(<JobDetail />)
    const panel = details()
    // "This device", not "Local": Routing's badge says "Local" about the agent.
    expect(within(panel).getByText('Type').nextElementSibling?.textContent).toBe('This device')
    expect(panel.textContent).toContain('Careful')
    expect(panel.textContent).toContain('Filesystem, Browser')
    expect(panel.textContent).not.toContain('Priority')
    // The type is in the panel, so the title stands alone.
    expect(screen.getByRole('heading', { level: 1 }).parentElement?.textContent).not.toContain('Local')
  })

  it('shows the Cinna agent and priority for a Cinna Task job, and says when there is no agent', () => {
    jobState.current = job({ type: 'cinna_task', cinnaAgentId: 'c1', cinnaPriority: 'high' } as Partial<JobDetailData>)
    const { unmount } = render(<JobDetail />)
    expect(within(details()).getByText('Type').nextElementSibling?.textContent).toBe('Cinna Task')
    expect(details().textContent).toContain('Cloud Reviewer')
    expect(details().textContent).toContain('High')
    unmount()
    jobState.current = job({ type: 'cinna_task', cinnaAgentId: null } as Partial<JobDetailData>)
    render(<JobDetail />)
    expect(within(details()).getByText('None')).toBeTruthy()
  })

  it('puts the whole description in a tooltip, since it is clamped to two lines', () => {
    const description = 'Checks every invoice against the ledger. '.repeat(10).trim()
    jobState.current = job({ description })
    render(<JobDetail />)
    expect(screen.getByText(description).getAttribute('title')).toBe(description)
  })
})

describe('the job page’s Tasks history', () => {
  function history(): HTMLElement {
    return screen.getByRole('region', { name: 'Tasks history' })
  }

  it('shows ten runs, then more in place, then says all are shown — as the Inbox does', () => {
    runsState.current = Array.from({ length: 23 }, (_, i) => ({ id: `run-${i + 1}` }))
    jobState.current = job()
    render(<JobDetail />)
    expect(within(history()).getAllByTestId('run-row')).toHaveLength(10)
    fireEvent.click(within(history()).getByRole('button', { name: 'Show more tasks' }))
    expect(within(history()).getAllByTestId('run-row')).toHaveLength(20)
    fireEvent.click(within(history()).getByRole('button', { name: 'Show more tasks' }))
    expect(within(history()).getAllByTestId('run-row')).toHaveLength(23)
    expect(within(history()).queryByRole('button', { name: 'Show more tasks' })).toBeNull()
    expect(within(history()).getByText('All 23 shown')).toBeTruthy()
  })

  it('puts a run that starts while the page is open on top, keeping the others in place', () => {
    runsState.current = Array.from({ length: 12 }, (_, i) => ({ id: `run-${12 - i}` }))
    jobState.current = job()
    const { rerender } = render(<JobDetail />)
    runsState.current = [{ id: 'run-13' }, ...runsState.current]
    rerender(<JobDetail />)
    const ids = within(history()).getAllByTestId('run-row').map((r) => r.textContent)
    expect(ids).toHaveLength(10)
    expect(ids.slice(0, 3)).toEqual(['run-13', 'run-12', 'run-11'])
  })

  it('offers no Show more for ten runs or fewer', () => {
    runsState.current = Array.from({ length: 10 }, (_, i) => ({ id: `run-${i + 1}` }))
    jobState.current = job()
    render(<JobDetail />)
    expect(within(history()).getAllByTestId('run-row')).toHaveLength(10)
    expect(within(history()).queryByRole('button', { name: 'Show more tasks' })).toBeNull()
  })

  it('says there are none, flush with its heading as the Inbox’s Recent tasks is', () => {
    jobState.current = job()
    render(<JobDetail />)
    const empty = within(history()).getByText('No tasks yet')
    expect(empty.className).not.toMatch(/\bp[xl]-/)
  })
})
