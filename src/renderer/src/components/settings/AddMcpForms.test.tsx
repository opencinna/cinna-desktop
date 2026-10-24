import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddCustomMcpForm } from './AddCustomMcpForm'
import { AddLocalMcpForm } from './AddLocalMcpForm'

const POLICY = 'Your admin does not allow your own MCP connectors.'
const upsert = vi.fn()

function renderForm(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  upsert.mockReset()
  upsert.mockResolvedValue({ id: '', success: false, ok: false, code: 'policy', message: POLICY })
  ;(window as unknown as { api: unknown }).api = { mcp: { upsert } }
})

describe('a policy refusal of a new connector', () => {
  it('shows main’s sentence in the remote form and keeps it open', async () => {
    const onClose = vi.fn()
    const onCreated = vi.fn()
    renderForm(<AddCustomMcpForm onClose={onClose} onCreated={onCreated} initialName="Docs" />)
    fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com'), { target: { value: 'https://docs.example/mcp' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })
    expect((await screen.findByRole('alert')).textContent).toBe(POLICY)
    expect(onClose).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
    expect((screen.getByPlaceholderText('https://mcp.example.com') as HTMLInputElement).value).toBe('https://docs.example/mcp')
  })

  it('shows main’s sentence in the local form and keeps it open', async () => {
    const onClose = vi.fn()
    renderForm(<AddLocalMcpForm onClose={onClose} initialName="Files" />)
    fireEvent.change(screen.getByPlaceholderText('e.g., npx'), { target: { value: 'npx' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })
    expect((await screen.findByRole('alert')).textContent).toBe(POLICY)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says nothing when the connector is saved', async () => {
    upsert.mockResolvedValue({ id: 'm1', success: true })
    const onCreated = vi.fn()
    renderForm(<AddLocalMcpForm onClose={vi.fn()} onCreated={onCreated} initialName="Files" />)
    fireEvent.change(screen.getByPlaceholderText('e.g., npx'), { target: { value: 'npx' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })
    expect(onCreated).toHaveBeenCalledWith('m1')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
