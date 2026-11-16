import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { createElement, createRef } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { JobDetailData } from '../../../../shared/jobs'
import type { JobEditFormHandle, JobEditFormFlushResult } from './JobEditForm'

/**
 * Editing a job mobile runs as the Assistant. Its stored `modeId` is null, so
 * the Assistant pill starts selected (not Default), choosing Default or a mode
 * is a change, and saving that change asks first: the job becomes a desktop
 * job and mobile stops running it as the Assistant.
 */

const update = vi.hoisted(() => ({ mutate: vi.fn(), mutateAsync: vi.fn() }))

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useChatModes', () => ({
  useChatModes: () => ({
    data: [
      { id: 'm1', name: 'Everyday', isDefault: true, colorPreset: 'slate' },
      { id: 'm2', name: 'Deep work', isDefault: false, colorPreset: 'slate' }
    ]
  })
}))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useCinna', () => ({ useCinnaAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useJobs', () => ({
  useUpdateJob: () => update,
  useSetJobMcps: () => ({ mutate: vi.fn() }),
  useSetJobAgents: () => ({ mutate: vi.fn() })
}))

const { JobEditForm } = await import('./JobEditForm')

function job(): JobDetailData {
  return {
    id: 'job-1',
    title: 'Morning brief',
    description: null,
    prompt: 'Summarise my day',
    type: 'local',
    modeId: null,
    runsOnMobile: true,
    needsSetup: false,
    incompleteSetup: false,
    agentIds: [],
    mcpProviderIds: [],
    recentRuns: []
  } as unknown as JobDetailData
}

const pill = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement
const dialog = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Make this a desktop job' })

function renderForm(): React.RefObject<JobEditFormHandle | null> {
  const ref = createRef<JobEditFormHandle>()
  render(createElement(JobEditForm, { job: job(), ref }))
  return ref
}

beforeEach(() => {
  update.mutate.mockReset()
  update.mutateAsync.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

describe('the mode picker of a job mobile runs as the Assistant', () => {
  it('can be picked again before Save, which drops the held change', async () => {
    const ref = renderForm()
    fireEvent.click(pill('Default'))
    expect(pill('Assistant (runs on mobile)').disabled).toBe(false)
    fireEvent.click(pill('Assistant (runs on mobile)'))
    let result: JobEditFormFlushResult | undefined
    await act(async () => { result = await ref.current!.flush() })
    expect(result).toEqual({ ok: true })
    expect(dialog()).toBeNull()
    expect(update.mutateAsync).not.toHaveBeenCalled()
  })

  it('says what picking another mode does', () => {
    renderForm()
    expect(pill('Assistant (runs on mobile)').getAttribute('title')).toBe(
      'Set on mobile. Picking another mode makes this a desktop job.'
    )
  })

  it('focuses Cancel when the confirm opens, and tells the caller it opened', () => {
    const ref = renderForm()
    fireEvent.click(pill('Deep work'))
    const onConfirmOpen = vi.fn()
    act(() => { void ref.current!.flush({ onConfirmOpen }) })
    expect(onConfirmOpen).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('settles a pending confirm as cancelled when the form unmounts', async () => {
    const ref = createRef<JobEditFormHandle>()
    const { unmount } = render(createElement(JobEditForm, { job: job(), ref }))
    fireEvent.click(pill('Deep work'))
    let pending!: Promise<JobEditFormFlushResult>
    act(() => { pending = ref.current!.flush() })
    unmount()
    await expect(pending).resolves.toEqual({ ok: false, cancelled: true })
    expect(update.mutateAsync).not.toHaveBeenCalled()
  })

  it('saves nothing with no change, and asks nothing', async () => {
    const ref = renderForm()
    let result: JobEditFormFlushResult | undefined
    await act(async () => { result = await ref.current!.flush() })
    expect(result).toEqual({ ok: true })
    expect(dialog()).toBeNull()
    expect(update.mutateAsync).not.toHaveBeenCalled()
  })

  it('does not auto-save a mode change before the confirm', () => {
    vi.useFakeTimers()
    renderForm()
    fireEvent.click(pill('Deep work'))
    act(() => { vi.advanceTimersByTime(2000) })
    expect(update.mutate).not.toHaveBeenCalled()
  })

  it('keeps the form as it was when the confirm is cancelled', async () => {
    const ref = renderForm()
    fireEvent.click(pill('Default'))
    let pending!: Promise<JobEditFormFlushResult>
    act(() => { pending = ref.current!.flush() })
    expect(dialog()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(pending).resolves.toEqual({ ok: false, cancelled: true })
    expect(dialog()).toBeNull()
    expect(update.mutateAsync).not.toHaveBeenCalled()
    // The choice is still held: the next Save asks again.
    act(() => { void ref.current!.flush() })
    expect(dialog()).not.toBeNull()
  })

  it('sends the mode on confirm, even Default, which equals the stored null', async () => {
    const ref = renderForm()
    fireEvent.click(pill('Default'))
    let pending!: Promise<JobEditFormFlushResult>
    act(() => { pending = ref.current!.flush() })
    fireEvent.click(screen.getByRole('button', { name: 'Make desktop job' }))
    await expect(pending).resolves.toEqual({ ok: true })
    expect(update.mutateAsync).toHaveBeenCalledWith({ jobId: 'job-1', patch: { modeId: null } })
    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('keeps the confirm open with the reason when the save fails', async () => {
    update.mutateAsync.mockRejectedValueOnce(
      new Error("Error invoking remote method 'job:update': JobError: Job not found")
    )
    const ref = renderForm()
    fireEvent.click(pill('Deep work'))
    act(() => { void ref.current!.flush() })
    fireEvent.click(screen.getByRole('button', { name: 'Make desktop job' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Job not found'))
    expect(dialog()).not.toBeNull()
    expect(update.mutateAsync).toHaveBeenCalledWith({ jobId: 'job-1', patch: { modeId: 'm2' } })
  })
})
