import { beforeEach, describe, expect, it, vi } from 'vitest'

const appState = vi.hoisted(() => ({ ready: true }))
vi.mock('electron', () => ({ app: { isReady: () => appState.ready } }))
const focusMainWindow = vi.hoisted(() => vi.fn())
const ensureMainWindow = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../../window/focus', () => ({ focusMainWindow, ensureMainWindow }))
const oauth = vi.hoisted(() => ({ inProgress: false }))
vi.mock('../../auth/cinna-oauth', () => ({ isCinnaOAuthInProgress: () => oauth.inProgress }))
const nudgeOAuthFlows = vi.hoisted(() => vi.fn(() => 0))
vi.mock('../../services/serviceCredentials/service', () => ({ serviceCredentialService: { nudgeOAuthFlows } }))

const { deepLinkActionOf, deepLinkService, deepLinkUrlFromArgv, parseOAuthDoneLink } = await import('./deepLinkService')
const { connectIntentService } = await import('./connectIntentService')
const { skillLinkIntentService } = await import('./skillLinkIntentService')
const { CONNECT_INTENT_ARGV_FLAG, CONNECT_INTENT_CHANNEL } = await import('../../../shared/connectIntent')
const { SKILL_LINK_INTENT_CHANNEL } = await import('../../../shared/skillLink')
const { clearLogEntries, getLogEntries } = await import('../../logger/logger')

/**
 * One funnel, one slot per kind. What matters most is that the two kinds
 * never touch each other's slot: a skill link arriving while the person reads
 * a connect confirm step must not evict it, and either consume drops only its
 * own. `connectIntentService.test.ts` covers the connect path itself.
 */
const CONNECT = 'cinna://connect?server=https://cinna.acme.com'
const SKILL = 'cinna://skill/com.acme.erp-lookup?server=https://cinna.acme.com'
const send = vi.fn()

beforeEach(() => {
  connectIntentService.reset()
  skillLinkIntentService.reset()
  oauth.inProgress = false
  send.mockClear()
  focusMainWindow.mockClear()
  nudgeOAuthFlows.mockClear()
  ensureMainWindow.mockClear()
  appState.ready = true
  clearLogEntries()
  deepLinkService.install(() => ({ isDestroyed: () => false, webContents: { send } }) as never)
})

describe('deepLinkActionOf', () => {
  it.each([
    [CONNECT, 'connect'],
    [SKILL, 'skill'],
    ['cinna:///skill/x', 'skill'],
    ['CINNA://Skill/x', 'skill'],
    ['https://cinna.acme.com/get/skill/x', null],
    ['not a url', null]
  ])('%s → %s', (url, action) => {
    expect(deepLinkActionOf(url)).toBe(action)
  })
})

describe('deepLinkService.deliver', () => {
  it('routes a connect link to the connect slot and pushes it on its channel', () => {
    deepLinkService.deliver(CONNECT, 'open-url')
    expect(connectIntentService.getPending()?.serverUrl).toBe('https://cinna.acme.com')
    expect(skillLinkIntentService.getPending()).toBeNull()
    expect(send).toHaveBeenCalledWith(CONNECT_INTENT_CHANNEL, expect.objectContaining({ serverUrl: 'https://cinna.acme.com' }))
    expect(focusMainWindow).toHaveBeenCalledTimes(1)
  })

  it('routes a skill link to the skill slot and pushes it on its channel', () => {
    deepLinkService.deliver(SKILL, 'open-url')
    const intent = skillLinkIntentService.getPending()
    expect(intent?.link).toEqual({ origin: 'https://cinna.acme.com', packageId: 'com.acme.erp-lookup', form: 'cinna', serverGiven: true })
    expect(typeof intent?.receivedAt).toBe('number')
    expect(connectIntentService.getPending()).toBeNull()
    expect(send).toHaveBeenCalledWith(SKILL_LINK_INTENT_CHANNEL, intent)
    expect(send).not.toHaveBeenCalledWith(CONNECT_INTENT_CHANNEL, expect.anything())
    expect(focusMainWindow).toHaveBeenCalledTimes(1)
  })

  it('takes a skill link without a server as one for the active profile', () => {
    deepLinkService.deliver('cinna:///skill/com.acme.erp-lookup', 'second-instance')
    expect(skillLinkIntentService.getPending()?.link).toEqual({ origin: null, packageId: 'com.acme.erp-lookup', form: 'cinna', serverGiven: false })
  })

  it('a skill link does not evict a pending connect intent, and the connect one does not evict it', () => {
    deepLinkService.deliver(CONNECT, 'open-url')
    deepLinkService.deliver(SKILL, 'open-url')
    expect(connectIntentService.getPending()?.serverUrl).toBe('https://cinna.acme.com')
    deepLinkService.deliver('cinna://connect?server=https://other.example', 'open-url')
    expect(skillLinkIntentService.getPending()?.link.packageId).toBe('com.acme.erp-lookup')
    expect(connectIntentService.getPending()?.serverUrl).toBe('https://other.example')
  })

  it('consuming one kind leaves the other, even with an equal receivedAt', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5000)
    deepLinkService.deliver(CONNECT, 'open-url')
    deepLinkService.deliver(SKILL, 'open-url')
    vi.mocked(Date.now).mockRestore()
    skillLinkIntentService.consume(5000)
    expect(skillLinkIntentService.getPending()).toBeNull()
    expect(connectIntentService.getPending()).not.toBeNull()
    deepLinkService.deliver(SKILL, 'open-url')
    connectIntentService.consume()
    expect(connectIntentService.getPending()).toBeNull()
    expect(skillLinkIntentService.getPending()).not.toBeNull()
  })

  it('a refused skill link buffers nothing in either slot, and its URL is not logged', () => {
    deepLinkService.deliver('cinna://skill/bad+id?server=https://secret-host.example', 'open-url')
    deepLinkService.deliver('cinna://skill/x?server=http://plain.example', 'open-url')
    expect(skillLinkIntentService.getPending()).toBeNull()
    expect(connectIntentService.getPending()).toBeNull()
    expect(send).not.toHaveBeenCalled()
    const logged = JSON.stringify(getLogEntries())
    expect(logged).not.toContain('secret-host')
    expect(logged).not.toContain('plain.example')
    expect(logged).not.toContain('bad+id')
  })

  it('an unknown action still reaches the connect service, which refuses it as before', () => {
    deepLinkService.deliver('cinna://disconnect?server=https://cinna.acme.com', 'open-url')
    expect(connectIntentService.getPending()).toBeNull()
    expect(skillLinkIntentService.getPending()).toBeNull()
    expect(getLogEntries().some((e) => e.message.includes('unknown action'))).toBe(true)
  })
})

describe('the skill slot', () => {
  it('replaces rather than queues', () => {
    deepLinkService.deliver('cinna://skill/a.one', 'open-url')
    deepLinkService.deliver('cinna://skill/b.two', 'open-url')
    expect(skillLinkIntentService.getPending()?.link.packageId).toBe('b.two')
  })

  it('consumes only the named intent, so a newer click survives', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000)
    const first = skillLinkIntentService.deliver('cinna://skill/a.one', 'open-url')!
    const newer = skillLinkIntentService.deliver('cinna://skill/b.two', 'open-url')!
    skillLinkIntentService.consume(first.receivedAt)
    expect(skillLinkIntentService.getPending()?.link.packageId).toBe('b.two')
    skillLinkIntentService.consume(newer.receivedAt)
    expect(skillLinkIntentService.getPending()).toBeNull()
  })

  it('consume() with no receivedAt drops whatever is held', () => {
    deepLinkService.deliver(SKILL, 'argv')
    skillLinkIntentService.consume()
    expect(skillLinkIntentService.getPending()).toBeNull()
  })

  it('is held, not pushed, while an OAuth flow is in flight, and pushed by flush once it ends', () => {
    oauth.inProgress = true
    deepLinkService.deliver(SKILL, 'open-url')
    deepLinkService.deliver(CONNECT, 'open-url')
    expect(skillLinkIntentService.getPending()).not.toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(focusMainWindow).not.toHaveBeenCalled()
    deepLinkService.flush()
    expect(send).not.toHaveBeenCalled()

    oauth.inProgress = false
    deepLinkService.flush()
    expect(send).toHaveBeenCalledWith(SKILL_LINK_INTENT_CHANNEL, skillLinkIntentService.getPending())
    expect(send).toHaveBeenCalledWith(CONNECT_INTENT_CHANNEL, connectIntentService.getPending())
  })

  it('is buffered for a renderer that is not there yet', () => {
    skillLinkIntentService.install(() => null)
    deepLinkService.deliver(SKILL, 'open-url')
    expect(send).not.toHaveBeenCalled()
    expect(skillLinkIntentService.getPending()?.link.packageId).toBe('com.acme.erp-lookup')
  })
})

describe('the E2E flag', () => {
  it('carries a cinna://skill link into the same funnel', () => {
    const url = deepLinkUrlFromArgv(['/repo', '--use-mock-keychain', `${CONNECT_INTENT_ARGV_FLAG}${SKILL}`])
    expect(url).toBe(SKILL)
    deepLinkService.deliver(url!, 'test-argv')
    expect(skillLinkIntentService.getPending()?.link.packageId).toBe('com.acme.erp-lookup')
  })
})

/**
 * Core's Google sign-in end page hands the user back with `cinna://oauth-done`. A nudge, never a
 * result: it brings the window forward and asks the waiting connects to poll now, and touches no slot.
 */
describe('cinna://oauth-done', () => {
  const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

  it.each([
    [`cinna://oauth-done?credential_id=${ID}`, { credentialId: ID, failed: false }],
    [`cinna:///oauth-done?credential_id=${ID.toUpperCase()}`, { credentialId: ID, failed: false }],
    ['cinna://oauth-done?status=error', { credentialId: null, failed: true }],
    ['cinna://oauth-done?credential_id=../../etc&status=ok&next=https://evil.example', { credentialId: null, failed: false }],
    ['cinna://oauth-done?credential_id=g-1', { credentialId: null, failed: false }],
    ['cinna://skill/x', null],
    ['https://cinna.acme.com/oauth-done?credential_id=' + ID, null]
  ])('%s parses as %j', (url, parsed) => {
    expect(parseOAuthDoneLink(url)).toEqual(parsed)
  })

  it('brings a window back (reopened if closed), focuses it and polls the named flow now, from every delivery path', async () => {
    for (const source of ['open-url', 'second-instance', 'argv'] as const) deepLinkService.deliver(`cinna://oauth-done?credential_id=${ID}`, source)
    expect(nudgeOAuthFlows.mock.calls).toEqual([[ID], [ID], [ID]])
    expect(ensureMainWindow).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => expect(focusMainWindow).toHaveBeenCalledTimes(3))
    expect(send).not.toHaveBeenCalled()
  })

  it('makes no window before the app is ready (a cold launch from the link): startup shows the first one', () => {
    appState.ready = false
    deepLinkService.deliver(`cinna://oauth-done?credential_id=${ID}`, 'open-url')
    expect(ensureMainWindow).not.toHaveBeenCalled()
    expect(focusMainWindow).toHaveBeenCalledTimes(1)
    expect(nudgeOAuthFlows).toHaveBeenCalledWith(ID)
  })

  it('polls every waiting flow for a failure, or an id that is not a UUID', () => {
    deepLinkService.deliver('cinna://oauth-done?status=error', 'open-url')
    deepLinkService.deliver('cinna://oauth-done?credential_id=not-a-uuid', 'open-url')
    expect(nudgeOAuthFlows.mock.calls).toEqual([[null], [null]])
  })

  it('arrives from the argv the way a cold launch on Linux delivers it', () => {
    const url = deepLinkUrlFromArgv(['/usr/bin/cinna', `cinna://oauth-done?credential_id=${ID}`])
    expect(url).not.toBeNull()
    deepLinkService.deliver(url!, 'argv')
    expect(nudgeOAuthFlows).toHaveBeenCalledWith(ID)
  })

  it('leaves both intent slots alone, and a pending connect intent where it was', () => {
    oauth.inProgress = true
    deepLinkService.deliver(CONNECT, 'open-url')
    deepLinkService.deliver(`cinna://oauth-done?credential_id=${ID}`, 'open-url')
    expect(connectIntentService.getPending()?.serverUrl).toBe('https://cinna.acme.com')
    expect(skillLinkIntentService.getPending()).toBeNull()
    expect(getLogEntries().some((e) => e.message.includes('unknown action'))).toBe(false)
    expect(nudgeOAuthFlows).toHaveBeenCalledTimes(1)
  })
})
