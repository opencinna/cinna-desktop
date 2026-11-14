import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VAULT_MOVE_STEPS, type VaultMoveProgressEvent, type VaultPrecheckDto } from '../../../../../../shared/vault/types'

vi.mock('../../../../hooks/useServiceCredentials', () => ({
  useServiceCredentials: () => ({ data: { items: [{ id: 'cred-1', cloudId: 'c-1', name: 'CRM key' }] } })
}))
vi.mock('../../../../stores/auth.store', () => ({
  useAuthStore: (select: (s: unknown) => unknown) => select({ currentUser: { cinnaServerUrl: 'https://core.example' } })
}))

import { MoveToVaultDialog } from './MoveToVaultDialog'

/**
 * Move to vault…: the pre-check before anything changes, every step listed
 * from the start, the steps' progress and output, a failure that lands in the
 * dialog and closes nothing, and the two steps after a move that worked.
 */

let precheck: VaultPrecheckDto
let progress: ((event: VaultMoveProgressEvent) => void) | null
const vault = {
  precheck: vi.fn(async () => ({ ok: true, data: precheck })),
  hostCopy: vi.fn(async () => ({ ok: true, data: null as unknown })),
  moveIn: vi.fn(async () => ({ ok: true, data: { moveId: 'm1' } })),
  cancelMove: vi.fn(async () => ({ ok: true, data: undefined })),
  deleteHostCopy: vi.fn(async () => ({ ok: true, data: undefined })),
  onMoveProgress: vi.fn((cb: (event: VaultMoveProgressEvent) => void) => {
    progress = cb
    return () => { progress = null }
  }),
  onState: vi.fn(() => () => {})
}

beforeEach(() => {
  precheck = {
    agentId: 'folder:alpha',
    agentName: 'Alpha',
    engine: 'claude',
    folderPath: '/Users/me/agents/alpha',
    copyBytes: 3 * 1024 ** 2,
    copyFiles: 42,
    items: [
      { kind: 'mac-command', severity: 'warning', title: 'Scripts call macOS-only commands', paths: ['scripts/notify.sh'] },
      { kind: 'service-credential', severity: 'info', title: 'Attached credentials are delivered inside' }
    ],
    canMove: true,
    needsApiKey: false,
    apiKeyName: 'ANTHROPIC_API_KEY'
  }
  progress = null
  ;(window as unknown as { api: unknown }).api = { vault }
  vi.clearAllMocks()
})
afterEach(cleanup)

function renderDialog(onClose = vi.fn()): { onClose: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client }, createElement(MoveToVaultDialog, { agentId: 'folder:alpha', agentName: 'Alpha', onClose })))
  return { onClose }
}
const emit = (event: Partial<VaultMoveProgressEvent> & Pick<VaultMoveProgressEvent, 'step' | 'status'>): void =>
  act(() => progress?.({ moveId: 'm1', agentId: 'folder:alpha', ...event }))
const stepStatus = (id: string): string | null =>
  screen.getByRole('list', { name: 'Steps' }).querySelector(`[data-step="${id}"]`)!.getAttribute('data-status')

describe('MoveToVaultDialog', () => {
  it('lists every step from the start and the pre-check findings before Move', async () => {
    renderDialog()
    const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
    // Pre-check, the eight move steps, Delete the original, Rotate credentials.
    expect(steps).toHaveLength(VAULT_MOVE_STEPS.length + 3)
    expect(await screen.findByText('Scripts call macOS-only commands')).toBeTruthy()
    expect(screen.getByText('scripts/notify.sh')).toBeTruthy()
    expect(screen.getByText(/Copies 42 files \(3 MB\)/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('textbox', { name: /API key/ })).toBeNull()
  })

  it('disables Move while a blocker stands', async () => {
    precheck = {
      ...precheck,
      canMove: false,
      items: [{ kind: 'unsupported-engine', severity: 'blocker', title: 'This engine can’t run in a vault yet' }, ...precheck.items]
    }
    renderDialog()
    expect(await screen.findByText('This engine can’t run in a vault yet')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers an API key field when the host signs in by subscription, and checks the size on Move', async () => {
    precheck = { ...precheck, needsApiKey: true }
    renderDialog()
    const key = await screen.findByLabelText('API key for the engine inside the vault')
    fireEvent.change(key, { target: { value: 'sk-ant-test' } })
    fireEvent.change(screen.getByLabelText('Disk size limit in GB'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('alert').textContent).toBe('The limit is at least 1 GB.')
    expect(vault.moveIn).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Disk size limit in GB'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(vault.moveIn).toHaveBeenCalledWith('folder:alpha', { sizeBytes: 20 * 1024 ** 3, apiKey: 'sk-ant-test' }))
  })

  it('hints at the key of the engine that moves in, not Anthropic\'s for every engine', async () => {
    precheck = { ...precheck, engine: 'codex', needsApiKey: true, apiKeyName: 'OPENAI_API_KEY' }
    renderDialog()
    expect((await screen.findByLabelText('API key for the engine inside the vault')).getAttribute('placeholder')).toBe('sk-…')
    cleanup()
    precheck = { ...precheck, engine: 'antigravity', apiKeyName: 'GEMINI_API_KEY' }
    renderDialog()
    expect((await screen.findByLabelText('API key for the engine inside the vault')).getAttribute('placeholder')).toBe('AIza…')
    cleanup()
    precheck = { ...precheck, engine: 'opencode', apiKeyName: null }
    renderDialog()
    expect((await screen.findByLabelText('API key for the engine inside the vault')).getAttribute('placeholder')).toBe('API key')
  })

  it('stays on the pre-check with the reason when the move is refused before it starts', async () => {
    vault.moveIn.mockResolvedValueOnce({ ok: false, code: 'denied', message: 'denied' } as never)
    renderDialog()
    await screen.findByText('Scripts call macOS-only commands')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(await screen.findByText('Cancelled at the prompt — nothing was moved.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move' })).toBeTruthy()
  })

  it('shows each step as it runs, with the rebuild output, and a failure that closes nothing', async () => {
    const { onClose } = renderDialog()
    await screen.findByText('Scripts call macOS-only commands')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(vault.moveIn).toHaveBeenCalled())
    emit({ step: 'create', status: 'done' })
    emit({ step: 'rebuild', status: 'running', message: 'uv sync', output: 'Resolved 12 packages\n' })
    expect(stepStatus('create')).toBe('done')
    expect(stepStatus('rebuild')).toBe('running')
    expect(screen.getByText(/Resolved 12 packages/)).toBeTruthy()
    // The detail pane holds output and failures only; the outline already lists every step.
    expect(document.querySelector('[data-step-log="create"]')).toBeNull()
    expect(document.querySelector('[data-step-log="rebuild"]')).not.toBeNull()
    // Running: undismissable, Cancel asks main to stop.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(vault.cancelMove).toHaveBeenCalledWith('m1'))
    emit({ step: 'rebuild', status: 'failed', message: 'no lockfile', rolledBack: true })
    expect(stepStatus('rebuild')).toBe('failed')
    expect(screen.getByRole('alert').textContent).toBe(
      'Rebuild dependencies failed: no lockfile. The half-built vault was removed; Alpha is untouched on this Mac.'
    )
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('after a move, offers to delete the original by name, then the rotation checklist with Manage', async () => {
    vault.hostCopy.mockResolvedValue({
      ok: true,
      data: { agentId: 'folder:alpha', folderPath: '/Users/me/agents/alpha', inGitRepo: true, gitRemote: 'github.com/me/alpha', underTimeMachine: true }
    })
    renderDialog()
    await screen.findByText('Scripts call macOS-only commands')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(vault.moveIn).toHaveBeenCalled())
    emit({
      step: 'check',
      status: 'done',
      rotation: [
        { kind: 'service-credential', name: 'CRM key', credentialId: 'cred-1' },
        { kind: 'env-key', name: 'STRIPE_KEY', detail: 'in .env' }
      ]
    })
    expect(await screen.findByText(/can’t be brought back from this Mac/)).toBeTruthy()
    expect(screen.getByText(/the git remote github.com\/me\/alpha keeps its history/)).toBeTruthy()
    expect(screen.getByText(/Time Machine backups keep earlier versions/)).toBeTruthy()
    const remove = screen.getByRole('button', { name: 'Delete original' }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Type Alpha to delete it'), { target: { value: 'Alpha' } })
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)
    await waitFor(() => expect(vault.deleteHostCopy).toHaveBeenCalledWith('folder:alpha', 'Alpha'))
    const checklist = await screen.findByRole('list', { name: 'Rotation checklist' })
    expect(within(checklist).getByText('STRIPE_KEY')).toBeTruthy()
    expect(within(checklist).getByRole('button', { name: 'Manage CRM key' })).toBeTruthy()
    expect(within(checklist).queryByRole('button', { name: 'Manage STRIPE_KEY' })).toBeNull()
    // The checklist on screen is the step finished, not one still spinning.
    expect(stepStatus('rotate')).toBe('done')
  })

  it('marks Rotate credentials skipped when there is nothing to rotate', async () => {
    vault.hostCopy.mockResolvedValue({ ok: true, data: null })
    renderDialog()
    await screen.findByText('Scripts call macOS-only commands')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(vault.moveIn).toHaveBeenCalled())
    emit({ step: 'check', status: 'done', rotation: [] })
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    expect(await screen.findByText(/Nothing to rotate/)).toBeTruthy()
    expect(stepStatus('rotate')).toBe('skipped')
  })

  it('says a refused size on the field’s own line, in place of its hint, not in the footer', async () => {
    renderDialog()
    await screen.findByText('Scripts call macOS-only commands')
    const field = screen.getByLabelText('Disk size limit in GB')
    const line = field.closest('label')!
    expect(within(line).getByText('grows as used')).toBeTruthy()
    fireEvent.change(field, { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('The limit is at most 2048 GB.')
    expect(line.contains(alert)).toBe(true)
    expect(within(line).queryByText('grows as used')).toBeNull()
    // Editing the value takes the refusal with it; the hint is back on the same line.
    fireEvent.change(field, { target: { value: '20' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(line).getByText('grows as used')).toBeTruthy()
  })
})
