import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSkillCredentialsWatch } from './useServiceCredentials'
import { useFinishSetupStore } from '../stores/finishSetup.store'
import type { ServiceCredentialsChangedPayload } from '../../../shared/serviceCredentials'

describe('useSkillCredentialsWatch', () => {
  it('remembers the skill slots main filled in the background, and ignores a plain change', () => {
    let push: (payload: ServiceCredentialsChangedPayload) => void = () => {}
    window.api = { serviceCredentials: { onChanged: (cb: typeof push) => { push = cb; return () => {} } } } as never
    useFinishSetupStore.setState({ pending: [], autoAttached: {} })
    renderHook(() => useSkillCredentialsWatch())
    act(() => push({ lastSync: 1, error: null }))
    expect(useFinishSetupStore.getState().autoAttached).toEqual({})
    act(() => push({ autoAttached: { agentId: 'folder:kit', items: [{ slot: 'erp-api', credentialName: 'ERP', skill: true }] } }))
    expect(useFinishSetupStore.getState().autoAttached).toEqual({ 'folder:kit': ['skill:erp-api'] })
  })
})
