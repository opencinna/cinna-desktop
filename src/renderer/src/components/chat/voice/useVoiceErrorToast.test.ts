import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '../../../stores/toast.store'
import { useVoiceErrorToast } from './useVoiceErrorToast'

beforeEach(() => {
  useToastStore.setState({ toast: null })
})

describe('useVoiceErrorToast', () => {
  it('shows an error toast without a link, and takes it down when the next recording starts', () => {
    const { result } = renderHook(() => useVoiceErrorToast())
    act(() => result.current('Nothing was recorded.'))
    expect(useToastStore.getState().toast).toMatchObject({ message: 'Nothing was recorded.', kind: 'error', link: null })
    act(() => result.current(null))
    expect(useToastStore.getState().toast).toBeNull()
  })

  it('never takes down a toast someone else showed since', () => {
    const { result } = renderHook(() => useVoiceErrorToast())
    act(() => result.current('Nothing was recorded.'))
    act(() => { useToastStore.getState().show('Audio input is hidden.', { kind: 'info', link: null }) })
    act(() => result.current(null))
    expect(useToastStore.getState().toast?.message).toBe('Audio input is hidden.')
  })

  it('leaves alone a toast it never showed', () => {
    useToastStore.getState().show('Off Agent is disabled')
    const { result } = renderHook(() => useVoiceErrorToast())
    act(() => result.current(null))
    expect(useToastStore.getState().toast?.message).toBe('Off Agent is disabled')
  })

  it('tells two toasts shown in one millisecond apart', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1)
    const first = useToastStore.getState().show('one')
    const second = useToastStore.getState().show('two')
    expect(second).not.toBe(first)
    vi.restoreAllMocks()
  })
})
