import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import type { StoredPermissionGrant } from '../../../../../shared/localAgentRequests'
import { localAgentKey } from '../../../hooks/useLocalAgents'
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
const setClaudeApproval = vi.fn<() => Promise<unknown>>()
const setHandovers = vi.fn<(agentId: string, handovers: unknown) => Promise<unknown>>()
const handoversCheck = vi.fn<(agentId: string) => Promise<unknown>>()
;(window as unknown as { api: unknown }).api = {
  localAgents: {
    grantsList,
    grantForget,
    grantsClear,
    setClaudeApproval,
    setHandovers,
    handoversCheck
  },
  /**
   * This machine's Default runtime, which the card now reads: an agent whose
   * folder names no engine runs on whatever this says, and the card describes
   * *that* engine's permission system rather than the manifest's silence.
   *
   * The OpenCode runner here, which is what every test below but the Claude
   * ones assumes. A card that could not answer at all is its own state — see
   * the test for it.
   */
  engine: { defaultRuntime: async () => ({ engine: 'opencode' }) }
}

const agent = {
  id: 'folder:alpha',
  name: 'Alpha',
  desktop: { localApiBaseUrl: null, hasAgentToken: false, sessionCount: 0, lastStatusAt: null }
} as LocalAgentDto

/**
 * A bare folder — the one kind with a handovers inbox. `desktop` is spelled out
 * because the card now reads a setting out of it, and every DTO main builds has
 * it: a fixture without one is a shape the app never produces.
 */
const BARE = {
  id: 'folder:external:r1:a',
  name: 'Alpha',
  kind: 'bare',
  instructionsFile: 'CLAUDE.md',
  desktop: { localApiBaseUrl: null, hasAgentToken: false, sessionCount: 0, lastStatusAt: null }
} as LocalAgentDto

/** The same agent on the user's own Claude Code install, with no choice made. */
const claudeAgent = {
  ...agent,
  runtime: { engine: 'claude' },
  desktop: { localApiBaseUrl: null, hasAgentToken: false, sessionCount: 0, lastStatusAt: null, claudeApproval: null }
} as LocalAgentDto

const grant = (over: Partial<StoredPermissionGrant> = {}): StoredPermissionGrant => ({
  key: 'webfetch::https://docs.example.com/*',
  action: 'webfetch',
  pattern: 'https://docs.example.com/*',
  scope: 'origin',
  decidedAt: Date.now(),
  ...over
})

function renderCard(a: LocalAgentDto = agent): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    createElement(QueryClientProvider, { client }, createElement(PermissionsCard, { agent: a }))
  )
}

/**
 * The card as the page renders it: over the agent's own query, so a DTO the
 * save hook writes into the cache reaches the card as a new prop, the way it
 * does in the app. A static prop would hide the half of the round trip where
 * the hook's `setQueryData` is what keeps the control on the picked value.
 */
function LiveCard({ initial }: { initial: LocalAgentDto }): React.JSX.Element | null {
  const { data } = useQuery({ queryKey: localAgentKey(initial.id), queryFn: () => initial })
  return data ? createElement(PermissionsCard, { agent: data }) : null
}

function renderLiveCard(a: LocalAgentDto): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    createElement(QueryClientProvider, { client }, createElement(LiveCard, { initial: a }))
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

/** Git's answer about `.cinna/handovers`, as the outcome the channel returns. */
function gitSays(result: string): { ok: true; value: { result: string } } {
  return { ok: true, value: { result } }
}

describe('PermissionsCard', () => {
  it('says what the agent may do without asking, even with nothing remembered', async () => {
    // The default profile changed — an agent now works freely inside its own
    // folder — and a user who notices it stopped asking has to be able to find
    // out why on the agent's own page. Mutation: render the sentence only when
    // there are grants fails this.
    grantsList.mockResolvedValue([])
    renderCard()
    // **Awaited, because the card will not say whose permission system this is
    // until it knows which runtime the agent uses.** An agent whose folder names
    // no engine runs on this machine's Default runtime, and describing the
    // OpenCode profile before that answer arrives would be a security sentence
    // the card then retracts.
    expect(
      await screen.findByText(/runs commands inside its own folder without asking/)
    ).toBeTruthy()
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
    expect(await screen.findByText(/replaces the rules for/)).toBeTruthy()
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

/**
 * What the card *claims*, for a folder that never agreed to the kit.
 *
 * This card is the user's only statement of what an agent may do to their
 * machine, and they read it about a repository they share with other people.
 * Two of its three examples named files a bare folder does not have, and a
 * reader who spots two fictional examples discounts the third — which is the
 * one that matters, about a command reaching anything they can.
 */
describe('PermissionsCard — a bare agent', () => {
  const bare = BARE

  it('names only files the folder actually has', async () => {
    grantsList.mockResolvedValue([])
    renderCard(bare)
    await waitFor(() => expect(grantsList).toHaveBeenCalled())

    // The file this folder resolved to, not the first name on the list: a
    // `CLAUDE.md` folder told it may not edit "its own AGENT.md" is told about
    // a file it does not have.
    expect(await screen.findByText('CLAUDE.md')).toBeTruthy()
    expect(screen.queryByText('AGENT.md')).toBeNull()
    expect(screen.queryByText('credentials/.env')).toBeNull()
    expect(screen.queryByText(/prompt or manifest/)).toBeNull()
    // The half of the key-file sentence that is true for any folder survives.
    expect(screen.getByText(/any file that looks like a key file/)).toBeTruthy()
  })

  it('does not point at a state file that is not in the folder', async () => {
    grantsList.mockResolvedValue([])
    renderCard(bare)
    await waitFor(() => expect(grantsList).toHaveBeenCalled())

    // Moved under `userData` precisely so a shared working tree stays clean.
    expect(screen.queryByText('app-data/desktop.json')).toBeNull()
    expect(screen.getByText(/Kept on this machine rather than in the folder/)).toBeTruthy()
  })

  it('says the grants are tied to where the folder sits', async () => {
    // They are keyed on the folder's real path, so moving it starts a new agent
    // that is asked again — the same fact the Folder tab states about identity,
    // repeated here because this is the card where the user decided to trust it.
    grantsList.mockResolvedValue([])
    renderCard(bare)
    await waitFor(() => expect(grantsList).toHaveBeenCalled())

    expect(screen.getByText(/moving or renaming it starts a new agent/i)).toBeTruthy()
  })

  it('claims no permission system until it knows which runtime the agent runs on', async () => {
    /**
     * The window this exists for: an agent whose folder names nothing, on a
     * machine whose Default runtime has not been read yet. Whether the CLI's own
     * reviewer or the OpenCode profile governs this agent is the card's whole
     * subject, and a first paint that answers it and is corrected a moment later
     * is worse than one that waits — this is a security surface, and the
     * retraction is of the sentence saying who approves a command.
     *
     * Mutation: defaulting the unread answer to OpenCode fails this.
     */
    grantsList.mockResolvedValue([])
    const api = (window as unknown as { api: { engine: { defaultRuntime: () => Promise<unknown> } } })
      .api
    const answered = api.engine.defaultRuntime
    api.engine.defaultRuntime = () => new Promise(() => {})
    try {
      renderCard()
      expect(screen.getByText(/Reading which runtime this agent uses/)).toBeTruthy()
      expect(screen.queryByText(/runs commands inside its own folder without asking/)).toBeNull()
      // And no Approvals control either: the other branch is just as much a
      // claim about what is in force.
      expect(screen.queryByLabelText('Approvals')).toBeNull()
    } finally {
      api.engine.defaultRuntime = answered
    }
  })

  it('keeps the kit copy for a kit agent', async () => {
    grantsList.mockResolvedValue([])
    renderCard()
    await waitFor(() => expect(grantsList).toHaveBeenCalled())

    expect(await screen.findByText('credentials/.env')).toBeTruthy()
    expect(screen.getByText('app-data/desktop.json')).toBeTruthy()
    expect(screen.queryByText(/Kept on this machine rather than in the folder/)).toBeNull()
  })
})

/**
 * The card for an agent on the Claude engine, where the CLI's own classifier
 * sits in front of the desktop's permission block.
 */
describe('PermissionsCard — an agent on Claude', () => {
  it('describes the classifier rather than the OpenCode profile, and offers the choice', async () => {
    grantsList.mockResolvedValue([])
    renderCard(claudeAgent)
    // The OpenCode profile's sentence describes rules that are not in force
    // on this engine. Mutation: drop the branch and the card claims the agent
    // "runs commands inside its own folder without asking", which on `default`
    // it does not.
    expect(screen.queryByText(/runs commands inside its own folder without asking/)).toBeNull()
    // The blunt sentence. It was watched: the classifier approved a force push
    // and a global git config rewrite, and the callback never fired.
    expect(screen.getByText(/approved everything it was shown/)).toBeTruthy()
    const select = screen.getByLabelText('Approvals') as HTMLSelectElement
    // No choice made reads as the default, not as a blank option.
    expect(select.value).toBe('auto')
    await waitFor(() => expect(grantsList).toHaveBeenCalled())
  })

  it('renders the choice the agent already made', () => {
    grantsList.mockResolvedValue([])
    renderCard({
      ...claudeAgent,
      desktop: { ...claudeAgent.desktop, claudeApproval: 'ask' }
    } as LocalAgentDto)
    expect((screen.getByLabelText('Approvals') as HTMLSelectElement).value).toBe('ask')
  })

  it('saves a change against this agent and renders what came back', async () => {
    grantsList.mockResolvedValue([])
    setClaudeApproval.mockResolvedValue({
      ok: true,
      value: { ...claudeAgent, desktop: { ...claudeAgent.desktop, claudeApproval: 'ask' } }
    })
    renderLiveCard(claudeAgent)
    fireEvent.change(await screen.findByLabelText('Approvals'), { target: { value: 'ask' } })
    // The pick shows at once, for the whole round trip. The select is
    // otherwise controlled by the DTO, which main re-scans the folder before
    // answering — rendering that alone snapped the control back to `auto`
    // until the answer landed, then flipped it (ux_rules §1). Mutation: render
    // the stored value alone fails this.
    expect((screen.getByLabelText('Approvals') as HTMLSelectElement).value).toBe('ask')
    await waitFor(() => expect(setClaudeApproval).toHaveBeenCalledWith('folder:alpha', 'ask'))
    await waitFor(() =>
      expect((screen.getByLabelText('Approvals') as HTMLSelectElement).value).toBe('ask')
    )
  })

  it('keeps the refusal beside the control, and the control where it was', async () => {
    grantsList.mockResolvedValue([])
    setClaudeApproval.mockRejectedValue(new Error('That agent is busy in a chat.'))
    renderCard(claudeAgent)
    fireEvent.change(screen.getByLabelText('Approvals'), { target: { value: 'ask' } })
    // Outcome first, reason second (ux_rules §6). The select renders the DTO,
    // which a failed save left alone, so it reads `auto` again on its own.
    expect(await screen.findByText(/Nothing was changed — that agent is busy in a chat\./)).toBeTruthy()
    expect((screen.getByLabelText('Approvals') as HTMLSelectElement).value).toBe('auto')
  })

  it('offers no such choice to an agent on OpenCode', () => {
    grantsList.mockResolvedValue([])
    renderCard()
    expect(screen.queryByLabelText('Approvals')).toBeNull()
  })
})


/**
 * Whether a brief left in the folder runs without asking.
 *
 * This is the one control on the page that grants **arbitrary code execution
 * from a file anyone who can write to the folder can create** — a `git pull`
 * included (`drafts/file_handovers` §3.4). So the two things worth pinning are
 * that the folder's git state is stated whatever it is, and that `auto` cannot
 * be picked when that state forbids it.
 */
describe('PermissionsCard — handovers', () => {
  it('offers the choice on a bare folder, asking by default', async () => {
    grantsList.mockResolvedValue([])
    handoversCheck.mockResolvedValue(gitSays('ignored'))
    renderCard(BARE)
    const select = (await screen.findByLabelText('Handovers')) as HTMLSelectElement
    // No choice made reads as the safe one, not as a blank option.
    expect(select.value).toBe('ask')
    expect(await screen.findByText('.cinna/handovers is ignored by git')).toBeTruthy()
  })

  it('offers it to no kit agent', async () => {
    // A kit folder is published and Cinna writes into it: a handovers
    // directory there would travel with the kit (§3.8).
    grantsList.mockResolvedValue([])
    renderCard()
    await waitFor(() => expect(grantsList).toHaveBeenCalled())
    expect(screen.queryByLabelText('Handovers')).toBeNull()
    expect(handoversCheck).not.toHaveBeenCalled()
  })

  it('says what git said before anyone clicks, and refuses auto for it', async () => {
    // Mutation: enable the option regardless of the check and this fails —
    // the user picks `auto`, main refuses it, and the reason arrives after
    // the click instead of before it (ux_rules §6).
    grantsList.mockResolvedValue([])
    handoversCheck.mockResolvedValue(gitSays('tracked'))
    renderCard(BARE)
    expect(
      await screen.findByText(
        '.cinna/handovers is tracked by git — automatic runs are unavailable'
      )
    ).toBeTruthy()
    const auto = screen.getByRole('option', { name: 'Run automatically' }) as HTMLOptionElement
    expect(auto.disabled).toBe(true)
  })

  it('shows what would happen, not what is stored, when git overrules auto', async () => {
    /*
      A folder set to `auto` whose handovers git tracks asks anyway — main
      refuses the automatic start. The select used to read "Run automatically"
      directly above a line saying automatic runs are unavailable, so the
      control stated the opposite of what the app would do (`ux_rules.md` §1,
      §7). Mutation: render `stored` instead of the effective value and the
      first expectation fails.
    */
    grantsList.mockResolvedValue([])
    handoversCheck.mockResolvedValue(gitSays('tracked'))
    renderCard({ ...BARE, desktop: { ...BARE.desktop, handovers: 'auto' } })
    // Once git has answered: until then nothing is known that could overrule
    // the stored value, which is the same moment the `auto` option is greyed.
    await waitFor(() =>
      expect(((screen.getByLabelText('Handovers')) as HTMLSelectElement).value).toBe('ask')
    )
    // And the stored setting is not lost — this line is where it still shows.
    const line = await screen.findByText(
      'Run automatically is set but not in force — git tracks .cinna/handovers'
    )
    expect(line.getAttribute('title')).toBe(
      'Run automatically is set but not in force — git tracks .cinna/handovers'
    )
  })

  it('offers a way out of a stored auto git has overruled', async () => {
    /*
      The select shows the effective `ask`, so picking `ask` in it is not a
      change and fires nothing — the stored `auto` stayed, invisible, and came
      back into force the day the folder's .gitignore did. This is the one
      control that clears it. Mutation: remove the button and this fails.
    */
    grantsList.mockResolvedValue([])
    handoversCheck.mockResolvedValue(gitSays('tracked'))
    setHandovers.mockResolvedValue({ ok: true, value: BARE })
    renderLiveCard({ ...BARE, desktop: { ...BARE.desktop, handovers: 'auto' } })

    const clear = await screen.findByRole('button', { name: 'Switch to ask' })
    fireEvent.click(clear)
    await waitFor(() => expect(setHandovers).toHaveBeenCalledWith('folder:external:r1:a', 'ask'))
  })

  it('offers it only where something is actually overruled', async () => {
    grantsList.mockResolvedValue([])
    handoversCheck.mockResolvedValue(gitSays('tracked'))
    renderCard(BARE)
    await screen.findByText('.cinna/handovers is tracked by git — automatic runs are unavailable')
    expect(screen.queryByRole('button', { name: 'Switch to ask' })).toBeNull()
  })

  it('leaves a stored auto alone where git allows it', async () => {
    grantsList.mockResolvedValue([])
    handoversCheck.mockResolvedValue(gitSays('ignored'))
    renderCard({ ...BARE, desktop: { ...BARE.desktop, handovers: 'auto' } })
    expect(((await screen.findByLabelText('Handovers')) as HTMLSelectElement).value).toBe('auto')
    expect(await screen.findByText('.cinna/handovers is ignored by git')).toBeTruthy()
  })

  it('allows auto in a folder that is not a repository at all', async () => {
    // Nothing can arrive by pull, so there is nothing to protect against.
    grantsList.mockResolvedValue([])
    handoversCheck.mockResolvedValue(gitSays('not_a_repo'))
    renderCard(BARE)
    expect(await screen.findByText('Not a git repository')).toBeTruthy()
    expect(
      (screen.getByRole('option', { name: 'Run automatically' }) as HTMLOptionElement).disabled
    ).toBe(false)
  })

  it('treats a git check that failed as a check that forbids auto', async () => {
    /*
      The line would otherwise read "Checking git…" for ever and the option
      would stay enabled on evidence nobody has. `unknown` is not `ignored` —
      the same rule main applies.
    */
    grantsList.mockResolvedValue([])
    handoversCheck.mockRejectedValue(new Error('git is not installed'))
    renderCard(BARE)
    expect(
      await screen.findByText('Could not check git — automatic runs are unavailable')
    ).toBeTruthy()
    expect(
      (screen.getByRole('option', { name: 'Run automatically' }) as HTMLOptionElement).disabled
    ).toBe(true)
  })

  it('says it is checking while it is checking, rather than nothing', async () => {
    grantsList.mockResolvedValue([])
    let answer: (value: unknown) => void = () => {}
    handoversCheck.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    renderCard(BARE)
    expect(await screen.findByText('Checking git…')).toBeTruthy()
    await act(async () => {
      answer(gitSays('ignored'))
    })
    await waitFor(() => expect(screen.getByText('.cinna/handovers is ignored by git')).toBeTruthy())
  })

  it('saves the choice against this agent and keeps the pick across the round trip', async () => {
    grantsList.mockResolvedValue([])
    handoversCheck.mockResolvedValue(gitSays('ignored'))
    setHandovers.mockResolvedValue({
      ok: true,
      value: { ...BARE, desktop: { ...BARE.desktop, handovers: 'auto' } }
    })
    renderLiveCard(BARE)
    fireEvent.change(await screen.findByLabelText('Handovers'), { target: { value: 'auto' } })
    // Immediately, not after main re-scans the folder (ux_rules §1).
    expect((screen.getByLabelText('Handovers') as HTMLSelectElement).value).toBe('auto')
    await waitFor(() =>
      expect(setHandovers).toHaveBeenCalledWith('folder:external:r1:a', 'auto')
    )
    await waitFor(() =>
      expect((screen.getByLabelText('Handovers') as HTMLSelectElement).value).toBe('auto')
    )
  })

  it('keeps a refused save beside the control and snaps the select back', async () => {
    grantsList.mockResolvedValue([])
    handoversCheck.mockResolvedValue(gitSays('ignored'))
    setHandovers.mockRejectedValue(new Error('.cinna/handovers is tracked by git.'))
    renderCard(BARE)
    fireEvent.change(await screen.findByLabelText('Handovers'), { target: { value: 'auto' } })
    // Outcome first, reason second (§6) — nothing was granted.
    expect(
      await screen.findByText(/Nothing was changed — \.cinna\/handovers is tracked by git\./)
    ).toBeTruthy()
    await waitFor(() =>
      expect((screen.getByLabelText('Handovers') as HTMLSelectElement).value).toBe('ask')
    )
  })
})
