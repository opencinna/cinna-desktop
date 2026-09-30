import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

/**
 * The default tool is one setting and nothing else: picking writes the id,
 * clearing writes the empty string ("ask each time"), and neither touches any
 * other key.
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
  it('writes the tool id and nothing else', () => {
    mutate.mockClear()
    const { result } = renderHook(() => useSetDefaultTool())
    result.current('codex')
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith({ key: 'localAgentsDefaultTool', value: 'codex' })
  })

  it('clearing the tool writes the empty default and nothing else', () => {
    mutate.mockClear()
    const { result } = renderHook(() => useSetDefaultTool())
    result.current(null)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith({ key: 'localAgentsDefaultTool', value: '' })
  })
})
