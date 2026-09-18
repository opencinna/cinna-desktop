import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatModeCard } from './ChatModeCard'
import { ChatModeForm } from './ChatModeForm'
import { useChatModes } from '../../hooks/useChatModes'
import type { ChatModeData } from '../../constants/chatModeColors'

const runtime = vi.hoisted(() => ({ engine: 'claude' }))
vi.mock('../../hooks/useEngine', () => ({ useDefaultRuntime: () => ({ data: runtime }) }))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useRuntimeModelCatalog', () => ({ useRuntimeModelCatalog: () => ({ data: undefined }) }))
vi.mock('../../hooks/useLocalAgents', () => ({ AGENT_CREDENTIAL_BINDINGS_KEY: ['bindings'] }))

const initial: ChatModeData = {
  id: 'mode', name: 'Writing', engine: 'claude', systemPrompt: 'Old instructions', toolPolicy: 'connectors',
  providerId: null, modelId: null, mcpProviderIds: [], colorPreset: 'indigo', isDefault: false,
  managed: false, adminManaged: false, enabled: true, createdAt: new Date()
}
function mount(element: React.ReactNode): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
  return client
}
function SavedMode(): React.JSX.Element {
  const { data } = useChatModes()
  return data?.[0] ? <ChatModeCard mode={data[0]} /> : <p>Loading</p>
}

beforeEach(() => { runtime.engine = 'claude'; Object.defineProperty(window, 'api', { value: {}, writable: true, configurable: true }) })

describe('chat mode creation', () => {
  it('keeps optional controls collapsed and supports native form submission', async () => {
    const upsert = vi.fn().mockResolvedValue({ success: true, id: 'new' })
    Object.assign(window.api, { chatModes: { upsert } })
    const onClose = vi.fn()
    mount(<ChatModeForm onClose={onClose} />)
    expect(screen.getByLabelText('Runtime').closest('details')).toBeNull()
    expect(screen.getByLabelText('Instructions').closest('details')?.open).toBe(false)
    expect(screen.getByLabelText('Tools').closest('details')?.open).toBe(false)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A simple mode' } })
    fireEvent.submit(screen.getByRole('form', { name: 'New chat mode' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ name: 'A simple mode', systemPrompt: '', toolPolicy: 'connectors' }))
  })

  it.each(['explicit', 'inherited'])('saves a %s Codex mode with editable model, instructions and tool policy', async (selection) => {
    runtime.engine = selection === 'inherited' ? 'codex' : 'claude'
    const upsert = vi.fn().mockResolvedValue({ success: true, id: 'new' })
    const onClose = vi.fn()
    Object.assign(window.api, { chatModes: { upsert } })
    mount(<ChatModeForm onClose={onClose} />)
    expect(screen.getByRole('option', { name: 'Codex' }).matches(':disabled')).toBe(false)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Codex writing' } })
    if (selection === 'explicit') fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'codex' } })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByLabelText('AI Credentials')).toBeNull()
    fireEvent.click(screen.getByText('More options'))
    expect(screen.getByLabelText('Model').matches(':disabled')).toBe(false)
    expect(screen.getByLabelText('Instructions').matches(':disabled')).toBe(false)
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.5' } })
    fireEvent.blur(screen.getByLabelText('Model'))
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Write concise answers.' } })
    fireEvent.blur(screen.getByLabelText('Instructions'))
    fireEvent.change(screen.getByLabelText('Tools'), { target: { value: 'none' } })
    expect(screen.getByRole('button', { name: 'Create Mode' }).matches(':disabled')).toBe(false)
    fireEvent.submit(screen.getByRole('form', { name: 'New chat mode' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ engine: selection === 'explicit' ? 'codex' : null,
      modelId: 'gpt-5.5', providerId: null, systemPrompt: 'Write concise answers.', toolPolicy: 'none' }))
  })

  it('shows the domain error without Electron transport plumbing', async () => {
    Object.assign(window.api, { chatModes: { upsert: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'chatmode:upsert': ValidationError: Choose another name")) } })
    mount(<ChatModeForm onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Duplicate' } })
    fireEvent.submit(screen.getByRole('form', { name: 'New chat mode' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Choose another name')
  })
})

describe('chat mode editing', () => {
  it('preserves instructions when a second field changes before the first save returns', async () => {
    let persisted = { ...initial }
    const finish: Array<() => void> = []
    const upsert = vi.fn((patch) => new Promise(resolve => finish.push(() => {
      persisted = { ...persisted, ...patch }
      resolve({ success: true, id: persisted.id })
    })))
    Object.assign(window.api, {
      providers: { onAccountConfigSynced: () => () => {} },
      chatModes: { list: vi.fn(async () => [{ ...persisted }]), upsert }
    })
    const client = mount(<SavedMode />)
    fireEvent.click(await screen.findByText('Writing'))
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Keep these new instructions' } })
    fireEvent.blur(screen.getByLabelText('Instructions'))
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Tools'), { target: { value: 'none' } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Delete chat mode' }).matches(':disabled')).toBe(true)
    await act(async () => { finish.shift()!() })
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(2))
    expect(upsert.mock.calls[1][0]).toMatchObject({ systemPrompt: 'Keep these new instructions', toolPolicy: 'none' })
    await act(async () => { finish.shift()!() })
    await waitFor(() => expect(client.isMutating()).toBe(0))
    expect(persisted).toMatchObject({ systemPrompt: 'Keep these new instructions', toolPolicy: 'none' })
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('Keep these new instructions')
    expect((screen.getByLabelText('Tools') as HTMLSelectElement).value).toBe('none')
  })

  it.each(['explicit', 'inherited', 'switched'])('edits a %s Codex mode without requiring an AI credential', async (selection) => {
    runtime.engine = 'codex'
    let persisted = { ...initial, engine: selection === 'switched' ? 'claude' as const : selection === 'explicit' ? 'codex' as const : null, providerId: 'obsolete-credential' }
    const upsert = vi.fn(async patch => { persisted = { ...persisted, ...patch }; return { success: true, id: 'mode' } })
    Object.assign(window.api, {
      providers: { onAccountConfigSynced: () => () => {} },
      chatModes: { list: vi.fn(async () => [{ ...persisted }]), upsert }
    })
    const client = mount(<SavedMode />)
    fireEvent.click(await screen.findByText('Writing'))
    if (selection === 'switched') fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'codex' } })
    expect(screen.queryByText('Inactive')).toBeNull()
    expect(screen.queryByLabelText('AI Credentials')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByLabelText('Instructions').matches(':disabled')).toBe(false)
    expect(screen.getByLabelText('Tools').matches(':disabled')).toBe(false)
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.5' } })
    fireEvent.blur(screen.getByLabelText('Model'))
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Updated Codex instructions' } })
    fireEvent.blur(screen.getByLabelText('Instructions'))
    fireEvent.change(screen.getByLabelText('Tools'), { target: { value: 'none' } })
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(selection === 'switched' ? 4 : 3))
    await waitFor(() => expect(client.isMutating()).toBe(0))
    expect(persisted).toMatchObject({ engine: selection === 'inherited' ? null : 'codex',
      modelId: 'gpt-5.5', systemPrompt: 'Updated Codex instructions', toolPolicy: 'none' })
  })
})
