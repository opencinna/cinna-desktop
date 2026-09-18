import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let appSettings = { localAgentsCodexPath: '' }
let binary: Record<string, unknown> = { state: 'ready', path: '/data/runtimes/codex-0.155.0/codex', source: 'managed', version: 'codex-cli 0.155.0' }
const setAppSetting = vi.fn()
vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ data: appSettings }),
  useSetAppSetting: () => ({ mutate: setAppSetting })
}))
vi.mock('../../hooks/useEngine', () => ({ useCodexBinary: () => ({ data: binary }) }))
const { CodexSettingsFields } = await import('./CodexSettingsFields')

beforeEach(() => {
  appSettings = { localAgentsCodexPath: '' }
  binary = { state: 'ready', path: '/data/runtimes/codex-0.155.0/codex', source: 'managed', version: 'codex-cli 0.155.0' }
  setAppSetting.mockReset()
})

describe('CodexSettingsFields', () => {
  it('adds no line under the field between a save and main’s re-resolution', () => {
    // Main re-resolves when this path is saved, so "still the old path" is an
    // interval that lasts a frame. Mutation: give the field a `pendingMessage`
    // and that frame lengthens the card and takes it back (ux_rules rule 1).
    appSettings = { localAgentsCodexPath: '/opt/codex' }
    const view = render(<CodexSettingsFields />)
    const card = view.container.firstElementChild!
    expect(card.querySelectorAll('p')).toHaveLength(0)
    expect(screen.queryByText(/old path|next Codex run/)).toBeNull()

    // …and none after a failed install either: the field is how the user gets out of it.
    binary = { state: 'failed', error: 'Codex could not be downloaded.' }
    view.rerender(<CodexSettingsFields />)
    expect(card.querySelectorAll('p')).toHaveLength(0)
  })

  it('saves on blur, and shows a refused path below the field with the draft kept', () => {
    render(<CodexSettingsFields />)
    const input = screen.getByLabelText('Codex Path', { exact: true }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'relative/codex' } })
    fireEvent.blur(input)
    expect(setAppSetting).toHaveBeenCalledWith({ key: 'localAgentsCodexPath', value: 'relative/codex' }, expect.anything())
    act(() => setAppSetting.mock.calls[0][1].onError(new Error('The Codex path must be an absolute path to the codex executable.')))
    expect(input.value).toBe('relative/codex')
    const message = screen.getByText('The Codex path must be an absolute path to the codex executable.')
    expect(input.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
