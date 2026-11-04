import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Only main's `'on'` is on; `'unset'`, `'off'` and settings not loaded yet are off. */

const settings = vi.hoisted(() => ({ data: undefined as Record<string, unknown> | undefined, isError: false }))
vi.mock('./useAppSettings', () => ({ useAppSettings: () => ({ data: settings.data, isError: settings.isError }) }))

const { useCapabilities } = await import('./useCapabilities')

beforeEach(() => {
  settings.data = undefined
  settings.isError = false
})

describe('useCapabilities', () => {
  it('reads off, and not loaded, before the settings answer', () => {
    expect(renderHook(() => useCapabilities()).result.current).toEqual({ notesEnabled: false, dashboardsEnabled: false, loaded: false })
  })

  it('is on only for on', () => {
    settings.data = { notesCapability: 'on', dashboardsCapability: 'unset' }
    expect(renderHook(() => useCapabilities()).result.current).toEqual({ notesEnabled: true, dashboardsEnabled: false, loaded: true })
    settings.data = { notesCapability: 'off', dashboardsCapability: 'on' }
    expect(renderHook(() => useCapabilities()).result.current).toEqual({ notesEnabled: false, dashboardsEnabled: true, loaded: true })
  })

  it('counts a failed read as loaded and off, so a hidden capability is left', () => {
    settings.isError = true
    expect(renderHook(() => useCapabilities()).result.current).toEqual({ notesEnabled: false, dashboardsEnabled: false, loaded: true })
  })
})
