import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import type { VaultAvailabilityDto, VaultStateEvent, VaultStatusDto } from '../../../../../../shared/vault/types'
import { AgentVaultSection } from './AgentVaultSection'
import { useVaultWatch } from '../../../../hooks/useVault'

/**
 * Security → Agent Vault in each state it can be drawn in: off with Move to
 * vault…, unavailable with the reason and no button, and on — locked,
 * unlocked with its countdown — with the row heights a state change keeps.
 */

const CAPS = { separateKernel: true, hardwareKey: true, perActionPresence: true }
let availability: VaultAvailabilityDto
let status: VaultStatusDto
let stateListener: ((event: VaultStateEvent) => void) | null
const vault = {
  availability: vi.fn(async () => availability),
  status: vi.fn(async () => ({ ok: true, data: status })),
  unlock: vi.fn(async () => ({ ok: true, data: { ...status, state: 'unlocked', until: Date.now() + 60_000 } })),
  lock: vi.fn(async () => ({ ok: true, data: { ...status, state: 'locked', until: null } })),
  hostCopy: vi.fn(async () => ({ ok: true, data: null })),
  engineAuth: vi.fn(async () => ({ ok: true, data: { loggedIn: true, method: 'api_key' } })),
  secrets: vi.fn(async () => ({ ok: true, data: { names: ['DB_URL'] } })),
  runtimes: vi.fn(async () => ({ ok: true, data: [{ engine: 'claude', version: '2.0.1', kind: 'executable', pinned: '2.0.1' }] })),
  listFiles: vi.fn(async () => ({ ok: true, data: [{ name: 'AGENT.md', type: 'file', size: 120, mtime: 0 }] })),
  setSize: vi.fn(async () => ({ ok: true, data: status })),
  setSecret: vi.fn(async () => ({ ok: true, data: undefined })),
  deleteSecret: vi.fn(async () => ({ ok: true, data: undefined })),
  onState: vi.fn((cb: (event: VaultStateEvent) => void) => {
    stateListener = cb
    return () => { stateListener = null }
  }),
  onMoveProgress: vi.fn(() => () => {})
}

beforeEach(() => {
  availability = { availability: { ok: true }, backend: 'apple-vz', flavor: 'release', capabilities: CAPS }
  status = {
    agentId: 'folder:alpha',
    vaultId: 'v1',
    agentName: 'Alpha',
    engine: 'claude',
    state: 'locked',
    until: null,
    sizeBytes: 10 * 1024 ** 3,
    usedBytes: 2.4 * 1024 ** 3,
    egress: { hosts: ['api.anthropic.com'] },
    createdAt: Date.UTC(2026, 10, 13),
    imageVersion: '1.0.0',
    error: null
  }
  stateListener = null
  ;(window as unknown as { api: unknown }).api = { vault }
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function agent(overrides: Partial<LocalAgentDto> = {}): LocalAgentDto {
  return { id: 'folder:alpha', name: 'Alpha', path: '/tmp/alpha', kind: 'kit', ...overrides } as LocalAgentDto
}
const inVault = (): LocalAgentDto => agent({ path: '', vault: { vaultId: 'v1', state: 'locked', engine: 'claude' } })

function renderSection(a: LocalAgentDto, onMove = vi.fn()): { onMove: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The app shell's watcher folds `vault:state` pushes into the cache, as in App.tsx.
  function Harness(): React.JSX.Element {
    useVaultWatch()
    return createElement(AgentVaultSection, { agent: a, onMove })
  }
  render(createElement(QueryClientProvider, { client }, createElement(Harness)))
  return { onMove }
}

describe('AgentVaultSection — off', () => {
  it('offers Move to vault… once this Mac can hold a vault, and the threat model behind a toggle', async () => {
    const { onMove } = renderSection(agent())
    expect(screen.getByRole('heading', { name: 'Agent Vault' })).toBeTruthy()
    const move = screen.getByRole('button', { name: /Move to vault/ }) as HTMLButtonElement
    // Disabled, not absent, while this Mac is checked: the row keeps its shape.
    expect(move.disabled).toBe(true)
    await waitFor(() => expect(move.disabled).toBe(false))
    fireEvent.click(move)
    expect(onMove).toHaveBeenCalled()
    const toggle = screen.getByRole('button', { name: 'What a vault protects against' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/there is no backup yet, so the agent would be lost/)).toBeTruthy()
    expect(screen.getByText(/The clipboard/)).toBeTruthy()
  })

  it.each([
    ['unsupported-os', 'Needs macOS 15 or later on Apple silicon.'],
    ['nested', 'Not available inside a virtual machine.'],
    ['helper-missing', 'The vault helper is missing from this build.'],
    ['image-missing', 'The guest image isn’t installed.']
  ] as const)('says %s in words and offers no button, keeping the section', async (reason, text) => {
    availability = { ...availability, availability: { ok: false, reason }, flavor: null }
    renderSection(agent())
    expect(await screen.findByText(text)).toBeTruthy()
    expect(screen.getByText('Not available on this Mac')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Move to vault/ })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Agent Vault' })).toBeTruthy()
  })

  it('marks a helper that is not the release build as a test helper', async () => {
    availability = { ...availability, flavor: 'fake' }
    renderSection(agent())
    expect(await screen.findByText('Test helper')).toBeTruthy()
  })

  it('names the backend in the test badge’s tooltip', async () => {
    availability = { ...availability, backend: 'fake', flavor: 'dev' }
    renderSection(inVault())
    const badge = await screen.findByText('Test helper')
    expect(badge.getAttribute('title')).toContain('Test backend (no isolation)')
    expect(document.querySelector('[data-vault-facts]')!.textContent).not.toContain('Test backend')
  })

  it('shows no test badge for the release helper', async () => {
    renderSection(agent())
    await waitFor(() => expect((screen.getByRole('button', { name: /Move to vault/ }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText('Test helper')).toBeNull()
  })
})

describe('AgentVaultSection — on', () => {
  it('shows a locked vault with Unlock, and the guest-side rows asking to unlock first', async () => {
    renderSection(inVault())
    expect(await screen.findByRole('button', { name: /^Unlock$/ })).toBeTruthy()
    expect(screen.getByText('Locked')).toBeTruthy()
    // Nothing is read from a guest that is not running.
    expect(screen.getAllByText('Unlock the vault to see this.').length).toBeGreaterThan(0)
    expect(vault.engineAuth).not.toHaveBeenCalled()
    expect(vault.secrets).not.toHaveBeenCalled()
    // Disk usage beside the limit, and the facts under the controls.
    expect(await screen.findByText('10 GB · 2.4 GB used')).toBeTruthy()
    // Neither the size (the Disk size row says it) nor the backend (the Test helper tooltip).
    const facts = document.querySelector('[data-vault-facts]')!
    expect(facts.textContent).toMatch(/^Created .+ · guest image 1\.0\.0$/)
    expect(screen.getByRole('button', { name: /Move out of vault/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Delete vault/ })).toBeTruthy()
  })

  it('follows a state push to unlocked with the countdown and Lock now, in the same row', async () => {
    renderSection(inVault())
    const button = await screen.findByRole('button', { name: /^Unlock$/ })
    const row = button.closest('.flex.items-start') as HTMLElement
    act(() => stateListener?.({ agentId: 'folder:alpha', vaultId: 'v1', state: 'unlocked', until: Date.now() + 42_000, error: null }))
    expect(await screen.findByRole('button', { name: /Lock now/ })).toBeTruthy()
    // The same button element and row: the label swapped in place.
    expect(screen.getByRole('button', { name: /Lock now/ })).toBe(button)
    expect(within(row).getByText(/Unlocked · locks in 4[12]s/)).toBeTruthy()
    // Unlocked, the guest-side rows read.
    expect(await screen.findByText('Signed in with an API key')).toBeTruthy()
    expect(await screen.findByText('DB_URL')).toBeTruthy()
    expect(await screen.findByText('AGENT.md')).toBeTruthy()
  })

  it('says Running while a turn holds the vault open', async () => {
    status = { ...status, state: 'unlocked', until: null }
    renderSection(inVault())
    expect(await screen.findByText('Running')).toBeTruthy()
  })

  it('says a cancelled prompt as an answer, under the button', async () => {
    vault.unlock.mockResolvedValueOnce({ ok: false, code: 'denied', message: 'denied' } as never)
    renderSection(inVault())
    fireEvent.click(await screen.findByRole('button', { name: /^Unlock$/ }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Unlock was cancelled at the prompt.')
  })

  it('refuses a disk limit below what is used, on Save, naming the usage, without asking the helper', async () => {
    renderSection(inVault())
    await screen.findByText('10 GB · 2.4 GB used')
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    const input = screen.getByRole('textbox', { name: 'Disk size limit in GB' })
    fireEvent.change(input, { target: { value: '2' } })
    // Nothing said while typing (ux_rules rule 1).
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.submit(input.closest('form')!)
    expect(screen.getByRole('alert').textContent).toBe('The vault already uses 2.4 GB; the limit can’t go below that.')
    expect(vault.setSize).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(vault.setSize).toHaveBeenCalledWith('folder:alpha', 20 * 1024 ** 3))
  })

  const unlockNow = (): void =>
    act(() => stateListener?.({ agentId: 'folder:alpha', vaultId: 'v1', state: 'unlocked', until: Date.now() + 60_000, error: null }))
  const lockNow = (): void =>
    act(() => stateListener?.({ agentId: 'folder:alpha', vaultId: 'v1', state: 'locked', until: null, error: null }))

  it('leaves the engine’s key out of Secrets; Engine login removes it behind a confirm that says it signs out', async () => {
    vault.secrets.mockResolvedValue({ ok: true, data: { names: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'DB_URL'] } })
    renderSection(inVault())
    await screen.findByRole('button', { name: /^Unlock$/ })
    unlockNow()
    expect(await screen.findByText('DB_URL')).toBeTruthy()
    expect(screen.queryByText('ANTHROPIC_API_KEY')).toBeNull()
    expect(screen.queryByText('CLAUDE_CODE_OAUTH_TOKEN')).toBeNull()
    expect(screen.getByText('1 secret')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete ANTHROPIC_API_KEY' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove API key or token' }))
    expect(screen.getByText(/Claude Code is signed out in this vault until you set a new one/)).toBeTruthy()
    expect(vault.deleteSecret).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove and sign out' }))
    await waitFor(() => expect(vault.deleteSecret).toHaveBeenCalledWith('folder:alpha', 'ANTHROPIC_API_KEY'))
  })

  it('keeps the Secrets rows when the vault locks, with the names hidden', async () => {
    vault.secrets.mockResolvedValue({ ok: true, data: { names: ['DB_URL', 'API_TOKEN'] } })
    renderSection(inVault())
    await screen.findByRole('button', { name: /^Unlock$/ })
    unlockNow()
    expect(await screen.findByText('DB_URL')).toBeTruthy()
    const before = within(screen.getByRole('list', { name: 'Secrets' })).getAllByRole('listitem').length
    lockNow()
    await screen.findByText('2 secrets · names hidden while locked')
    expect(screen.queryByText('DB_URL')).toBeNull()
    const rows = within(screen.getByRole('list', { name: 'Secrets' })).getAllByRole('listitem')
    expect(rows.length).toBe(before)
    for (const row of rows) expect(row.className).toContain('min-h-[30px]')
  })

  it('opens one edit form at a time', async () => {
    status = { ...status, state: 'unlocked', until: Date.now() + 60_000 }
    renderSection(inVault())
    await screen.findByText('10 GB · 2.4 GB used')
    const add = await screen.findByRole('button', { name: 'Add' })
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true)
    expect((add as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /^(Set|Replace) API key or token$/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says so in an open form that needs the vault when it locks, and keeps what was typed', async () => {
    renderSection(inVault())
    await screen.findByRole('button', { name: /^Unlock$/ })
    unlockNow()
    const add = await screen.findByRole('button', { name: 'Add' })
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(add)
    fireEvent.change(screen.getByRole('textbox', { name: 'Secret name' }), { target: { value: 'NEW_KEY' } })
    lockNow()
    expect(await screen.findByText('Locked — unlock to save.')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Secret name' }) as HTMLInputElement).value).toBe('NEW_KEY')
    const save = screen.getAllByRole('button', { name: 'Save' }).find((b) => b.closest('form')?.contains(screen.getByRole('textbox', { name: 'Secret name' })))!
    expect((save as HTMLButtonElement).disabled).toBe(true)
  })

  it('names the toolchain by engine, with an update badge naming the pinned versions', async () => {
    vault.runtimes.mockResolvedValue({
      ok: true,
      data: [
        { engine: 'claude', version: '2.1.318-host', kind: 'executable', pinned: '2.1.319' },
        { engine: 'claude', version: '0.101.0-b009fefc', kind: 'adapter', pinned: '0.101.0-b009fefc' }
      ]
    })
    status = { ...status, state: 'unlocked', until: Date.now() + 60_000 }
    renderSection(inVault())
    expect(await screen.findByText(/^Claude Code 2\.1\.318 · adapter 0\.101\.0$/)).toBeTruthy()
    const badge = screen.getByText('Update available')
    expect(badge.getAttribute('title')).toBe('Update dependencies installs Claude Code 2.1.319.')
  })
})
