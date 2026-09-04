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
 * which drop a DomainError's `code`. The last two tests hold that path open.
 *
 * Those two inject the message in the form the wire actually delivers, prefix
 * and class name and all. The earlier version of this test injected an
 * already-clean sentence — the one string this path never produces — so it went
 * on passing while the alert box read `Error invoking remote method
 * 'job:execute': JobError: …` in the running app. A fixture that skips the
 * transport is not a fixture for a transport bug.
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

/** Exactly what `jobService.executeLocal` throws, before the wire touches it. */
const REFUSAL =
  "This job can't run on this device. It needs an agent that isn't " +
  'available here: Invoice Checker.'

function runButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Run/ }) as HTMLButtonElement
}

beforeEach(() => {
  exec.mutate.mockClear()
  exec.error = null
  jobState.current = job()
})

describe('the job detail view for a job this device cannot run', () => {
  it('says the job cannot run here', () => {
    jobState.current = job({ incompleteSetup: true })
    render(<JobDetail />)
    expect(screen.getByText('Incomplete setup')).toBeTruthy()
    expect(screen.getByText(/needs an agent that isn't available on this device/)).toBeTruthy()
  })

  it('does not promise a device where the job will run instead', () => {
    // This assertion replaces one that required the opposite sentence, and the
    // reversal is the point rather than a casualty of it.
    //
    // "It will run on a device where that agent is set up" describes a machine
    // the app has no way to know exists. `rebuildJobManifest` is called on
    // every local edit with no sync guard, so a single-machine user who never
    // enabled sync still gets a manifest — attach a folder agent, move its
    // directory, and this panel appears. The sentence was false for them, and
    // it pointed them at a second computer they do not own.
    jobState.current = job({ incompleteSetup: true })
    const { container } = render(<JobDetail />)
    expect(container.textContent ?? '').not.toMatch(
      /will run on|another device|a device where|other device/i
    )
  })

  it('does not tell the user to copy the agent onto this machine', () => {
    // Local agents are not synced and the matching semantics across machines
    // are undesigned, so a hand-copy instruction promises a workflow that does
    // not exist. It would clear the block today — that is what makes it unsafe
    // to print. The panel is the surface where such a sentence would land.
    jobState.current = job({ incompleteSetup: true })
    const { container } = render(<JobDetail />)
    expect(container.textContent ?? '').not.toMatch(/copy|move it|re-?create|folder|directory/i)
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

  it('shows the main process refusal with no IPC plumbing in front of it', () => {
    // The stale-list race: the list said runnable, main disagreed. The thrown
    // message is the entire explanation — the error `code` does not survive the
    // trip — so it has to reach the screen unedited, agent names and all.
    //
    // `ipcMain.handle` rewrites a rejection's message and `_wrap.ts` sets
    // `outbound.name`, so this is the literal string the renderer receives.
    exec.error = new Error(
      "Error invoking remote method 'job:execute': JobError: " + REFUSAL
    )
    render(<JobDetail />)

    const alert = screen.getByRole('alert')
    // Presence is the weaker half: /Invoice Checker/ matched the wrapped string
    // too, which is how this went unnoticed. The absence assertions are the
    // ones that fail when the unwrap is removed.
    expect(alert.textContent).toBe(REFUSAL)
    expect(alert.textContent ?? '').not.toContain('invoking remote method')
    expect(alert.textContent ?? '').not.toContain('JobError')
  })

  it('leaves a message that never crossed IPC exactly as it is', () => {
    // The over-correction guard. Unwrapping must strip the transport and
    // nothing else — a failure raised renderer-side carries no prefix, and
    // trimming a leading word off it, or swapping in the fallback, would lose
    // the only account of the failure the user gets.
    exec.error = new Error('Chat has no model/provider configured.')
    render(<JobDetail />)
    expect(screen.getByRole('alert').textContent).toBe(
      'Chat has no model/provider configured.'
    )
  })
})
