import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let appSettings = { localAgentsEnginePath: '' }
const setAppSetting = vi.fn()
vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ data: appSettings }),
  useSetAppSetting: () => ({ mutate: setAppSetting })
}))
vi.mock('../../hooks/useEngine', () => ({
  useEngineBinary: () => ({ data: { state: 'ready', path: '/usr/local/bin/opencode', version: '1.2.3' } })
}))
const { OpenCodeSettingsFields } = await import('./OpenCodeSettingsFields')

beforeEach(() => {
  appSettings = { localAgentsEnginePath: '' }
  setAppSetting.mockReset()
})

describe('OpenCodeSettingsFields', () => {
  it('notes a saved path the status line does not describe yet, last in its card', () => {
    appSettings = { ...appSettings, localAgentsEnginePath: '/opt/opencode' }
    render(<OpenCodeSettingsFields />)

    expect(
      screen.getByText('Used from the next agent run. The status above is still the old path.')
    ).toBeTruthy()
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
