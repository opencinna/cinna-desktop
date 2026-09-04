import { render, screen, fireEvent } from '@testing-library/react'
import { createElement, createRef } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { JobDetailData } from '../../../../shared/jobs'
import type { JobEditFormHandle } from './JobEditForm'

/**
 * What a failed save tells the user.
 *
 * This one is worth a note because the catch and the screen are in different
 * files. `JobEditForm.flush()` catches the rejection and hands back
 * `{ok: false, error}`; `JobEditPage` renders it with `setError(result.error)`.
 * So the string is *produced* here and *displayed* there — which is exactly the
 * kind of one-level indirection that hides a raw `err.message` from a reader
 * grepping for JSX, and it is why the unwrap belongs at the catch rather than
 * at the render.
 *
 * `job:update` is registered with `ipcHandle` and throws, so the rejection
 * arrives wrapped by `ipcMain.handle` + `_wrap.ts`.
 */

const mutateAsync = vi.hoisted(() => vi.fn())

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useCinna', () => ({ useCinnaAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useJobs', () => ({
  useUpdateJob: () => ({ mutateAsync }),
  useSetJobMcps: () => ({ mutate: vi.fn() }),
  useSetJobAgents: () => ({ mutate: vi.fn() })
}))

const { JobEditForm } = await import('./JobEditForm')

const SENTENCE = 'A job cannot be renamed while a run is in progress.'
const WIRE = "Error invoking remote method 'job:update': JobError: " + SENTENCE

function job(): JobDetailData {
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
    recentRuns: []
  } as unknown as JobDetailData
}

/** Render, make a real edit so `buildPatch()` is non-empty, then flush. */
async function saveAfterEdit(): Promise<{ ok: boolean; error?: string }> {
  const ref = createRef<JobEditFormHandle>()
  render(createElement(JobEditForm, { job: job(), ref }))
  fireEvent.change(screen.getByPlaceholderText('What does this job do?'), {
    target: { value: 'Nightly check v2' }
  })
  return (await ref.current!.flush()) as { ok: boolean; error?: string }
}

beforeEach(() => {
  mutateAsync.mockReset()
})

describe('a job save the main process rejects', () => {
  it('hands the page a message with no IPC plumbing in it', async () => {
    mutateAsync.mockRejectedValue(new Error(WIRE))

    const result = await saveAfterEdit()

    expect(result.ok).toBe(false)
    expect(result.error).toBe(SENTENCE)
    expect(result.error ?? '').not.toContain('invoking remote method')
    expect(result.error ?? '').not.toContain('JobError')
  })

  it('passes through a failure that never crossed IPC unchanged', async () => {
    // The over-correction guard.
    mutateAsync.mockRejectedValue(new Error('The form has unsaved attachments.'))

    const result = await saveAfterEdit()

    expect(result.error).toBe('The form has unsaved attachments.')
  })

  it('reports success when the save goes through', async () => {
    mutateAsync.mockResolvedValue(undefined)

    const result = await saveAfterEdit()

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })
})
