import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let appSettings = { localAgentsClaudePath: '' }
let binary: Record<string, unknown> = { state: 'ready', path: '/data/runtimes/claude-2.1.276/claude', source: 'managed', version: '2.1.276 (Claude Code)' }
const setAppSetting = vi.fn()
vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ data: appSettings }),
  useSetAppSetting: () => ({ mutate: setAppSetting })
}))
vi.mock('../../hooks/useEngine', () => ({ useClaudeBinary: () => ({ data: binary }) }))
const { ClaudeSettingsFields } = await import('./ClaudeSettingsFields')

beforeEach(() => {
  appSettings = { localAgentsClaudePath: '' }
  binary = { state: 'ready', path: '/data/runtimes/claude-2.1.276/claude', source: 'managed', version: '2.1.276 (Claude Code)' }
  setAppSetting.mockReset()
})

describe('ClaudeSettingsFields', () => {
  it('adds no line under the field between a save and main’s re-resolution', () => {
    // Main re-resolves when this path is saved (`engine.ipc.ts`), so "still the
    // old path" lasts a frame. Mutation: give the field a `pendingMessage` and
    // that frame lengthens the card and takes it back (ux_rules rule 1).
    appSettings = { localAgentsClaudePath: '/opt/claude' }
    const view = render(<ClaudeSettingsFields />)
    const card = view.container.firstElementChild!
    expect(card.querySelectorAll('p')).toHaveLength(0)
  })

  it('says a failed Claude Code under its own field, in one line that moves nothing above it', () => {
    appSettings = { localAgentsClaudePath: '/opt/claude' }
    binary = { state: 'failed', error: 'Claude path is not a file — fix it in Local Development.' }
    const view = render(<ClaudeSettingsFields />)
    const input = screen.getByLabelText('Claude Path', { exact: true })
    const reason = screen.getByText('Claude path is not a file — fix it in Local Development.')
    expect(input.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(reason.className).toContain('truncate')
    expect(reason.className).toContain('text-[var(--color-danger)]')
    expect(view.container.querySelectorAll('p')).toHaveLength(1)
  })

  it('saves its own setting on blur, and shows a refused path below the field with the draft kept', () => {
    render(<ClaudeSettingsFields />)
    const input = screen.getByLabelText('Claude Path', { exact: true }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'relative/claude' } })
    fireEvent.blur(input)
    // Its own key: a copy-paste that kept `localAgentsCodexPath` would save a
    // claude path as the Codex binary.
    expect(setAppSetting).toHaveBeenCalledWith({ key: 'localAgentsClaudePath', value: 'relative/claude' }, expect.anything())
    act(() => setAppSetting.mock.calls[0][1].onError(new Error('The Claude path must be an absolute path to the claude executable.')))
    expect(input.value).toBe('relative/claude')
    const message = screen.getByText('The Claude path must be an absolute path to the claude executable.')
    expect(input.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('throws a half-typed path away on Escape instead of saving it', () => {
    render(<ClaudeSettingsFields />)
    const input = screen.getByLabelText('Claude Path', { exact: true }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '/opt/cl' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(setAppSetting).not.toHaveBeenCalled()
  })
})
