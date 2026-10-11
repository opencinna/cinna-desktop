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
    bundleId: null,
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
    uuid: 'item-1',
    bundleId: 'test.core.alpha1234',
    repoId: 'r1',
    slug: 'alpha',
    name: 'Alpha in the library',
    description: '',
    cloneUrl: 'https://core.test/git/r1.git',
    headSha: 'a',
    access: 'maintain',
    visibility: 'public',
    isListed: true,
    maintainers: [{ userId: 'u1', displayName: 'Ann' }],
    engine: null,
    manifestId: null,
    latest: { number: 3, label: null, publishedAt: '2026-10-09T10:00:00Z', publishedBy: 'Bob', releaseNotes: 'Tightened the prompt' },
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
  autoAttached: [],
  setupNeeded: false,
  ...overrides
})

let sharing: Record<string, ReturnType<typeof vi.fn>>
const PEOPLE: AgentPeopleDto = {
  visible: true,
  people: [
    { principal: { kind: 'user', userId: 'u1' }, access: 'maintain', displayName: 'Ann' },
    { principal: { kind: 'everyone' }, access: 'use', displayName: '' }
  ],
  selfUserId: 'u1'
}
const BOB = { principal: { kind: 'user' as const, userId: 'u2' }, access: 'use' as const, displayName: 'Bob' }
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

/** The value beside a label in Where it's shared, or null when there is no such fact. */
const fact = (where: HTMLElement, label: string): string | null => {
  const term = Array.from(where.querySelectorAll('dt')).find((dt) => dt.textContent === label)
  return term ? (term.nextElementSibling?.textContent ?? '') : null
}

describe('SharingTab — where it is shared', () => {
  it('reads the library again on open and shows that entry’s facts', async () => {
    mount(status())
    expect(sharing.library).toHaveBeenCalledWith(true)
    const where = section(SHARE_UI_TEXT.whereShared)
    await waitFor(() => expect(where.textContent).toContain('Alpha in the library'))
    expect(where.textContent).toContain('core.test')
    expect(where.textContent).toContain(SHARE_ACCESS_TEXT.maintain)
    expect(where.textContent).toContain('Ann')
    // The latest version as facts of their own, not a dotted line under the status.
    expect(fact(where, SHARE_UI_TEXT.versionLabel)).toBe('3')
    expect(fact(where, SHARE_UI_TEXT.sharedByLabel)).toBe('Bob')
    expect(fact(where, SHARE_UI_TEXT.sharedOnLabel)).toContain('2026')
    expect(where.querySelector('[data-sharing-status]')?.textContent).not.toContain('Bob')
    expect(where.querySelector('[data-sharing-status]')?.textContent).not.toContain('3')
    // No catalog id recorded in the folder: the listing's, as the same read-only fact.
    expect(where.textContent).toContain(SHARE_UI_TEXT.catalogIdLabel)
    expect(within(where).getByText('test.core.alpha1234').tagName).toBe('CODE')
  })

  it('shows the catalog id this computer recorded for the agent, read-only', async () => {
    mount(status({ bundleId: 'test.core.recorded1' }))
    const where = section(SHARE_UI_TEXT.whereShared)
    await waitFor(() => expect(where.textContent).toContain('Alpha in the library'))
    const id = within(where).getByText('test.core.recorded1')
    expect(id.tagName).toBe('CODE')
    // A long id truncates in its column, the whole of it on hover.
    expect(id.className.split(/\s+/)).toContain('truncate')
    expect(id.getAttribute('title')).toBe('test.core.recorded1')
    expect(where.textContent).not.toContain('test.core.alpha1234')
    expect(within(where).queryByRole('textbox')).toBeNull()
  })

  it('says nothing about a version before the first share', async () => {
    sharing.library.mockResolvedValue(ok({ host: 'https://core.test', agents: [entry({ latest: null })], fetchedAt: '' }))
    mount(status())
    const where = section(SHARE_UI_TEXT.whereShared)
    await waitFor(() => expect(where.textContent).toContain('Alpha in the library'))
    expect(fact(where, SHARE_UI_TEXT.versionLabel)).toBeNull()
    expect(fact(where, SHARE_UI_TEXT.sharedByLabel)).toBeNull()
  })

  it.each<[string, Partial<LibraryAgentDto>, string | null]>([
    ['listed and shared with people', { visibility: 'users' }, null],
    ['listed and public', { visibility: 'public' }, null],
    ['not listed', { isListed: false }, SHARE_UI_TEXT.notListed],
    ['private', { visibility: 'private' }, SHARE_UI_TEXT.privateItem],
    ['private and not listed', { visibility: 'private', isListed: false }, SHARE_UI_TEXT.notListed]
  ])('says who can get it only when the catalog narrows it: %s', async (_label, overrides, expected) => {
    sharing.library.mockResolvedValue(ok({ host: 'https://core.test', agents: [entry(overrides)], fetchedAt: '' }))
    mount(status())
    const where = section(SHARE_UI_TEXT.whereShared)
    await waitFor(() => expect(where.textContent).toContain('Alpha in the library'))
    expect(fact(where, SHARE_UI_TEXT.whoCanGetLabel)).toBe(expected)
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
  it('leaves out your own row when you are already named a maintainer above', async () => {
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.everyone))
    expect(people.textContent).not.toContain(SHARE_UI_TEXT.you)
    expect(within(people).queryByLabelText(SHARE_UI_TEXT.accessFor(SHARE_UI_TEXT.you))).toBeNull()
    // Everyone on the server can only use it: a fixed badge, not a choice.
    expect(within(people).queryAllByRole('combobox')).toHaveLength(0)
    expect(people.textContent).toContain(SHARE_ACCESS_TEXT.use)
  })

  it('says no one else has access when you are the only one', async () => {
    sharing.people.mockResolvedValue(ok({ ...PEOPLE, people: [PEOPLE.people[0]] }))
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.peopleNoOneElse))
  })

  it('shows your own access read-only when you are not a maintainer: no select, no remove', async () => {
    sharing.people.mockResolvedValue(
      ok({
        visible: true,
        people: [PEOPLE.people[0], { principal: { kind: 'user', userId: 'u2' }, access: 'edit', displayName: 'Bob' }],
        selfUserId: 'u2'
      })
    )
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.you))
    expect(people.textContent).toContain(SHARE_ACCESS_TEXT.edit)
    expect(within(people).queryByLabelText(SHARE_UI_TEXT.accessFor(SHARE_UI_TEXT.you))).toBeNull()
    expect(within(people).queryByRole('button', { name: SHARE_UI_TEXT.removePerson(SHARE_UI_TEXT.you) })).toBeNull()
  })

  it('gives the access select a fixed width, never the whole row the name needs', async () => {
    sharing.people.mockResolvedValue(ok({ ...PEOPLE, people: [...PEOPLE.people, BOB] }))
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain('Bob'))
    // `w-full` beside `w-36` wins on stylesheet order and leaves the name no width.
    expect(within(people).getAllByRole('combobox')).toHaveLength(1)
    for (const select of within(people).getAllByRole('combobox')) {
      expect(select.className.split(/\s+/)).not.toContain('w-full')
    }
  })

  it('builds each change on the list the server answered, and holds the controls while one is saving', async () => {
    let answer: (value: unknown) => void = () => {}
    sharing.setPeople.mockReturnValueOnce(new Promise((r) => { answer = r }))
    const carol = { principal: { kind: 'user' as const, userId: 'u3' }, access: 'use' as const, displayName: 'Carol' }
    sharing.people.mockResolvedValue(ok({ ...PEOPLE, people: [...PEOPLE.people, BOB, carol] }))
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain('Bob'))
    const bob = (): HTMLSelectElement =>
      within(people).getByLabelText(SHARE_UI_TEXT.accessFor('Bob')) as HTMLSelectElement
    fireEvent.change(bob(), { target: { value: 'edit' } })
    await waitFor(() => expect(bob().disabled).toBe(true))
    // The refetch after the change has not answered yet: the list on screen
    // and the next edit come from the PUT's own answer.
    sharing.people.mockReturnValue(new Promise(() => {}))
    const answered = {
      visible: true,
      people: [PEOPLE.people[0], PEOPLE.people[1], { ...BOB, access: 'edit' }, carol],
      selfUserId: 'u1'
    }
    await act(async () => answer(ok({ ...done(), people: answered })))
    await waitFor(() => expect(bob().disabled).toBe(false))
    expect(bob().value).toBe('edit')
    fireEvent.change(within(people).getByLabelText(SHARE_UI_TEXT.accessFor('Carol')), { target: { value: 'edit' } })
    await waitFor(() => expect(sharing.setPeople).toHaveBeenCalledTimes(2))
    // Your own grant, hidden from the list, is still saved with it, unchanged.
    expect(sharing.setPeople).toHaveBeenLastCalledWith(AGENT.id, [
      { principal: { kind: 'user', userId: 'u1' }, access: 'maintain' },
      { principal: { kind: 'everyone' }, access: 'use' },
      { principal: { kind: 'user', userId: 'u2' }, access: 'edit' },
      { principal: { kind: 'user', userId: 'u3' }, access: 'edit' }
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
    sharing.people.mockResolvedValue(ok({ ...PEOPLE, people: [...PEOPLE.people, BOB] }))
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain('Bob'))
    fireEvent.change(within(people).getByLabelText(SHARE_UI_TEXT.accessFor('Bob')), { target: { value: 'edit' } })
    await waitFor(() =>
      expect(within(people).getByRole('alert').textContent).toBe('An agent needs at least one maintainer.')
    )
  })

  it('shows only the maintainers to someone who may not see the list, with no way to change it', async () => {
    sharing.people.mockResolvedValue(ok({ visible: false, people: [], selfUserId: null }))
    mount(status({ remote: { ...status().remote, access: 'use' } }))
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.peopleOnlyMaintainer))
    await waitFor(() => expect(people.textContent).toContain('Ann'))
    expect(within(people).queryByRole('button', { name: SHARE_UI_TEXT.shareWithPerson })).toBeNull()
    expect(within(people).queryByRole('combobox')).toBeNull()
  })

  it('offers Share with everyone while the agent is not public, adds the Everyone row through the same save, and then hides', async () => {
    let answer: (value: unknown) => void = () => {}
    sharing.setPeople.mockReturnValueOnce(new Promise((r) => { answer = r }))
    sharing.library.mockResolvedValue(ok({ host: 'https://core.test', agents: [entry({ visibility: 'users' })], fetchedAt: '' }))
    sharing.people.mockResolvedValue(ok({ ...PEOPLE, people: [PEOPLE.people[0], BOB] }))
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain('Bob'))
    const everyone = (): HTMLButtonElement | null =>
      within(people).queryByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone }) as HTMLButtonElement | null
    await waitFor(() => expect(everyone()).not.toBeNull())
    fireEvent.click(everyone()!)
    await waitFor(() => expect(sharing.setPeople).toHaveBeenCalledTimes(1))
    expect(sharing.setPeople).toHaveBeenCalledWith(AGENT.id, [
      { principal: { kind: 'user', userId: 'u1' }, access: 'maintain' },
      { principal: { kind: 'user', userId: 'u2' }, access: 'use' },
      { principal: { kind: 'everyone' }, access: 'use' }
    ])
    // Pending like every other People change: the controls hold, this button says it is busy.
    await waitFor(() => expect(everyone()!.disabled).toBe(true))
    expect(everyone()!.getAttribute('aria-busy')).toBe('true')
    expect((within(people).getByRole('button', { name: SHARE_UI_TEXT.shareWithPerson }) as HTMLButtonElement).disabled).toBe(true)
    sharing.people.mockReturnValue(new Promise(() => {}))
    await act(async () =>
      answer(ok({ ...done(), people: { visible: true, people: [PEOPLE.people[0], BOB, PEOPLE.people[1]], selfUserId: 'u1' } }))
    )
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.everyone))
    expect(everyone()).toBeNull()
    expect(within(people).getByRole('button', { name: SHARE_UI_TEXT.shareWithPerson })).toBeTruthy()
  })

  it('keeps Share with everyone after a refusal, with the server’s sentence under the list, so nothing is pushed down', async () => {
    sharing.setPeople.mockResolvedValue(ok(done({ done: false, refusal: 'failed', detail: 'Public items are turned off here.' })))
    sharing.library.mockResolvedValue(ok({ host: 'https://core.test', agents: [entry({ visibility: 'users' })], fetchedAt: '' }))
    sharing.people.mockResolvedValue(ok({ ...PEOPLE, people: [PEOPLE.people[0], BOB] }))
    mount(status())
    const people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(within(people).getByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone })).toBeTruthy())
    fireEvent.click(within(people).getByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone }))
    await waitFor(() => expect(within(people).getByRole('alert').textContent).toBe('Public items are turned off here.'))
    const alert = within(people).getByRole('alert')
    const list = people.querySelector('[data-sharing-people]')!
    expect(alert.parentElement).toBe(list)
    expect(list.lastElementChild).toBe(alert)
    // The rows did not move: the list is still first.
    expect(list.firstElementChild).not.toBe(alert)
    const button = within(people).getByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-busy')).not.toBe('true')
  })

  it('does not offer Share with everyone when the agent is already public, nor to someone who cannot change people', async () => {
    mount(status())
    let people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.everyone))
    expect(within(people).getByRole('button', { name: SHARE_UI_TEXT.shareWithPerson })).toBeTruthy()
    expect(within(people).queryByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone })).toBeNull()
    cleanup()

    // Public but unlisted: no Everyone row, yet nothing for the button to add.
    sharing.library.mockResolvedValue(ok({ host: 'https://core.test', agents: [entry({ isListed: false })], fetchedAt: '' }))
    sharing.people.mockResolvedValue(ok({ ...PEOPLE, people: [PEOPLE.people[0], BOB] }))
    mount(status())
    people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain('Bob'))
    // The listing has answered: Where it’s shared says it is not listed.
    await waitFor(() => expect(document.body.textContent).toContain(SHARE_UI_TEXT.notListed))
    expect(within(people).queryByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone })).toBeNull()
    cleanup()

    sharing.library.mockResolvedValue(ok({ host: 'https://core.test', agents: [entry({ visibility: 'users', access: 'use' })], fetchedAt: '' }))
    sharing.people.mockResolvedValue(ok({ visible: false, people: [], selfUserId: null }))
    mount(status({ remote: { ...status().remote, access: 'use' } }))
    people = section(SHARE_UI_TEXT.peopleSection)
    await waitFor(() => expect(people.textContent).toContain(SHARE_UI_TEXT.peopleOnlyMaintainer))
    expect(within(people).queryByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone })).toBeNull()
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
      // The pick closes the dropdown and stays in the field.
      expect(within(dialog).queryByRole('listbox')).toBeNull()
      const field = within(dialog).getByLabelText(SHARE_UI_TEXT.peopleSearchLabel, { selector: 'input' }) as HTMLInputElement
      expect(field.value).toBe('Bob <bob@x.test>')
      expect((within(dialog).getByLabelText(SHARE_UI_TEXT.accessLabel) as HTMLSelectElement).value).toBe('use')
      expect(within(dialog).getByLabelText(SHARE_UI_TEXT.accessLabel).className.split(/\s+/)).not.toContain('w-full')
      // Editing the field drops the pick until someone is picked again.
      fireEvent.change(field, { target: { value: 'Bob' } })
      expect((within(dialog).getByRole('button', { name: SHARE_UI_TEXT.addPerson }) as HTMLButtonElement).disabled).toBe(true)
      await act(async () => { vi.advanceTimersByTime(400) })
      fireEvent.click(within(dialog).getByRole('option', { name: 'Bob <bob@x.test>' }))
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.addPerson }))
      })
      expect(sharing.setPeople).toHaveBeenCalledWith(AGENT.id, [
        { principal: { kind: 'user', userId: 'u1' }, access: 'maintain' },
        { principal: { kind: 'everyone' }, access: 'use' },
        { principal: { kind: 'user', userId: 'u2' }, access: 'use' }
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

  it('clears a refused delete when the choice changes, and says unticking still removes sharing here', async () => {
    const refusal = '2 people use this. It can be removed once nobody does.'
    sharing.unshare.mockResolvedValue(ok(done({ done: false, refusal: 'failed', detail: refusal })))
    mount(status())
    await waitFor(() => expect(section(SHARE_UI_TEXT.whereShared).textContent).toContain('Alpha in the library'))
    const dialog = open()
    expect(dialog.textContent).not.toContain(SHARE_UI_TEXT.removeSharingOnlyHint)
    const box = within(dialog).getByRole('checkbox')
    fireEvent.click(box)
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.removeSharingConfirm }))
    })
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(refusal))
    expect(dialog.textContent).toContain(SHARE_UI_TEXT.removeSharingOnlyHint)
    fireEvent.click(box)
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(dialog.textContent).not.toContain(SHARE_UI_TEXT.removeSharingOnlyHint)
    sharing.unshare.mockResolvedValue(ok(done()))
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.removeSharingConfirm }))
    })
    expect(sharing.unshare).toHaveBeenLastCalledWith(AGENT.id, false)
  })

  it.each<[string, Partial<AgentShareStatus>, Partial<LibraryAgentDto> | null]>([
    ['someone who may only edit', {}, { access: 'edit' }],
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
