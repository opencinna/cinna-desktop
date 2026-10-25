import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MCPSettingsSection, MCP_SETTINGS_TEXT } from './MCPSettingsSection'
import { addonPolicyKey } from '../../hooks/useAddonDirectory'

/** Settings → MCP offers only what the account's admin policy allows; main refuses the rest anyway. */

const policy = vi.fn()

function renderSection(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MCPSettingsSection />
    </QueryClientProvider>
  )
  return client
}

beforeEach(() => {
  policy.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    mcp: { list: async () => [], onStatusChanged: () => () => {}, registryList: async () => [], registrySearchAll: async () => ({ entries: [], errors: [] }) },
    addons: { policy }
  }
})

describe('MCPSettingsSection and the admin policy', () => {
  it('offers all three ways to add with everything allowed', async () => {
    policy.mockResolvedValue({ externalDirectories: true, customMcp: true, pluginHooks: true, stdioMcp: true })
    renderSection()
    await screen.findByRole('button', { name: 'Add from Registry' })
    expect(screen.getByRole('button', { name: 'Add Custom MCP' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add Local MCP' })).toBeTruthy()
    expect(screen.queryByText(MCP_SETTINGS_TEXT.adminOff, { exact: false })).toBeNull()
  })

  it('hides the registry search with public directories off, and says so where it was', async () => {
    policy.mockResolvedValue({ externalDirectories: false, customMcp: true, pluginHooks: true, stdioMcp: true })
    renderSection()
    await screen.findByTestId('mcp-add-registry-off')
    expect(screen.queryByRole('button', { name: 'Add from Registry' })).toBeNull()
    expect(screen.getByTestId('mcp-add-off').textContent).toBe(`${MCP_SETTINGS_TEXT.adminOff}: Add from Registry`)
    expect(screen.getByRole('button', { name: 'Add Custom MCP' })).toBeTruthy()
  })

  it('hides Custom with custom connectors off, and Local with local servers off', async () => {
    policy.mockResolvedValue({ externalDirectories: true, customMcp: true, pluginHooks: true, stdioMcp: false })
    renderSection()
    await screen.findByTestId('mcp-add-local-off')
    expect(screen.queryByRole('button', { name: 'Add Local MCP' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add Custom MCP' })).toBeTruthy()
  })

  it('hides Custom and Local with custom connectors off', async () => {
    policy.mockResolvedValue({ externalDirectories: true, customMcp: false, pluginHooks: true, stdioMcp: true })
    renderSection()
    await screen.findByTestId('mcp-add-custom-off')
    expect(screen.getByTestId('mcp-add-local-off')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add from Registry' })).toBeTruthy()
  })

  it('keeps an open panel, with what was typed in it, when the policy turns it off, until its own Close', async () => {
    const all = { externalDirectories: true, customMcp: true, pluginHooks: true, stdioMcp: true }
    policy.mockResolvedValue(all)
    const client = renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Add from Registry' }))
    const search = screen.getByPlaceholderText('Search servers...') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'ledger' } })
    // The admin turns public directories off (a refusal in the picker reads the policy again).
    policy.mockResolvedValue({ ...all, externalDirectories: false })
    await act(async () => { await client.invalidateQueries({ queryKey: addonPolicyKey(null) }) })
    expect(client.getQueryData(addonPolicyKey(null))).toMatchObject({ externalDirectories: false })
    // Still open with the search typed; no Add button appears under the pointer.
    expect((screen.getByPlaceholderText('Search servers...') as HTMLInputElement).value).toBe('ledger')
    expect(screen.queryByRole('button', { name: 'Add Custom MCP' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByPlaceholderText('Search servers...')).toBeNull()
    expect(screen.getByTestId('mcp-add-off').textContent).toBe(`${MCP_SETTINGS_TEXT.adminOff}: Add from Registry`)
    expect(screen.getByRole('button', { name: 'Add Custom MCP' })).toBeTruthy()
  })
})
