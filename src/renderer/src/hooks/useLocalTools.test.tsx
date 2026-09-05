import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

/**
 * Clearing the default tool also clears auto-open: "ask each time" and "open
 * automatically" contradict each other, and a cleared default that left
 * auto-open armed re-armed it silently the next time any tool was picked.
 */

const mutate = vi.fn()
vi.mock('./useAppSettings', () => ({
  useAppSettings: () => ({ data: undefined }),
  useSetAppSetting: () => ({ mutate })
}))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: [] }),
  useMutation: () => ({ mutate: vi.fn() }),
  useQueryClient: () => ({})
}))

const { useSetDefaultTool } = await import('./useLocalTools')

describe('useSetDefaultTool', () => {
  it('writes the tool id and leaves auto-open alone', () => {
    const { result } = renderHook(() => useSetDefaultTool())
    result.current('codex')
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith({ key: 'localAgentsDefaultTool', value: 'codex' })
  })

  it('clearing the tool also turns auto-open off', () => {
    mutate.mockClear()
    const { result } = renderHook(() => useSetDefaultTool())
    result.current(null)
    expect(mutate).toHaveBeenCalledWith({ key: 'localAgentsDefaultTool', value: '' })
    expect(mutate).toHaveBeenCalledWith({ key: 'localAgentsAutoOpen', value: false })
  })
})
