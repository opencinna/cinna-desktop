import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import type { StoredPermissionGrant } from '../../../../../shared/localAgentRequests'
import { PermissionsCard } from './PermissionsCard'

/**
 * The card that says what the agent may do — and the only place a decision the
 * user made in a chat can be taken back.
 *
 * The revoke path is what is actually tested here, because it is the half that
 * can lie: a list that keeps showing a rule that is gone, or a refusal that
 * disappears with the row that raised it, both leave the user believing the
 * agent will ask again when it will not.
 */

const grantsList = vi.fn<() => Promise<StoredPermissionGrant[]>>()
const grantForget = vi.fn<() => Promise<StoredPermissionGrant[]>>()
const grantsClear = vi.fn<() => Promise<StoredPermissionGrant[]>>()
;(window as unknown as { api: unknown }).api = {
  localAgents: { grantsList, grantForget, grantsClear }
}

const agent = { id: 'folder:alpha', name: 'Alpha' } as LocalAgentDto

const grant = (over: Partial<StoredPermissionGrant> = {}): StoredPermissionGrant => ({
  key: 'webfetch::https://docs.example.com/*',
  action: 'webfetch',
  pattern: 'https://docs.example.com/*',
  scope: 'origin',
  decidedAt: Date.now(),
  ...over
})

function renderCard(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    createElement(QueryClientProvider, { client }, createElement(PermissionsCard, { agent }))
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('PermissionsCard', () => {
  it('says what the agent may do without asking, even with nothing remembered', () => {
    // The default profile changed — an agent now works freely inside its own
    // folder — and a user who notices it stopped asking has to be able to find
    // out why on the agent's own page. Mutation: render the sentence only when
    // there are grants fails this.
    grantsList.mockResolvedValue([])
    renderCard()
    expect(screen.getByText(/runs commands inside its own folder without asking/)).toBeTruthy()
    // **And the limit of that, in the same breath.** The profile allows the
    // shell tool outright and the engine gates a command by its text, not by
    // what it touches — so the file-tool denies above do not hold for a
    // command, and a card that implied they did would be the most misleading
    // sentence in the app. Mutation: delete this paragraph and the card claims
    // a boundary the engine does not enforce.
    expect(screen.getByText(/a command can reach anything you can/)).toBeTruthy()
  })

  it("says when the folder's own manifest replaces part of the profile", async () => {
    // `runtime.permissions` in `cinna-agent.json` replaces whole entries of the
    // generated profile, so the sentence above the list stops being the whole
    // truth wherever it is used. Mutation: render the sentence unconditionally
    // fails this — the card would describe rules that are not in force.
    grantsList.mockResolvedValue([])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PermissionsCard, {
          agent: {
            ...agent,
            runtime: { permissions: { webfetch: 'allow', bash: { '*': 'allow' } } }
          } as LocalAgentDto
        })
      )
    )
    // The keys, not just the warning: "some of these rules may be wrong" tells
    // the user the paragraph above is unreliable and nothing else (ux_rules §7).
    // Mutation: render a bare "some of those rules" fails this.
    expect(screen.getByText(/replaces the rules for/)).toBeTruthy()
    expect(screen.getByText('bash, webfetch')).toBeTruthy()
  })

  it('does not claim an override when the manifest declares none', () => {
    grantsList.mockResolvedValue([])
    renderCard()
    expect(screen.queryByText(/replaces some of those rules/)).toBeNull()
  })

  it('does not say "nothing yet" while it is still reading', async () => {
    // `undefined` and `[]` are different answers: collapsing them made the card
    // claim this agent has no standing permissions for the round trip it takes
    // to find out (ux_rules §1). Mutation: `const rows = grants ?? []` with no
    // `loading` branch fails this.
    let release: (grants: StoredPermissionGrant[]) => void = () => {}
    grantsList.mockReturnValue(new Promise((resolve) => (release = resolve)))
    renderCard()

    expect(screen.getByText('Reading…')).toBeTruthy()
    expect(screen.queryByText(/Nothing yet/)).toBeNull()
    release([])
    expect(await screen.findByText(/Nothing yet/)).toBeTruthy()
  })

  it('lists a remembered decision with the pattern it actually covers', async () => {
    grantsList.mockResolvedValue([grant()])
    renderCard()
    // The pattern, not the URL that produced it: a user revoking a grant needs
    // to see the scope they are revoking.
    expect(await screen.findByText('https://docs.example.com/*')).toBeTruthy()
    // A space between the phrase and the pattern in the *text*, not only in the
    // margin: they are adjacent inline expressions, so without it the row reads
    // "Fetch from the webhttps://docs.example.com/*" to anything that consumes
    // `textContent` — a screen reader, or an E2E assertion.
    const row = screen.getByText('https://docs.example.com/*').parentElement
    expect(row?.textContent).toContain('Fetch from the web https://docs.example.com/*')
  })

  it('drops the row from the list the moment it is forgotten', async () => {
    // The handler answers with the list it leaves, and that list is written
    // straight into the cache. Mutation: ignore the response and rely on a
    // refetch fails this — the revoked row stays on screen until the refetch
    // lands, which is exactly when the user is deciding whether it worked.
    grantsList.mockResolvedValue([grant()])
    grantForget.mockResolvedValue([])
    renderCard()

    fireEvent.click(await screen.findByLabelText(/Forget permission to fetch from the web/))
    await waitFor(() => expect(screen.queryByText('https://docs.example.com/*')).toBeNull())
    expect(screen.getByText(/Nothing yet/)).toBeTruthy()
  })

  it('keeps a refusal on screen after the row that raised it is gone', async () => {
    // The mutation is owned by the card, not by the row: a row unmounts on
    // success, and an error handler owned there would be dropped with it —
    // `ux_rules.md` §5, and the same lesson as the delete dialog. Mutation:
    // move `useForgetAgentGrants` into the row component fails this.
    grantsList.mockResolvedValue([grant()])
    grantForget.mockRejectedValue(new Error('That agent folder is no longer there.'))
    renderCard()

    fireEvent.click(await screen.findByLabelText(/Forget permission to fetch from the web/))
    // The outcome leads. The message from main names the file that would not
    // take the write; what the user needs first is that the rule is still in
    // force (ux_rules §6, and §5's "nothing was removed"). Mutation: render
    // `unwrapIpcError(err)` alone fails this.
    expect(
      await screen.findByText(/Nothing was forgotten — that agent folder is no longer there\./)
    ).toBeTruthy()
  })
})
