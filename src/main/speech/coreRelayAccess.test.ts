import { describe, expect, it, vi } from 'vitest'
import { SPEECH_STATUS_CHANGED_CHANNEL } from '../../shared/speech'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createCoreRelayAccess, parseRelayDiscovery } = await import('./coreRelayAccess')

const SERVER = 'https://cinna.example.com'
const RELAY = { version: 1, url: 'wss://api.cinna.example.com/api/v1/speech/stream' }

describe('parseRelayDiscovery', () => {
  it('is available with version 1 and a wss URL, named by instance_name', () => {
    expect(parseRelayDiscovery({ instance_name: ' Acme ', voice_transcription: RELAY }, SERVER))
      .toEqual({ available: true, url: RELAY.url, serverName: 'Acme' })
  })

  it('names the server by its host without instance_name', () => {
    expect(parseRelayDiscovery({ voice_transcription: RELAY }, SERVER)).toMatchObject({ available: true, serverName: 'cinna.example.com' })
  })

  it.each([
    ['no block', {}],
    ['another version', { voice_transcription: { ...RELAY, version: 2 } }],
    ['a string version', { voice_transcription: { ...RELAY, version: '1' } }],
    ['no url', { voice_transcription: { version: 1 } }],
    ['a url that is not a string', { voice_transcription: { version: 1, url: 42 } }],
    ['an http url', { voice_transcription: { version: 1, url: 'https://x/api/v1/speech/stream' } }],
    ['a malformed url', { voice_transcription: { version: 1, url: 'not a url' } }],
    ['plain ws to a TLS server', { voice_transcription: { version: 1, url: 'ws://api.cinna.example.com/api/v1/speech/stream' } }]
  ])('is unavailable with %s', (_why, doc) => {
    expect(parseRelayDiscovery(doc, SERVER).available).toBe(false)
  })

  it('accepts plain ws for an http or loopback server', () => {
    expect(parseRelayDiscovery({ voice_transcription: { version: 1, url: 'ws://localhost:8000/api/v1/speech/stream' } }, SERVER).available).toBe(true)
    expect(parseRelayDiscovery({ voice_transcription: { version: 1, url: 'ws://10.0.0.5/api/v1/speech/stream' } }, 'http://10.0.0.5').available).toBe(true)
  })
})

function setup(initial: { doc?: unknown; signedIn?: boolean; cinna?: boolean } = {}) {
  let now = 1_000_000
  let doc: unknown = initial.doc ?? { instance_name: 'Acme', voice_transcription: RELAY }
  let fail = false
  const state = { profile: 'p1' as string | null, signedIn: initial.signedIn ?? true, cinna: initial.cinna ?? true, server: SERVER }
  const discover = vi.fn(async () => {
    if (fail) throw new Error('offline')
    return doc
  })
  const fetchUsage = vi.fn(async (): Promise<unknown> => ({ enabled: true, used_seconds: 600, cap_seconds: 3600, period_end: '2026-12-01T00:00:00Z' }))
  const publishEvent = vi.fn()
  const access = createCoreRelayAccess({
    profileId: () => state.profile,
    account: () => (state.cinna ? { serverUrl: state.server, signedIn: state.signedIn } : null),
    discover,
    fetchUsage,
    publishEvent,
    now: () => now,
    ttlMs: 5 * 60_000
  })
  return {
    access,
    discover,
    fetchUsage,
    publishEvent,
    state,
    setDoc: (next: unknown) => { doc = next },
    setFail: (next: boolean) => { fail = next },
    advance: (ms: number) => { now += ms }
  }
}

describe('coreRelayAccess', () => {
  it('answers not available at once, reads discovery in the background, then publishes the change', async () => {
    const t = setup()
    expect(t.access.status()).toEqual({ available: false })
    expect(t.discover).toHaveBeenCalledWith(SERVER)
    await vi.waitFor(() => expect(t.publishEvent).toHaveBeenCalledWith(SPEECH_STATUS_CHANGED_CHANNEL, {}))
    expect(t.access.status()).toEqual({ available: true, serverName: 'Acme' })
    expect(t.access.endpoint()).toEqual({ profileId: 'p1', serverUrl: SERVER, url: RELAY.url, serverName: 'Acme' })
  })

  it('never reads discovery for a signed-out or non-Cinna profile', async () => {
    const out = setup({ signedIn: false })
    expect(await out.access.refresh()).toEqual({ available: false })
    expect(out.discover).not.toHaveBeenCalled()
    expect(out.access.endpoint()).toBeNull()
    const local = setup({ cinna: false })
    expect(await local.access.refresh()).toEqual({ available: false })
    expect(local.discover).not.toHaveBeenCalled()
  })

  it('reads again only when the answer is older than the TTL', async () => {
    const t = setup()
    await t.access.refresh()
    expect(t.discover).toHaveBeenCalledTimes(1)
    t.access.status()
    t.advance(4 * 60_000)
    t.access.status()
    expect(t.discover).toHaveBeenCalledTimes(1)
    t.advance(60_000)
    t.access.status()
    expect(t.discover).toHaveBeenCalledTimes(2)
  })

  it('refresh reads now and publishes when the relay goes away; no event when nothing changed', async () => {
    const t = setup()
    await t.access.refresh()
    expect(t.publishEvent).toHaveBeenCalledTimes(1)
    await t.access.refresh()
    expect(t.publishEvent).toHaveBeenCalledTimes(1)
    t.setDoc({ instance_name: 'Acme' })
    expect(await t.access.refresh()).toEqual({ available: false })
    expect(t.publishEvent).toHaveBeenCalledTimes(2)
    expect(t.access.endpoint()).toBeNull()
  })

  it('a failed read keeps the last known answer', async () => {
    const t = setup()
    await t.access.refresh()
    t.setFail(true)
    expect(await t.access.refresh()).toEqual({ available: true, serverName: 'Acme' })
    expect(t.publishEvent).toHaveBeenCalledTimes(1)
  })

  it('keeps one answer per profile and server, and a sign-out is published on the next read', async () => {
    const t = setup()
    await t.access.refresh()
    t.state.profile = 'p2'
    t.setDoc({})
    expect(await t.access.refresh()).toEqual({ available: false })
    expect(t.publishEvent).toHaveBeenCalledTimes(2)
    t.state.profile = 'p1'
    // p1's answer is still fresh: no read, but the switch back is published.
    expect(t.access.status()).toEqual({ available: true, serverName: 'Acme' })
    expect(t.discover).toHaveBeenCalledTimes(2)
    expect(t.publishEvent).toHaveBeenCalledTimes(3)
    t.state.signedIn = false
    expect(t.access.status()).toEqual({ available: false })
    expect(t.publishEvent).toHaveBeenCalledTimes(4)
  })

  it('reads the month from the usage endpoint, failures as data', async () => {
    const t = setup()
    await t.access.refresh()
    expect(await t.access.usage()).toEqual({ ok: true, enabled: true, usedSeconds: 600, capSeconds: 3600, periodEnd: '2026-12-01T00:00:00Z' })
    t.fetchUsage.mockResolvedValueOnce({ enabled: true, used_seconds: 0, cap_seconds: null, period_end: 'x' })
    expect(await t.access.usage()).toMatchObject({ ok: true, capSeconds: null })
    t.fetchUsage.mockRejectedValueOnce(new Error('HTTP 500'))
    expect(await t.access.usage()).toEqual({ ok: false, message: "Could not read this month's dictation from Acme." })
    t.fetchUsage.mockResolvedValueOnce({ used_seconds: 'lots' })
    expect(await t.access.usage()).toMatchObject({ ok: false })
    t.state.signedIn = false
    expect(await t.access.usage()).toMatchObject({ ok: false })
  })
})
