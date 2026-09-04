import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { JobDetailData } from '../../../../shared/jobs'

/**
 * What the job's own screen says about a job this device cannot run.
 *
 * The main process refuses the run (`jobService.executeLocal`); this view is
 * where the user finds out *why* without having to attempt it. Both halves are
 * asserted here, because either alone is a worse product than neither: a
 * disabled button with no explanation is a dead end, and an explanation beside
 * a live button is an invitation to click it.
 *
 * The refusal's own message is the third surface, and it arrives as a thrown
 * `Error` — the only channel that survives `ipcMain.handle` + `contextBridge`,
 * which drop a DomainError's `code`. The last test holds that path open.
 */

const jobState = vi.hoisted(() => ({ current: null as JobDetailData | null }))
const exec = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  error: null as Error | null
}))

vi.mock('../../hooks/useJobs', () => ({
  useJob: () => ({ data: jobState.current, isLoading: false }),
  useJobRuns: () => ({ data: [] }),
  useExecuteJob: () => exec,
  useJobDependencyStatus: () => ({ data: [] })
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
      setActiveView: () => undefined,
      setSettingsMenu: () => undefined
    })
}))

const { JobDetail } = await import('./JobDetail')

function job(over: Partial<JobDetailData> = {}): JobDetailData {
  return {
    id: 'job-1',
    title: 'Nightly check',
    description: null,
    prompt: 'Check the invoices',
    type: 'local',
    modeId: null,
    needsSetup: false,
    incompleteSetup: false,
    agentIds: [],
    mcpProviderIds: [],
    recentRuns: [],
    ...over
  } as unknown as JobDetailData
}

function runButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Run/ }) as HTMLButtonElement
}

beforeEach(() => {
  exec.mutate.mockClear()
  exec.error = null
  jobState.current = job()
})

describe('the job detail view for a job this device cannot run', () => {
  it('says the job is not compatible with this setup', () => {
    jobState.current = job({ incompleteSetup: true })
    render(<JobDetail />)
    expect(screen.getByText('Incomplete setup')).toBeTruthy()
    expect(screen.getByText(/isn't compatible with this setup/)).toBeTruthy()
  })

  it('disables Run, and the disabled control still explains itself', () => {
    // A disabled button gets no mouse events in Chromium, so the tooltip lives
    // on a wrapper — without it the one control the user is asking about is
    // the one that stays silent.
    jobState.current = job({ incompleteSetup: true })
    render(<JobDetail />)
    const btn = runButton()
    expect(btn.disabled).toBe(true)
    expect(btn.parentElement?.getAttribute('title')).toBe(
      "This job can't run on this device — incomplete setup"
    )
    fireEvent.click(btn)
    expect(exec.mutate).not.toHaveBeenCalled()
  })

  it('leaves an ordinary job alone — no panel, and Run works', () => {
    // The half a fix that blocks everything would pass without.
    render(<JobDetail />)
    expect(screen.queryByText('Incomplete setup')).toBeNull()
    const btn = runButton()
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(exec.mutate).toHaveBeenCalledWith({ jobId: 'job-1', navigate: true })
  })

  it('shows the main process refusal verbatim when a run is attempted anyway', () => {
    // The stale-list race: the list said runnable, main disagreed. The thrown
    // message is the entire explanation — the error `code` does not survive the
    // trip — so it has to reach the screen unedited, agent names and all.
    exec.error = new Error(
      "This job isn't compatible with this setup. It needs an agent that isn't " +
        'available on this device: Invoice Checker.'
    )
    render(<JobDetail />)
    expect(screen.getByText(/Invoice Checker/)).toBeTruthy()
  })
})
