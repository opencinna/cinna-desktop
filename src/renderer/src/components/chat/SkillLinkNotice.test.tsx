import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AlertTriangle } from 'lucide-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import type { SkillLinkResolution, SkillLinkSkill } from '../../../../shared/skillLink'

/**
 * The skill-link offer row in every README §4 state: what it says, which
 * actions it carries, and that it always keeps its reserved second line, so
 * the row never changes height as the lookup answers (ux_rules rule 1).
 */

const login = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }))
vi.mock('../../hooks/useAuth', () => ({ useLogin: () => login }))

const resolve = vi.fn<(input: unknown) => Promise<SkillLinkResolution>>()
const add = vi.fn()
const update = vi.fn()
const deliverPasted = vi.fn(async () => null)
const openExternal = vi.fn(async () => ({ success: true }))
window.api = { skillLinks: { resolve }, catalogSkills: { add, update }, connect: { deliverPasted }, system: { openExternal } } as never

const { useSkillLinkNotice } = await import('./SkillLinkNotice')
const { ComposerNoticePanel } = await import('./ComposerNoticePanel')
const { useSkillLinkOfferStore } = await import('../../stores/skillLinkOffer.store')
const { LOCAL_AGENTS_KEY, localAgentKey } = await import('../../hooks/useLocalAgents')

const LINK = { origin: 'https://cinna.test', packageId: 'test.erp', form: 'https' as const, serverGiven: true }
const SKILL: SkillLinkSkill = {
  packageUuid: 'uuid-1',
  packageId: 'test.erp',
  title: 'ERP lookup',
  name: 'erp-lookup',
  revisionNumber: 3,
  versionLabel: '3.0',
  publisher: 'Ada',
  description: 'Look things up.',
  requiredCredentialSpecs: []
}
const AGENT = { id: 'folder:a', name: 'Invoices' }
const onNewAgent = vi.fn()
const base = { host: 'cinna.test', origin: 'https://cinna.test', serverGiven: true, skill: SKILL }
const ok = (target: Record<string, unknown> = { agentId: AGENT.id, agentName: 'Invoices', verdict: 'ok' }): SkillLinkResolution =>
  ({ state: 'ok', ...base, target }) as SkillLinkResolution

function Harness({ chatKey, agent = AGENT, extra = false }: { chatKey: string; agent?: { id: string; name: string } | null; extra?: boolean }): React.JSX.Element {
  const notice = useSkillLinkNotice(chatKey, agent, { onNewAgent })
  const warning = { key: 'w', tone: 'warning' as const, icon: AlertTriangle, text: 'Needs setup' }
  return <ComposerNoticePanel notices={[...(notice ? [notice] : []), ...(extra ? [warning] : [])]} />
}

/** The test's client, for the re-reads an Add runs. */
let client: QueryClient
function wrapper({ children }: { children: ReactNode }) {
  const [own] = useState(() => (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })))
  return <QueryClientProvider client={own}>{children}</QueryClientProvider>
}

/** The offer alone is named for what it is; beside another row, the panel is the agent's status. */
const panel = (): HTMLElement => screen.getByRole('status', { name: /^(Skill link|Agent status)$/ })
/**
 * The row's second line: present in every state, held one button tall by its
 * strut — a zero-width, aria-hidden button that is always its first child.
 */
function expectReservedLine(): HTMLElement {
  const row = panel().querySelector('li')!
  const line = row.children[1] as HTMLElement
  expect(line).toBeTruthy()
  const strut = line.firstElementChild as HTMLElement
  expect(strut.tagName).toBe('BUTTON')
  expect(strut.getAttribute('aria-hidden')).toBe('true')
  expect(strut.getAttribute('tabindex')).toBe('-1')
  return line
}

function show(answer: SkillLinkResolution | Promise<SkillLinkResolution>, chatKey = 'chat-1', agent: { id: string; name: string } | null = AGENT) {
  resolve.mockReturnValue(answer instanceof Promise ? answer : Promise.resolve(answer))
  act(() => useSkillLinkOfferStore.getState().raise(LINK, chatKey))
  return render(<Harness chatKey={chatKey} agent={agent} />, { wrapper })
}

beforeEach(() => {
  useSkillLinkOfferStore.setState({ offer: null })
  resolve.mockReset()
  add.mockReset()
  update.mockReset()
  onNewAgent.mockReset()
  login.mutateAsync.mockReset()
  login.isPending = false
  openExternal.mockClear()
})

describe('the skill-link offer row', () => {
  it('pending: a lookup line at the row’s full height, and the accent tone when it is the only row', () => {
    show(new Promise(() => {}))
    expect(screen.getByTitle('Looking up test.erp on cinna.test…')).toBeTruthy()
    expect(within(expectReservedLine()).getByText('Nothing is added until you choose.')).toBeTruthy()
    expect(panel().getAttribute('data-tone')).toBe('accent')
    expect(panel().getAttribute('aria-label')).toBe('Skill link')
    expect(screen.queryByRole('button', { name: 'Add to Invoices' })).toBeNull()
    // The package id as code; one line that truncates, the whole sentence in its tooltip.
    expect(screen.getByText('test.erp').tagName).toBe('CODE')
    const sentence = panel().querySelector('li p')!
    expect(sentence.className).toContain('truncate')
    expect(sentence.className).not.toContain('line-clamp-2')
    expect(sentence.getAttribute('title')).toBe('Looking up test.erp on cinna.test…')
  })

  it('the panel takes the warning tone when a warning row sits beside the offer', () => {
    resolve.mockReturnValue(new Promise(() => {}))
    act(() => useSkillLinkOfferStore.getState().raise(LINK, 'chat-1'))
    render(<Harness chatKey="chat-1" extra />, { wrapper })
    expect(panel().getAttribute('data-tone')).toBe('warning')
    expect(panel().getAttribute('aria-label')).toBe('Agent status')
  })

  it('ok: title, version, publisher and host; Add to the agent first, New agent second', async () => {
    show(ok())
    const addButton = await screen.findByRole('button', { name: 'Add to Invoices' })
    expect(panel().querySelector('li p')!.textContent).toBe('ERP lookup · Version 3 (3.0) · by Ada on cinna.test')
    const hostLink = screen.getByRole('link', { name: 'cinna.test' })
    expect(hostLink.getAttribute('title')).toBe('https://cinna.test')
    fireEvent.click(hostLink)
    expect(openExternal).toHaveBeenCalledWith('https://cinna.test')
    expect(resolve).toHaveBeenCalledWith({ origin: 'https://cinna.test', packageId: 'test.erp', agentId: 'folder:a' })
    const line = expectReservedLine()
    const buttons = within(line).getAllByRole('button')
    expect(buttons[0]).toBe(addButton)
    expect(buttons[1].getAttribute('aria-label')).toBe('New agent with this skill')
    expect(addButton.getAttribute('aria-disabled')).toBeNull()
    expect(addButton.className).toContain('composer-notice-button-primary')
    expect(screen.getByRole('button', { name: 'Dismiss skill link' })).toBeTruthy()
    fireEvent.click(buttons[1])
    expect(onNewAgent).toHaveBeenCalledWith(SKILL, expect.objectContaining({ link: LINK }))
  })

  it('ok with Add disabled: the reason on the second line, New agent still offered', async () => {
    show(ok({ agentId: AGENT.id, agentName: 'Invoices', verdict: 'read_only' }))
    const addButton = await screen.findByRole('button', { name: 'Add to Invoices' })
    expect(addButton.getAttribute('aria-disabled')).toBe('true')
    // Disabled, it is not drawn as the first choice.
    expect(addButton.className).not.toContain('composer-notice-button-primary')
    expect(addButton.className).toContain('aria-disabled:!opacity-50')
    expect(within(expectReservedLine()).getByText(/shared with you to use/)).toBeTruthy()
    fireEvent.click(addButton)
    expect(add).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'New agent with this skill' }).getAttribute('aria-disabled')).toBeNull()
  })

  it('no agent picked: Add to agent, disabled, says to pick one', async () => {
    show(ok({ agentId: null, agentName: null, verdict: 'no_agent' }), 'new', null)
    expect((await screen.findByRole('button', { name: 'Add to agent' })).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(/Pick one agent/)).toBeTruthy()
  })

  it('adding: a pending label at the same place, then the row goes on success', async () => {
    let finish!: (value: unknown) => void
    add.mockReturnValue(new Promise((resolveAdd) => (finish = resolveAdd)))
    show(ok())
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Invoices' }))
    expect(add).toHaveBeenCalledWith('folder:a', 'uuid-1')
    const addButton = screen.getByRole('button', { name: 'Add to Invoices' })
    expect(addButton.getAttribute('aria-disabled')).toBe('true')
    expect(within(addButton).getByText('Adding…').getAttribute('aria-hidden')).toBe('false')
    expectReservedLine()
    await act(async () => finish({ ok: true, name: 'erp-lookup', revisionNumber: 3 }))
    expect(useSkillLinkOfferStore.getState().offer).toBeNull()
    expect(screen.queryByRole('status', { name: /^(Skill link|Agent status)$/ })).toBeNull()
  })

  it('an Add refusal shows in the row and closes nothing', async () => {
    add.mockResolvedValue({ ok: false, code: 'clash', message: 'This agent already has a skill with that name.' })
    show(ok())
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Invoices' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('This agent already has a skill with that name.')
    expect(expectReservedLine().contains(alert)).toBe(true)
    expect(useSkillLinkOfferStore.getState().offer).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Add to Invoices' })).toBeTruthy()
  })

  it('the refusal it was raised with (New agent’s failed add) shows on arrival', async () => {
    resolve.mockResolvedValue(ok())
    act(() => useSkillLinkOfferStore.getState().raise(LINK, 'new', { addError: 'The skill could not be downloaded.' }))
    render(<Harness chatKey="new" />, { wrapper })
    expect((await screen.findByRole('alert')).textContent).toBe('The skill could not be downloaded.')
  })

  it('already_added and behind: Update to the latest', async () => {
    update.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3 })
    show({ state: 'already_added', ...base, target: { agentId: AGENT.id, agentName: 'Invoices', verdict: 'already_added', pinName: 'erp-lookup', pinnedRevision: 2, behind: true } })
    expect(await screen.findByText('ERP lookup is already on Invoices (Version 2)')).toBeTruthy()
    expectReservedLine()
    fireEvent.click(screen.getByRole('button', { name: 'Update to Version 3' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('folder:a', 'erp-lookup'))
    await waitFor(() => expect(useSkillLinkOfferStore.getState().offer).toBeNull())
  })

  it('already_added and current: no Update', async () => {
    show({ state: 'already_added', ...base, target: { agentId: AGENT.id, agentName: 'Invoices', verdict: 'already_added', pinName: 'erp-lookup', pinnedRevision: 3, behind: false } })
    expect(await screen.findByText('ERP lookup is already on Invoices (Version 3)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Update/ })).toBeNull()
    expectReservedLine()
  })

  it('other_profile: Switch to that account, which moves the offer along', async () => {
    login.mutateAsync.mockResolvedValue({ success: true })
    show({ state: 'other_profile', host: 'acme.test', origin: 'https://acme.test', profileId: 'p2', profileName: 'Me at Acme', title: 'ERP (Acme)' })
    expect(await screen.findByText('ERP (Acme) is on acme.test, not your current account.')).toBeTruthy()
    expectReservedLine()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Me at Acme' }))
    await waitFor(() => expect(login.mutateAsync).toHaveBeenCalledWith({ userId: 'p2' }))
    await waitFor(() => expect(useSkillLinkOfferStore.getState().offer).toMatchObject({ chatKey: 'new', pendingFrom: null }))
  })

  it('Switch: the row stays where it is with Switching… while the login runs, and a failure brings nothing back', async () => {
    let finish!: (value: unknown) => void
    login.mutateAsync.mockReturnValue(new Promise((resolveLogin) => (finish = resolveLogin)))
    show({ state: 'other_profile', host: 'acme.test', origin: 'https://acme.test', profileId: 'p2', profileName: 'Me at Acme', title: 'ERP (Acme)' })
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Me at Acme' }))
    const button = screen.getByRole('button', { name: 'Switch to Me at Acme' })
    expect(within(button).getByText('Switching…').getAttribute('aria-hidden')).toBe('false')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('ERP (Acme) is on acme.test, not your current account.')).toBeTruthy()
    expect(useSkillLinkOfferStore.getState().offer).toMatchObject({ chatKey: 'new', pendingFrom: 'chat-1' })
    await act(async () => finish({ success: false }))
    expect(useSkillLinkOfferStore.getState().offer).toMatchObject({ chatKey: 'chat-1', pendingFrom: null })
    expect((await screen.findByRole('alert')).textContent).toMatch(/needs its password/)
  })

  it('not_connected: Connect… goes through the connect confirm step', async () => {
    show({ state: 'not_connected', host: 'acme.test', origin: 'https://acme.test' })
    expect(await screen.findByText('This skill is on acme.test. Connect to it first.')).toBeTruthy()
    expectReservedLine()
    fireEvent.click(screen.getByRole('button', { name: 'Connect…' }))
    expect(deliverPasted).toHaveBeenCalledWith('cinna://connect?server=https%3A%2F%2Facme.test')
  })

  it('no_access: says so, with nothing to click but ×', async () => {
    show({ state: 'no_access', host: 'cinna.test', origin: 'https://cinna.test' })
    expect(await screen.findByText('You don’t have access to this skill on cinna.test.')).toBeTruthy()
    expect(within(expectReservedLine()).queryByRole('button')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss skill link' }))
    expect(useSkillLinkOfferStore.getState().offer).toBeNull()
  })

  it('reauth_required: says to sign in again, not that the server is unreachable; Try again asks again', async () => {
    show({ state: 'reauth_required', host: 'cinna.test', origin: 'https://cinna.test' })
    expect(await screen.findByText('Sign in to cinna.test again to look this skill up.')).toBeTruthy()
    expect(screen.queryByText(/Couldn’t reach/)).toBeNull()
    const line = expectReservedLine()
    resolve.mockResolvedValue(ok())
    fireEvent.click(within(line).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Add to Invoices' })).toBeTruthy()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('a successful Add runs the re-reads every other Add runs', async () => {
    add.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3 })
    show(ok())
    const addButton = await screen.findByRole('button', { name: 'Add to Invoices' })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    fireEvent.click(addButton)
    await waitFor(() => expect(useSkillLinkOfferStore.getState().offer).toBeNull())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: LOCAL_AGENTS_KEY })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: localAgentKey('folder:a') })
  })

  it('a successful Update runs them too', async () => {
    update.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3 })
    show({ state: 'already_added', ...base, target: { agentId: AGENT.id, agentName: 'Invoices', verdict: 'already_added', pinName: 'erp-lookup', pinnedRevision: 2, behind: true } })
    const updateButton = await screen.findByRole('button', { name: 'Update to Version 3' })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    fireEvent.click(updateButton)
    await waitFor(() => expect(useSkillLinkOfferStore.getState().offer).toBeNull())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: localAgentKey('folder:a') })
  })

  it('offline: Try again asks again', async () => {
    show({ state: 'offline', host: 'cinna.test', origin: 'https://cinna.test' })
    expect(await screen.findByText('Couldn’t reach cinna.test to look this skill up.')).toBeTruthy()
    expectReservedLine()
    resolve.mockResolvedValue(ok())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Add to Invoices' })).toBeTruthy()
    expect(resolve).toHaveBeenCalledTimes(2)
  })
})

describe('where the offer lives', () => {
  it('only on the composer with its key', () => {
    resolve.mockReturnValue(new Promise(() => {}))
    act(() => useSkillLinkOfferStore.getState().raise(LINK, 'chat-2'))
    render(<Harness chatKey="chat-1" />, { wrapper })
    expect(screen.queryByRole('status', { name: /^(Skill link|Agent status)$/ })).toBeNull()
  })

  it('a composer changing key does not dismiss it by itself (the App-level watch does: useSkillLinkIntents)', () => {
    const view = show(new Promise(() => {}), 'chat-1')
    view.rerender(<Harness chatKey="chat-2" />)
    expect(useSkillLinkOfferStore.getState().offer?.chatKey).toBe('chat-1')
  })

  it('a second link on the same composer shows its lookup line, never the first link’s skill', async () => {
    show(ok())
    expect(await screen.findByRole('button', { name: 'Add to Invoices' })).toBeTruthy()
    resolve.mockReturnValue(new Promise(() => {}))
    act(() => useSkillLinkOfferStore.getState().raise({ ...LINK, packageId: 'test.other' }, 'chat-1'))
    expect(await screen.findByText(/Looking up/)).toBeTruthy()
    expect(panel().querySelector('li p')!.textContent).toBe('Looking up test.other on cinna.test…')
    expect(screen.queryByText(/ERP lookup/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'New agent with this skill' })).toBeNull()
  })

  it('the agent changing holds every action on the last answer, and names the new agent', async () => {
    let answer!: (value: SkillLinkResolution) => void
    resolve.mockResolvedValueOnce(ok({ agentId: AGENT.id, agentName: 'Invoices', verdict: 'read_only' }))
    const view = show(ok({ agentId: AGENT.id, agentName: 'Invoices', verdict: 'read_only' }))
    expect(await screen.findByText(/shared with you to use/)).toBeTruthy()
    resolve.mockReturnValue(new Promise((r) => (answer = r)))
    view.rerender(<Harness chatKey="chat-1" agent={{ id: 'folder:b', name: 'Reports' }} />)
    const addButton = await screen.findByRole('button', { name: 'Add to Reports' })
    expect(addButton.getAttribute('aria-disabled')).toBe('true')
    // The previous agent's refusal is not said of this one.
    expect(screen.queryByText(/shared with you to use/)).toBeNull()
    const newAgent = screen.getByRole('button', { name: 'New agent with this skill' })
    expect(newAgent.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(newAgent)
    expect(onNewAgent).not.toHaveBeenCalled()
    await act(async () => answer(ok({ agentId: 'folder:b', agentName: 'Reports', verdict: 'ok' })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to Reports' }).getAttribute('aria-disabled')).toBeNull())
    expect(screen.getByRole('button', { name: 'New agent with this skill' }).getAttribute('aria-disabled')).toBeNull()
  })

  it('moveTo survives the switch it announces', () => {
    const view = show(new Promise(() => {}), 'chat-1')
    act(() => useSkillLinkOfferStore.getState().moveTo('chat-2'))
    view.rerender(<Harness chatKey="chat-2" />)
    expect(useSkillLinkOfferStore.getState().offer?.chatKey).toBe('chat-2')
    expect(screen.getByTitle('Looking up test.erp on cinna.test…')).toBeTruthy()
  })
})
