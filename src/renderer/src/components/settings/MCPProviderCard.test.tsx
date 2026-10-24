import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
const upsertMutate = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useMcp', () => ({
  useUpsertMcpProvider: () => ({ mutate: upsertMutate }), useDeleteMcpProvider: () => ({ mutate: vi.fn() }),
  useConnectMcp: () => ({ mutate: vi.fn() }), useDisconnectMcp: () => ({ mutate: vi.fn() })
}))
vi.mock('../ui/AnimatedCollapse', () => ({ AnimatedCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null }))
import { MCPProviderCard } from './MCPProviderCard'
it('keeps Transport available when moving from stdio to SSE and back', () => {
  render(<MCPProviderCard provider={{ id: 'mcp', name: 'Test MCP', transportType: 'stdio',
    enabled: true, hasAuth: false, authType: 'oauth', status: 'disconnected', tools: [] }} />)
  fireEvent.click(screen.getByText('Test MCP'))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sse' } })
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('sse')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'stdio' } })
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('stdio')
})

const broken = { id: 'gh', name: 'GitHub', transportType: 'streamable-http', url: 'https://gh.example/mcp',
  enabled: true, hasAuth: false, authType: 'oauth', status: 'error', error: 'HTTP 500', tools: [] }

it('draws a connector’s state with the same glyph and tone in Settings as on an agent’s Addons tab', () => {
  const glyph = (): HTMLElement => screen.getByRole('img', { name: 'HTTP 500' })
  const { unmount } = render(<MCPProviderCard provider={broken} />)
  const settings = { className: glyph().className, icon: glyph().innerHTML }
  unmount()
  render(<MCPProviderCard provider={broken} detach={{ onDetach: vi.fn() }} />)
  expect(glyph().className).toBe(settings.className)
  expect(glyph().innerHTML).toBe(settings.icon)
  expect(settings.className).toContain('--color-danger')
})

it('opens its form from a button that says whether it is open, in Settings too', () => {
  render(<MCPProviderCard provider={broken} />)
  const header = screen.getByRole('button', { name: /GitHub/, expanded: false })
  fireEvent.click(header)
  expect(header.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('combobox')).toBeTruthy()
})

it('saves a plugin’s connector with its stored args unsplit and its fields read-only; only the values change', () => {
  const args = ['/Users/me/Library/Application Support/cinna/plugins/carbone/server.mjs', '--port', '0']
  render(<MCPProviderCard provider={{ id: 'p1', name: 'carbone', transportType: 'stdio', command: 'node', args,
    env: { API_KEY: '' }, enabled: true, hasAuth: false, authType: 'oauth', status: 'disconnected', tools: [],
    managedBy: 'plugin:e@s' }} />)
  fireEvent.click(screen.getByText('carbone'))
  expect((screen.getByDisplayValue(args.join(' ')) as HTMLInputElement).readOnly).toBe(true)
  fireEvent.change(screen.getByPlaceholderText('API_KEY=xxx'), { target: { value: 'API_KEY=sk-1' } })
  fireEvent.click(screen.getByText('Save'))
  expect(upsertMutate.mock.calls[0][0]).toMatchObject({ id: 'p1', name: 'carbone', command: 'node', args, env: { API_KEY: 'sk-1' } })
})
