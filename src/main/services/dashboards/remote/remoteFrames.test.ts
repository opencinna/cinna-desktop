import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const { openRemoteFrame, parseFrameUrl, safeContentType, REMOTE_FRAME_REFRESH_MS, REMOTE_FRAME_REMINT_GAP_MS } = await import('./remoteFrames')
type CoreOutcome<T> = import('./coreDashboardsClient').CoreOutcome<T>
type CoreFrame = import('./coreDashboardsClient').CoreFrame

/** A core whose /d/v/ answers by cap and path; caps are minted in order. */
function fakeCore(options: { expiresInMs?: number; answer?: (cap: string, path: string, method: string) => Response } = {}) {
  let clock = 1_000_000
  let minted = 0
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; redirect: string }> = []
  const mint = vi.fn(async (): Promise<CoreOutcome<CoreFrame>> => {
    minted += 1
    return {
      ok: true,
      value: {
        frame_url: `https://content.example.com/d/v/cap${minted}/app/index.html`,
        expires_at: new Date(clock + (options.expiresInMs ?? 12 * 3600_000)).toISOString()
      }
    }
  })
  const fetch = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; redirect: 'manual' }) => {
    requests.push({ url, ...init })
    const match = /\/d\/v\/([^/]+)\/(.*)$/.exec(new URL(url).pathname)!
    const answer = options.answer?.(match[1], match[2], init.method)
    return answer ?? new Response(`<p>${match[2]}</p>`, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'x=1', 'Content-Security-Policy': "frame-ancestors https://core" } })
  })
  return { mint, fetch, requests, now: () => clock, advance: (ms: number) => { clock += ms }, minted: () => minted }
}

async function open(core: ReturnType<typeof fakeCore>, maxBytes = 1024) {
  const opened = await openRemoteFrame({ fetch: core.fetch, mint: core.mint, maxBytes, now: core.now })
  if (!opened.ok) throw new Error(opened.code)
  return opened.frame
}

const text = (body: Uint8Array | null): string => new TextDecoder().decode(body ?? new Uint8Array())

describe('remoteFrames', () => {
  it('splits frame_url into the content base (through the cap) and the entry', () => {
    expect(parseFrameUrl('https://c.example.com/d/v/abc.def.ghi/index.html')).toEqual({ base: 'https://c.example.com/d/v/abc.def.ghi/', entry: 'index.html' })
    expect(parseFrameUrl('https://c.example.com/prefix/d/v/cap/app/x%20y.html')).toEqual({ base: 'https://c.example.com/prefix/d/v/cap/', entry: 'app/x%20y.html' })
    for (const bad of ['not a url', 'file:///d/v/cap/index.html', 'https://c/d/v/cap/', 'https://c/d/v/', 'https://c/x/cap/index.html', 'https://u:p@c/d/v/cap/i.html']) {
      expect(parseFrameUrl(bad), bad).toBeNull()
    }
  })

  it('opens with the decoded entry and fetches files under the base: GET/HEAD only, no auth, no redirect', async () => {
    const core = fakeCore()
    const frame = await open(core)
    expect(frame.entry).toBe('app/index.html')
    const got = await frame.file(['app', 'index.html'], 'GET')
    expect(got).toEqual({ ok: true, contentType: 'text/html; charset=utf-8', body: expect.any(Uint8Array) })
    expect(text(got.ok ? got.body : null)).toBe('<p>app/index.html</p>')
    const head = await frame.file(['a b.js'], 'HEAD')
    expect(head).toEqual({ ok: true, contentType: 'text/html; charset=utf-8', body: null })
    expect(core.requests).toEqual([
      { url: 'https://content.example.com/d/v/cap1/app/index.html', method: 'GET', headers: {}, redirect: 'manual' },
      { url: 'https://content.example.com/d/v/cap1/a%20b.js', method: 'HEAD', headers: {}, redirect: 'manual' }
    ])
    expect(core.mint).toHaveBeenCalledTimes(1)
  })

  it('re-mints before expires_at, lazily at the next request', async () => {
    const core = fakeCore({ expiresInMs: 3600_000 })
    const frame = await open(core)
    await frame.file(['index.html'], 'GET')
    core.advance(3600_000 - REMOTE_FRAME_REFRESH_MS - 1)
    await frame.file(['index.html'], 'GET')
    expect(core.mint).toHaveBeenCalledTimes(1)
    core.advance(2)
    await frame.file(['index.html'], 'GET')
    expect(core.mint).toHaveBeenCalledTimes(2)
    expect(core.requests.at(-1)?.url).toContain('/d/v/cap2/')
  })

  it('re-mints once and retries on a 401 or 403 from /d/v/', async () => {
    for (const refused of [401, 403]) {
      const core = fakeCore({ answer: (cap) => (cap === 'cap1' ? new Response('no', { status: refused }) : undefined as never) })
      const frame = await open(core)
      const got = await frame.file(['index.html'], 'GET')
      expect(got.ok, String(refused)).toBe(true)
      expect(core.mint).toHaveBeenCalledTimes(2)
      expect(core.requests.map((r) => r.url)).toEqual(['https://content.example.com/d/v/cap1/index.html', 'https://content.example.com/d/v/cap2/index.html'])
    }
  })

  it('re-mints once on a 404 (core’s answer to a dead cap) and serves the 404 only when the fresh cap gives it too', async () => {
    const core = fakeCore({ answer: (cap, path) => (cap === 'cap1' || path === 'missing.js' ? new Response('Not found', { status: 404 }) : undefined as never) })
    const frame = await open(core)
    expect((await frame.file(['index.html'], 'GET')).ok).toBe(true)
    expect(core.mint).toHaveBeenCalledTimes(2)
    core.advance(REMOTE_FRAME_REMINT_GAP_MS)
    expect(await frame.file(['missing.js'], 'GET')).toEqual({ ok: false, status: 404, message: 'Not found' })
    expect(core.mint).toHaveBeenCalledTimes(3)
    expect(core.requests.slice(-2).map((r) => r.url)).toEqual(['https://content.example.com/d/v/cap2/missing.js', 'https://content.example.com/d/v/cap3/missing.js'])
  })

  it('does not mint in a loop for a page of missing files: one refusal re-mint per frame per gap', async () => {
    const core = fakeCore({ answer: (_cap, path) => (path.startsWith('missing') ? new Response('Not found', { status: 404 }) : undefined as never) })
    const frame = await open(core)
    for (let i = 0; i < 5; i++) expect(await frame.file([`missing${i}.js`], 'GET')).toMatchObject({ ok: false, status: 404 })
    expect(core.mint).toHaveBeenCalledTimes(2)
    // Requests refused together share the one re-mint.
    const together = await Promise.all([1, 2, 3].map((i) => (core.advance(0), frame.file([`missing-x${i}.js`], 'GET'))))
    expect(together.every((r) => !r.ok)).toBe(true)
    expect(core.mint).toHaveBeenCalledTimes(2)
    core.advance(REMOTE_FRAME_REMINT_GAP_MS)
    await frame.file(['missing9.js'], 'GET')
    expect(core.mint).toHaveBeenCalledTimes(3)
  })

  it('does not loop: a refusal after the re-mint is the answer', async () => {
    const core = fakeCore({ answer: () => new Response('no', { status: 403 }) })
    const frame = await open(core)
    expect(await frame.file(['index.html'], 'GET')).toMatchObject({ ok: false, status: 404 })
    expect(core.mint).toHaveBeenCalledTimes(2)
  })

  it('says why: 503 is the environment, a network failure is the server, a redirect is not followed', async () => {
    const asleep = await open(fakeCore({ answer: () => new Response('', { status: 503 }) }))
    expect(await asleep.file(['index.html'], 'GET')).toEqual({ ok: false, status: 503, message: 'The agent’s environment isn’t running.' })
    const core = fakeCore()
    const offline = await open(core)
    core.fetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await offline.file(['index.html'], 'GET')).toEqual({ ok: false, status: 502, message: 'Can’t reach the Cinna server.' })
    const moved = await open(fakeCore({ answer: () => new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/' } }) }))
    expect(await moved.file(['index.html'], 'GET')).toMatchObject({ ok: false, status: 404 })
    const broken = await open(fakeCore({ answer: () => new Response('', { status: 500 }) }))
    expect(await broken.file(['index.html'], 'GET')).toMatchObject({ ok: false, status: 502 })
  })

  it('caps the size like a local frame, by Content-Length or by reading', async () => {
    const declared = await open(fakeCore({ answer: () => new Response('x'.repeat(10), { status: 200, headers: { 'Content-Length': '5000' } }) }), 100)
    expect(await declared.file(['big.js'], 'GET')).toMatchObject({ ok: false, status: 413 })
    const streamed = await open(fakeCore({ answer: () => new Response('x'.repeat(101), { status: 200 }) }), 100)
    expect(await streamed.file(['big.js'], 'GET')).toMatchObject({ ok: false, status: 413 })
    const fits = await open(fakeCore({ answer: () => new Response('x'.repeat(100), { status: 200 }) }), 100)
    expect(await fits.file(['ok.js'], 'GET')).toMatchObject({ ok: true })
  })

  it('does not mint ahead of expiry on every request after a failed mint: one try per gap, the old cap meanwhile', async () => {
    const core = fakeCore({ expiresInMs: REMOTE_FRAME_REFRESH_MS + 10_000 })
    const frame = await open(core)
    core.advance(20_000) // inside the refresh window, the cap still good for a while
    core.mint.mockResolvedValue({ ok: false, code: 'env_unavailable', message: 'asleep', status: 503 })
    expect(await frame.file(['index.html'], 'GET')).toMatchObject({ ok: false })
    expect(core.mint).toHaveBeenCalledTimes(2)
    // Within the gap: no mint, the old cap serves.
    for (let i = 0; i < 5; i++) expect(await frame.file(['index.html'], 'GET')).toMatchObject({ ok: true })
    expect(core.mint).toHaveBeenCalledTimes(2)
    expect(core.requests.at(-1)?.url).toContain('/d/v/cap1/')
    // After the gap: one more try, which works.
    core.advance(REMOTE_FRAME_REMINT_GAP_MS)
    core.mint.mockReset()
    core.mint.mockResolvedValue({ ok: true, value: { frame_url: 'https://content.example.com/d/v/cap9/app/index.html', expires_at: new Date(core.now() + 12 * 3600_000).toISOString() } })
    expect(await frame.file(['index.html'], 'GET')).toMatchObject({ ok: true })
    expect(core.mint).toHaveBeenCalledTimes(1)
    expect(core.requests.at(-1)?.url).toContain('/d/v/cap9/')
  })

  it('passes core’s refusal of the mint as its code, and a failed re-mint as an error page', async () => {
    const refused = await openRemoteFrame({
      fetch: vi.fn(),
      mint: async () => ({ ok: false, code: 'env_unavailable', message: 'asleep', status: 409 }),
      maxBytes: 10
    })
    expect(refused).toEqual({ ok: false, code: 'env_unavailable', message: 'asleep' })
    const notAFrame = await openRemoteFrame({ fetch: vi.fn(), mint: async () => ({ ok: true, value: { frame_url: 'https://x/other', expires_at: 'soon' } }), maxBytes: 10 })
    expect(notAFrame).toMatchObject({ ok: false, code: 'call_failed' })

    const core = fakeCore({ expiresInMs: 1000 })
    const frame = await open(core)
    core.mint.mockResolvedValueOnce({ ok: false, code: 'unreachable', message: 'down', status: null })
    expect(await frame.file(['index.html'], 'GET')).toEqual({ ok: false, status: 502, message: 'Can’t reach the Cinna server.' })
  })

  it('keeps only a well-formed Content-Type', () => {
    expect(safeContentType('Text/HTML; charset=utf-8')).toBe('text/html; charset=utf-8')
    expect(safeContentType(null)).toBe('application/octet-stream')
    expect(safeContentType('text/html\r\nX-Evil: 1')).toBe('application/octet-stream')
    expect(safeContentType('nonsense')).toBe('application/octet-stream')
  })
})
