import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentPeopleDto,
  AgentShareResult,
  AgentShareStatus,
  AgentVersionDto,
  LibraryAgentDto
} from '../../../../../../shared/agentSharing'

/**
 * The Sharing tab: what it says about where the agent is shared (library
 * facts from the listing entry matching the folder's team version, re-read on
 * open), who has access and how a maintainer changes it, the folder's
 * versions with the unsent ones marked, and Remove sharing — whose refusal
 * stays in its dialog and whose success is the page's quiet note.
 */

const { SharingTab } = await import('./SharingTab')
const { useShareActions } = await import('./useShareActions')
const { SHARE_ACCESS_TEXT, SHARE_UI_TEXT } = await import('../../../../utils/shareText')
const { resetSharingFetchClock, sharingStatusesKey } = await import('../../../../hooks/useSharing')
const { useAuthStore } = await import('../../../../stores/auth.store')

const AGENT = { id: 'folder:alpha', name: 'Alpha' }

function status(overrides: Partial<AgentShareStatus> = {}): AgentShareStatus {
  return {
    agentId: AGENT.id,
    remote: { kind: 'cinna', url: 'https://core.test/git/r1.git', repoId: 'r1', host: 'https://core.test', access: 'maintain' },
    state: 'up_to_date',
    headSha: 'a',
    remoteHeadSha: 'a',
    ahead: 0,
    behind: 0,
    changedFiles: 0,
    unshared: false,
    fetched: false,
    refusal: null,
    ...overrides
  }
}

function entry(overrides: Partial<LibraryAgentDto> = {}): LibraryAgentDto {
  return {
    repoId: 'r1',
    slug: 'alpha',
    name: 'Alpha in the library',
    description: '',
    cloneUrl: 'https://core.test/git/r1.git',
    headSha: 'a',
    updatedAt: '2026-10-09T10:00:00Z',
    access: 'maintain',
    maintainers: [{ userId: 'u1', displayName: 'Ann' }],
    engine: null,
    manifestId: null,
    pushedBy: 'Bob',
    localAgentId: AGENT.id,
    updateAvailable: false,
    ...overrides
  }
}

const ok = <T,>(value: T) => ({ success: true as const, value })
const done = (overrides: Partial<AgentShareResult> = {}): AgentShareResult => ({
  done: true,
  refusal: null,
  detail: null,
  status: null,
  agentId: AGENT.id,
  ...overrides
})

let sharing: Record<string, ReturnType<typeof vi.fn>>
const PEOPLE: AgentPeopleDto = {
  visible: true,
  people: [
    { principal: { kind: 'user', userId: 'u1' }, access: 'maintain', displayName: 'Ann' },
    { principal: { kind: 'everyone' }, access: 'read', displayName: '' }
  ],
  selfUserId: 'u1'
}
const HISTORY: AgentVersionDto[] = [
  { note: 'Tightened the prompt', author: 'Ann', date: '2026-10-09T11:00:00Z', unsent: true },
  { note: 'First version', author: 'Bob', date: '2026-10-08T09:00:00Z', unsent: false }
]

beforeEach(() => {
  resetSharingFetchClock()
  act(() =>
    useAuthStore.setState({
      currentUser: { id: 'p1', type: 'cinna_user', username: 'ann', displayName: 'Ann', hasPassword: false } as never
    })
  )
  sharing = {
    statuses: vi.fn(),
    status: vi.fn(() => new Promise(() => {})),
    library: vi.fn().mockResolvedValue(ok({ host: 'https://core.test', agents: [entry()], fetchedAt: '' })),
    people: vi.fn().mockResolvedValue(ok(PEOPLE)),
    history: vi.fn().mockResolvedValue(ok(HISTORY)),
    setPeople: vi.fn().mockResolvedValue(ok(done())),
    unshare: vi.fn().mockResolvedValue(ok(done())),
    searchPeople: vi.fn().mockResolvedValue(ok([])),
    update: vi.fn(),
    shareChanges: vi.fn(),
    draftMessage: vi.fn().mockResolvedValue(ok(''))
  }
  ;(window as unknown as { api: unknown }).api = {
    sharing,
    system: { openExternal: vi.fn().mockResolvedValue({ success: true }) }
  }
})

afterEach(() => {
  act(() => useAuthStore.setState({ currentUser: null }))
  cleanup()
  vi.clearAllMocks()
})

function mount(listed: AgentShareStatus): { onNote: ReturnType<typeof vi.fn> } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(sharingStatusesKey('p1'), [listed])
  sharing.statuses.mockResolvedValue(ok([listed]))
  const onNote = vi.fn()
  function Page(): React.JSX.Element {
    const actions = useShareActions(AGENT.id, { onError: vi.fn(), onNote })
    return createElement(SharingTab, { agent: AGENT, actions, bindActionErrors: () => {}, onNote })
  }
  render(createElement(QueryClientProvider, { client }, createElement(Page)))
  return { onNote }
}

const section = (name: string): HTMLElement =>
  screen.getByRole('heading', { name }).closest('section') as HTMLElement

describe('SharingTab — where it is shared', () => {
  it('reads the library again on open and shows that entry’s facts', async () => {
    mount(status())
    expect(sharing.library).toHaveBeenCalledWith(true)
    const where = section(SHARE_UI_TEXT.whereShared)
    await waitFor(() => expect(where.textContent).toContain('Alpha in the library'))
    expect(where.textContent).toContain('core.test')
    expect(where.textContent).toContain(SHARE_ACCESS_TEXT.maintain)
    expect(where.textContent).toContain('Ann')
    expect(where.textContent).toContain('by Bob')
  })

  it('names an external team version as the user’s own server, with no library facts', async () => {
    mount(status({ remote: { kind: 'external', url: 'https://github.com/acme/alpha.git', repoId: null, host: null, access: null } }))
    const where = section(SHARE_UI_TEXT.whereShared)
    expect(where.textContent).toContain(SHARE_UI_TEXT.ownServer)
    expect(where.textContent).toContain('https://github.com/acme/alpha.git')
    expect(where.textContent).not.toContain(SHARE_UI_TEXT.libraryNameLabel)
    // People is a library thing; an external one has none.
    expect(screen.queryByRole('heading', { name: SHARE_UI_TEXT.peopleSection })).toBeNull()
  })

  it('offers Update and Share changes beside the state they change', () => {
    mount(status({ state: 'behind', behind: 1, unshared: true, changedFiles: 1 }))
    const where = section(SHARE_UI_TEXT.whereShared)
    expect(within(where).getByRole('button', { name: SHARE_UI_TEXT.update })).toBeTruthy()
    expect(within(where).getByRole('button', { name: SHARE_UI_TEXT.shareChanges })).toBeTruthy()
  })
})

describe('SharingTab — people', () => {
  it('marks your own row "You", with no remove', async () => {
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.everyone))
    expect(within(people).getByLabelText(SHARE_UI_TEXT.accessFor(SHARE_UI_TEXT.you))).toBeTruthy()
    expect(within(people).queryByRole('button', { name: SHARE_UI_TEXT.removePerson(SHARE_UI_TEXT.you) })).toBeNull()
    expect(within(people).getByRole('button', { name: SHARE_UI_TEXT.removePerson(SHARE_UI_TEXT.everyone) })).toBeTruthy()
  })

  it('builds each change on the list the server answered, and holds the controls while one is saving', async () => {
    let answer: (value: unknown) => void = () => {}
    sharing.setPeople.mockReturnValueOnce(new Promise((r) => { answer = r }))
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.everyone))
    const everyone = (): HTMLSelectElement =>
      within(people).getByLabelText(SHARE_UI_TEXT.accessFor(SHARE_UI_TEXT.everyone)) as HTMLSelectElement
    fireEvent.change(everyone(), { target: { value: 'write' } })
    await waitFor(() => expect(everyone().disabled).toBe(true))
    // The refetch after the change has not answered yet: the list on screen
    // and the next edit come from the PUT's own answer.
    sharing.people.mockReturnValue(new Promise(() => {}))
    const answered = {
      visible: true,
      people: [PEOPLE.people[0], { ...PEOPLE.people[1], access: 'write' }],
      selfUserId: 'u1'
    }
    await act(async () => answer(ok({ ...done(), people: answered })))
    await waitFor(() => expect(everyone().disabled).toBe(false))
    expect(everyone().value).toBe('write')
    fireEvent.change(within(people).getByLabelText(SHARE_UI_TEXT.accessFor(SHARE_UI_TEXT.you)), { target: { value: 'write' } })
    await waitFor(() => expect(sharing.setPeople).toHaveBeenCalledTimes(2))
    expect(sharing.setPeople).toHaveBeenLastCalledWith(AGENT.id, [
      { principal: { kind: 'user', userId: 'u1' }, access: 'write' },
      { principal: { kind: 'everyone' }, access: 'write' }
    ])
  })

  it('asks in the row before removing someone, Everyone included', async () => {
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.everyone))
    fireEvent.click(within(people).getByRole('button', { name: SHARE_UI_TEXT.removePerson(SHARE_UI_TEXT.everyone) }))
    expect(sharing.setPeople).not.toHaveBeenCalled()
    expect(people.textContent).toContain(SHARE_UI_TEXT.removePersonConfirm(SHARE_UI_TEXT.everyone))
    fireEvent.click(within(people).getByRole('button', { name: SHARE_UI_TEXT.cancel }))
    expect(sharing.setPeople).not.toHaveBeenCalled()
    fireEvent.click(within(people).getByRole('button', { name: SHARE_UI_TEXT.removePerson(SHARE_UI_TEXT.everyone) }))
    fireEvent.click(within(people).getByRole('button', { name: SHARE_UI_TEXT.removePersonAction }))
    await waitFor(() => expect(sharing.setPeople).toHaveBeenCalledTimes(1))
    expect(sharing.setPeople).toHaveBeenLastCalledWith(AGENT.id, [
      { principal: { kind: 'user', userId: 'u1' }, access: 'maintain' }
    ])
  })

  it('shows the server’s refusal under the list, closing nothing', async () => {
    sharing.setPeople.mockResolvedValue(ok(done({ done: false, refusal: 'failed', detail: 'An agent needs at least one maintainer.' })))
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.everyone))
    fireEvent.change(within(people).getByLabelText(SHARE_UI_TEXT.accessFor(SHARE_UI_TEXT.you)), { target: { value: 'read' } })
    await waitFor(() =>
      expect(within(people).getByRole('alert').textContent).toBe('An agent needs at least one maintainer.')
    )
  })

  it('shows only the maintainers to someone who may not see the list, with no way to change it', async () => {
    sharing.people.mockResolvedValue(ok({ visible: false, people: [], selfUserId: null }))
    mount(status({ remote: { ...status().remote, access: 'read' } }))
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.peopleOnlyMaintainer))
    await waitFor(() => expect(people.textContent).toContain('Ann'))
    expect(within(people).queryByRole('button', { name: SHARE_UI_TEXT.shareWithPerson })).toBeNull()
    expect(within(people).queryByRole('combobox')).toBeNull()
  })

  it('adds a person picked in Share with a person, as Can use unless changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      sharing.searchPeople.mockResolvedValue(ok([{ userId: 'u2', email: 'bob@x.test', name: 'Bob' }]))
      mount(status())
      const people = section(SHARE_UI_TEXT.peopleSection)
      await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.everyone))
      fireEvent.click(within(people).getByRole('button', { name: SHARE_UI_TEXT.shareWithPerson }))
      const dialog = screen.getByRole('dialog', { name: SHARE_UI_TEXT.shareWithPersonTitle })
      fireEvent.change(within(dialog).getByLabelText(SHARE_UI_TEXT.peopleSearchLabel, { selector: 'input' }), { target: { value: 'bob' } })
      await act(async () => { vi.advanceTimersByTime(400) })
      fireEvent.click(within(dialog).getByRole('option', { name: 'Bob <bob@x.test>' }))
      expect((within(dialog).getByLabelText(SHARE_UI_TEXT.accessLabel) as HTMLSelectElement).value).toBe('read')
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.addPerson }))
      })
      expect(sharing.setPeople).toHaveBeenCalledWith(AGENT.id, [
        { principal: { kind: 'user', userId: 'u1' }, access: 'maintain' },
        { principal: { kind: 'everyone' }, access: 'read' },
        { principal: { kind: 'user', userId: 'u2' }, access: 'read' }
      ])
      await waitFor(() => expect(screen.queryByRole('dialog', { name: SHARE_UI_TEXT.shareWithPersonTitle })).toBeNull())
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SharingTab — history', () => {
  it('lists versions newest first and marks the ones not shared yet', async () => {
    mount(status())
    const history = section(SHARE_UI_TEXT.historySection)
    await waitFor(() => expect(history.textContent).toContain('Tightened the prompt'))
    const rows = Array.from(history.querySelectorAll('[data-sharing-history] > div > div'))
    expect(rows.map((row) => row.textContent?.includes(SHARE_UI_TEXT.notSharedYet))).toEqual([true, false])
    expect(rows[1].textContent).toContain('First version')
  })
})

describe('SharingTab — remove sharing', () => {
  const open = (): HTMLElement => {
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.removeSharingMenu }))
    return screen.getByRole('dialog', { name: SHARE_UI_TEXT.removeSharingTitle })
  }

  it('offers to delete from the library to a maintainer, unchecked, and says so in the note on success', async () => {
    const { onNote } = mount(status())
    await waitFor(() => expect(section(SHARE_UI_TEXT.whereShared).textContent).toContain('Alpha in the library'))
    const dialog = open()
    const box = within(dialog).getByRole('checkbox', { name: SHARE_UI_TEXT.alsoDeleteFromLibrary }) as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.removeSharingConfirm }))
    })
    expect(sharing.unshare).toHaveBeenCalledWith(AGENT.id, true)
    await waitFor(() => expect(onNote).toHaveBeenCalledWith(SHARE_UI_TEXT.noLongerSharedNote('Alpha')))
  })

  it('keeps the server’s refusal in the dialog', async () => {
    sharing.unshare.mockResolvedValue(
      ok(done({ done: false, refusal: 'failed', detail: 'Another person has this agent in their workspace.' }))
    )
    mount(status())
    await waitFor(() => expect(section(SHARE_UI_TEXT.whereShared).textContent).toContain('Alpha in the library'))
    const dialog = open()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.removeSharingConfirm }))
    })
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toBe('Another person has this agent in their workspace.')
    )
    expect(screen.getByRole('dialog', { name: SHARE_UI_TEXT.removeSharingTitle })).toBeTruthy()
  })

  it.each<[string, Partial<AgentShareStatus>, Partial<LibraryAgentDto> | null]>([
    ['someone who may only edit', {}, { access: 'write' }],
    ['an agent no longer shared', { state: 'removed' }, null],
    ['an agent shared on another account', { state: 'other_account' }, {}]
  ])('disconnects locally only for %s', async (_label, overrides, listing) => {
    sharing.library.mockResolvedValue(
      ok({ host: 'https://core.test', agents: listing ? [entry(listing)] : [], fetchedAt: '' })
    )
    mount(status(overrides))
    await waitFor(() => expect(sharing.library).toHaveBeenCalled())
    await act(async () => {})
    const dialog = open()
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.removeSharingConfirm }))
    })
    expect(sharing.unshare).toHaveBeenCalledWith(AGENT.id, false)
  })
})
