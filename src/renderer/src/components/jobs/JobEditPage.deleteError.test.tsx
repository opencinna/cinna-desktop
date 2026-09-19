import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The edit page's Delete job, when main refuses it. The dialog stays open with
 * the reason in it, as on the job page — it used to close with nothing said,
 * leaving the user to guess whether the job was gone (`ux_rules.md` §6).
 */

const deleteMutate = vi.hoisted(() => vi.fn())
vi.hoisted(() => { (window as unknown as { api: unknown }).api = { app: { setTheme: async () => undefined } } })

vi.mock('../../hooks/useJobs', () => ({
  useJob: () => ({ data: { id: 'job-1', title: 'Nightly check' }, isLoading: false }),
  useDeleteJob: () => ({ mutate: deleteMutate, isPending: false })
}))
vi.mock('./JobEditForm', () => ({ JobEditForm: () => null }))

const { JobEditPage } = await import('./JobEditPage')
const { useUIStore } = await import('../../stores/ui.store')

beforeEach(() => {
  deleteMutate.mockReset()
  useUIStore.setState({ activeJobId: 'job-1', activeView: 'job-edit' })
})

describe('JobEditPage delete', () => {
  it('keeps the dialog open with the reason when the delete fails', () => {
    deleteMutate.mockImplementation((_id: string, opts: { onError: (err: Error) => void }) =>
      opts.onError(new Error("Error invoking remote method 'job:delete': JobError: Job not found"))
    )
    render(<JobEditPage />)
    fireEvent.click(screen.getByTitle('Delete job'))
    const dialog = screen.getByRole('dialog', { name: 'Delete job' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(deleteMutate).toHaveBeenCalledWith('job-1', expect.anything())
    expect(screen.getByRole('dialog', { name: 'Delete job' })).toBeTruthy()
    expect(within(screen.getByRole('dialog', { name: 'Delete job' })).getByRole('alert').textContent).toBe('Job not found')
  })

  it('opens again without the last attempt’s reason', () => {
    deleteMutate.mockImplementation((_id: string, opts: { onError: (err: Error) => void }) =>
      opts.onError(new Error('Job not found'))
    )
    render(<JobEditPage />)
    fireEvent.click(screen.getByTitle('Delete job'))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete job' })).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByTitle('Delete job'))
    expect(within(screen.getByRole('dialog', { name: 'Delete job' })).queryByRole('alert')).toBeNull()
  })
})
