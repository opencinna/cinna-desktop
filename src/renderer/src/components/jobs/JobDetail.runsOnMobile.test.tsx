import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { JobDetailData } from '../../../../shared/jobs'

/**
 * The job page for a job mobile runs as the Assistant: it says where the job
 * runs instead of a chat mode, never the desktop's default mode, and its Run
 * button is disabled with the reason beside it.
 */

const jobState = vi.hoisted(() => ({ current: null as JobDetailData | null }))
const exec = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, error: null as Error | null }))

const schedulesProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))
vi.mock('./JobSchedules', () => ({
  JobSchedules: (props: Record<string, unknown>) => { schedulesProps.current = props; return <div /> },
  useJobScheduleCount: () => 0
}))
vi.mock('../../hooks/useJobs', () => ({
  useJob: () => ({ data: jobState.current, isLoading: false }),
  useJobRuns: () => ({ data: [] }),
  useExecuteJob: () => exec,
  useJobDependencyStatus: () => ({ data: [] }),
  useDeleteJob: () => ({ mutate: vi.fn(), isPending: false })
}))
vi.mock('../../hooks/useCinnaRunPoll', () => ({ useCinnaRunPoll: () => undefined }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useChatModes', () => ({
  useChatModes: () => ({ data: [{ id: 'm1', name: 'Everyday', isDefault: true, colorPreset: 'slate' }] })
}))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useCinna', () => ({ useCinnaAgents: () => ({ data: [] }) }))
vi.mock('../../stores/ui.store', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ activeJobId: 'job-1', setActiveView: () => undefined, setSettingsMenu: () => undefined })
}))

const { JobDetail } = await import('./JobDetail')

const HINT = 'Runs on mobile as the Assistant. Pick a desktop mode in Edit to run it here.'

function job(over: Partial<JobDetailData> = {}): JobDetailData {
  return {
    id: 'job-1',
    title: 'Morning brief',
    description: null,
    prompt: 'Summarise my day',
    type: 'local',
    modeId: null,
    needsSetup: false,
    incompleteSetup: false,
    runsOnMobile: true,
    agentIds: [],
    mcpProviderIds: [],
    recentRuns: [],
    ...over
  } as unknown as JobDetailData
}

const runButton = (): HTMLButtonElement => screen.getByRole('button', { name: /Run/ }) as HTMLButtonElement

beforeEach(() => {
  exec.mutate.mockClear()
  exec.error = null
  jobState.current = job()
})

describe('the job page for a job mobile runs as the Assistant', () => {
  it('names the Assistant as its mode, not the default mode', () => {
    render(<JobDetail />)
    const details = screen.getByRole('complementary', { name: 'Details' })
    expect(details.textContent).toContain('Assistant (runs on mobile)')
    expect(details.textContent).not.toContain('Everyday')
  })

  it('disables Run and says why, beside it and in its tooltip', () => {
    render(<JobDetail />)
    expect(runButton().disabled).toBe(true)
    expect(runButton().parentElement?.getAttribute('title')).toBe(HINT)
    expect(screen.getByText(HINT)).toBeTruthy()
    // Described by the hint, which is not an alert: only a refused run is announced.
    expect(document.getElementById(runButton().getAttribute('aria-describedby')!)?.textContent).toBe(HINT)
    expect(screen.getByRole('alert').textContent).toBe('')
    fireEvent.click(runButton())
    expect(exec.mutate).not.toHaveBeenCalled()
  })

  it('runs as before once it is an ordinary desktop job', () => {
    jobState.current = job({ runsOnMobile: false })
    render(<JobDetail />)
    expect(runButton().disabled).toBe(false)
    expect(screen.queryByText(HINT)).toBeNull()
    expect(screen.getByRole('complementary', { name: 'Details' }).textContent).not.toContain('Assistant')
  })

  it('hands its Schedules tab that the job runs on mobile', () => {
    render(<JobDetail />)
    fireEvent.click(screen.getByRole('tab', { name: 'Schedules' }))
    expect(schedulesProps.current).toMatchObject({ jobId: 'job-1', runsOnMobile: true })
  })
})
