import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * A folder agent is offered in the composer's `@`-mention picker.
 *
 * The sibling claim to `JobEditForm.agentPicker.test.tsx`: these were the two
 * call sites of `canBeCounterparty`, the temporary `source !== 'folder'`
 * exclusion deleted once Phase 6's local runner could serve one. The predicate
 * that remains is `a.enabled` alone, and the third test here is the one that
 * can tell that change from having deleted the whole filter.
 *
 * `ChatInput` is ~1300 lines over two dozen hooks, and 7b judged mounting it
 * disproportionate for pinning one id derivation (see the note in
 * `useCliCommands.test.tsx`). It is worth it here because the picker *is* the
 * behaviour under change — there is nowhere else the claim is observable, and
 * `shared/localAgents.test.ts` no longer has a function to test. The harness
 * cost is kept to one permissive `window.api` stub rather than a mock per hook,
 * so a new hook in `ChatInput` does not break this file.
 */

const agentList = vi.hoisted(() => ({ current: [] as unknown[] }))

/**
 * Every `window.api.<ns>.<method>()` resolves to `[]` unless overridden below.
 * The composer's data hooks only need *a* resolved value to render the list
 * under test; anything that matters to this test is named explicitly.
 */
const api: Record<string, unknown> = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (ns === 'agents') {
        return {
          list: async () => agentList.current,
          onRemoteSyncComplete: () => () => undefined,
          listCliCommands: async () => []
        }
      }
      return new Proxy(
        {},
        {
          get: (_t2, method: string) =>
            method.startsWith('on') ? () => () => undefined : async () => []
        }
      )
    }
  }
)
;(window as unknown as { api: unknown }).api = api

// jsdom implements no layout, so the popup's keyboard-scroll call is absent.
Element.prototype.scrollIntoView = function scrollIntoView(): void {}

const { ChatInput } = await import('./ChatInput')

function agent(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'agent-1',
    name: 'Agent',
    description: null,
    protocol: 'a2a',
    cardUrl: null,
    endpointUrl: null,
    protocolInterfaceUrl: null,
    protocolInterfaceVersion: null,
    hasAccessToken: false,
    cardData: null,
    skills: null,
    enabled: true,
    source: 'local',
    remoteTargetType: null,
    remoteTargetId: null,
    remoteMetadata: null,
    localPath: null,
    localRootId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  }
}

const folderAgent = agent({
  id: 'folder:alpha',
  name: 'Invoice Checker',
  source: 'folder',
  protocol: 'local-folder',
  localPath: '/w/Local/invoice-checker',
  localRootId: 'r1'
})

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Seeded rather than fetched: the `@` popup is driven by the agents query,
  // and seeding it means the list is present on the first render rather than
  // one microtask later — an assertion made before an awaited fetch lands is
  // the shape that has passed against its own mutation in this project before.
  client.setQueryData(['agents'], agentList.current)
  return createElement(QueryClientProvider, { client }, children)
}

/** Type `@` into the composer and return the popup's rendered agent names. */
async function mentionAgents(list: unknown[]): Promise<HTMLElement> {
  agentList.current = list
  render(createElement(ChatInput, { chatId: 'chat-1', onTogglePendingAgent: () => undefined }), {
    wrapper
  })
  const box = screen.getByRole('combobox')
  fireEvent.change(box, { target: { value: '@' } })
  return box as HTMLElement
}

beforeEach(() => {
  agentList.current = []
})

describe('composer @-mention picker', () => {
  it('offers a folder agent', async () => {
    await mentionAgents([folderAgent])
    expect(screen.getByText('Invoice Checker')).toBeTruthy()
  })

  it('offers it alongside the agents that were never excluded', async () => {
    await mentionAgents([folderAgent, agent({ id: 'local-1', name: 'Hand Added' })])
    expect(screen.getByText('Invoice Checker')).toBeTruthy()
    expect(screen.getByText('Hand Added')).toBeTruthy()
  })

  it('still withholds a folder agent the user has switched off', async () => {
    // `enabled` is the user's own toggle and survives a rescan; the exclusion
    // that was deleted was a capability gap the whole app had. Deleting the
    // filter outright would pass the first test and fail this one.
    //
    // The enabled agent is in the list for a second reason: without it, a
    // popup that never opened at all would satisfy the `toBeNull()` and this
    // test would pass while proving nothing. It fires second so the failure
    // message names the withholding, not the harness.
    await mentionAgents([
      { ...folderAgent, enabled: false },
      agent({ id: 'local-1', name: 'Hand Added' })
    ])
    expect(screen.queryByText('Invoice Checker')).toBeNull()
    expect(screen.getByText('Hand Added')).toBeTruthy()
  })
})
