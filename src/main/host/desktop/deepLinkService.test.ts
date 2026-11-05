import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))
const focusMainWindow = vi.hoisted(() => vi.fn())
vi.mock('../../window/focus', () => ({ focusMainWindow }))
const oauth = vi.hoisted(() => ({ inProgress: false }))
vi.mock('../../auth/cinna-oauth', () => ({ isCinnaOAuthInProgress: () => oauth.inProgress }))

const { deepLinkActionOf, deepLinkService, deepLinkUrlFromArgv } = await import('./deepLinkService')
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
