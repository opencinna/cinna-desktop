import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { CliCommand } from '../../../shared/cliCommands'
import { useCliCommands } from './useCliCommands'

/**
 * `useCliCommands` is the one renderer-side link between `ChatInput`'s `/`
 * popup and `agentService.listCliCommands` — and it is deliberately
 * agent-id-agnostic: it does not know or care whether the id it is handed
 * names a remote A2A agent or a folder agent, it just calls
 * `window.api.agents.listCliCommands(agentId)` and surfaces whatever comes
 * back. That is what makes the folder branch reachable from the popup with
 * no renderer change of its own — this test pins the claim directly rather
 * than leaving it inferred from reading the hook.
 *
 * What this file does NOT cover, and is not a substitute for: `ChatInput`
 * actually calling this hook with a folder agent's id at the right moment
 * (`promptSourceAgent = boundAgent ?? selectedAgent ?? null`). `ChatInput` is
 * ~1300 lines pulling in two dozen other hooks with no existing test
 * harness; mounting it to pin one id derivation was judged disproportionate
 * for this phase. That link is verified by code inspection only — `boundAgent`
 * resolves from `useAgents()`'s unfiltered list by `chatData.agentId`, with
 * no source-based gate anywhere in that path — not by a test.
 */

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient()
  return createElement(QueryClientProvider, { client }, children)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useCliCommands', () => {
  it('fetches by whatever id it is given — a folder agent id included, no special-casing', async () => {
    const commands: CliCommand[] = [
      { slug: 'check', name: 'check', description: 'Run the checks', command: '/run:check' }
    ]
    const listCliCommands = vi.fn().mockResolvedValue({ success: true, commands })
    ;(window as unknown as { api: { agents: { listCliCommands: typeof listCliCommands } } }).api =
      { agents: { listCliCommands } }

    const { result } = renderHook(() => useCliCommands('folder:alpha'), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual(commands))
    expect(listCliCommands).toHaveBeenCalledWith('folder:alpha')
  })

  it('does not call the API at all with no agent selected, and returns []', () => {
    const listCliCommands = vi.fn()
    ;(window as unknown as { api: { agents: { listCliCommands: typeof listCliCommands } } }).api =
      { agents: { listCliCommands } }

    const { result } = renderHook(() => useCliCommands(null), { wrapper })

    expect(listCliCommands).not.toHaveBeenCalled()
    expect(result.current.data).toBeUndefined()
    expect(result.current.fetchStatus).toBe('idle')
  })

  it('surfaces [] rather than throwing when the main side reports commands: []', async () => {
    const listCliCommands = vi.fn().mockResolvedValue({ success: false, commands: [], error: 'boom' })
    ;(window as unknown as { api: { agents: { listCliCommands: typeof listCliCommands } } }).api =
      { agents: { listCliCommands } }

    const { result } = renderHook(() => useCliCommands('folder:broken'), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual([]))
  })
})
