import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactsSupport, ArtifactsSupportChangedPayload } from '../../../shared/artifacts'

/**
 * Main pushes its support answer when it changes (core reachable after a
 * launch, or core dropped artifacts); the loader takes it for the current
 * profile without a focus event or a second question.
 */

const LIMITS = { maxRevisionBytes: 1, maxRevisionFiles: 1, maxFileBytes: 1 }
const NO: ArtifactsSupport = { supported: false, limits: LIMITS }
const YES: ArtifactsSupport = { supported: true, instanceName: 'Acme', limits: LIMITS }

const pushHandlers: Array<(payload: ArtifactsSupportChangedPayload) => void> = []
let answer: () => Promise<ArtifactsSupport> = async () => NO
const support = vi.fn(() => answer())

;(window as unknown as { api: unknown }).api = {
  artifacts: {
    support,
    onChanged: () => () => undefined,
    onSupportChanged: (handler: (payload: ArtifactsSupportChangedPayload) => void) => {
      pushHandlers.push(handler)
      return () => pushHandlers.splice(pushHandlers.indexOf(handler), 1)
    }
  }
}

const { useArtifactsSupport, useArtifactsSupportLoader, useArtifactsSupportStore } = await import('./useArtifacts')
const { useAuthStore } = await import('../stores/auth.store')

const push = (payload: ArtifactsSupportChangedPayload): void => {
  for (const handler of [...pushHandlers]) handler(payload)
}

beforeEach(() => {
  pushHandlers.length = 0
  support.mockClear()
  answer = async () => NO
  useArtifactsSupportStore.setState({ profileId: null, support: NO })
  useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user' } as never })
})

describe('useArtifactsSupportLoader — the support push', () => {
  it('applies a pushed answer for the current profile without asking again', async () => {
    const { result } = renderHook(() => {
      useArtifactsSupportLoader()
      return useArtifactsSupport()
    })
    await waitFor(() => expect(useArtifactsSupportStore.getState().profileId).toBe('p1'))
    expect(result.current.supported).toBe(false)
    await act(async () => push({ profileId: 'p1', support: YES }))
    expect(result.current).toEqual(YES)
    expect(support).toHaveBeenCalledTimes(1)
  })

  it('ignores an answer pushed for another profile', async () => {
    const { result } = renderHook(() => {
      useArtifactsSupportLoader()
      return useArtifactsSupport()
    })
    await waitFor(() => expect(useArtifactsSupportStore.getState().profileId).toBe('p1'))
    await act(async () => push({ profileId: 'p2', support: YES }))
    expect(result.current.supported).toBe(false)
    expect(useArtifactsSupportStore.getState().profileId).toBe('p1')
  })

  it('a reply to a question asked before a push does not overwrite the pushed answer', async () => {
    let reply!: (value: ArtifactsSupport) => void
    answer = () => new Promise((resolve) => (reply = resolve))
    const { result } = renderHook(() => {
      useArtifactsSupportLoader()
      return useArtifactsSupport()
    })
    await act(async () => push({ profileId: 'p1', support: YES }))
    await act(async () => reply(NO))
    expect(result.current).toEqual(YES)
  })

  it('stops listening when unmounted', () => {
    const { unmount } = renderHook(() => useArtifactsSupportLoader())
    expect(pushHandlers).toHaveLength(1)
    unmount()
    expect(pushHandlers).toHaveLength(0)
  })
})
