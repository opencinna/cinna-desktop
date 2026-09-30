import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createHtmlPreviewServer, htmlPreviewContentType, MAX_HTML_PREVIEW_BYTES } = await import('./htmlPreviewServer')
const { injectPreviewLinkHelper } = await import('./previewLinkHelper')
type Deps = import('./htmlPreviewServer').HtmlPreviewServerDeps

/**
 * The `cinna-preview:` registry and handler: what a token serves, to whom,
 * and with which headers. The reads behind it are fakes; the agent-file gate
 * itself is tested in `agentFileService.test.ts`.
 */

let user: string
let calls: Array<[string, unknown, unknown?]>
let counter: number

function makeServer(overrides: Partial<Deps> = {}) {
  return createHtmlPreviewServer({
    currentUserId: () => user,
    readAttachment: async (input) => {
      calls.push(['attachment', input])
      return { bytes: Buffer.from('<p>attached</p>'), truncated: false }
    },
    readAgentDocument: async (input, maxBytes) => {
      calls.push(['document', input, maxBytes])
      return { success: true, bytes: Buffer.from('<p>agent</p>') }
    },
    readAgentAsset: async (input, segments) => {
      calls.push(['asset', input, segments])
      if (segments.join('/') === 'secret.txt') return { success: false, code: 'needs_consent', error: 'no' }
      if (segments.join('/') === 'huge.js') return { success: false, code: 'too_large', error: 'This file is too large to show.' }
      return { success: true, bytes: Buffer.from(`asset:${segments.join('/')}`) }
    },
    newToken: () => `t${++counter}`,
    ...overrides
  })
}

const get = (server: ReturnType<typeof makeServer>, url: string, method = 'GET') => server.handle({ url, method })

beforeEach(() => {
  user = 'u1'
  calls = []
  counter = 0
})

describe('the html preview server', () => {
  it('issues an unguessable lower-case token and a url naming the document', () => {
    const server = createHtmlPreviewServer({
      currentUserId: () => 'u1',
      readAttachment: async () => ({ bytes: Buffer.alloc(0), truncated: false }),
      readAgentDocument: async () => ({ success: true, bytes: Buffer.alloc(0) }),
      readAgentAsset: async () => ({ success: true, bytes: Buffer.alloc(0) })
    })
    const a = server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/out/My Report.html' })
    const b = server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/out/My Report.html' })
    expect(a.token).toMatch(/^[0-9a-f]{48}$/)
    expect(a.token).not.toBe(b.token)
    expect(a.url).toBe(`cinna-preview://${a.token}/My%20Report.html`)
  })

  it('serves an agent document with the frame headers', async () => {
    const server = makeServer()
    const { url } = server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/out/report.html' })
    const response = await get(server, url)
    expect(response.status).toBe(200)
    // The entry document carries the link helper; nothing else of it changes.
    expect(await response.text()).toBe(injectPreviewLinkHelper(Buffer.from('<p>agent</p>')).toString())
    expect(Object.fromEntries(response.headers)).toEqual({
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'content-type': 'text/html',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    })
    expect(calls).toEqual([['document', { agentId: 'folder:a', path: '/agent/out/report.html' }, MAX_HTML_PREVIEW_BYTES]])
  })

  it('serves relative assets of an agent document through the asset gate, typed by extension', async () => {
    const server = makeServer()
    const { token } = server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/out/report.html' })
    const css = await get(server, `cinna-preview://${token}/style.css?v=2`)
    expect(css.headers.get('content-type')).toBe('text/css')
    expect(await css.text()).toBe('asset:style.css')
    // A sibling HTML page gets the link helper too, so its links still open on a click.
    expect(await (await get(server, `cinna-preview://${token}/page2.html`)).text()).toBe(
      injectPreviewLinkHelper(Buffer.from('asset:page2.html')).toString()
    )
    const image = await get(server, `cinna-preview://${token}/img/my%20x.png`)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(calls.at(-1)).toEqual(['asset', { agentId: 'folder:a', path: '/agent/out/report.html' }, ['img', 'my x.png']])
  })

  it('answers 404 for an unknown token, a released one, and a refused asset', async () => {
    const server = makeServer()
    const { token, url } = server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/report.html' })
    expect((await get(server, 'cinna-preview://nope/report.html')).status).toBe(404)
    expect((await get(server, `cinna-preview://${token}/secret.txt`)).status).toBe(404)
    expect(server.release(token)).toBe(true)
    expect((await get(server, url)).status).toBe(404)
    expect(server.release(token)).toBe(false)
    expect(server.release(42)).toBe(false)
  })

  it('passes encoded traversal to the gate as a segment, never as a path', async () => {
    const server = makeServer()
    const { token } = server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/report.html' })
    await get(server, `cinna-preview://${token}/..%2F..%2Fsecret`)
    await get(server, `cinna-preview://${token}/a/%2E%2E/%2E%2E/b`)
    // The URL parser folds real `..` segments at the root; an encoded slash stays inside one segment.
    expect(calls.map((call) => call[2])).toEqual([['../../secret'], ['b']])
    expect((await get(server, `cinna-preview://${token}/%E0%A4%A`)).status).toBe(404)
  })

  it('serves an attachment document only, never anything beside it', async () => {
    const server = makeServer()
    const { token, url } = server.register({ type: 'attachment', attachmentId: 'f1', source: 'local', filename: 'page' })
    const response = await get(server, url)
    expect(response.status).toBe(200)
    // Named by its MIME type only: the document is still served as HTML.
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(calls).toEqual([['attachment', { userId: 'u1', attachmentId: 'f1', source: 'local', maxBytes: MAX_HTML_PREVIEW_BYTES }]])
    expect((await get(server, `cinna-preview://${token}/style.css`)).status).toBe(404)
    expect(calls).toHaveLength(1)
  })

  it('refuses over the size cap', async () => {
    const server = makeServer({ readAttachment: async () => ({ bytes: Buffer.from('<p>'), truncated: true }) })
    const attachment = server.register({ type: 'attachment', attachmentId: 'f1', source: 'cinna', filename: 'big.html' })
    expect((await get(server, attachment.url)).status).toBe(413)
    const agent = server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/report.html' })
    expect((await get(server, `cinna-preview://${agent.token}/huge.js`)).status).toBe(413)
  })

  it('serves nothing to another profile, and forgets the token', async () => {
    const server = makeServer()
    const { url } = server.register({ type: 'attachment', attachmentId: 'f1', source: 'local', filename: 'a.html' })
    user = 'u2'
    expect((await get(server, url)).status).toBe(404)
    user = 'u1'
    expect((await get(server, url)).status).toBe(404)
    expect(calls).toEqual([])
  })

  it('answers only GET and HEAD, and only its own scheme', async () => {
    const server = makeServer()
    const { token, url } = server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/report.html' })
    expect((await get(server, url, 'POST')).status).toBe(405)
    const head = await get(server, url, 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await get(server, `https://${token}/report.html`)).status).toBe(404)
    expect((await get(server, 'not a url')).status).toBe(404)
  })

  it('keeps a bounded number of tokens, dropping the oldest', async () => {
    const server = makeServer({ maxTokens: 2 })
    const first = server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/1.html' })
    server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/2.html' })
    server.register({ type: 'agentFile', agentId: 'folder:a', path: '/agent/3.html' })
    expect(server.size()).toBe(2)
    expect((await get(server, first.url)).status).toBe(404)
  })

  it('types files by extension', () => {
    expect(htmlPreviewContentType('a.js')).toBe('text/javascript')
    expect(htmlPreviewContentType('a.JSON')).toBe('application/json')
    expect(htmlPreviewContentType('font.woff2')).toBe('font/woff2')
    expect(htmlPreviewContentType('data.bin')).toBe('application/octet-stream')
  })
})
