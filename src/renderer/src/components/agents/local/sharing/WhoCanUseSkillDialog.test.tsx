import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPeopleDto, SetPeopleResult } from '../../../../../../shared/agentSharing'

/**
 * A shared skill's Who can use: the agent's People list over the skill
 * package's grants — the list, adding a person in place, changing access,
 * removing behind the row's confirm, Share with everyone and its refusal —
 * and Escape that steps back from the add form, then closes, without
 * reaching the catalog dialog underneath.
 */

const { WhoCanUseSkillDialog } = await import('./WhoCanUseSkillDialog')
const { SHARE_UI_TEXT } = await import('../../../../utils/shareText')
const { SKILL_SHARE_TEXT } = await import('../../../../utils/catalogItems')
const { useAuthStore } = await import('../../../../stores/auth.store')

const PKG = 'pkg-1'
const ok = <T,>(value: T) => ({ success: true as const, value })
const done = (overrides: Partial<SetPeopleResult> = {}): SetPeopleResult => ({
  done: true,
  refusal: null,
  detail: null,
  status: null,
  agentId: null,
  autoAttached: [],
  setupNeeded: false,
  people: null,
  ...overrides
})

const ANN = { principal: { kind: 'user' as const, userId: 'u1' }, access: 'maintain' as const, displayName: 'Ann' }
const BOB = { principal: { kind: 'user' as const, userId: 'u2' }, access: 'use' as const, displayName: 'Bob' }
const PEOPLE: AgentPeopleDto = { visible: true, people: [ANN, BOB], selfUserId: 'u1' }

function skillItem(visibility = 'users', maintainers = [{ user_id: 'u1', display_name: 'Ann' }]) {
  return {
    kind: 'skill',
    runs_on: null,
    uuid: PKG,
    id: 'test.core.erp-lookup',
    name: 'erp-lookup',
    display_name: 'erp-lookup',
    description: null,
    publisher: null,
    maintainers,
    access: 'maintain',
    visibility,
    is_listed: true,
    latest: null,
    install_count: 0,
    my_installs: [],
    required_credential_specs: [],
    skills: null,
    desktop: null,
    skill: null
  }
}

let sharing: Record<string, ReturnType<typeof vi.fn>>
let onClose: ReturnType<typeof vi.fn>

beforeEach(() => {
  act(() =>
    useAuthStore.setState({
      currentUser: { id: 'p1', type: 'cinna_user', username: 'ann', displayName: 'Ann', hasPassword: false } as never
    })
  )
  sharing = {
    itemPeople: vi.fn().mockResolvedValue(ok(PEOPLE)),
    setItemPeople: vi.fn().mockResolvedValue(ok(done())),
    searchPeople: vi.fn().mockResolvedValue(ok([{ userId: 'u3', email: 'carol@x.test', name: 'Carol' }]))
  }
  ;(window as unknown as { api: unknown }).api = {
    sharing,
    catalog: { items: vi.fn().mockResolvedValue(ok({ host: 'https://core.test', items: [skillItem()], fetchedAt: '', available: true })) }
  }
  onClose = vi.fn()
})

afterEach(() => {
  act(() => useAuthStore.setState({ currentUser: null }))
  cleanup()
  vi.clearAllMocks()
})

function mount(): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(WhoCanUseSkillDialog, { itemUuid: PKG, skillName: 'erp-lookup', onClose })
    )
  )
  return screen.getByRole('dialog', { name: SKILL_SHARE_TEXT.whoCanUseTitle('erp-lookup') })
}

describe('Who can use a skill', () => {
  it('lists who has access by the package uuid, the maintainer’s own row left out', async () => {
    const dialog = mount()
    await within(dialog).findByText('Bob')
    expect(sharing.itemPeople).toHaveBeenCalledWith(PKG)
    expect(within(dialog).queryByText(SHARE_UI_TEXT.you)).toBeNull()
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(1)
    // Not public: Share with everyone is offered beside Share with a person….
    expect(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.shareWithPerson })).toBeTruthy()
  })

  it('names the maintainers on a line above the list, and never says no one else has access while a co-maintainer does', async () => {
    sharing.itemPeople.mockResolvedValue(ok({ ...PEOPLE, people: [ANN] }))
    ;(window as unknown as { api: { catalog: { items: ReturnType<typeof vi.fn> } } }).api.catalog.items.mockResolvedValue(
      ok({
        host: 'https://core.test',
        items: [skillItem('users', [{ user_id: 'u1', display_name: 'Ann' }, { user_id: 'u9', display_name: 'Dan' }])],
        fetchedAt: '',
        available: true
      })
    )
    const dialog = mount()
    await within(dialog).findByText(SHARE_UI_TEXT.peopleOnlyMaintainers)
    const line = dialog.querySelector('[data-who-can-use-maintainers]')!
    expect(line.textContent).toBe(`${SHARE_UI_TEXT.maintainersLabel}Ann, Dan`)
    expect(within(dialog).queryByText(SHARE_UI_TEXT.peopleNoOneElse)).toBeNull()
  })

  it('says no one else has access when the only maintainer is you and no one has a grant', async () => {
    sharing.itemPeople.mockResolvedValue(ok({ ...PEOPLE, people: [ANN] }))
    const dialog = mount()
    await within(dialog).findByText(SHARE_UI_TEXT.peopleNoOneElse)
    expect(dialog.querySelector('[data-who-can-use-maintainers]')!.textContent).toBe(`${SHARE_UI_TEXT.maintainersLabel}Ann`)
  })

  it('changes a person’s access, and removes one only after the row’s confirm', async () => {
    const dialog = mount()
    await within(dialog).findByText('Bob')
    fireEvent.change(within(dialog).getByLabelText(SHARE_UI_TEXT.accessFor('Bob')), { target: { value: 'edit' } })
    await waitFor(() => expect(sharing.setItemPeople).toHaveBeenCalledTimes(1))
    expect(sharing.setItemPeople).toHaveBeenLastCalledWith(PKG, [
      { principal: ANN.principal, access: 'maintain' },
      { principal: BOB.principal, access: 'edit' }
    ])
    await waitFor(() => expect(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.removePerson('Bob') })).toHaveProperty('disabled', false))
    fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.removePerson('Bob') }))
    expect(sharing.setItemPeople).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.removePersonAction }))
    await waitFor(() => expect(sharing.setItemPeople).toHaveBeenCalledTimes(2))
    expect(sharing.setItemPeople).toHaveBeenLastCalledWith(PKG, [{ principal: ANN.principal, access: 'maintain' }])
    expect(onClose).not.toHaveBeenCalled()
  })

  it('adds a person in place of the list, and goes back to it once the server took them', async () => {
    const dialog = mount()
    await within(dialog).findByText('Bob')
    fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.shareWithPerson }))
    // One dialog: the form replaces the list rather than opening over it.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const search = within(dialog).getByRole('combobox', { name: SHARE_UI_TEXT.peopleSearchLabel })
    fireEvent.change(search, { target: { value: 'car' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /Carol/ }, { timeout: 2000 }))
    fireEvent.change(within(dialog).getByLabelText(SHARE_UI_TEXT.accessLabel), { target: { value: 'edit' } })
    fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.addPerson }))
    await waitFor(() => expect(sharing.setItemPeople).toHaveBeenCalledTimes(1))
    expect(sharing.setItemPeople).toHaveBeenLastCalledWith(PKG, [
      { principal: ANN.principal, access: 'maintain' },
      { principal: BOB.principal, access: 'use' },
      { principal: { kind: 'user', userId: 'u3' }, access: 'edit' }
    ])
    await within(dialog).findByRole('button', { name: SHARE_UI_TEXT.shareWithPerson })
  })

  it('keeps the add form open with the server’s refusal', async () => {
    sharing.setItemPeople.mockResolvedValue(ok(done({ done: false, refusal: 'failed', detail: 'Carol is not active.' })))
    const dialog = mount()
    await within(dialog).findByText('Bob')
    fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.shareWithPerson }))
    fireEvent.change(within(dialog).getByRole('combobox', { name: SHARE_UI_TEXT.peopleSearchLabel }), { target: { value: 'car' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /Carol/ }, { timeout: 2000 }))
    fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.addPerson }))
    expect(await within(dialog).findByText('Carol is not active.')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.addPerson })).toBeTruthy()
  })

  it('shares with everyone, and a refusal shows under the list in the skill’s words', async () => {
    sharing.setItemPeople.mockResolvedValue(ok(done({ done: false, refusal: 'no_access' })))
    const dialog = mount()
    await within(dialog).findByText('Bob')
    fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone }))
    await waitFor(() => expect(sharing.setItemPeople).toHaveBeenCalledTimes(1))
    expect(sharing.setItemPeople).toHaveBeenLastCalledWith(PKG, [
      { principal: ANN.principal, access: 'maintain' },
      { principal: BOB.principal, access: 'use' },
      { principal: { kind: 'everyone' }, access: 'use' }
    ])
    const alert = await within(dialog).findByText(SKILL_SHARE_TEXT.peopleNoAccess)
    expect(alert.parentElement!.lastElementChild).toBe(alert)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers no Share with everyone on a public skill, which lists Everyone instead', async () => {
    sharing.itemPeople.mockResolvedValue(
      ok({ ...PEOPLE, people: [...PEOPLE.people, { principal: { kind: 'everyone' }, access: 'use', displayName: '' }] })
    )
    ;(window as unknown as { api: { catalog: { items: ReturnType<typeof vi.fn> } } }).api.catalog.items.mockResolvedValue(
      ok({ host: 'https://core.test', items: [skillItem('public')], fetchedAt: '', available: true })
    )
    const dialog = mount()
    await within(dialog).findByText(SHARE_UI_TEXT.everyone)
    expect(within(dialog).queryByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone })).toBeNull()
  })

  it('shows a non-maintainer the maintainers and changes nothing', async () => {
    sharing.itemPeople.mockResolvedValue(ok({ visible: false, people: [], selfUserId: null }))
    const dialog = mount()
    await within(dialog).findByText(SHARE_UI_TEXT.peopleOnlyMaintainer)
    // Named once, on the Maintainers line, not again as a row.
    expect(within(dialog).getAllByText('Ann')).toHaveLength(1)
    expect(within(dialog).queryByRole('button', { name: SHARE_UI_TEXT.shareWithPerson })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: SHARE_UI_TEXT.shareWithEveryone })).toBeNull()
  })

  it('Escape steps back from the add form, then closes — and never reaches a surface underneath', async () => {
    const underneath = vi.fn()
    window.addEventListener('keydown', underneath)
    try {
      const dialog = mount()
      await within(dialog).findByText('Bob')
      fireEvent.click(within(dialog).getByRole('button', { name: SHARE_UI_TEXT.shareWithPerson }))
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      await within(dialog).findByRole('button', { name: SHARE_UI_TEXT.shareWithPerson })
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(underneath).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', underneath)
    }
  })
})
