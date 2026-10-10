import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryAgentDto } from '../../../../shared/agentSharing'

/**
 * A blocked job's unavailable folder dependency offers "Get X from the team
 * library" only when the library has an agent with that manifest id and this
 * machine has no copy of it. Get runs the library's own Get; its pending label
 * is inline, a refusal sits beside the button, and success re-reads the job.
 */

const { TeamLibraryGet } = await import('./TeamLibraryGet')
const { useAuthStore } = await import('../../stores/auth.store')
const { SHARE_REFUSAL_TEXT, SHARE_UI_TEXT } = await import('../../utils/shareText')

function libraryAgent(overrides: Partial<LibraryAgentDto> = {}): LibraryAgentDto {
  return {
    uuid: 'item-1',
    bundleId: 'test.core.item1',
    repoId: 'r-payroll',
    slug: 'payroll',
    name: 'Payroll Checker',
    description: '',
    cloneUrl: 'https://core.test/git/r-payroll.git',
    headSha: 'a',
    access: 'use',
    visibility: 'users',
    isListed: true,
    maintainers: [],
    engine: null,
    manifestId: 'm-1',
    latest: { number: 1, publishedAt: '2026-10-01T00:00:00Z', publishedBy: null, releaseNotes: null },
    localAgentId: null,
    updateAvailable: false,
    ...overrides
  }
}

let library: ReturnType<typeof vi.fn>
let get: ReturnType<typeof vi.fn>

beforeEach(() => {
  useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user', username: 'u', displayName: 'U', hasPassword: false } as never })
  library = vi.fn().mockResolvedValue({ success: true, value: { host: 'h', agents: [libraryAgent()], fetchedAt: 'now' } })
  get = vi.fn()
  ;(window as unknown as { api: unknown }).api = { sharing: { library, get } }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function mount(manifestId = 'm-1'): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(createElement(QueryClientProvider, { client }, createElement(TeamLibraryGet, { jobId: 'job-1', manifestId })))
  // Settled either way, so "offers nothing" is about the data, not the timing.
  await waitFor(() => expect(client.getQueryState(['sharing', 'library', 'p1'])?.status).toBe('success'))
  return client
}

const LABEL = SHARE_UI_TEXT.getFromLibrary('Payroll Checker')

describe('TeamLibraryGet', () => {
  it('offers Get for a library agent with the dependency’s manifest id', async () => {
    await mount()
    expect(screen.getByRole('button', { name: LABEL })).toBeTruthy()
  })

  it('offers nothing when the manifest id is not in the library', async () => {
    await mount('m-other')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers nothing when this machine already has the agent', async () => {
    library.mockResolvedValue({ success: true, value: { host: 'h', agents: [libraryAgent({ localAgentId: 'folder:m-1' })], fetchedAt: 'now' } })
    await mount()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers nothing on a profile without a Team library', async () => {
    library.mockResolvedValue({ success: true, value: null })
    await mount()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('gets it, shows Getting… inline, and re-reads the job on success', async () => {
    let resolve: (value: unknown) => void = () => {}
    get.mockReturnValue(new Promise((r) => { resolve = r }))
    const client = await mount()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: LABEL }))
    })
    expect(get).toHaveBeenCalledWith('r-payroll')
    expect(screen.getByRole('button', { name: SHARE_UI_TEXT.getting })).toBeTruthy()
    await act(async () =>
      resolve({ success: true, value: { done: true, refusal: null, detail: null, status: null, agentId: 'folder:m-1' } })
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['jobs', 'job-1'] })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a refusal beside the button, which stays', async () => {
    get.mockResolvedValue({
      success: true,
      value: { done: false, refusal: 'exists', detail: 'Payroll', status: null, agentId: null }
    })
    await mount()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: LABEL }))
    })
    expect(screen.getByRole('alert').textContent).toContain('Payroll')
    expect(screen.getByRole('button', { name: LABEL })).toBeTruthy()

    get.mockResolvedValue({ success: true, value: { done: false, refusal: 'fetch_failed', detail: null, status: null, agentId: null } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: LABEL }))
    })
    expect(screen.getByRole('alert').textContent).toBe(SHARE_REFUSAL_TEXT.fetch_failed)
  })
})
