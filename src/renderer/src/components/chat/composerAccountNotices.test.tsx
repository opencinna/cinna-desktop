import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UnavailableCredentialAccount } from '../../../../shared/serviceCredentials'

/**
 * The composer's rows for the accounts a folder agent's credentials come from that cannot supply
 * them now: what each says and offers, and the rows they replace (Finish setup, Authorize, the
 * `credentials_needed` readiness line, "No AI credential") for the slots those accounts hold.
 */

;(window as unknown as { api: unknown }).api = {}

const { unavailableAccountSentence, unavailableAccountAction, unavailableAccountNotice, unavailableAccountName, unavailableAccountLabel, unavailableAccountReason, accountFirstName } = await import('./composerAccountNotices')
const { assembleNoticeRows, folderCredentialsNotice, folderGoogleSlot, skillCredentialsNotice } = await import('./ComposerReadiness')
const { skillsLackingCredentials } = await import('../../stores/skillCredentialPrompt.store')
const { ComposerNoticePanel } = await import('./ComposerNoticePanel')

const account = (over: Partial<UnavailableCredentialAccount> = {}): UnavailableCredentialAccount => ({
  key: 'k1', userId: 'alice', name: 'Alice', email: 'alice@corp.com', host: 'core.corp.com', reason: 'signed_out', current: false, credentials: 2, aiCredential: false, ...over
})

const handlers = () => ({ switchTo: vi.fn(), reauth: vi.fn(), openAccounts: vi.fn(), switching: null, reauthPending: false, failure: (): string | null => null })

describe('what an account row says', () => {
  it('says who and why first, then what comes from that account', () => {
    expect(unavailableAccountSentence(account())).toBe('Alice is signed out: 2 credentials come from that account.')
    expect(unavailableAccountSentence(account({ credentials: 1, reason: 'locked' }))).toBe('Alice is locked: 1 credential comes from that account.')
    expect(unavailableAccountSentence(account({ credentials: 0, aiCredential: true, reason: 'session_expired' }))).toBe('Alice’s session expired: its AI credential comes from that account.')
    expect(unavailableAccountSentence(account({ aiCredential: true }))).toBe('Alice is signed out: 2 credentials and its AI credential come from that account.')
    expect(unavailableAccountSentence(account({ credentials: 0, aiCredential: true, reason: 'other_profile' }))).toBe('Alice isn’t the current profile: its AI credential comes from that account.')
  })
  it('says a removed or unknown account held them when nothing names it', () => {
    const nobody = { userId: null, name: null, email: null, host: null }
    expect(unavailableAccountSentence(account({ ...nobody, reason: 'removed' }))).toBe('A removed account held 2 credentials.')
    expect(unavailableAccountSentence(account({ ...nobody, reason: 'unknown', credentials: 1 }))).toBe('An account that isn’t signed in here holds 1 credential.')
    expect(unavailableAccountLabel(account({ ...nobody, reason: 'removed' }))).toBe('Account removed')
    expect(unavailableAccountLabel(account({ reason: 'locked' }))).toBe('Alice is locked')
  })
  it('names the account as the app does, "Name <email> host", without repeating the email', () => {
    expect(unavailableAccountName(account())).toBe('Alice <alice@corp.com> core.corp.com')
    expect(unavailableAccountName(account({ name: 'alice@corp.com' }))).toBe('alice@corp.com core.corp.com')
    expect(unavailableAccountName(account({ host: null, email: null }))).toBe('Alice')
  })
  it('keeps the sentence to the first name, so the reason survives a narrow window; the whole account is in the title', () => {
    const row = unavailableAccountNotice(account({ name: 'Alice Whitfield-Montgomery' }), handlers())
    expect(row.text).toBe('Alice is signed out: 2 credentials come from that account.')
    expect(row.title).toBe('Alice is signed out: 2 credentials come from that account. (Alice Whitfield-Montgomery <alice@corp.com> core.corp.com)')
    expect(unavailableAccountLabel(account({ name: 'Alice Whitfield-Montgomery', reason: 'session_expired' }))).toBe('Alice’s session expired')
    expect(unavailableAccountReason(account({ name: 'Alice Whitfield-Montgomery', reason: 'locked' }))).toBe('Locked')
  })
})

describe('what an account row offers', () => {
  it('re-authenticates only the current profile whose session expired', () => {
    expect(unavailableAccountAction(account({ current: true, reason: 'session_expired' }))).toBe('reauth')
    expect(unavailableAccountAction(account({ reason: 'session_expired' }))).toBe('switch')
  })
  it('switches to a signed-out, locked or other profile, and opens User Accounts for one that is gone', () => {
    for (const reason of ['signed_out', 'locked', 'other_profile'] as const) expect(unavailableAccountAction(account({ reason }))).toBe('switch')
    expect(unavailableAccountAction(account({ reason: 'removed' }))).toBe('accounts')
    expect(unavailableAccountAction(account({ reason: 'unknown', userId: null }))).toBe('accounts')
  })

  it('draws one warning row whose one button runs that action', () => {
    const h = handlers()
    const { rerender } = render(<ComposerNoticePanel notices={[unavailableAccountNotice(account(), h)]} />)
    fireEvent.click(screen.getByRole('button', { name: /Switch to Alice/ }))
    expect(h.switchTo).toHaveBeenCalledWith(account())
    expect(screen.getByText(/Alice is signed out: 2 credentials come/)).toBeTruthy()
    rerender(<ComposerNoticePanel notices={[unavailableAccountNotice(account({ current: true, reason: 'session_expired' }), h)]} />)
    fireEvent.click(screen.getByRole('button', { name: /Re-authenticate/ }))
    expect(h.reauth).toHaveBeenCalled()
    rerender(<ComposerNoticePanel notices={[unavailableAccountNotice(account({ reason: 'removed' }), h)]} />)
    fireEvent.click(screen.getByRole('button', { name: /Open accounts/ }))
    expect(h.openAccounts).toHaveBeenCalled()
  })
  it('is a warning on one line, and a failure replaces the sentence rather than trailing it, cause first', () => {
    const row = unavailableAccountNotice(account({ name: 'Alice Smith' }), { ...handlers(), failure: () => 'Profile not found' })
    expect(row).toMatchObject({ key: 'account:k1', tone: 'warning', singleLine: true })
    expect(row.text).toBe('Switch failed: Profile not found')
    expect(row.title).toBe('Couldn’t switch to Alice Smith <alice@corp.com> core.corp.com: Profile not found')
    const reauth = unavailableAccountNotice(account({ current: true, reason: 'session_expired' }), { ...handlers(), failure: () => 'Server unreachable' })
    expect(reauth.text).toBe('Re-authentication failed: Server unreachable')
    expect(reauth.title).toBe('Couldn’t sign in to Alice <alice@corp.com> core.corp.com again: Server unreachable')
    // The re-auth fallback is only the lead again: said once.
    const bare = unavailableAccountNotice(account({ current: true, reason: 'session_expired' }), { ...handlers(), failure: () => 'Re-authentication failed' })
    expect(bare.text).toBe('Re-authentication failed')
  })
  it('switches to the first name, capped, with the whole account in the title', () => {
    render(<ComposerNoticePanel notices={[unavailableAccountNotice(account({ name: 'Alexandra Montgomery-Smith' }), handlers())]} />)
    const button = screen.getByRole('button', { name: 'Switch to Alexandra' })
    expect(button.getAttribute('title')).toBe('Switch to Alexandra Montgomery-Smith <alice@corp.com> core.corp.com')
    expect(button.querySelector('.max-w-\\[5rem\\].truncate')?.textContent).toBe('Alexandra')
    expect(accountFirstName({ name: 'bob@corp.com' })).toBe('bob')
    expect(accountFirstName({ name: null })).toBeNull()
  })
})

describe('the rows an unavailable account replaces', () => {
  const slot = (name: string, type: string, over: Record<string, unknown> = {}) =>
    ({ name, type, optional: false, envPrefix: null, serviceUri: null, expectedKeys: [], presentKeys: [], satisfied: false, attachment: null, ...over })
  const held = (name: string, type = 'api_token') => slot(name, type, { attachment: { credentialId: `row-${name}`, state: 'account_unavailable' } })
  const folderOf = (credentials: unknown[], extra: Record<string, unknown> = {}) =>
    ({ id: 'folder:kit', readiness: 'credentials_needed', readinessReason: 'A credential this agent uses comes from a Cinna account that isn’t available right now.', credentials, skills: [], ...extra }) as never

  it('asks Finish setup (or Authorize) only for the slots no unavailable account holds', () => {
    expect(folderCredentialsNotice(folderOf([held('erp')]), vi.fn())).toBeNull()
    expect(folderGoogleSlot(folderOf([held('mail', 'gmail_oauth_readonly')]))).toBeNull()
    const both = folderOf([held('erp'), slot('crm', 'api_token')], { readinessReason: 'Add the credentials for crm by attaching them or configuring credentials/.env.' })
    expect(folderCredentialsNotice(both, vi.fn())?.text).toBe('Add the credentials for crm by attaching them or configuring credentials/.env.')
    expect(folderGoogleSlot(folderOf([held('erp'), slot('mail', 'gmail_oauth_readonly')]))).toEqual({ slotKey: 'mail', type: 'gmail_oauth_readonly' })
  })

  it('leaves a skill slot an unavailable account holds out of the skill prompt', () => {
    const skill = { name: 'invoices', description: '', version: null, source: 'catalog', path: '', deliverable: true, issues: [],
      credentials: [{ slot: 'erp-api', type: 'api_token', description: null, filled: false, attachment: { credentialId: 'r', state: 'account_unavailable' } }] }
    const folder = folderOf([], { skills: [skill] })
    expect(skillsLackingCredentials(folder, ['invoices'])).toEqual([])
    expect(skillCredentialsNotice(folder, ['invoices'], vi.fn(), vi.fn())).toBeNull()
  })

  const row = (key: string) => ({ key, tone: 'warning' as const, icon: (() => null) as never, text: key })
  const parts = (over: Record<string, unknown> = {}) => ({
    folder: folderOf([held('erp')]),
    readinessItem: row('readiness'),
    readiness: { state: 'credentials_needed', reason: 'A credential this agent uses comes from a Cinna account that isn’t available right now.' } as never,
    reasonId: 'reason',
    credentials: null,
    accounts: { rows: [row('account:k1')], loaded: true, aiCredentialCovered: false },
    skillCredentials: null,
    aiCredential: null,
    staleModel: null,
    findings: null,
    ...over
  }) as never

  it('lets the account row stand in for the readiness line when it holds every unsatisfied slot', () => {
    expect(assembleNoticeRows(parts()).map((r) => [r.key, r.textId])).toEqual([['account:k1', 'reason']])
    // Before main has named the account: neither line, so nothing shows and then goes.
    expect(assembleNoticeRows(parts({ accounts: { rows: [], loaded: false, aiCredentialCovered: false } }))).toEqual([])
  })

  it('keeps the readiness line when no account row can stand in for it: main named none, or failed', () => {
    expect(assembleNoticeRows(parts({ accounts: { rows: [], loaded: true, aiCredentialCovered: false } })).map((r) => r.key)).toEqual(['readiness'])
    expect(assembleNoticeRows(parts({ accounts: { rows: [], loaded: true, failed: true, aiCredentialCovered: false } })).map((r) => r.key)).toEqual(['readiness'])
  })

  it('keeps the credentials row for genuinely missing slots, beside the account row', () => {
    const rows = assembleNoticeRows(parts({ folder: folderOf([held('erp'), slot('crm', 'api_token')]), credentials: row('folder-credentials') }))
    expect(rows.map((r) => [r.key, r.textId])).toEqual([['folder-credentials', 'reason'], ['account:k1', undefined]])
  })

  it('holds the "No AI credential" row until main has answered, and drops it when an account row tells it', () => {
    const base = { folder: folderOf([]), readiness: null, readinessItem: null, aiCredential: row('ai-credential') }
    expect(assembleNoticeRows(parts({ ...base, accounts: { rows: [], loaded: false, aiCredentialCovered: false } }))).toEqual([])
    expect(assembleNoticeRows(parts({ ...base, accounts: { rows: [row('account:k1')], loaded: true, aiCredentialCovered: true } })).map((r) => r.key)).toEqual(['account:k1'])
    expect(assembleNoticeRows(parts({ ...base, accounts: { rows: [], loaded: true, aiCredentialCovered: false } })).map((r) => r.key)).toEqual(['ai-credential'])
  })
})
