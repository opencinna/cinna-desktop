import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The composer's `?` note picker follows Notes (Settings → Features →
 * Capabilities): with Notes off, `?` is ordinary text even when the profile
 * has notes. Driven through the real `useCapabilities` over a scripted
 * `settings.getAll`, so main's `'unset'` is covered as off too.
 *
 * Two gates hold the line (`noteGate` in the trigger handler, `notePopupOpen`
 * at render) — the same redundancy `ChatInput.folderAgentPrompts.test.tsx`
 * records for `#` — so a mutation check has to drop the Notes half of both.
 */

let notesCapability = 'on'
const getAll = vi.fn(async () => ({ notesCapability, dashboardsCapability: 'off' }))
const listNotes = vi.fn(async () => [
  { id: 'n1', title: 'Quarterly plan', body: '', folderId: null, position: 0, createdAt: new Date(0), updatedAt: new Date(0) }
])

const api: Record<string, unknown> = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (ns === 'agents') {
        return {
          list: async () => [],
          onRemoteSyncComplete: () => () => undefined,
          onReadinessChanged: () => () => undefined,
          checkReadiness: async () => null,
          listCliCommands: async () => []
        }
      }
      if (ns === 'settings') return { getAll }
      if (ns === 'notes') {
        return new Proxy({}, { get: (_t2, method: string) => (method === 'list' ? listNotes : method.startsWith('on') ? () => () => undefined : async () => []) })
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

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

/** Mount the new-chat composer, wait for notes and settings, and type `?`. */
async function typeQuestionMark(): Promise<() => void> {
  const { unmount } = render(createElement(ChatInput, { chatId: null, selectedAgent: null }), { wrapper })
  await waitFor(() => {
    expect(listNotes).toHaveBeenCalled()
    expect(getAll).toHaveBeenCalled()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '?' } })
  return unmount
}

beforeEach(() => {
  getAll.mockClear()
  listNotes.mockClear()
})

describe('`?` notes in the composer', () => {
  it('offers the profile’s notes while Notes is on', async () => {
    notesCapability = 'on'
    await typeQuestionMark()
    expect(await screen.findByText('Quarterly plan')).toBeTruthy()
  })

  it('opens nothing while Notes is off, or not decided yet', async () => {
    for (const state of ['off', 'unset']) {
      notesCapability = state
      const unmount = await typeQuestionMark()
      expect(screen.queryByText('Quarterly plan')).toBeNull()
      unmount()
    }
  })
})
