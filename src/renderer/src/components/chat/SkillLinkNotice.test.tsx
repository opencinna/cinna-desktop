import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AlertTriangle } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import type { SkillLinkResolution, SkillLinkSkill } from '../../../../shared/skillLink'

/**
 * The skill-link offer row in every README §4 state: what it says, which
 * actions it carries, and that it is always one truncated line held one
 * button tall, the actions at its end, so the row never changes height as the
 * lookup answers (ux_rules rule 1).
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
const { useSkillLinkOfferStore, SETTLING_FALLBACK_MS } = await import('../../stores/skillLinkOffer.store')
const { useSkillCredentialPromptStore } = await import('../../stores/skillCredentialPrompt.store')
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
 * The row's one line, in every state: the sentence truncated rather than
 * wrapped, held one button tall by its strut — a zero-width, aria-hidden
 * button that is always its first child — and the × at its end.
 */
function expectOneLine(): HTMLElement {
  const row = panel().querySelector('li')!
  const line = row.firstElementChild as HTMLElement
  // Nothing under the line but the details drawer.
  expect(Array.from(row.children).slice(1).every((el) => !el.querySelector('button'))).toBe(true)
  const strut = line.firstElementChild as HTMLElement
  expect(strut.tagName).toBe('BUTTON')
  expect(strut.getAttribute('aria-hidden')).toBe('true')
  expect(strut.getAttribute('tabindex')).toBe('-1')
  expect(line.querySelector('p')!.className).toContain('truncate')
  expect(line.lastElementChild!.getAttribute('aria-label')).toBe('Dismiss skill link')
  return line
}

/** The settling row: the checking sentence, no actions but the ×, on the offer's one line. */
function expectSettlingRow(): void {
  expect(panel().querySelector('li p')!.textContent).toBe('Added ERP lookup. Checking its credentials…')
  expect(panel().querySelector('li p')!.getAttribute('title')).toBe('Added ERP lookup. Checking its credentials…')
  const line = expectOneLine()
  expect(within(line).getAllByRole('button')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: /^Add$|Update to|New agent|More / })).toBeNull()
  expect(screen.queryByRole('button', { name: /^Details of/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Dismiss skill link' })).toBeTruthy()
}

function show(answer: SkillLinkResolution | Promise<SkillLinkResolution>, chatKey = 'chat-1', agent: { id: string; name: string } | null = AGENT) {
  resolve.mockReturnValue(answer instanceof Promise ? answer : Promise.resolve(answer))
  act(() => useSkillLinkOfferStore.getState().raise(LINK, chatKey))
  return render(<Harness chatKey={chatKey} agent={agent} />, { wrapper })
}

beforeEach(() => {
  useSkillLinkOfferStore.setState({ offer: null })
  useSkillCredentialPromptStore.setState({ prompts: {}, settled: {} })
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
    expect(screen.getByTitle('Looking up test.erp on cinna.test… Nothing is added until you choose.')).toBeTruthy()
    // The note sits after the sentence, on its line: nothing is offered yet, but the row is already one button tall.
    expect(within(expectOneLine()).getByText('Nothing is added until you choose.').closest('p')).toBeTruthy()
    expect(panel().getAttribute('data-tone')).toBe('accent')
    expect(panel().getAttribute('aria-label')).toBe('Skill link')
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    // The package id as code; one line that truncates, the whole sentence in its tooltip.
    expect(screen.getByText('test.erp').tagName).toBe('CODE')
    const sentence = panel().querySelector('li p')!
    expect(sentence.className).toContain('truncate')
    expect(sentence.className).not.toContain('line-clamp-2')
    expect(sentence.getAttribute('title')).toBe('Looking up test.erp on cinna.test… Nothing is added until you choose.')
  })

  it('the panel takes the warning tone when a warning row sits beside the offer', () => {
    resolve.mockReturnValue(new Promise(() => {}))
    act(() => useSkillLinkOfferStore.getState().raise(LINK, 'chat-1'))
    render(<Harness chatKey="chat-1" extra />, { wrapper })
    expect(panel().getAttribute('data-tone')).toBe('warning')
    expect(panel().getAttribute('aria-label')).toBe('Agent status')
  })

  it('ok: title, version, publisher and host; Add first, New agent with this skill behind its chevron', async () => {
    show(ok())
    const addButton = await screen.findByRole('button', { name: 'Add' })
    expect(panel().querySelector('li p')!.textContent).toBe('ERP lookup · v3 (3.0) · by Ada on cinna.test')
    const hostLink = screen.getByRole('link', { name: 'cinna.test' })
    expect(hostLink.getAttribute('title')).toBe('https://cinna.test')
    fireEvent.click(hostLink)
    expect(openExternal).toHaveBeenCalledWith('https://cinna.test')
    expect(resolve).toHaveBeenCalledWith({ origin: 'https://cinna.test', packageId: 'test.erp', agentId: 'folder:a' })
    // Message left, then the details chevron, Add with its chevron, and the × on the same line:
    // one labelled action (ux_rules rule 20), the agent's name in its title rather than its label.
    const line = expectOneLine()
    const buttons = within(line).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Details of ERP lookup', 'Add', 'More ways to add', 'Dismiss skill link'])
    expect(buttons[1]).toBe(addButton)
    expect(addButton.textContent).toContain('Add')
    expect(addButton.getAttribute('title')).toBe('Add ERP lookup to Invoices')
    expect(addButton.getAttribute('aria-disabled')).toBeNull()
    expect(addButton.className).toContain('composer-notice-button-primary')
    expect(screen.queryByRole('button', { name: 'New agent with this skill' })).toBeNull()
    fireEvent.click(buttons[2])
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'New agent with this skill' }))
    expect(onNewAgent).toHaveBeenCalledWith(SKILL, expect.objectContaining({ link: LINK }))
    expect(add).not.toHaveBeenCalled()
  })

  it('details: the chevron opens the description and lets the sentence wrap in full', async () => {
    show(ok())
    const toggle = await screen.findByRole('button', { name: 'Details of ERP lookup' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const sentence = panel().querySelector('li p')!
    expect(sentence.className).toContain('truncate')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Look things up.')).toBeTruthy()
    expect(sentence.className).not.toContain('truncate')
    fireEvent.click(toggle)
    expect(sentence.className).toContain('truncate')
  })

  it('ok but refused: no disabled Add; New agent is the row’s one action, the reason on the line in place of the facts', async () => {
    show(ok({ agentId: AGENT.id, agentName: 'Invoices', verdict: 'read_only' }))
    const newAgent = await screen.findByRole('button', { name: 'New agent' })
    const line = expectOneLine()
    expect(within(line).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Details of ERP lookup', 'New agent', 'Dismiss skill link'])
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'More ways to add' })).toBeNull()
    expect(newAgent.getAttribute('title')).toBe('New agent with this skill')
    expect(newAgent.getAttribute('aria-disabled')).toBeNull()
    const sentence = line.querySelector('p')!
    expect(sentence.textContent).toBe('ERP lookup · Invoices is shared with you to use, so its skills can’t be changed here.')
    // The facts it stands in for stay in the tooltip.
    expect(sentence.getAttribute('title')).toContain('v3 (3.0) · by Ada on cinna.test')
    fireEvent.click(newAgent)
    expect(onNewAgent).toHaveBeenCalledWith(SKILL, expect.objectContaining({ link: LINK }))
    expect(add).not.toHaveBeenCalled()
  })

  it('no agent picked: New agent alone, and the line says to pick one', async () => {
    show(ok({ agentId: null, agentName: null, verdict: 'no_agent' }), 'new', null)
    expect(await screen.findByRole('button', { name: 'New agent' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    expect(screen.getByText(/Pick one agent/)).toBeTruthy()
  })

  it('adding: a pending label at the same place, then the row checks the credentials on success', async () => {
    let finish!: (value: unknown) => void
    add.mockReturnValue(new Promise((resolveAdd) => (finish = resolveAdd)))
    show(ok())
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    expect(add).toHaveBeenCalledWith('folder:a', 'uuid-1')
    const addButton = screen.getByRole('button', { name: 'Add' })
    expect(addButton.getAttribute('aria-disabled')).toBe('true')
    expect(within(addButton).getByText('Adding…').getAttribute('aria-hidden')).toBe('false')
    expectOneLine()
    await act(async () => finish({ ok: true, name: 'erp-lookup', revisionNumber: 3 }))
    expect(useSkillLinkOfferStore.getState().offer?.settling).toEqual({ agentId: 'folder:a', since: 0, title: 'ERP lookup' })
    expectSettlingRow()
  })

  it('an Add refusal takes the line beside the button and closes nothing', async () => {
    add.mockResolvedValue({ ok: false, code: 'clash', message: 'This agent already has a skill with that name.' })
    show(ok())
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('This agent already has a skill with that name.')
    expect(expectOneLine().querySelector('p')!.contains(alert)).toBe(true)
    expect(alert.closest('p')!.getAttribute('title')).toBe('This agent already has a skill with that name. ERP lookup · v3 (3.0) · by Ada on cinna.test')
    expect(useSkillLinkOfferStore.getState().offer).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
  })

  it('the refusal it was raised with (New agent’s failed add) shows on arrival', async () => {
    resolve.mockResolvedValue(ok())
    act(() => useSkillLinkOfferStore.getState().raise(LINK, 'new', { addError: 'The skill could not be downloaded.' }))
    render(<Harness chatKey="new" />, { wrapper })
    expect((await screen.findByRole('alert')).textContent).toBe('The skill could not be downloaded.')
  })

  it('already_added and behind: Update to the latest, New agent behind its chevron', async () => {
    update.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3 })
    show({ state: 'already_added', ...base, target: { agentId: AGENT.id, agentName: 'Invoices', verdict: 'already_added', pinName: 'erp-lookup', pinnedRevision: 2, behind: true } })
    expect(await screen.findByText('ERP lookup is already on Invoices (v2)')).toBeTruthy()
    const line = expectOneLine()
    expect(within(line).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Details of ERP lookup', 'Update to v3', 'More actions', 'Dismiss skill link'])
    const updateButton = screen.getByRole('button', { name: 'Update to v3' })
    expect(updateButton.getAttribute('title')).toBe('Update ERP lookup on Invoices to v3')
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'New agent with this skill' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(updateButton)
    await waitFor(() => expect(update).toHaveBeenCalledWith('folder:a', 'erp-lookup'))
    await waitFor(() => expectSettlingRow())
  })

  it('already_added and current: no Update', async () => {
    show({ state: 'already_added', ...base, target: { agentId: AGENT.id, agentName: 'Invoices', verdict: 'already_added', pinName: 'erp-lookup', pinnedRevision: 3, behind: false } })
    expect(await screen.findByText('ERP lookup is already on Invoices (v3)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Update/ })).toBeNull()
    expect(within(expectOneLine()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Details of ERP lookup', 'New agent', 'Dismiss skill link'])
  })

  it('other_profile: Switch to that account, which moves the offer along', async () => {
    login.mutateAsync.mockResolvedValue({ success: true })
    show({ state: 'other_profile', host: 'acme.test', origin: 'https://acme.test', profileId: 'p2', profileName: 'Me at Acme', title: 'ERP (Acme)' })
    expect(await screen.findByText('ERP (Acme) is on acme.test, not your current account.')).toBeTruthy()
    expectOneLine()
    const switchButton = screen.getByRole('button', { name: 'Switch account' })
    expect(switchButton.getAttribute('title')).toBe('Switch to Me at Acme')
    fireEvent.click(switchButton)
    await waitFor(() => expect(login.mutateAsync).toHaveBeenCalledWith({ userId: 'p2' }))
    await waitFor(() => expect(useSkillLinkOfferStore.getState().offer).toMatchObject({ chatKey: 'new', pendingFrom: null }))
  })

  it('Switch: the row stays where it is with Switching… while the login runs, and a failure brings nothing back', async () => {
    let finish!: (value: unknown) => void
    login.mutateAsync.mockReturnValue(new Promise((resolveLogin) => (finish = resolveLogin)))
    show({ state: 'other_profile', host: 'acme.test', origin: 'https://acme.test', profileId: 'p2', profileName: 'Me at Acme', title: 'ERP (Acme)' })
    fireEvent.click(await screen.findByRole('button', { name: 'Switch account' }))
    const button = screen.getByRole('button', { name: 'Switch account' })
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
    expectOneLine()
    fireEvent.click(screen.getByRole('button', { name: 'Connect…' }))
    expect(deliverPasted).toHaveBeenCalledWith('cinna://connect?server=https%3A%2F%2Facme.test')
  })

  it('no_access: says so, with nothing to click but ×', async () => {
    show({ state: 'no_access', host: 'cinna.test', origin: 'https://cinna.test' })
    expect(await screen.findByText('You don’t have access to this skill on cinna.test.')).toBeTruthy()
    expect(within(expectOneLine()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Dismiss skill link'])
    expect(screen.getByTitle('You don’t have access to this skill on cinna.test. Ask whoever shared it.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss skill link' }))
    expect(useSkillLinkOfferStore.getState().offer).toBeNull()
  })

  it('reauth_required: says to sign in again, not that the server is unreachable; Try again asks again', async () => {
    show({ state: 'reauth_required', host: 'cinna.test', origin: 'https://cinna.test' })
    expect(await screen.findByText('Sign in to cinna.test again to look this skill up.')).toBeTruthy()
    expect(screen.queryByText(/Couldn’t reach/)).toBeNull()
    const line = expectOneLine()
    resolve.mockResolvedValue(ok())
    fireEvent.click(within(line).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Add' })).toBeTruthy()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('a successful Add runs the re-reads every other Add runs', async () => {
    add.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3 })
    show(ok())
    const addButton = await screen.findByRole('button', { name: 'Add' })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    fireEvent.click(addButton)
    await waitFor(() => expect(useSkillLinkOfferStore.getState().offer?.settling).toBeTruthy())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: LOCAL_AGENTS_KEY })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: localAgentKey('folder:a') })
  })

  it('a successful Update runs them too', async () => {
    update.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3 })
    show({ state: 'already_added', ...base, target: { agentId: AGENT.id, agentName: 'Invoices', verdict: 'already_added', pinName: 'erp-lookup', pinnedRevision: 2, behind: true } })
    const updateButton = await screen.findByRole('button', { name: 'Update to v3' })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    fireEvent.click(updateButton)
    await waitFor(() => expect(useSkillLinkOfferStore.getState().offer?.settling).toBeTruthy())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: localAgentKey('folder:a') })
  })

  it('offline: Try again asks again', async () => {
    show({ state: 'offline', host: 'cinna.test', origin: 'https://cinna.test' })
    expect(await screen.findByText('Couldn’t reach cinna.test to look this skill up.')).toBeTruthy()
    expectOneLine()
    resolve.mockResolvedValue(ok())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Add' })).toBeTruthy()
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
    expect(await screen.findByRole('button', { name: 'Add' })).toBeTruthy()
    resolve.mockReturnValue(new Promise(() => {}))
    act(() => useSkillLinkOfferStore.getState().raise({ ...LINK, packageId: 'test.other' }, 'chat-1'))
    expect(await screen.findByText(/Looking up/)).toBeTruthy()
    expect(panel().querySelector('li p')!.textContent).toBe('Looking up test.other on cinna.test… Nothing is added until you choose.')
    expect(screen.queryByText(/ERP lookup/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'More ways to add' })).toBeNull()
  })

  it('the agent changing holds every action on the last answer, and names the new agent', async () => {
    let answer!: (value: SkillLinkResolution) => void
    resolve.mockResolvedValueOnce(ok({ agentId: AGENT.id, agentName: 'Invoices', verdict: 'read_only' }))
    const view = show(ok({ agentId: AGENT.id, agentName: 'Invoices', verdict: 'read_only' }))
    expect(await screen.findByText(/shared with you to use/)).toBeTruthy()
    resolve.mockReturnValue(new Promise((r) => (answer = r)))
    view.rerender(<Harness chatKey="chat-1" agent={{ id: 'folder:b', name: 'Reports' }} />)
    const addButton = await screen.findByRole('button', { name: 'Add' })
    expect(addButton.getAttribute('title')).toBe('Add ERP lookup to Reports')
    expect(addButton.getAttribute('aria-disabled')).toBe('true')
    // The previous agent's refusal is not said of this one.
    expect(screen.queryByText(/shared with you to use/)).toBeNull()
    const more = screen.getByRole('button', { name: 'More ways to add' })
    expect(more.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(more)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(addButton)
    expect(add).not.toHaveBeenCalled()
    expect(onNewAgent).not.toHaveBeenCalled()
    await act(async () => answer(ok({ agentId: 'folder:b', agentName: 'Reports', verdict: 'ok' })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' }).getAttribute('aria-disabled')).toBeNull())
    expect(screen.getByRole('button', { name: 'More ways to add' }).getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More ways to add' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New agent with this skill' }))
    expect(onNewAgent).toHaveBeenCalledTimes(1)
  })

  it('moveTo survives the switch it announces', () => {
    const view = show(new Promise(() => {}), 'chat-1')
    act(() => useSkillLinkOfferStore.getState().moveTo('chat-2'))
    view.rerender(<Harness chatKey="chat-2" />)
    expect(useSkillLinkOfferStore.getState().offer?.chatKey).toBe('chat-2')
    expect(screen.getByTitle('Looking up test.erp on cinna.test… Nothing is added until you choose.')).toBeTruthy()
  })
})

describe('after Add: checking its credentials', () => {
  afterEach(() => vi.useRealTimers())

  async function added(): Promise<void> {
    add.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3 })
    show(ok())
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    await waitFor(() => expectSettlingRow())
  }

  it('reads the settle counter at the click: a fill that settles before Add answers still ends the wait', async () => {
    let finish!: (value: unknown) => void
    add.mockReturnValue(new Promise((resolveAdd) => (finish = resolveAdd)))
    act(() => useSkillCredentialPromptStore.setState({ settled: { 'folder:a': 4 } }))
    show(ok())
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    act(() => useSkillCredentialPromptStore.getState().settle('folder:a', []))
    await act(async () => finish({ ok: true, name: 'erp-lookup', revisionNumber: 3 }))
    await waitFor(() => expect(useSkillLinkOfferStore.getState().offer).toBeNull())
  })

  it('goes once the agent’s settle counter passes the click’s, and not on another agent’s', async () => {
    await added()
    act(() => useSkillCredentialPromptStore.getState().settle('folder:other', []))
    expectSettlingRow()
    // In the very render the counter moves, so a credential prompt raised with it takes the row’s place.
    act(() => useSkillCredentialPromptStore.getState().settle('folder:a', ['erp-lookup']))
    expect(screen.queryByRole('status', { name: /^(Skill link|Agent status)$/ })).toBeNull()
    expect(useSkillLinkOfferStore.getState().offer).toBeNull()
  })

  it('goes after the fallback wait when no fill settles', async () => {
    // The clock still runs for the lookup and Add; the jump below is the fake part.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await added()
    act(() => { vi.advanceTimersByTime(SETTLING_FALLBACK_MS - 1000) })
    expectSettlingRow()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(useSkillLinkOfferStore.getState().offer).toBeNull()
    expect(screen.queryByRole('status', { name: /^(Skill link|Agent status)$/ })).toBeNull()
  })

  it('the × still puts it away at once', async () => {
    await added()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss skill link' }))
    expect(useSkillLinkOfferStore.getState().offer).toBeNull()
  })
})
