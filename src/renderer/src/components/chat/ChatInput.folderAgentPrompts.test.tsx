import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

/**
 * `#` example prompts reach a folder agent.
 *
 * The composer sources them from `agent.remoteMetadata.example_prompts` through
 * `extractExamplePrompts`, a field built for agents synced from a Cinna backend.
 * A folder agent carried `remoteMetadata: null`, so `#` rendered nothing for it
 * — not because anything filtered folder agents out of this path (`boundAgent`
 * and `selectedAgent` both come from the *unfiltered* agents list), but because
 * there was no data to find. Synthesizing the metadata from the folder's
 * manifest is what fills it in.
 *
 * This file pins the half that is about the renderer: given a folder agent that
 * *has* the metadata, the popup opens and offers its prompts. It deliberately
 * supplies the metadata directly rather than going through the synthesis, so a
 * failure here means the composer path broke, not that the synthesis did.
 *
 * **Two gates guard the empty case, and each survives its own deletion.** The
 * last two tests assert that `#` opens nothing for an agent with no prompts.
 * That behaviour is defended twice — `promptGate` (`ChatInput.tsx`, the trigger
 * handler: `token.char === '#' && examplePrompts.length > 0`, which decides
 * whether `triggerChar` is set at all) and `promptPopupOpen` (`triggerChar ===
 * '#' && examplePrompts.length > 0`, which decides whether the popup renders).
 * Mutation-checked: deleting the length half of *either* one alone leaves these
 * four tests **passing**, because the other still holds the line; deleting both
 * fails the last two. So the behaviour is covered and **neither individual gate
 * is** — do not read a green suite as licence to remove one of them. This is
 * recorded rather than fixed: the redundancy predates this work, and collapsing
 * it would mean changing shared composer control flow for every trigger char to
 * make a test sharper.
 */

const api: Record<string, unknown> = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (ns === 'agents') {
        return {
          list: async () => [],
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

function folderAgent(examplePrompts: unknown): Record<string, unknown> {
  return {
    id: 'folder:alpha',
    name: 'Invoice Checker',
    description: 'Checks invoices.',
    protocol: 'local-folder',
    cardUrl: null,
    endpointUrl: null,
    protocolInterfaceUrl: null,
    protocolInterfaceVersion: null,
    hasAccessToken: false,
    cardData: null,
    skills: null,
    enabled: true,
    source: 'folder',
    remoteTargetType: null,
    remoteTargetId: null,
    remoteMetadata:
      examplePrompts === undefined
        ? null
        : {
            entrypoint_prompt: null,
            example_prompts: examplePrompts,
            session_mode: null,
            ui_color_preset: null,
            protocol_versions: []
          },
    localPath: '/w/Local/invoice-checker',
    localRootId: 'r1',
    createdAt: new Date('2026-01-01T00:00:00Z')
  }
}

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

/** Mount the new-chat composer with this agent selected and type `#`. */
function typeHash(agent: Record<string, unknown> | null): void {
  render(
    createElement(ChatInput, {
      chatId: null,
      selectedAgent: agent as never,
      onTogglePendingAgent: () => undefined
    }),
    { wrapper }
  )
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '#' } })
}

describe('`#` prompts for a folder agent', () => {
  it('offers every prompt the folder’s manifest supplied', () => {
    typeHash(folderAgent(['dad-joke: tell me a dad joke', 'summarise my inbox']))
    // `getAllByText` because an unlabelled prompt renders as both its own tag
    // and its own body text — one entry, two nodes.
    expect(screen.getAllByText('summarise my inbox').length).toBeGreaterThan(0)
    expect(screen.getByText('dad-joke')).toBeTruthy()
  })

  it('splits a `label: prompt` entry into a short tag, as it does for a remote agent', () => {
    // `extractExamplePrompts` is shared with remote agents and folder agents get
    // no separate treatment — this asserts they reach the same code, not a copy.
    typeHash(folderAgent(['dad-joke: tell me a dad joke']))
    expect(screen.getByText('dad-joke')).toBeTruthy()
  })

  it('opens no popup for a folder agent whose manifest listed none', () => {
    // The state before the synthesis, and still the state for a manifest with
    // no `example_prompts`: `promptPopupOpen` is gated on a non-empty list, so
    // `#` stays plain text rather than opening an empty menu.
    typeHash(folderAgent([]))
    expect(screen.queryByText('dad-joke')).toBeNull()
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false')
  })

  it('opens no popup when the agent carries no metadata at all', () => {
    // `remoteMetadata: null` — every folder row before the synthesis lands, and
    // any row whose scan has not caught up yet.
    typeHash(folderAgent(undefined))
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false')
  })
})
