import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnavailableCredentialAccount } from '../../../../shared/serviceCredentials'

/**
 * The account rows' actions, shared by the composer, Finish setup and the Credentials tab: a Switch
 * that lands carries the composer's half-typed message to the profile switched to, and a failure
 * belongs to the account whose button ran it.
 */

const login = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useAuth', () => ({
  useUsers: () => ({ data: [{ id: 'u-alice', hasPassword: false }, { id: 'u-bob', hasPassword: false }] }),
  useLogin: () => ({ mutateAsync: login, isPending: false }),
  useCinnaReauth: () => ({ mutate: vi.fn(), isPending: false, error: null, data: undefined })
}))
vi.mock('../auth/LoginPrompt', () => ({ LoginPrompt: () => null }))
;(window as unknown as { api: unknown }).api = {}

const { useUnavailableAccountActions } = await import('./composerAccountNotices')
const { composerDraftKey, useComposerDraftStore } = await import('../../stores/composerDraft.store')

const account = (over: Partial<UnavailableCredentialAccount> = {}): UnavailableCredentialAccount => ({
  key: 'k-alice', userId: 'u-alice', name: 'Alice Smith', email: 'alice@corp.com', host: 'core.corp', reason: 'signed_out', current: false, credentials: 1, aiCredential: false, ...over
})

beforeEach(() => {
  login.mockReset()
  useComposerDraftStore.setState({ drafts: {} })
})

describe('Switch to <name>', () => {
  const from = composerDraftKey('me', 'agent:folder:kit')

  it('carries the composer’s draft to the profile switched to', async () => {
    useComposerDraftStore.getState().update(from, () => ({ text: 'half a thought' }))
    login.mockResolvedValue({ success: true })
    const { result } = renderHook(() => useUnavailableAccountActions({ draftKey: from }))
    await act(async () => { result.current.actions.switchTo(account()) })
    expect(login).toHaveBeenCalledWith({ userId: 'u-alice' })
    expect(useComposerDraftStore.getState().drafts[composerDraftKey('u-alice', 'agent:folder:kit')]?.text).toBe('half a thought')
    expect(useComposerDraftStore.getState().drafts[from]?.text).toBe('')
  })

  it('lands a chat’s message on the new-chat screen addressed to the composer’s agent', async () => {
    const chat = composerDraftKey('me', 'chat:c1')
    useComposerDraftStore.getState().update(chat, () => ({ text: 'half a thought' }))
    login.mockResolvedValue({ success: true })
    const { result } = renderHook(() => useUnavailableAccountActions({ draftKey: chat, agentId: 'folder:kit' }))
    await act(async () => { result.current.actions.switchTo(account()) })
    expect(useComposerDraftStore.getState().drafts[composerDraftKey('u-alice', 'new-chat')]).toMatchObject({ text: 'half a thought', pendingAgentIds: ['folder:kit'] })
  })

  it('leaves the draft where it is when the switch is refused, and says so on that account only', async () => {
    useComposerDraftStore.getState().update(from, () => ({ text: 'half a thought' }))
    login.mockResolvedValue({ success: false, error: 'Profile not found' })
    const { result } = renderHook(() => useUnavailableAccountActions({ draftKey: from }))
    await act(async () => { result.current.actions.switchTo(account()) })
    expect(useComposerDraftStore.getState().drafts[from]?.text).toBe('half a thought')
    expect(result.current.actions.failure(account())).toBe('Profile not found')
    expect(result.current.actions.failure(account({ key: 'k-bob', userId: 'u-bob' }))).toBeNull()
    act(() => result.current.dismissFailure())
    expect(result.current.actions.failure(account())).toBeNull()
  })
})
