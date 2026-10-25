import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
const upsertMutate = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useMcp', () => ({
  useUpsertMcpProvider: () => ({ mutate: upsertMutate }), useDeleteMcpProvider: () => ({ mutate: vi.fn() }),
  useConnectMcp: () => ({ mutate: vi.fn() }), useDisconnectMcp: () => ({ mutate: vi.fn() })
}))
let policy: { stdioMcp: boolean } | undefined = { stdioMcp: false }
vi.mock('../../hooks/useAddonDirectory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useAddonDirectory')>()),
  useAddonPolicy: () => ({ data: policy })
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

it('marks a plugin’s connector in Settings with where it is from, offers no Delete, and says its switch is for this computer', () => {
  render(<MCPProviderCard provider={{ id: 'p1', name: 'ledger', transportType: 'stdio', command: 'node', enabled: true, hasAuth: false,
    authType: 'oauth', status: 'disconnected', tools: [], managedBy: 'plugin:e@s', managedByTitle: 'Ledger Tools' }} />)
  expect(screen.getByText('From Ledger Tools')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Delete MCP ledger' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Turn off ledger' }).getAttribute('title')).toBe('Turn off ledger on this computer')
})

it('says From a plugin when main does not name the plugin, and keeps Delete on the user’s own connector', () => {
  const { unmount } = render(<MCPProviderCard provider={{ id: 'p1', name: 'ledger', transportType: 'stdio', enabled: true, hasAuth: false,
    authType: 'oauth', status: 'disconnected', tools: [], managedBy: 'plugin:e@s' }} />)
  expect(screen.getByText('From a plugin')).toBeTruthy()
  unmount()
  render(<MCPProviderCard provider={broken} />)
  expect(screen.getByRole('button', { name: 'Delete MCP GitHub' })).toBeTruthy()
  expect(screen.queryByText('From a plugin')).toBeNull()
})

it('asks one password field per stored setting, never showing a value, and sends every name (blank keeps)', () => {
  upsertMutate.mockClear()
  render(<MCPProviderCard provider={{ id: 'p2', name: 'ledger', transportType: 'stdio', command: 'node', args: ['s.mjs'],
    env: { LEDGER_TOKEN: '', LEDGER_REGION: '' }, envSlots: [{ name: 'LEDGER_TOKEN', hasValue: true }, { name: 'LEDGER_REGION', hasValue: false }],
    enabled: true, hasAuth: false, authType: 'oauth', status: 'disconnected', tools: [], managedBy: 'plugin:e@s' }} />)
  fireEvent.click(screen.getByText('ledger'))
  expect(screen.queryByPlaceholderText('API_KEY=xxx')).toBeNull()
  const token = screen.getByLabelText('LEDGER_TOKEN') as HTMLInputElement
  const region = screen.getByLabelText('LEDGER_REGION') as HTMLInputElement
  expect(token.type).toBe('password')
  expect(token.value).toBe('')
  expect(token.placeholder).toBe('Saved — leave blank to keep it')
  expect(region.placeholder).toBe('Value')
  // Typing makes the form dirty: the switch waits for Save.
  fireEvent.change(region, { target: { value: 'eu' } })
  expect((screen.getByRole('button', { name: 'Turn off ledger' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByText('Save'))
  expect(upsertMutate.mock.calls[0][0]).toMatchObject({ id: 'p2', command: 'node', args: ['s.mjs'], env: { LEDGER_TOKEN: '', LEDGER_REGION: 'eu' } })
})

it('asks per-slot fields for a directory connector of the user’s own too, keeping its command editable', () => {
  upsertMutate.mockClear()
  render(<MCPProviderCard provider={{ id: 'd1', name: 'files', transportType: 'stdio', command: 'uvx', args: ['mcp-files'],
    env: { ROOT: '' }, envSlots: [{ name: 'ROOT', hasValue: true }], enabled: true, hasAuth: false, authType: 'oauth',
    status: 'disconnected', tools: [] }} />)
  fireEvent.click(screen.getByText('files'))
  expect((screen.getByDisplayValue('uvx') as HTMLInputElement).readOnly).toBe(false)
  fireEvent.change(screen.getByLabelText('ROOT'), { target: { value: '/data' } })
  fireEvent.click(screen.getByText('Save'))
  expect(upsertMutate.mock.calls[0][0]).toMatchObject({ id: 'd1', command: 'uvx', env: { ROOT: '/data' } })
})

it('offers no Reconnect on a connector the admin’s policy refused, and keeps it for one that needs Node.js', () => {
  const local = { id: 'p1', name: 'ledger', transportType: 'stdio', command: 'node', enabled: true, hasAuth: false,
    authType: 'oauth', status: 'error', tools: [], managedBy: 'plugin:e@s' }
  const { unmount } = render(<MCPProviderCard provider={{ ...local, error: 'Blocked by your admin' }} />)
  fireEvent.click(screen.getByRole('button', { name: /ledger/, expanded: false }))
  expect(screen.getAllByText('Blocked by your admin').length).toBeGreaterThan(0)
  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  unmount()
  render(<MCPProviderCard provider={{ ...local, error: 'Needs Node.js — install it from nodejs.org' }} />)
  fireEvent.click(screen.getByRole('button', { name: /ledger/, expanded: false }))
  expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
})

it('offers Reconnect again on a policy refusal once the policy allows local servers', () => {
  // A refusal recorded in a race with the policy turning local servers back on must not be left without a way out.
  policy = { stdioMcp: true }
  try {
    const local = { id: 'p1', name: 'ledger', transportType: 'stdio', command: 'node', enabled: true, hasAuth: false,
      authType: 'oauth', status: 'error', tools: [], managedBy: 'plugin:e@s', error: 'Blocked by your admin' }
    render(<MCPProviderCard provider={local} />)
    fireEvent.click(screen.getByRole('button', { name: /ledger/, expanded: false }))
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
  } finally {
    policy = { stdioMcp: false }
  }
})
