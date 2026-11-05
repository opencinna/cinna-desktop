import { describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { useSkillCredentialsWatch } from './useServiceCredentials'
import { useFinishSetupStore } from '../stores/finishSetup.store'
import { useSkillCredentialPromptStore } from '../stores/skillCredentialPrompt.store'
import type { ServiceCredentialsChangedPayload } from '../../../shared/serviceCredentials'

function wrapper(client = new QueryClient()) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
}

describe('useSkillCredentialsWatch', () => {
  it('remembers the skill slots main filled in the background, and ignores a plain change', () => {
    let push: (payload: ServiceCredentialsChangedPayload) => void = () => {}
    window.api = { serviceCredentials: { onChanged: (cb: typeof push) => { push = cb; return () => {} } } } as never
    useFinishSetupStore.setState({ pending: [], autoAttached: {} })
    renderHook(() => useSkillCredentialsWatch(), { wrapper: wrapper() })
    act(() => push({ lastSync: 1, error: null }))
    expect(useFinishSetupStore.getState().autoAttached).toEqual({})
    act(() => push({ autoAttached: { agentId: 'folder:kit', items: [{ slot: 'erp-api', credentialName: 'ERP', skill: true }] } }))
    expect(useFinishSetupStore.getState().autoAttached).toEqual({ 'folder:kit': ['skill:erp-api'] })
  })

  const cred = (slot: string, filled: boolean) => ({ slot, type: 'api_token', description: null, filled })
  const skill = (name: string, credentials: ReturnType<typeof cred>[], over: Record<string, unknown> = {}) =>
    ({ name, description: '', version: null, source: 'catalog', path: '', deliverable: true, issues: [], credentials, ...over })
  const snapshot = (skills: ReturnType<typeof skill>[]) =>
    ({ roots: [], agents: [{ id: 'folder:kit', skills }], homeAccess: 'ok', homeMissing: false, homePath: '/h' })

  it('raises, once the agents list is re-read, only the named skills that still lack a credential, and bumps the settle counter', async () => {
    let push: (payload: ServiceCredentialsChangedPayload) => void = () => {}
    window.api = { serviceCredentials: { onChanged: (cb: typeof push) => { push = cb; return () => {} } } } as never
    useSkillCredentialPromptStore.setState({ prompts: {}, settled: {} })
    const client = new QueryClient()
    client.setQueryData(['local-agents'], snapshot([skill('erp-orders', [cred('erp-api', true)])]))
    let release: () => void = () => {}
    const refetched = new Promise<void>((resolve) => { release = resolve })
    const refetch = vi.spyOn(client, 'refetchQueries').mockImplementation(() => refetched)
    renderHook(() => useSkillCredentialsWatch(), { wrapper: wrapper(client) })
    act(() => push({ autoAttached: { agentId: 'folder:kit', items: [{ slot: 'erp-api', credentialName: 'ERP', skill: true }] } }))
    expect(useSkillCredentialPromptStore.getState().settled).toEqual({})
    act(() => push({ skillSlotsSettled: { agentId: 'folder:kit', skills: ['erp-orders', 'crm-sync', 'gone', 'filled'] } }))
    // Not before the agents list is re-read: the row would show a slot the fill just filled.
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['local-agents'] })
    await Promise.resolve()
    expect(useSkillCredentialPromptStore.getState()).toMatchObject({ prompts: {}, settled: {} })
    // The re-read list: erp-orders and crm-sync lack something, `filled` does not, `gone` is not there.
    client.setQueryData(['local-agents'], snapshot([
      skill('erp-orders', [cred('erp-api', false)]),
      skill('crm-sync', [cred('crm', true), cred('crm-db', false)]),
      skill('filled', [cred('x', true)])
    ]))
    release()
    await waitFor(() => expect(useSkillCredentialPromptStore.getState().settled).toEqual({ 'folder:kit': 1 }))
    expect(useSkillCredentialPromptStore.getState().prompts).toEqual({ 'folder:kit': ['erp-orders', 'crm-sync'] })
  })

  it('bumps the counter without raising when every named slot is filled, and asks for the agent when no list is cached', async () => {
    let push: (payload: ServiceCredentialsChangedPayload) => void = () => {}
    const get = vi.fn(async () => ({ ok: true, value: { id: 'folder:kit', skills: [skill('erp-orders', [cred('erp-api', true)])] } }))
    window.api = { serviceCredentials: { onChanged: (cb: typeof push) => { push = cb; return () => {} } }, localAgents: { get } } as never
    useSkillCredentialPromptStore.setState({ prompts: {}, settled: { 'folder:kit': 2 } })
    renderHook(() => useSkillCredentialsWatch(), { wrapper: wrapper() })
    act(() => push({ skillSlotsSettled: { agentId: 'folder:kit', skills: ['erp-orders'] } }))
    await waitFor(() => expect(useSkillCredentialPromptStore.getState().settled).toEqual({ 'folder:kit': 3 }))
    expect(get).toHaveBeenCalledWith('folder:kit')
    expect(useSkillCredentialPromptStore.getState().prompts).toEqual({})
  })
})
