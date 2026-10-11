import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let appSettings = { localAgentsAntigravityPath: '' }
let binary: Record<string, unknown> = { state: 'ready', path: '/data/runtimes/antigravity-1.3.0/agy_acp_server.par', source: 'managed', version: null }
const setAppSetting = vi.fn()
vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ data: appSettings }),
  useSetAppSetting: () => ({ mutate: setAppSetting })
}))
vi.mock('../../hooks/useEngine', () => ({ useAntigravityBinary: () => ({ data: binary }) }))
const { AntigravitySettingsFields } = await import('./AntigravitySettingsFields')

beforeEach(() => {
  appSettings = { localAgentsAntigravityPath: '' }
  binary = { state: 'ready', path: '/data/runtimes/antigravity-1.3.0/agy_acp_server.par', source: 'managed', version: null }
  setAppSetting.mockReset()
})

describe('AntigravitySettingsFields', () => {
  it('adds no line under the field between a save and main’s re-resolution', () => {
    // Main re-resolves when this path is saved, so "still the old path" is an
    // interval that lasts a frame. Mutation: give the field a `pendingMessage`
    // and that frame lengthens the card and takes it back (ux_rules rule 1).
    appSettings = { localAgentsAntigravityPath: '/opt/agy_acp_server.par' }
    const view = render(<AntigravitySettingsFields />)
    const card = view.container.firstElementChild!
    expect(card.querySelectorAll('p')).toHaveLength(0)
    expect(screen.queryByText(/old path|next Antigravity run/)).toBeNull()

  })

  it('says a failed Antigravity under its own field, in one line that moves nothing above it', () => {
    // It used to be a red paragraph above all three fields, so pressing Enter on
    // a bad path moved the field being edited. Mutation: render it before the
    // input, or drop `truncate`, and a long failure is three lines again.
    appSettings = { localAgentsAntigravityPath: '/opt/agy_acp_server.par' }
    binary = { state: 'failed', error: 'Antigravity path is not a file — fix it in Local Development.' }
    const view = render(<AntigravitySettingsFields />)
    const input = screen.getByLabelText('Antigravity Path', { exact: true })
    const reason = screen.getByText('Antigravity path is not a file — fix it in Local Development.')
    expect(input.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(reason.className).toContain('truncate')
    expect(reason.className).toContain('text-[var(--color-danger)]')
    expect(reason.getAttribute('title')).toBe('Antigravity path is not a file — fix it in Local Development.')
    expect(view.container.querySelectorAll('p')).toHaveLength(1)
  })

  it('saves on blur, and shows a refused path below the field with the draft kept', () => {
    render(<AntigravitySettingsFields />)
    const input = screen.getByLabelText('Antigravity Path', { exact: true }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'relative/agy_acp_server.par' } })
    fireEvent.blur(input)
    expect(setAppSetting).toHaveBeenCalledWith({ key: 'localAgentsAntigravityPath', value: 'relative/agy_acp_server.par' }, expect.anything())
    act(() => setAppSetting.mock.calls[0][1].onError(new Error('The Antigravity path must be an absolute path to agy_acp_server.par.')))
    expect(input.value).toBe('relative/agy_acp_server.par')
    const message = screen.getByText('The Antigravity path must be an absolute path to agy_acp_server.par.')
    expect(input.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
