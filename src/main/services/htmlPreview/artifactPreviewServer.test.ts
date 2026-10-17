import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createArtifactPreviewServer, artifactRelativePath, ARTIFACT_PREVIEW_CSP } = await import('./artifactPreviewServer')
type Deps = import('./artifactPreviewServer').ArtifactPreviewServerDeps
type View = import('../../../shared/artifacts').ArtifactView

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const BASE = 'https://content.example/a/v/cap1/'
const NOW = Date.parse('2026-10-17T10:00:00Z')

const view = (overrides: Partial<View> = {}): View => ({
  contentBase: BASE,
  entry: 'index.html',
  files: [{ path: 'index.html', size: 10, mime: 'text/html' }],
  revision: 2,
  expiresAt: '2026-10-17T11:00:00Z',
  ...overrides
})

let user: string
let fetched: string[]
let routes: Record<string, () => Response>
let mint: ReturnType<typeof vi.fn>
let clock: number

function server(extra: Partial<Deps> = {}) {
  let n = 0
  return createArtifactPreviewServer({
    currentUserId: () => user,
    mint: mint as unknown as Deps['mint'],
    fetch: async (url) => {
      fetched.push(url)
      const route = routes[url]
      return route ? route() : new Response('Not found', { status: 404 })
    },
    now: () => clock,
    newToken: () => `art-tok${++n}`,
    ...extra
  })
}

const get = (s: ReturnType<typeof server>, url: string) => s.handle({ url, method: 'GET' })

beforeEach(() => {
  user = 'alice'
  fetched = []
  clock = NOW
  mint = vi.fn()
  routes = {
    [`${BASE}index.html`]: () => new Response('<html><head></head><body>hi</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    [`${BASE}data/q3.csv`]: () => new Response('a,b\n', { headers: { 'content-type': 'text/csv', 'content-length': '4' } }),
    [`${BASE}my%20file.txt`]: () => new Response('x', { headers: { 'content-type': 'text/plain' } }),
    [`${BASE}docs`]: () => new Response(null, { status: 307, headers: { location: 'docs/' } }),
    [`${BASE}away`]: () => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } })
  }
})

describe('the artifact preview route', () => {
  it('maps cinna-preview://<token>/<path> to the capability’s content base, with the sandbox headers', async () => {
    const s = server()
    const { token, baseUrl } = s.register(ID, view())
    expect(token.startsWith('art-')).toBe(true)
    expect(baseUrl).toBe(`cinna-preview://${token}/`)
    expect(s.owns(token)).toBe(true)
    expect(s.owns('0123abcd')).toBe(false)
    const csv = await get(s, `${baseUrl}data/q3.csv`)
    expect(csv.status).toBe(200)
    expect(await csv.text()).toBe('a,b\n')
    expect(csv.headers.get('content-type')).toBe('text/csv')
    expect(csv.headers.get('content-security-policy')).toBe(ARTIFACT_PREVIEW_CSP)
    expect(csv.headers.get('x-content-type-options')).toBe('nosniff')
    expect(csv.headers.get('referrer-policy')).toBe('no-referrer')
    expect(fetched).toEqual([`${BASE}data/q3.csv`])
    // A file shown on its own: a text type becomes text/plain, so the frame shows it.
    const asText = await get(s, `${baseUrl}data/q3.csv?cinna-view=text`)
    expect(asText.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect((await get(s, `${baseUrl}my%20file.txt`)).status).toBe(200)
  })

  it('puts the link helper into an HTML page', async () => {
    const s = server()
    const { baseUrl } = s.register(ID, view())
    const page = await get(s, `${baseUrl}index.html`)
    const body = await page.text()
    expect(body).toContain('<base target="_top"/>')
    expect(body).toContain('<body>hi</body>')
  })

  it('refuses a path that escapes the base, and never asks core for it', async () => {
    const s = server()
    const { token } = s.register(ID, view())
    for (const path of ['/a%2Fb', '/a%5Cb', '/a//b', '/%00', '/%E0%A4%A']) {
      const answer = await get(s, `cinna-preview://${token}${path}`)
      expect(answer.status, path).toBe(404)
    }
    expect(fetched).toEqual([])
    // Dot segments are resolved by the URL parser before the route sees them: clamped at the base.
    await get(s, `cinna-preview://${token}/%2e%2e/%2e%2e/cap2/index.html`)
    expect(fetched).toEqual([`${BASE}cap2/index.html`])
    expect(artifactRelativePath('/docs/')).toBe('docs/')
    expect(artifactRelativePath('/')).toBe('')
    for (const raw of ['/a/../b', '/..', '/./x', '/%2e%2e/x', '/a%2F..%2Fb']) expect(artifactRelativePath(raw), raw).toBeNull()
  })

  it('follows a folder redirect inside the base only', async () => {
    const s = server()
    const { token } = s.register(ID, view())
    const folder = await get(s, `cinna-preview://${token}/docs`)
    expect(folder.status).toBe(307)
    expect(folder.headers.get('location')).toBe(`cinna-preview://${token}/docs/`)
    expect((await get(s, `cinna-preview://${token}/away`)).status).toBe(404)
  })

  it('serves nothing to another profile, for an unknown token, or once released', async () => {
    const s = server()
    const { token } = s.register(ID, view())
    expect((await get(s, 'cinna-preview://art-nope/index.html')).status).toBe(404)
    user = 'bob'
    expect((await get(s, `cinna-preview://${token}/index.html`)).status).toBe(404)
    user = 'alice'
    // The profile switch dropped it for good.
    expect((await get(s, `cinna-preview://${token}/index.html`)).status).toBe(404)
    const again = s.register(ID, view())
    expect(s.release(again.token)).toBe(true)
    expect((await get(s, `${again.baseUrl}index.html`)).status).toBe(404)
    expect((await s.handle({ url: `${again.baseUrl}index.html`, method: 'POST' })).status).toBe(405)
    expect(fetched).toEqual([])
  })

  it('binds a token to the profile the view was minted for, not the one active at register', async () => {
    const s = server()
    // The profile switched to bob while alice's view call was in flight.
    user = 'bob'
    const { token } = s.register(ID, view(), 'alice')
    expect((await get(s, `cinna-preview://${token}/index.html`)).status).toBe(404)
    expect(fetched).toEqual([])
    user = 'alice'
  })

  it('mints the capability again once it is about to expire, once for concurrent requests', async () => {
    const s = server()
    const { baseUrl } = s.register(ID, view())
    clock = Date.parse('2026-10-17T10:59:30Z')
    const BASE2 = 'https://content.example/a/v/cap2/'
    routes[`${BASE2}data/q3.csv`] = () => new Response('new', { headers: { 'content-type': 'text/csv' } })
    mint.mockResolvedValue({ ok: true, view: view({ contentBase: BASE2, expiresAt: '2026-10-17T12:00:00Z' }) })
    const [a, b] = await Promise.all([get(s, `${baseUrl}data/q3.csv`), get(s, `${baseUrl}data/q3.csv`)])
    expect(await a.text()).toBe('new')
    expect(await b.text()).toBe('new')
    expect(mint).toHaveBeenCalledTimes(1)
    expect(mint).toHaveBeenCalledWith(ID, 'alice')
    // A failed mint is a 502, said in the frame; the next request tries again.
    clock = Date.parse('2026-10-17T12:30:00Z')
    mint.mockResolvedValue({ ok: false, code: 'gone', message: 'gone' })
    expect((await get(s, `${baseUrl}data/q3.csv`)).status).toBe(502)
    expect(mint).toHaveBeenCalledTimes(2)
  })
})

describe('reading one file’s text for the preview', () => {
  it('reads the file through the capability, decoded as UTF-8', async () => {
    const s = server()
    const { token } = s.register(ID, view())
    routes[`${BASE}notes/read%20me.md`] = () => new Response('# Héllo\n', { headers: { 'content-type': 'text/markdown' } })
    expect(await s.readText(token, 'notes/read me.md')).toEqual({ ok: true, text: '# Héllo\n', truncated: false })
    expect(fetched).toEqual([`${BASE}notes/read%20me.md`])
  })

  it('cuts a file over the cap and says it was cut', async () => {
    const s = server()
    const { token } = s.register(ID, view())
    routes[`${BASE}big.txt`] = () => new Response('abcdefghij'.repeat(10), { headers: { 'content-type': 'text/plain' } })
    expect(await s.readText(token, 'big.txt', 25)).toEqual({ ok: true, text: 'abcdefghijabcdefghijabcde', truncated: true })
    expect(await s.readText(token, 'big.txt', 100)).toEqual({ ok: true, text: 'abcdefghij'.repeat(10), truncated: false })
  })

  it('refuses a path outside the base without asking core', async () => {
    const s = server()
    const { token } = s.register(ID, view())
    for (const path of ['../other/x.md', 'a/../../x.md', 'a\\b.md', '', 'docs/']) {
      const result = await s.readText(token, path)
      expect(result.ok).toBe(false)
    }
    expect(await s.readText(token, '../x.md')).toMatchObject({ ok: false, code: 'path_refused' })
    expect(fetched).toEqual([])
  })

  it('reads nothing for an unknown or released token, or another profile', async () => {
    const s = server()
    expect(await s.readText('art-nope', 'data/q3.csv')).toMatchObject({ ok: false, code: 'not_found' })
    const { token } = s.register(ID, view())
    user = 'bob'
    expect(await s.readText(token, 'data/q3.csv')).toMatchObject({ ok: false, code: 'not_found' })
    user = 'alice'
    expect(await s.readText(token, 'data/q3.csv')).toMatchObject({ ok: false, code: 'not_found' })
    expect(fetched).toEqual([])
  })

  it('mints an expired capability again, and fails as data when it cannot', async () => {
    const s = server()
    const { token } = s.register(ID, view())
    clock = Date.parse('2026-10-17T12:30:00Z')
    mint.mockResolvedValue({ ok: false, code: 'gone', message: 'gone' })
    expect(await s.readText(token, 'data/q3.csv')).toMatchObject({ ok: false, code: 'request_failed' })
    const BASE2 = 'https://content.example/a/v/cap2/'
    routes[`${BASE2}data/q3.csv`] = () => new Response('fresh', { headers: { 'content-type': 'text/csv' } })
    mint.mockResolvedValue({ ok: true, view: view({ contentBase: BASE2, expiresAt: '2026-10-17T14:00:00Z' }) })
    expect(await s.readText(token, 'data/q3.csv')).toEqual({ ok: true, text: 'fresh', truncated: false })
    expect(fetched).toEqual([`${BASE2}data/q3.csv`])
  })

  it('says a missing file or a core failure as data', async () => {
    const s = server()
    const { token } = s.register(ID, view())
    expect(await s.readText(token, 'missing.md')).toMatchObject({ ok: false, code: 'not_found' })
    routes[`${BASE}boom.md`] = () => new Response('x', { status: 500 })
    expect(await s.readText(token, 'boom.md')).toMatchObject({ ok: false, code: 'request_failed' })
    const failing = server({ fetch: async () => { throw new Error('offline') } })
    const other = failing.register(ID, view())
    expect(await failing.readText(other.token, 'a.md')).toMatchObject({ ok: false, code: 'request_failed' })
  })
})
