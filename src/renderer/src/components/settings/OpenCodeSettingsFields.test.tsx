import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let appSettings = { localAgentsEnginePath: '' }
const setAppSetting = vi.fn()
vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ data: appSettings }),
  useSetAppSetting: () => ({ mutate: setAppSetting })
}))
const READY = { state: 'ready', path: '/usr/local/bin/opencode', source: 'path', version: '1.2.3' }
let binary: Record<string, unknown> = READY
vi.mock('../../hooks/useEngine', () => ({
  useEngineBinary: () => ({ data: binary })
}))
const { OpenCodeSettingsFields } = await import('./OpenCodeSettingsFields')

beforeEach(() => {
  appSettings = { localAgentsEnginePath: '' }
  binary = READY
  setAppSetting.mockReset()
})

describe('OpenCodeSettingsFields', () => {
  it('adds no line under the field between a save and main’s re-resolution', () => {
    // Main re-resolves when this path is saved (`engine.ipc.ts`), so "still the
    // old path" would last a frame, lengthening the card and taking it back.
    appSettings = { localAgentsEnginePath: '/opt/opencode' }
    const view = render(<OpenCodeSettingsFields />)
    const card = view.container.firstElementChild!
    expect(card.querySelectorAll('p')).toHaveLength(0)
  })

  it('says a failed path without sending the user to the tab they are on', () => {
    appSettings = { localAgentsEnginePath: '/opt/opencode' }
    binary = {
      state: 'failed',
      error: 'OpenCode path is not a file — fix it in Local Development.',
      pathError: 'OpenCode path is not a file — fix or clear it.'
    }
    render(<OpenCodeSettingsFields />)
    const reason = screen.getByText('OpenCode path is not a file — fix or clear it.')
    expect(reason.getAttribute('title')).toBe('OpenCode path is not a file — fix or clear it.')
    expect(screen.queryByText(/Local Development/)).toBeNull()
  })

  it('discards a half-typed OpenCode Path on Escape instead of saving it', () => {
    // Escape resets the field and blurs it; the blur commits synchronously with
    // the closure's value, so without the discard flag this *saved* the typed
    // path — the opposite of what Escape means.
    appSettings = { ...appSettings, localAgentsEnginePath: '/opt/opencode' }
    render(<OpenCodeSettingsFields />)
    const input = screen.getByLabelText('OpenCode Path', { exact: true }) as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '/tmp/half-typ' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(document.activeElement).not.toBe(input)
    expect(input.value).toBe('/opt/opencode')
    expect(setAppSetting).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'localAgentsEnginePath' }),
      expect.anything()
    )
  })

  it('follows a changed saved path until the user starts a draft', () => {
    appSettings = { localAgentsEnginePath: '/first/opencode' }
    const view = render(<OpenCodeSettingsFields />)
    const input = screen.getByLabelText('OpenCode Path', { exact: true }) as HTMLInputElement
    appSettings = { localAgentsEnginePath: '/second/opencode' }
    view.rerender(<OpenCodeSettingsFields />)
    expect(input.value).toBe('/second/opencode')

    fireEvent.change(input, { target: { value: '' } })
    appSettings = { localAgentsEnginePath: '/third/opencode' }
    view.rerender(<OpenCodeSettingsFields />)
    expect(input.value).toBe('')
  })

  it('retains the attempted path when saving fails so it can be corrected', () => {
    appSettings = { localAgentsEnginePath: '/saved/opencode' }
    render(<OpenCodeSettingsFields />)
    const input = screen.getByLabelText('OpenCode Path', { exact: true }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '/new/opencode' } })
    fireEvent.blur(input)
    act(() => setAppSetting.mock.calls[0][1].onError(new Error('Cannot save path')))
    expect(input.value).toBe('/new/opencode')
    expect(screen.getByText('Cannot save path')).toBeTruthy()
  })

  it('does not discard a newer draft when an earlier save finishes', () => {
    render(<OpenCodeSettingsFields />)
    const input = screen.getByLabelText('OpenCode Path', { exact: true }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '/first/opencode' } })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: '/second/opencode' } })
    act(() => setAppSetting.mock.calls[0][1].onSuccess())
    expect(input.value).toBe('/second/opencode')
  })

})
