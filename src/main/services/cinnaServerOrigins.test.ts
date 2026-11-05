import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A server's other origins, read from the stored server's own discovery
 * document (web app vs backend). Every failure degrades to the stored origin,
 * and says so (`discovered: false`, `fromDiscovery: false`).
 */

const discover = vi.hoisted(() => vi.fn<(serverUrl: string, signal?: AbortSignal) => Promise<unknown>>())
vi.mock('../auth/cinna-oauth', () => ({ discoverCinnaEndpoints: discover }))

const { knownOriginsOf, webOriginOf } = await import('./cinnaServerOrigins')

const BACKEND = 'http://localhost:8000'
const WEB = 'http://localhost:5173'

const originsOf = async (serverUrl: string, waitMs?: number) => {
  const known = await knownOriginsOf(serverUrl, waitMs)
  return { origins: [...known.origins].sort(), discovered: known.discovered }
}

const doc = (over: Record<string, unknown> = {}) => ({
  authorization_endpoint: `${WEB}/oauth/authorize`,
  token_endpoint: `${BACKEND}/api/v1/oauth/token`,
  userinfo_endpoint: `${BACKEND}/api/v1/oauth/userinfo`,
  web_origin: WEB,
  ...over
})

beforeEach(() => {
  discover.mockReset()
  discover.mockResolvedValue(doc())
})

describe('knownOriginsOf', () => {
  it('the stored origin, the token and userinfo endpoints’ and web_origin, asking only the stored server', async () => {
    expect(await originsOf(`${BACKEND}/`)).toEqual({ origins: [WEB, BACKEND].sort(), discovered: true })
    expect(discover).toHaveBeenCalledTimes(1)
    expect(discover).toHaveBeenCalledWith(`${BACKEND}/`, expect.any(AbortSignal))
  })

  it('an older core without web_origin: the token and userinfo endpoints still count', async () => {
    discover.mockResolvedValue(doc({ web_origin: undefined, authorization_endpoint: 'https://api.example.com/oauth/authorize', token_endpoint: 'https://api.example.com/t', userinfo_endpoint: 'https://api.example.com/u' }))
    expect(await originsOf('https://dashboard.example.com')).toEqual({ origins: ['https://api.example.com', 'https://dashboard.example.com'], discovered: true })
  })

  it('never counts authorization_endpoint: it may be an identity provider other servers share', async () => {
    discover.mockResolvedValue(doc({ authorization_endpoint: 'https://idp.example.com/authorize', web_origin: undefined }))
    expect(await originsOf(`${BACKEND}/`)).toEqual({ origins: [BACKEND], discovered: true })
  })

  it('drops an origin the link grammar would refuse', async () => {
    discover.mockResolvedValue(
      doc({ web_origin: 'http://evil.example.com', authorization_endpoint: 'ftp://x.test/a', token_endpoint: 'not a url', userinfo_endpoint: 'https://u:p@creds.test/u' })
    )
    expect(await originsOf('https://cinna.test')).toEqual({ origins: ['https://cinna.test'], discovered: true })
  })

  it('a discovery that fails or hangs is the stored origin alone, and says it could not ask', async () => {
    discover.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await originsOf('https://cinna.test')).toEqual({ origins: ['https://cinna.test'], discovered: false })
    discover.mockReturnValue(new Promise(() => {}))
    expect(await originsOf('https://cinna.test', 10)).toEqual({ origins: ['https://cinna.test'], discovered: false })
  })

  it('aborts the hung request itself once the wait is over', async () => {
    let signal: AbortSignal | undefined
    discover.mockImplementation((_url, given) => {
      signal = given
      return new Promise(() => {})
    })
    expect((await knownOriginsOf('https://cinna.test', 10)).discovered).toBe(false)
    expect(signal?.aborted).toBe(true)
  })

  it('a stored URL that is itself refused knows nothing, and asks nothing', async () => {
    expect(await originsOf('http://lan.test')).toEqual({ origins: [], discovered: true })
    expect(discover).not.toHaveBeenCalled()
  })
})

describe('webOriginOf', () => {
  it('web_origin when the server sends an acceptable one', async () => {
    expect(await webOriginOf(BACKEND)).toEqual({ origin: WEB, fromDiscovery: true })
  })

  it('the stored origin on an older core or a refused web_origin, still from discovery', async () => {
    discover.mockResolvedValue(doc({ web_origin: undefined }))
    expect(await webOriginOf(`${BACKEND}/`)).toEqual({ origin: BACKEND, fromDiscovery: true })
    discover.mockResolvedValue(doc({ web_origin: 'http://evil.example.com' }))
    expect(await webOriginOf(BACKEND)).toEqual({ origin: BACKEND, fromDiscovery: true })
    discover.mockResolvedValue(doc({ web_origin: 42 }))
    expect(await webOriginOf(BACKEND)).toEqual({ origin: BACKEND, fromDiscovery: true })
  })

  it('the stored origin as a fallback, not from discovery, when discovery fails or hangs', async () => {
    discover.mockRejectedValue(new Error('HTTP 404'))
    expect(await webOriginOf(BACKEND)).toEqual({ origin: BACKEND, fromDiscovery: false })
    discover.mockReturnValue(new Promise(() => {}))
    expect(await webOriginOf(BACKEND, 10)).toEqual({ origin: BACKEND, fromDiscovery: false })
  })

  it('null for a stored URL the grammar refuses', async () => {
    expect(await webOriginOf('http://lan.test')).toEqual({ origin: null, fromDiscovery: false })
  })
})
