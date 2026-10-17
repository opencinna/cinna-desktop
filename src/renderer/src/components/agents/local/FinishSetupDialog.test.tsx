import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoAttachedCredential, CredentialSetupDto, CredentialSetupSkillSlot, CredentialSetupSlot, ServiceCredentialDto } from '../../../../../shared/serviceCredentials'
import { useFinishSetupStore } from '../../../stores/finishSetup.store'
import { useFinishSetup } from './FinishSetupDialog'

/**
 * The Finish setup dialog: what each slot row says, the two writes, and that
 * nothing closes it except its own footer while something typed is unsaved.
 */

const AGENT = 'folder:acme'
const record = (over: Partial<ServiceCredentialDto>): ServiceCredentialDto => ({
  id: 'row', origin: 'cloud', cloudId: 'c', name: 'Acme API', type: 'api_token', serviceUri: 'acme-api', notes: null,
  status: 'complete', isPlaceholder: false, relation: 'shared', ownerEmail: 'admin@example.test', localUseAllowed: true,
  revision: 'r1', hasValues: true, expiresAt: null, keyStatus: null, agentApi: null, keyBlocked: null, oauthStatus: null, grantedUserEmail: null, ...over
})
const slot = (over: Partial<CredentialSetupSlot>): CredentialSetupSlot => ({
  name: 'acme', type: 'api_token', optional: false, envPrefix: null, state: 'missing', attached: null,
  expectedKeys: [], presentKeys: [], options: [], ...over
})
let setup: CredentialSetupDto
const setupState = vi.fn(async () => ({ ok: true, value: setup }))
const attach = vi.fn(async () => ({ ok: true, value: [] }))
let skillAttached: AutoAttachedCredential[] = []
const setupSkills = vi.fn(async () => ({ ok: true, value: skillAttached }))
const skillSlot = (over: Partial<CredentialSetupSkillSlot>): CredentialSetupSkillSlot => ({
  slot: 'erp-api', type: 'api_token', skills: ['erp-orders'], description: null, state: 'missing', attached: null,
  typeMismatch: null, notLocal: null, options: [], provision: null, ...over
})
const openCredentials = vi.fn(async (): Promise<unknown> => ({ created: false, revealed: false }))
const setEnvValues = vi.fn(async (_id: string, values: Record<string, string>): Promise<unknown> => {
  // Main's answer: the slot now has these names.
  setup = { ...setup, slots: setup.slots.map((s) => ({ ...s, presentKeys: [...new Set([...s.presentKeys, ...Object.keys(values).filter((k) => s.expectedKeys.includes(k))])] })) }
  return { ok: true, value: [] }
})
window.api = {
  serviceCredentials: { setupState, attach, setupSkills, onChanged: () => () => {} },
  localAgents: { setEnvValues, openCredentials }
} as never

function Harness({ followRequests }: { followRequests?: boolean }): React.JSX.Element {
  const finish = useFinishSetup(AGENT, 'Acme Reporter', followRequests === undefined ? undefined : { followRequests })
  return createElement('div', null, createElement('button', { onClick: finish.open }, 'open'), finish.dialog)
}
function renderHarness(strict = false, followRequests?: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = createElement(QueryClientProvider, { client }, createElement(Harness, { followRequests }))
  return render(strict ? createElement(StrictMode, null, tree) : tree)
}
const dialog = () => screen.getByRole('dialog', { name: 'Finish setting up Acme Reporter' })
const row = (name: string) => screen.getByTestId(`finish-setup-slot-${name}`)
const field = (name: string, key: string) => within(row(name)).getByLabelText(key) as HTMLInputElement

beforeEach(() => {
  setupState.mockClear(); attach.mockClear(); setEnvValues.mockClear(); openCredentials.mockClear(); setupSkills.mockClear()
  skillAttached = []
  useFinishSetupStore.setState({ pending: [], autoAttached: {} })
  setup = {
    setupNeeded: true, skillSlots: [],
    slots: [
      slot({ name: 'acme', state: 'connected', attached: { credential: record({}), state: 'ready' } }),
      slot({ name: 'weather', envPrefix: 'WEATHER_', expectedKeys: ['WEATHER_API_KEY'] })
    ]
  }
})

describe('Finish setup', () => {
  it('opens by itself when the page lands after a Get that left something missing, under StrictMode', async () => {
    // As after a Get: the request is recorded, then the page mounts (twice, under StrictMode).
    useFinishSetupStore.getState().record(AGENT, { done: true, setupNeeded: true, autoAttached: [{ slot: 'acme', credentialName: 'Acme API' }] })
    renderHarness(true)
    await screen.findByTestId('finish-setup-slot-acme')
    expect(dialog()).toBeTruthy()
    expect(within(row('acme')).getByText('Connected automatically')).toBeTruthy()
    // The attached record is drawn as the Credentials tab draws it.
    expect(within(row('acme')).getByText('Acme API')).toBeTruthy()
    expect(within(row('acme')).getByRole('img', { name: 'Shared by admin@example.test' })).toBeTruthy()
    expect(within(row('weather')).getByText('Missing')).toBeTruthy()
    expect(field('weather', 'WEATHER_API_KEY').type).toBe('password')
    // Pinned to the top, so rows that change move only what is below them.
    expect(dialog().parentElement?.className).toContain('items-start')
  })

  it('opens when a request arrives while the page is already showing the agent', async () => {
    renderHarness()
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => useFinishSetupStore.getState().record(AGENT, { done: true, setupNeeded: true, autoAttached: [] }))
    await screen.findByTestId('finish-setup-slot-acme')
  })

  it('keeps several agents asking, each until its own dialog closes', async () => {
    renderHarness()
    act(() => {
      useFinishSetupStore.getState().record('folder:other', { done: true, setupNeeded: true, autoAttached: [] })
      useFinishSetupStore.getState().record(AGENT, { done: true, setupNeeded: true, autoAttached: [] })
    })
    await screen.findByTestId('finish-setup-slot-acme')
    fireEvent.click(screen.getByRole('button', { name: 'Finish later' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useFinishSetupStore.getState().pending).toEqual(['folder:other'])
  })

  it('with followRequests off, opens only when clicked and leaves the request for the page', async () => {
    // The composer's instance: the agent page answers the request, so this one must not open a second dialog.
    renderHarness(false, false)
    act(() => useFinishSetupStore.getState().record(AGENT, { done: true, setupNeeded: true, autoAttached: [] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-acme')
    fireEvent.click(screen.getByRole('button', { name: 'Finish later' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useFinishSetupStore.getState().pending).toEqual([AGENT])
  })

  it('stays closed when nothing is missing, and opens on demand with plain Connected', async () => {
    renderHarness()
    act(() => useFinishSetupStore.getState().record(AGENT, { done: true, setupNeeded: false, autoAttached: [] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-acme')
    expect(within(row('acme')).getByText('Connected')).toBeTruthy()
  })

  it('says Set on this computer, Optional, Missing with why an attachment stopped counting, and offers records', async () => {
    setup = {
      setupNeeded: true, skillSlots: [],
      slots: [
        slot({ name: 'env', state: 'env', envPrefix: 'ENV_', expectedKeys: ['ENV_KEY'], presentKeys: ['ENV_KEY'] }),
        slot({ name: 'extra', optional: true }),
        slot({
          name: 'acme', envPrefix: 'ACME_', expectedKeys: ['ACME_TOKEN'],
          attached: { credential: record({ name: 'Old Acme', localUseAllowed: false }), state: 'local_use_not_allowed' },
          options: [
            { group: 'acct', ref: 'one', credential: record({ id: 'one', name: 'Acme one', relation: 'owned', ownerEmail: null }) },
            { group: 'acct', ref: 'two', credential: record({ id: 'two', name: 'Acme two' }) }
          ]
        })
      ]
    }
    renderHarness()
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-acme')
    expect(within(row('env')).getByText('Set on this computer')).toBeTruthy()
    expect(within(row('env')).getByText('Set')).toBeTruthy()
    expect(within(row('extra')).getByText('Optional')).toBeTruthy()
    expect(within(row('extra')).getByText(/Nothing in your account fits it/)).toBeTruthy()
    expect(within(row('acme')).getByText('Missing')).toBeTruthy()
    expect(within(row('acme')).getByRole('img', { name: 'The owner must allow use on your computer' })).toBeTruthy()
    expect(within(row('acme')).getByText('or enter it on this computer')).toBeTruthy()
    const uses = within(row('acme')).getAllByRole('button', { name: 'Use this' })
    expect(uses).toHaveLength(2)
    fireEvent.click(uses[1])
    await waitFor(() => expect(attach).toHaveBeenCalledWith(AGENT, 'acct', 'two'))
    expect(dialog()).toBeTruthy()
  })

  it('keeps a saved name on screen as Set, keeps focus in the row, and never reshapes it while typing', async () => {
    setup = { setupNeeded: true, skillSlots: [], slots: [slot({ name: 'mail', envPrefix: 'MAIL_', expectedKeys: ['MAIL_LOGIN', 'MAIL_PASSWORD'] })] }
    renderHarness()
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-mail')
    const mail = row('mail')
    const shapeOf = () => [...mail.querySelectorAll('*')].map((el) => `${el.tagName}.${el.getAttribute('class')}`).join('|')
    const shape = shapeOf()
    fireEvent.change(field('mail', 'MAIL_LOGIN'), { target: { value: 'w"#=\\ x' } })
    expect(shapeOf()).toBe(shape)
    // The field part reads in full; the prefix is the part that gives way.
    expect(within(mail).getAllByText('LOGIN')).toHaveLength(1)
    expect(within(mail).getAllByTitle('MAIL_LOGIN').length).toBeGreaterThan(0)

    fireEvent.click(within(mail).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(within(row('mail')).getByText('Set')).toBeTruthy())
    expect(setEnvValues).toHaveBeenCalledWith(AGENT, { MAIL_LOGIN: 'w"#=\\ x' })
    expect(within(row('mail')).queryByLabelText('MAIL_LOGIN')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(field('mail', 'MAIL_PASSWORD')))

    fireEvent.click(within(row('mail')).getByRole('button', { name: 'Replace' }))
    expect(field('mail', 'MAIL_LOGIN').value).toBe('')
  })

  it('keeps a refusal in the dialog, with the reason main gave', async () => {
    renderHarness()
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-weather')
    fireEvent.change(field('weather', 'WEATHER_API_KEY'), { target: { value: 'k' } })
    setEnvValues.mockImplementationOnce(async () => ({ ok: false, code: 'turn_in_progress', name: 'LocalAgentError', message: 'This agent is running. Nothing was changed — save again when it finishes.' }))
    fireEvent.click(within(row('weather')).getByRole('button', { name: 'Save' }))
    expect(await within(dialog()).findByRole('alert')).toHaveProperty('textContent', 'This agent is running. Nothing was changed — save again when it finishes.')
    expect(field('weather', 'WEATHER_API_KEY').value).toBe('k')
  })

  it('Replace moves focus to its field, and Cancel puts the saved name back without saving', async () => {
    setup = { setupNeeded: false, skillSlots: [], slots: [slot({ name: 'mail', state: 'env', envPrefix: 'MAIL_', expectedKeys: ['MAIL_LOGIN', 'MAIL_PASSWORD'], presentKeys: ['MAIL_LOGIN', 'MAIL_PASSWORD'] })] }
    renderHarness()
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-mail')
    // Nothing editable: no Save to press.
    expect(within(row('mail')).queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(within(row('mail')).getByTitle('Replace MAIL_PASSWORD'))
    expect(document.activeElement).toBe(field('mail', 'MAIL_PASSWORD'))
    const save = within(row('mail')).getByRole('button', { name: 'Save' })
    fireEvent.change(field('mail', 'MAIL_PASSWORD'), { target: { value: 'new' } })
    fireEvent.change(field('mail', 'MAIL_PASSWORD'), { target: { value: '' } })
    // Typing neither adds nor removes it.
    expect(within(row('mail')).getByRole('button', { name: 'Save' })).toBe(save)
    fireEvent.change(field('mail', 'MAIL_PASSWORD'), { target: { value: 'typed' } })
    fireEvent.click(within(row('mail')).getByRole('button', { name: 'Cancel' }))
    expect(within(row('mail')).queryByLabelText('MAIL_PASSWORD')).toBeNull()
    expect(within(row('mail')).getAllByText('Set')).toHaveLength(2)
    expect(document.activeElement).toBe(within(row('mail')).getByTitle('Replace MAIL_PASSWORD'))
    expect(within(row('mail')).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(setEnvValues).not.toHaveBeenCalled()
    // What was typed went with it: a second Replace starts empty, and nothing holds Escape.
    fireEvent.click(within(row('mail')).getByTitle('Replace MAIL_PASSWORD'))
    expect(field('mail', 'MAIL_PASSWORD').value).toBe('')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers a slot with no fields its records and Open credentials/.env, never a field', async () => {
    setup = { setupNeeded: true, skillSlots: [], slots: [slot({ name: 'vendor', envPrefix: 'VENDOR_', options: [{ group: 'g', ref: 'v1', credential: record({ id: 'v1', cloudId: 'v1', name: 'Vendor key' }) }] })] }
    renderHarness()
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-vendor')
    const vendor = row('vendor')
    expect(vendor.querySelector('input')).toBeNull()
    expect(within(vendor).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(within(vendor).getByRole('button', { name: 'Use this' })).toBeTruthy()
    expect(within(vendor).queryByText(/Nothing in your account fits/)).toBeNull()
    openCredentials.mockImplementationOnce(async () => ({ created: true, revealed: true }))
    fireEvent.click(within(vendor).getByRole('button', { name: 'Open credentials/.env' }))
    await waitFor(() => expect(openCredentials).toHaveBeenCalledWith(AGENT))
    expect(await within(dialog()).findByRole('status')).toHaveProperty('textContent', 'Nothing here opens .env, so credentials/.env was shown in the file manager.')
  })

  it('shows a refusal in the footer\'s reserved line, adding nothing to the dialog', async () => {
    renderHarness()
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-weather')
    const shape = () => [...dialog().querySelectorAll('*')].filter((el) => !el.closest('[data-testid]') && el.getAttribute('role') !== 'alert').map((el) => `${el.tagName}.${el.getAttribute('class')}`).join('|')
    const before = shape()
    fireEvent.change(field('weather', 'WEATHER_API_KEY'), { target: { value: 'k' } })
    setEnvValues.mockImplementationOnce(async () => ({ ok: false, code: 'turn_in_progress', name: 'LocalAgentError', message: 'Refused.' }))
    fireEvent.click(within(row('weather')).getByRole('button', { name: 'Save' }))
    const alert = await within(dialog()).findByRole('alert')
    expect(shape()).toBe(before)
    expect(alert.parentElement?.parentElement?.className).toContain('h-9')
    expect(alert.parentElement?.parentElement?.contains(screen.getByRole('button', { name: 'Done' }))).toBe(true)
  })

  it('ignores the backdrop and Escape while something typed is unsaved, and not otherwise', async () => {
    renderHarness()
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-weather')
    fireEvent.change(field('weather', 'WEATHER_API_KEY'), { target: { value: 'typed' } })
    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(dialog()).toBeTruthy()
    expect(field('weather', 'WEATHER_API_KEY').value).toBe('typed')
    fireEvent.change(field('weather', 'WEATHER_API_KEY'), { target: { value: '' } })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Done saves what was typed and closes only once it landed; Finish later saves nothing', async () => {
    renderHarness()
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-weather')
    fireEvent.change(field('weather', 'WEATHER_API_KEY'), { target: { value: 'k' } })
    setEnvValues.mockImplementationOnce(async () => ({ ok: false, code: 'invalid_input', name: 'LocalAgentError', message: 'WEATHER_API_KEY must be a single line.' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(await within(dialog()).findByRole('alert')).toHaveProperty('textContent', 'WEATHER_API_KEY must be a single line.')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(setEnvValues).toHaveBeenLastCalledWith(AGENT, { WEATHER_API_KEY: 'k' })

    setEnvValues.mockClear()
    setup = { setupNeeded: true, skillSlots: [], slots: [slot({ name: 'other', envPrefix: 'OTHER_', expectedKeys: ['OTHER_KEY'] })] }
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('finish-setup-slot-other')
    fireEvent.change(field('other', 'OTHER_KEY'), { target: { value: 'later' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish later' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(setEnvValues).not.toHaveBeenCalled()
  })

  describe('skill slots', () => {
    const skillRow = (slotName: string) => screen.getByTestId(`finish-setup-skill-slot-${slotName}`)

    it('lists them apart, needed by their skills, with records to use and no .env names', async () => {
      setup = {
        ...setup,
        skillSlots: [
          skillSlot({
            slot: 'erp-api', skills: ['erp-orders', 'erp-invoices'],
            options: [{ group: 'acct', ref: 'erp-1', credential: record({ id: 'erp-1', name: 'ERP key', serviceUri: 'erp-api' }) }]
          }),
          skillSlot({ slot: 'crm', type: 'odoo', skills: ['crm-sync'] }),
          skillSlot({ slot: 'mail', type: 'email_imap', skills: ['inbox'], provision: 'not_allowed_locally' }),
          skillSlot({ slot: 'vault', skills: ['vault-read'], notLocal: record({ id: 'v-1', name: 'Vault key', serviceUri: 'vault', ownerEmail: 'admin@example.com' }) })
        ]
      }
      renderHarness()
      fireEvent.click(screen.getByText('open'))
      await screen.findByTestId('finish-setup-skill-slot-erp-api')
      expect(within(dialog()).getByText('Skills')).toBeTruthy()
      expect(within(skillRow('erp-api')).getByText('Missing')).toBeTruthy()
      expect(within(skillRow('erp-api')).getByText('Needed by skills erp-orders, erp-invoices · api_token')).toBeTruthy()
      expect(within(skillRow('erp-api')).queryByRole('textbox')).toBeNull()
      expect(skillRow('erp-api').querySelector('input')).toBeNull()
      expect(within(skillRow('crm')).getByText('Nothing in your account fits it: it needs a credential of type odoo whose Service URI is crm.')).toBeTruthy()
      expect(within(skillRow('mail')).getByText('The publisher provides it, but not for use on this computer.')).toBeTruthy()
      expect(within(skillRow('vault')).getByText('Vault key is shared with you, but not for use on this computer. admin@example.com can turn on Allow local use.')).toBeTruthy()

      fireEvent.click(within(skillRow('erp-api')).getByRole('button', { name: 'Use this' }))
      await waitFor(() => expect(attach).toHaveBeenCalledWith(AGENT, 'acct', 'erp-1'))
    })

    it('asks main to fill them once per opening, and says Connected automatically only on the skill slot', async () => {
      // An agent slot named like the skill's Service URI must not read as attached automatically.
      setup = {
        ...setup,
        slots: [slot({ name: 'erp-api', state: 'connected', attached: { credential: record({}), state: 'ready' } })],
        skillSlots: [skillSlot({ slot: 'erp-api', state: 'connected', attached: { credential: record({ name: 'ERP key' }), state: 'ready' } })]
      }
      skillAttached = [{ slot: 'erp-api', credentialName: 'ERP key', skill: true }]
      renderHarness(true)
      fireEvent.click(screen.getByText('open'))
      await waitFor(() => expect(within(skillRow('erp-api')).getByText('Connected automatically')).toBeTruthy())
      expect(within(row('erp-api')).getByText('Connected')).toBeTruthy()
      expect(setupSkills).toHaveBeenCalledTimes(1)
      expect(setupSkills).toHaveBeenCalledWith(AGENT)
      expect(useFinishSetupStore.getState().autoAttached[AGENT]).toEqual(['skill:erp-api'])

      fireEvent.click(screen.getByRole('button', { name: 'Finish later' }))
      fireEvent.click(screen.getByText('open'))
      await screen.findByTestId('finish-setup-skill-slot-erp-api')
      expect(setupSkills).toHaveBeenCalledTimes(2)
    })

    it('never opens the dialog by itself for a skill slot alone', async () => {
      setup = { ...setup, setupNeeded: false, slots: [], skillSlots: [skillSlot({})] }
      renderHarness()
      act(() => useFinishSetupStore.getState().record(AGENT, { done: true, setupNeeded: false, autoAttached: [{ slot: 'erp-api', credentialName: 'ERP key', skill: true }] }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(setupSkills).not.toHaveBeenCalled()
    })
  })
})
