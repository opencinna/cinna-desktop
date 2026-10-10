import { act, render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import type {
  AgentShareResult,
  AgentShareStatus,
  LibraryListingDto
} from '../../../../../shared/agentSharing'
import { SHARE_REFUSAL_TEXT, SHARE_UI_TEXT } from '../../../utils/shareText'

/**
 * Delete is the one destructive action on the agent page. Three things are
 * pinned: it always confirms first, a confirmed delete clears the selection
 * (the row is gone, and a page still asking for it would report the folder as
 * "not indexed"), and a `turn_in_progress` refusal is explained as "busy",
 * not as a failure — nothing was removed. Stamp identity is only offered to a
 * legacy folder.
 */

const remove = vi.fn()
let removePending = false
/** The hook-level `onSuccess` the menu registers — the one that survives unmounts. */
let hookOptions: { onSuccess?: () => void } | undefined
const setActiveLocalAgentId = vi.fn()
vi.mock('../../../stores/ui.store', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setActiveLocalAgentId })
}))
vi.mock('../../../hooks/useLocalAgents', () => ({
  useDeleteLocalAgent: (options?: { onSuccess?: () => void }) => {
    hookOptions = options
    return { mutate: remove, isPending: removePending }
  },
  useRescanLocalAgents: () => ({ mutate: vi.fn(), isPending: false }),
  useStampAgentIdentity: () => ({ mutate: vi.fn(), isPending: false })
}))
vi.mock('../../../hooks/useLocalTools', () => ({
  useOpenIn: () => ({ mutate: vi.fn() })
}))

/**
 * Sharing state, per test: `listed` is the agent's entry in the statuses list
 * (null = known not shared), `library` the Team library (null = not a Cinna
 * profile's), `isCinna` the active profile's type.
 */
let listed: AgentShareStatus | null = null
let library: LibraryListingDto | null = null
let isCinna = true
const shareWithTeam = vi.fn()
let shareWithTeamOptions: { onResult?: (result: AgentShareResult) => void } | undefined
vi.mock('../../../hooks/useSharing', () => ({
  useListedShareStatus: () => listed,
  useTeamLibrary: () => ({ data: library }),
  useShareWithTeam: (options?: { onResult?: (result: AgentShareResult) => void }) => {
    shareWithTeamOptions = options
    return { mutate: shareWithTeam, isPending: false }
  }
}))
vi.mock('../../../stores/auth.store', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentUser: { type: isCinna ? 'cinna_user' : 'local_user' } })
}))

const { AgentActionsMenu } = await import('./AgentActionsMenu')

function agent(overrides: Partial<LocalAgentDto> = {}): LocalAgentDto {
  return {
    id: 'folder:alpha',
    name: 'Alpha',
    path: '/tmp/agents/alpha',
    rootId: 'root-1',
    identity: 'manifest',
    kind: 'kit',
    stamps: { 'cinna-agent.json': { mtimeMs: 1, size: 1, hash: 'h' } },
    ...overrides
  } as LocalAgentDto
}

function openMenu(a: LocalAgentDto = agent()): void {
  render(createElement(AgentActionsMenu, { agent: a, onError: vi.fn() }))
  fireEvent.click(screen.getByRole('button', { name: /more actions/i }))
}

type DeleteOptions = { onError: (err: Error) => void }
function lastDeleteOptions(): DeleteOptions {
  return remove.mock.calls[0][1] as DeleteOptions
}

afterEach(() => {
  vi.clearAllMocks()
  removePending = false
  hookOptions = undefined
  listed = null
  library = null
  isCinna = true
  shareWithTeamOptions = undefined
  delete (window as unknown as { api?: unknown }).api
})

function sharedStatus(): AgentShareStatus {
  return {
    agentId: 'folder:alpha',
    remote: { kind: 'cinna', url: 'https://core.test/git/r1.git', repoId: 'r1', host: 'https://core.test', access: 'edit' },
    bundleId: null,
    state: 'up_to_date',
    headSha: 'a',
    remoteHeadSha: 'a',
    ahead: 0,
    behind: 0,
    changedFiles: 0,
    unshared: false,
    fetched: false,
    refusal: null
  }
}

const LIBRARY: LibraryListingDto = { host: 'https://core.test', agents: [], fetchedAt: '2026-10-09T00:00:00Z' }

/**
 * A shared agent's folder is a copy of the team's version: removing it trashes
 * this machine's copy only, and every name the dialog has says so — the menu
 * item, the heading, the button and the accessible name (ux_rules rule 10).
 */
describe('AgentActionsMenu — removing a shared agent', () => {
  it('names itself "Remove from this computer" everywhere, and trashes the folder', () => {
    listed = sharedStatus()
    openMenu()
    expect(screen.queryByRole('menuitem', { name: /delete agent/i })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: SHARE_UI_TEXT.removeFromComputerMenu }))
    const dialog = screen.getByRole('dialog', { name: SHARE_UI_TEXT.removeFromComputer })
    expect(dialog.textContent).toContain('Trash')
    expect(dialog.textContent).toContain('stays in the catalog')
    expect(screen.queryByRole('dialog', { name: /delete agent/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.removeFromComputer }))
    expect(remove).toHaveBeenCalledWith({ agentId: 'folder:alpha', trashFolder: true }, expect.anything())
  })

  it('shows main’s refusal naming what is unshared, and stays open', () => {
    listed = { ...sharedStatus(), state: 'unshared', unshared: true, changedFiles: 3 }
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: SHARE_UI_TEXT.removeFromComputerMenu }))
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.removeFromComputer }))
    // Main's sentence, as `localAgentService` writes it: the count, the first
    // files, and what to do.
    const refusal = Object.assign(
      new Error(
        "3 changes on this agent haven't been shared with the team yet (prompts/WORKFLOW.md, README.md, and 1 more). Share them first, or keep the folder."
      ),
      { code: 'unshared_changes' }
    )
    act(() => lastDeleteOptions().onError(refusal))
    expect(screen.getByRole('alert').textContent).toBe(refusal.message)
    expect(screen.getByRole('dialog', { name: SHARE_UI_TEXT.removeFromComputer })).toBeTruthy()
    expect(screen.getByRole('button', { name: SHARE_UI_TEXT.removeFromComputer })).toBeTruthy()
  })
})

describe('AgentActionsMenu — Share with the team', () => {
  it('is offered for a kit agent that is not shared, on a Cinna profile with a Team library', () => {
    library = LIBRARY
    openMenu()
    expect(screen.getByRole('menuitem', { name: SHARE_UI_TEXT.shareWithTeam })).toBeTruthy()
  })

  it('is offered again when the library no longer has the agent\'s team version', () => {
    library = LIBRARY
    listed = { ...sharedStatus(), state: 'removed' }
    openMenu()
    expect(screen.getByRole('menuitem', { name: SHARE_UI_TEXT.shareWithTeam })).toBeTruthy()
  })

  it.each([
    ['already shared', () => { library = LIBRARY; listed = sharedStatus() }, agent()],
    ['no Team library', () => { library = null }, agent()],
    ['not a Cinna profile', () => { library = LIBRARY; isCinna = false }, agent()],
    ['a bare agent', () => { library = LIBRARY }, agent({ kind: 'bare' })],
    ['statuses not loaded', () => { library = LIBRARY; listed = undefined as unknown as null }, agent()]
  ])('is not offered when %s', (_label, arrange, a) => {
    arrange()
    openMenu(a)
    expect(screen.queryByRole('menuitem', { name: SHARE_UI_TEXT.shareWithTeam })).toBeNull()
  })

  it('pre-fills the name, asks for no description, shares with only me by default, keeps a refusal in the dialog and closes on success', async () => {
    library = LIBRARY
    const draft = vi.fn().mockResolvedValue({ success: true, value: { name: 'Alpha', description: 'Watches.' } })
    ;(window as unknown as { api: unknown }).api = { sharing: { shareWithTeamDraft: draft } }
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: SHARE_UI_TEXT.shareWithTeam }))
    const dialog = screen.getByRole('dialog', { name: SHARE_UI_TEXT.shareWithTeamTitle })
    await act(async () => {})
    expect((screen.getByLabelText(SHARE_UI_TEXT.nameLabel) as HTMLInputElement).value).toBe('Alpha')
    // No description field: main sends the manifest's.
    expect(dialog.querySelector('textarea')).toBeNull()
    expect(dialog.textContent).not.toContain('Watches.')
    expect(dialog.querySelector('[data-chosen-people]')?.textContent).toBe(SHARE_UI_TEXT.peopleOnlyMe)

    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.share }))
    expect(shareWithTeam).toHaveBeenCalledWith(
      { agentId: 'folder:alpha', input: { name: 'Alpha', people: [] } },
      expect.anything()
    )
    act(() =>
      shareWithTeamOptions?.onResult?.({ done: false, refusal: 'no_access', detail: null, status: null, agentId: null, autoAttached: [], setupNeeded: false })
    )
    expect(dialog.textContent).toContain(SHARE_REFUSAL_TEXT.no_access)

    act(() =>
      shareWithTeamOptions?.onResult?.({ done: true, refusal: null, detail: null, status: null, agentId: null, autoAttached: [], setupNeeded: false })
    )
    expect(screen.queryByRole('dialog', { name: SHARE_UI_TEXT.shareWithTeamTitle })).toBeNull()
  })
})

describe('AgentActionsMenu — Share with the team’s people', () => {
  it('finds people as the user types, without moving the list, and sends each one picked with the access chosen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      library = LIBRARY
      const draft = vi.fn().mockResolvedValue({ success: true, value: { name: 'Alpha', description: '' } })
      const searchPeople = vi.fn().mockResolvedValue({
        success: true,
        value: [
          { userId: 'u2', email: 'bob@x.test', name: 'Bob' },
          { userId: 'u3', email: 'cy@x.test', name: 'Cy' }
        ]
      })
      ;(window as unknown as { api: unknown }).api = { sharing: { shareWithTeamDraft: draft, searchPeople } }
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: SHARE_UI_TEXT.shareWithTeam }))
      await act(async () => {})
      const results = (): HTMLElement | null => document.querySelector('[data-people-results]')
      const search = screen.getByLabelText(SHARE_UI_TEXT.peopleSearchLabel, { selector: 'input' })
      // Nothing typed: no dropdown at all.
      expect(results()).toBeNull()
      // One letter asks nothing and opens nothing.
      fireEvent.change(search, { target: { value: 'b' } })
      await act(async () => { vi.advanceTimersByTime(400) })
      expect(searchPeople).not.toHaveBeenCalled()
      expect(results()).toBeNull()
      // Typing settles, then the server is asked once; the answers float over
      // the dialog rather than pushing it down.
      fireEvent.change(search, { target: { value: 'bo' } })
      fireEvent.change(search, { target: { value: 'bob' } })
      await act(async () => { vi.advanceTimersByTime(400) })
      expect(searchPeople).toHaveBeenCalledTimes(1)
      expect(searchPeople).toHaveBeenCalledWith('bob')
      expect(results()!.className).toContain('absolute')
      fireEvent.click(screen.getByRole('option', { name: 'Bob <bob@x.test>' }))
      // A pick closes the dropdown, empties the field for the next person, and
      // joins the list as "Can use".
      expect(results()).toBeNull()
      expect((search as HTMLInputElement).value).toBe('')
      const access = screen.getByLabelText(SHARE_UI_TEXT.accessFor('Bob <bob@x.test>')) as HTMLSelectElement
      expect(access.value).toBe('use')
      fireEvent.change(access, { target: { value: 'edit' } })
      // Bob is on the list, so a new search leaves him out.
      fireEvent.change(search, { target: { value: 'cy' } })
      await act(async () => { vi.advanceTimersByTime(400) })
      expect(screen.queryByRole('option', { name: 'Bob <bob@x.test>' })).toBeNull()
      // Arrow keys and Enter pick too, and Escape closes the list, not the dialog.
      fireEvent.keyDown(search, { key: 'Escape' })
      expect(results()).toBeNull()
      expect(screen.getByRole('dialog', { name: SHARE_UI_TEXT.shareWithTeamTitle })).toBeTruthy()
      fireEvent.change(search, { target: { value: 'c' } })
      fireEvent.change(search, { target: { value: 'cy' } })
      await act(async () => { vi.advanceTimersByTime(400) })
      fireEvent.keyDown(search, { key: 'Enter' })
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.removePerson('Cy <cy@x.test>') }))

      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.share }))
      expect(shareWithTeam).toHaveBeenCalledWith(
        { agentId: 'folder:alpha', input: { name: 'Alpha', people: [{ userId: 'u2', access: 'edit' }] } },
        expect.anything()
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AgentActionsMenu — delete', () => {
  it('asks before deleting, then deletes and clears the selection', () => {
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /delete agent/i }))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: /delete agent/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /move to trash/i }))
    expect(remove).toHaveBeenCalledWith(
      { agentId: 'folder:alpha', trashFolder: true },
      expect.anything()
    )

    // Success is handled at hook level — a mutate-level callback is dropped by
    // TanStack once the caller has unmounted, and the dialog can be dismissed.
    act(() => hookOptions?.onSuccess?.())
    expect(setActiveLocalAgentId).toHaveBeenCalledWith(null)
    expect(screen.queryByRole('dialog', { name: /delete agent/i })).toBeNull()
  })

  it('cannot be dismissed while the delete is in flight', () => {
    removePending = true
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /delete agent/i }))
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(document.body)
    expect(screen.getByRole('dialog', { name: /delete agent/i })).toBeTruthy()
    expect((screen.getByRole('button', { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('explains a mid-turn refusal as busy and keeps the dialog open', () => {
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /delete agent/i }))
    fireEvent.click(screen.getByRole('button', { name: /move to trash/i }))

    const busy = Object.assign(new Error('This agent is busy right now.'), {
      code: 'turn_in_progress'
    })
    act(() => lastDeleteOptions().onError(busy))
    expect(screen.getByText(/middle of a turn/i)).toBeTruthy()
    expect(screen.getByRole('dialog', { name: /delete agent/i })).toBeTruthy()
    expect(setActiveLocalAgentId).not.toHaveBeenCalled()
  })

  it('cancels without deleting', () => {
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /delete agent/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: /delete agent/i })).toBeNull()
  })
})

describe('AgentActionsMenu — stamp identity', () => {
  it('is offered only to a legacy folder', () => {
    openMenu()
    expect(screen.queryByRole('menuitem', { name: /stamp identity/i })).toBeNull()
  })

  it('appears for a legacy folder whose manifest could be read', () => {
    openMenu(agent({ identity: 'legacy' }))
    expect(screen.getByRole('menuitem', { name: /stamp identity/i })).toBeTruthy()
  })
})

/**
 * Removing a **bare** agent is the one place the dialog asks a question rather
 * than confirming an answer, because the folder is not the desktop's: it is
 * very often a repository the user shares with other people, and forgetting an
 * agent must not be able to delete it by default.
 */
describe('AgentActionsMenu — removing a bare agent', () => {
  const bare = (): LocalAgentDto =>
    agent({ id: 'folder:external:r1:alpha', kind: 'bare', identity: 'external', stamps: {} })

  function openDialog(): void {
    openMenu(bare())
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove agent/ }))
  }

  it('defaults to the recoverable choice and never trashes on the first click', () => {
    // ux_rules rule 5: the recoverable option first, and selected. Mutation:
    // default `trashFolder` to true and the ordinary "I do not want this in my
    // list" click deletes somebody's repository folder.
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(remove).toHaveBeenCalledWith(
      { agentId: 'folder:external:r1:alpha', trashFolder: false },
      expect.anything()
    )
  })

  it('trashes the folder when that option is chosen, and says so on the button', () => {
    openDialog()
    fireEvent.click(screen.getByLabelText(/move the folder to the Trash/i))
    // The label changes with the choice, so the button never says one thing and
    // does the other.
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))

    expect(remove).toHaveBeenCalledWith(
      { agentId: 'folder:external:r1:alpha', trashFolder: true },
      expect.anything()
    )
  })

  it('announces itself by the word it uses', () => {
    // The accessible name *is* the visible name. Hardcoded to "Delete agent" it
    // announced the more alarming of the two words over a dialog whose heading,
    // menu item and button all said Remove — for the branch whose default
    // deletes nothing.
    openDialog()
    expect(screen.getByRole('dialog', { name: 'Remove agent' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Delete agent' })).toBeNull()
  })

  it('offers no such choice for a kit agent', () => {
    // Its row is a derived index over its folder: "remove from the list" would
    // be undone by the next scan, so it is not offered rather than refused
    // after the click.
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete agent/ }))
    expect(screen.queryByLabelText(/Remove from the list only/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeTruthy()
    // And a kit agent keeps the word it has always used.
    expect(screen.getByRole('dialog', { name: 'Delete agent' })).toBeTruthy()
  })
})
