import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
window.api = { app: { setTheme: async () => {} } } as never
const { ExternalAgentActionsMenu } = await import('./ExternalAgentActionsMenu')
const { useUIStore } = await import('../../stores/ui.store')
const { useAuthStore } = await import('../../stores/auth.store')

const api = { remove: vi.fn(), uninstall: vi.fn(), setEnabled: vi.fn(), syncRemote: vi.fn(), openExternal: vi.fn() }
const base = { id: 'agent', name: 'Research', source: 'local', enabled: true, remoteTargetType: null, remoteTargetId: null, remoteMetadata: null }
const onError = vi.fn()
function mount(overrides: Record<string, unknown> = {}, agents?: unknown[]) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  if (agents) client.setQueryData(['agents'], agents)
  render(<QueryClientProvider client={client}><ExternalAgentActionsMenu agent={{ ...base, ...overrides } as never} onError={onError} /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
  return client
}
function deferredResult() {
  let resolve!: (result: { success: boolean; error?: string }) => void
  const promise = new Promise<{ success: boolean; error?: string }>((done) => { resolve = done })
  return { promise, resolve }
}
const profile = { id: 'profile', type: 'cinna_user', username: 'user', displayName: 'User', hasPassword: false, cinnaServerUrl: 'https://cinna.example/' }
beforeEach(() => {
  vi.resetAllMocks()
  useAuthStore.setState({ currentUser: profile })
  for (const fn of Object.values(api)) fn.mockResolvedValue({ success: true })
  window.api = { agents: { delete: api.remove, setEnabled: api.setEnabled, syncRemote: api.syncRemote }, catalog: { uninstall: api.uninstall }, system: { openExternal: api.openExternal } } as never
  useUIStore.setState({ activeExternalAgentId: 'agent', activeView: 'external-agent' })
})

describe('agent actions', () => {
  it('offers deletion without disabling for a directly added A2A agent', () => {
    mount({ protocol: 'a2a' })
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(screen.getByRole('menuitem', { name: 'Delete agent…' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Disable/ })).toBeNull()
  })
  it('hides the last Cinna agent and returns to the starting screen', async () => {
    mount({ source: 'remote' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disable in Desktop App' }))
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith('agent', false))
    expect(api.remove).not.toHaveBeenCalled()
    await waitFor(() => expect(useUIStore.getState().activeExternalAgentId).toBeNull())
    expect(useUIStore.getState().activeView).toBe('chat')
  })
  it('offers enabling a disabled agent again', async () => {
    mount({ enabled: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable in Desktop App' }))
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith('agent', true))
  })
  it('keeps a failed deletion visible and the agent selected', async () => {
    api.remove.mockResolvedValue({ success: false, error: 'Agent busy' })
    mount()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete agent…' }))
    expect(api.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Agent busy')
    expect(useUIStore.getState().activeExternalAgentId).toBe('agent')
  })
  /*
    Every remote shape: a catalog install, a publisher's working copy, and an
    agent that was simply created on the server — cinna-server stamps a
    non-null `bundle_id` on all three at creation, so the third used to be
    read as somebody else's bundle and offered "Uninstall agent…". None of
    them is the desktop's to destroy.
  */
  it.each([
    ['a catalog install', { bundle_id: 'com.acme.research', bundle_uuid: 'bundle', is_publisher_install: false }],
    ['a published working copy', { bundle_id: 'com.acme.research', bundle_uuid: 'bundle', is_publisher_install: true }],
    ['an agent created on the server', { bundle_id: 'com.acme.research', bundle_uuid: null, is_publisher_install: false }]
  ])('offers %s its page on the server and nothing destructive', async (_name, remoteMetadata) => {
    mount({ source: 'remote', remoteTargetType: 'agent', remoteTargetId: 'server-id', remoteMetadata })
    // The page on the server leads, as the same-named item does in the task menu.
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open on the server', 'Disable in Desktop App'])
    expect(screen.queryByRole('menuitem', { name: 'Delete agent…' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Uninstall agent…' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open on the server' }))
    // One slash, from a server URL stored with a trailing one.
    await waitFor(() => expect(api.openExternal).toHaveBeenCalledWith('https://cinna.example/agent/server-id'))
    expect(api.remove).not.toHaveBeenCalled()
    expect(api.uninstall).not.toHaveBeenCalled()
  })
  it('offers only the Desktop switch for a shared route', () => {
    mount({ source: 'remote', remoteTargetType: 'route', remoteTargetId: 'route-id' })
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  })
  it.each(['profile', 'selection', 'view'])('does not redirect a different %s after delayed hiding', async (changed) => {
    const pending = deferredResult()
    api.setEnabled.mockReturnValue(pending.promise)
    const client = mount({ source: 'remote' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disable in Desktop App' }))
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledOnce())
    if (changed === 'profile') useAuthStore.setState({ currentUser: { ...profile, id: 'other-profile' } })
    if (changed === 'selection') useUIStore.setState({ activeExternalAgentId: 'other-agent' })
    if (changed === 'view') useUIStore.setState({ activeView: 'settings' })
    const before = { id: useUIStore.getState().activeExternalAgentId, view: useUIStore.getState().activeView }
    pending.resolve({ success: true })
    await waitFor(() => expect(client.isMutating()).toBe(0))
    expect(useUIStore.getState().activeExternalAgentId).toBe(before.id)
    expect(useUIStore.getState().activeView).toBe(before.view)
  })

  it('rolls back failed hiding without moving away from the agent', async () => {
    const agent = { ...base, source: 'remote' }
    api.setEnabled.mockResolvedValue({ success: false, error: 'Session expired' })
    const client = mount({ source: 'remote' }, [agent])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disable in Desktop App' }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Session expired'))
    expect(client.getQueryData(['agents'])).toEqual([agent])
    expect(useUIStore.getState().activeExternalAgentId).toBe('agent')
    expect(useUIStore.getState().activeView).toBe('external-agent')
  })

  it('skips a preceding agent hidden while this disable request was pending', async () => {
    const pending = deferredResult()
    api.setEnabled.mockReturnValue(pending.promise)
    const first = { ...base, id: 'first', source: 'remote' }
    const previous = { ...first, id: 'previous' }
    const target = { ...first, id: 'agent' }
    const client = mount({ source: 'remote' }, [first, previous, target])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disable in Desktop App' }))
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledOnce())
    client.setQueryData(['agents'], [first, { ...previous, enabled: false }, { ...target, enabled: false }])
    pending.resolve({ success: true })
    await waitFor(() => expect(useUIStore.getState().activeExternalAgentId).toBe('first'))
    expect(useUIStore.getState().agentPageMode).toBe('chat')
  })

  it.each(['profile', 'selection'])('does not clear a changed %s after a delayed deletion', async (changed) => {
    const pending = deferredResult()
    api.remove.mockReturnValue(pending.promise)
    const client = mount()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete agent…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledOnce())
    if (changed === 'profile') useAuthStore.setState({ currentUser: { ...profile, id: 'other-profile' } })
    else useUIStore.setState({ activeExternalAgentId: 'other-agent' })
    const selected = useUIStore.getState().activeExternalAgentId
    pending.resolve({ success: true })
    await waitFor(() => expect(client.isMutating()).toBe(0))
    expect(useUIStore.getState().activeExternalAgentId).toBe(selected)
  })

  it('says so on the page when the browser could not be opened', async () => {
    api.openExternal.mockResolvedValue({ success: false, error: 'open_failed' })
    mount({ source: 'remote', remoteTargetType: 'agent', remoteTargetId: 'server-id' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open on the server' }))
    // The code is translated once, in `useSystem`, not shown as `open_failed`.
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Your system could not open that link.'))
    expect(useUIStore.getState().activeExternalAgentId).toBe('agent')
  })

  it('has no page to offer for a target that is not an agent', () => {
    mount({ source: 'remote', remoteTargetType: 'identity', remoteTargetId: 'owner-id' })
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(screen.queryByRole('menuitem', { name: 'Open on the server' })).toBeNull()
  })

})
