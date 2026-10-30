import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react'
import { StrictMode, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentsHomeStore } from '../stores/agentsHome.store'
import { useAgentsHomeSettling, useCreateAgentsHomeOnOpen } from './useLocalAgents'

/**
 * A list read never creates the agents home, so the Agents tab creates a
 * missing one when it opens — once per window, and only when nothing has to be
 * asked first. StrictMode, refetches and a second mounted surface must not
 * turn that into a second request, and a guarded home stays a button.
 */

type Snapshot = { roots: unknown[]; agents: unknown[]; homeAccess: string; homeMissing: boolean; homePath: string }

const HOME = '/home/u/CinnaAgents'
let snapshot: Snapshot
const list = vi.fn(async () => snapshot)
const homeGrant = vi.fn(async () => {
  snapshot = { ...snapshot, homeMissing: false }
  return { path: '/home/u/CinnaAgents', access: 'ready', guarded: false }
})

beforeEach(() => {
  snapshot = { roots: [], agents: [], homeAccess: 'ready', homeMissing: true, homePath: HOME }
  list.mockClear()
  homeGrant.mockClear()
  useAgentsHomeStore.setState({ autoCreate: null, ask: null, dismissed: [] })
  ;(window as unknown as { api: unknown }).api = { localAgents: { list, homeGrant, roots: vi.fn(async () => []) } }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

const settled: boolean[] = []
function Probe(): null {
  useCreateAgentsHomeOnOpen()
  settled.push(useAgentsHomeSettling())
  return null
}

function mount(times = 1): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const probes = Array.from({ length: times }, (_, i) => createElement(Probe, { key: i }))
  render(createElement(StrictMode, null, createElement(QueryClientProvider, { client }, ...probes)))
}

describe('useCreateAgentsHomeOnOpen', () => {
  it('creates a missing, ready home once, even under StrictMode with two surfaces', async () => {
    settled.length = 0
    mount(2)
    await waitFor(() => expect(useAgentsHomeStore.getState().autoCreate).toEqual({ path: HOME, state: 'done' }))
    expect(homeGrant).toHaveBeenCalledTimes(1)
    // Settling until the lists came back with the answer, then not.
    expect(settled[0]).toBe(true)
    expect(settled[settled.length - 1]).toBe(false)
  })

  it('does not ask again in the same window for the same home', async () => {
    useAgentsHomeStore.setState({ autoCreate: { path: HOME, state: 'done' } })
    mount()
    await waitFor(() => expect(list).toHaveBeenCalled())
    await act(async () => {})
    expect(homeGrant).not.toHaveBeenCalled()
  })

  it('creates once more when the home moved to a different, missing path', async () => {
    useAgentsHomeStore.setState({ autoCreate: { path: '/home/u/Old', state: 'done' } })
    settled.length = 0
    mount()
    await waitFor(() => expect(useAgentsHomeStore.getState().autoCreate).toEqual({ path: HOME, state: 'done' }))
    expect(homeGrant).toHaveBeenCalledTimes(1)
    expect(settled[settled.length - 1]).toBe(false)
  })

  it('never creates a guarded home nobody has explained, nor one that exists', async () => {
    snapshot = { ...snapshot, homeAccess: 'needs_consent' }
    mount()
    await waitFor(() => expect(list).toHaveBeenCalled())
    await act(async () => {})
    expect(homeGrant).not.toHaveBeenCalled()

    snapshot = { roots: [], agents: [], homeAccess: 'ready', homeMissing: false, homePath: HOME }
    mount()
    await act(async () => {})
    expect(homeGrant).not.toHaveBeenCalled()
  })

  it('reports a refusal through the list, without raising the folder modal', async () => {
    homeGrant.mockImplementationOnce(async () => {
      snapshot = { ...snapshot, homeAccess: 'denied' }
      return { path: '/home/u/CinnaAgents', access: 'denied', guarded: false }
    })
    mount()
    await waitFor(() => expect(useAgentsHomeStore.getState().autoCreate).toEqual({ path: HOME, state: 'done' }))
    expect(useAgentsHomeStore.getState().ask).toBeNull()
  })
})
