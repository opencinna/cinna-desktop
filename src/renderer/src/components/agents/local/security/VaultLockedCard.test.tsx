import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import type { VaultAgentDetailsDto, VaultStatusDto } from '../../../../../../shared/vault/types'
import { VaultLockedCard } from './VaultLockedCard'
import { VaultOverview } from '../VaultOverview'
import { VaultCredentialsTab } from '../ServiceCredentialsTab'

/**
 * A vault agent's Overview and Credentials: one locked card with Unlock while
 * the vault is locked, one line while its details are read or when the read
 * failed, and the cards fed from the vault, read-only, once they are in.
 */

let status: VaultStatusDto
let details: VaultAgentDetailsDto
const vault = {
  status: vi.fn(async () => ({ ok: true, data: status })),
  unlock: vi.fn(async (): Promise<unknown> => ({ ok: true, data: { ...status, state: 'unlocked' } })),
  agentDetails: vi.fn(async (): Promise<unknown> => ({ ok: true, data: details }))
}
const localAgents = {
  readDoc: vi.fn(async () => { throw new Error('a vault agent has no folder to read') }),
  openPath: vi.fn()
}

beforeEach(() => {
  status = {
    agentId: 'folder:alpha', vaultId: 'v1', agentName: 'Alpha', engine: 'claude', state: 'locked', until: null,
    lockAfterMs: 300_000, sizeBytes: 10 * 1024 ** 3, usedBytes: null, egress: { hosts: [] },
    createdAt: 0, imageVersion: '1.0.0', error: null
  }
  details = {
    manifest: { name: 'Alpha', description: 'Balances the books.', example_prompts: ['What is owed?'] },
    description: 'Balances the books.',
    status: { summary: 'All balanced', state: 'healthy', updatedAt: '2026-11-18', body: '' },
    docs: {
      workflow: { relPath: 'docs/WORKFLOW_PROMPT.md', text: 'Reconcile every account.' },
      entrypoint: null,
      refiner: { relPath: 'docs/REFINER_PROMPT.md', text: 'Default to this month.' }
    },
    credentials: [{
      name: 'bank', type: 'api_token', optional: false, envPrefix: 'BANK_', serviceUri: null,
      expectedKeys: ['BANK_API_TOKEN'], presentKeys: ['BANK_API_TOKEN'], overlappingKeys: [], attachment: null, satisfied: true
    }],
    launch: { kind: 'kit', model: null, approval: 'ask' }
  }
  ;(window as unknown as { api: unknown }).api = { vault, localAgents }
  vi.clearAllMocks()
})
afterEach(() => cleanup())

function agent(state: 'locked' | 'unlocked'): LocalAgentDto {
  return {
    id: 'folder:alpha', name: 'Alpha', path: '', kind: 'kit', description: '', manifest: {}, status: null, credentials: [],
    stamps: {}, vault: { vaultId: 'v1', state, engine: 'claude', model: null }
  } as unknown as LocalAgentDto
}

/** `retries`: the app's own default (three, here without the delay), for a test about not retrying. */
function renderWith(element: ReactElement, retries = false): void {
  const client = new QueryClient({ defaultOptions: { queries: retries ? { retry: 3, retryDelay: 0 } : { retry: false } } })
  render(createElement(QueryClientProvider, { client }, element))
}

describe('VaultLockedCard', () => {
  it('says the details are in the locked vault and unlocks it, with a spinner in the button meanwhile', async () => {
    let finish: (value: unknown) => void = () => {}
    vault.unlock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    renderWith(createElement(VaultLockedCard, { agent: agent('locked') }))
    expect(screen.getByText('Alpha’s details are inside its locked vault.')).toBeTruthy()
    expect(screen.getByText('Unlock it to read them here.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(vault.unlock).toHaveBeenCalledWith('folder:alpha'))
    const button = await screen.findByRole('button', { name: 'Unlocking…' })
    expect(button.getAttribute('aria-busy')).toBe('true')
    // A second press while it runs starts nothing.
    fireEvent.click(button)
    expect(vault.unlock).toHaveBeenCalledTimes(1)
    finish({ ok: true, data: { ...status, state: 'unlocked' } })
  })

  it('says a refused unlock in full under the row, wrapped, with the hint line kept', async () => {
    vault.unlock.mockResolvedValueOnce({ ok: false, code: 'denied', message: 'Cancelled.' })
    renderWith(createElement(VaultLockedCard, { agent: agent('locked') }))
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Unlock was cancelled at the prompt.')
    // The reserved line keeps its words, so nothing above the refusal moves.
    expect(screen.getByText('Unlock it to read them here.')).toBeTruthy()
  })

  it('never cuts a long refusal: it wraps, outside the one-line row', async () => {
    const long = 'The vault helper could not start the virtual machine because another vault is still shutting down; try again in a minute or quit other apps that use virtualization.'
    vault.unlock.mockResolvedValueOnce({ ok: false, code: 'internal', message: long })
    renderWith(createElement(VaultLockedCard, { agent: agent('locked') }))
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(long)
    expect(alert.className).not.toContain('truncate')
    expect(alert.closest('[data-vault-locked-card]')).toBeNull()
  })

  it('draws Unlock with the vault’s fixed-width label, so pressing it never widens it', () => {
    renderWith(createElement(VaultLockedCard, { agent: agent('locked') }))
    const button = screen.getByRole('button', { name: 'Unlock' })
    // `VaultUnlockLabel`: the fixed-width cell, and the longest label it may show, reserved unseen.
    expect(button.querySelector('.min-w-\\[6\\.5rem\\]')).not.toBeNull()
    expect(button.textContent).toContain('Unlocking… 100%')
  })
})

describe('a vault agent’s Overview', () => {
  it('is the one locked card while the vault is locked, and reads nothing', async () => {
    renderWith(createElement(VaultOverview, { agent: agent('locked') }))
    expect(await screen.findByText('Alpha’s details are inside its locked vault.')).toBeTruthy()
    expect(screen.queryByText('Status')).toBeNull()
    expect(vault.agentDetails).not.toHaveBeenCalled()
    expect(localAgents.readDoc).not.toHaveBeenCalled()
  })

  it('shows the vault’s status, description, prompts and documents read-only once unlocked', async () => {
    status = { ...status, state: 'unlocked' }
    renderWith(createElement(VaultOverview, { agent: agent('unlocked') }))
    expect(await screen.findByText('Read-only while the agent is in a vault.')).toBeTruthy()
    expect(screen.getByText('All balanced')).toBeTruthy()
    expect(screen.getByText('Balances the books.')).toBeTruthy()
    expect(screen.getByText('What is owed?')).toBeTruthy()
    expect(screen.getByText('Reconcile every account.')).toBeTruthy()
    expect(screen.getByText('Default to this month.')).toBeTruthy()
    // The one document the vault folder lacks says so, not "add it with your assistant".
    expect(screen.getByText('The agent’s folder in the vault has no such file.')).toBeTruthy()
    expect(screen.queryByText(/This file is not in the folder/)).toBeNull()
    expect(screen.getByText('No router trigger.')).toBeTruthy()
    // How to edit the prompts list has nothing to say where it can't be edited.
    expect(screen.queryByText(/One per line\./)).toBeNull()
    // Nothing to reveal and nothing to edit: the file names are plain text.
    expect(screen.queryByTitle(/^Reveal /)).toBeNull()
    fireEvent.click(screen.getByText('Reconcile every account.'))
    expect(document.querySelector('textarea')).toBeNull()
    expect(localAgents.readDoc).not.toHaveBeenCalled()
  })

  it('says it is reading in one line, then a failed read in one line', async () => {
    status = { ...status, state: 'unlocked' }
    let answer: (value: unknown) => void = () => {}
    vault.agentDetails.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    renderWith(createElement(VaultOverview, { agent: agent('unlocked') }), true)
    expect(await screen.findByText('Reading from the vault…')).toBeTruthy()
    answer({ ok: false, code: 'internal', message: 'The vault did not answer in time.' })
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t read from the vault. The vault did not answer in time.')
    // A vault refusal is an answer: asked once, not retried into a long "Reading…".
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vault.agentDetails).toHaveBeenCalledTimes(1)
  })

  it('offers Retry on a failed read, which reads again', async () => {
    status = { ...status, state: 'unlocked' }
    vault.agentDetails.mockResolvedValueOnce({ ok: false, code: 'internal', message: 'The vault did not answer in time.' })
    renderWith(createElement(VaultOverview, { agent: agent('unlocked') }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('All balanced')).toBeTruthy()
    expect(vault.agentDetails).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a vault agent’s Credentials', () => {
  it('is the one locked card while the vault is locked', async () => {
    renderWith(createElement(VaultCredentialsTab, { agent: agent('locked') }))
    expect(await screen.findByText('Alpha’s details are inside its locked vault.')).toBeTruthy()
    expect(screen.queryByText('Attached Credentials')).toBeNull()
  })

  it('lists the declared slots from the vault, read-only, and offers no attach', async () => {
    status = { ...status, state: 'unlocked' }
    renderWith(createElement(VaultCredentialsTab, { agent: agent('unlocked') }))
    expect(await screen.findByText('bank')).toBeTruthy()
    expect(screen.getByText('BANK_API_TOKEN ✓')).toBeTruthy()
    expect(screen.queryByText('This agent declares no credentials.')).toBeNull()
    // Said once, in the card's footnote: no section that holds only that sentence.
    expect(screen.getByText(/attaching or detaching now doesn’t change what it has/)).toBeTruthy()
    expect(screen.queryByText('Attached Credentials')).toBeNull()
    expect(screen.queryByRole('button', { name: /Attach/ })).toBeNull()
    expect(screen.queryByTitle(/Open credentials\/\.env/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
