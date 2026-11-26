import { beforeEach, describe, expect, it } from 'vitest'
import { createAgentDetailsFrameServer, retargetWebLinks, stripMetaRefresh } from './agentDetailsFrameServer'
import { AGENT_DETAILS_CSP } from '../../../shared/agentDetails'

/** The det- handler: one document per token, nothing else, under the C4 policy. */

const HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>W</title></head>' +
  '<body><a href="https://example.com/">Site</a></body></html>'

let user = 'p1'
let counter = 0

const server = (maxTokens?: number) =>
  createAgentDetailsFrameServer({
    currentUserId: () => user,
    newToken: () => `det-${(++counter).toString().padStart(4, '0')}`,
    ...(maxTokens ? { maxTokens } : {})
  })

beforeEach(() => {
  user = 'p1'
  counter = 0
})

describe('agentDetailsFrameServer', () => {
  it('owns det- hosts only', () => {
    const s = server()
    expect(s.owns('det-abc')).toBe(true)
    expect(s.owns('art-abc')).toBe(false)
    expect(s.owns('dash-abc')).toBe(false)
    expect(s.owns('0123abcd')).toBe(false)
  })

  it('strips a meta refresh from what it serves', async () => {
    const s = server()
    const { url } = s.register('<head><META HTTP-EQUIV=Refresh CONTENT="0;url=https://x.test/"><title>T</title></head>')
    expect(await (await s.handle({ url, method: 'GET' })).text()).toBe('<head><title>T</title></head>')
  })

  it('serves the document unchanged, with the C4 policy as a header', async () => {
    const s = server()
    const { url, token } = s.register(HTML)
    expect(url).toBe(`cinna-preview://${token}/`)
    const res = await s.handle({ url, method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(AGENT_DETAILS_CSP)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const text = await res.text()
    expect(text).toBe(HTML.replace('href="https://example.com/"', 'href="https://example.com/" target="_top"'))
    expect(text).not.toContain('<script')
  })

  it('answers HEAD without a body, and refuses other methods', async () => {
    const s = server()
    const { url } = s.register(HTML)
    const head = await s.handle({ url, method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await s.handle({ url, method: 'POST' })).status).toBe(405)
  })

  it('serves nothing but the document', async () => {
    const s = server()
    const { url } = s.register(HTML)
    for (const path of ['index.html', 'style.css', '../x', 'a/b']) {
      expect((await s.handle({ url: url + path, method: 'GET' })).status).toBe(404)
    }
    expect((await s.handle({ url: 'cinna-preview://det-9999/', method: 'GET' })).status).toBe(404)
    expect((await s.handle({ url: 'not a url', method: 'GET' })).status).toBe(404)
  })

  it('serves nothing to another profile, and forgets the token', async () => {
    const s = server()
    const { url } = s.register(HTML, 'p1')
    user = 'p2'
    expect((await s.handle({ url, method: 'GET' })).status).toBe(404)
    user = 'p1'
    expect((await s.handle({ url, method: 'GET' })).status).toBe(404)
    expect(s.size()).toBe(0)
  })

  it('keeps at most the cap of tokens, dropping the oldest, and releases on request', async () => {
    const s = server(2)
    const a = s.register('<p>a</p>')
    const b = s.register('<p>b</p>')
    const c = s.register('<p>c</p>')
    expect(s.size()).toBe(2)
    expect((await s.handle({ url: a.url, method: 'GET' })).status).toBe(404)
    expect((await s.handle({ url: b.url, method: 'GET' })).status).toBe(200)
    expect(s.release(c.token)).toBe(true)
    expect(s.release(42)).toBe(false)
    expect((await s.handle({ url: c.url, method: 'GET' })).status).toBe(404)
  })
})

describe('stripMetaRefresh', () => {
  it.each([
    '<meta http-equiv="refresh" content="0; url=https://x.test/">',
    "<meta http-equiv='REFRESH' content='5'>",
    '<meta content="0;url=https://x.test/" http-equiv=refresh>',
    '<meta\n  content="0"\n  http-equiv = " refresh "\n/>',
    '<META/http-equiv="Refresh"/content="0">',
    '<meta http-equiv="&#114;efresh" content="0">',
    '<meta http-equiv="&#x52;efresh" content="0">',
    '<meta content="a>b" http-equiv="refresh">'
  ])('removes %s', (tag) => {
    expect(stripMetaRefresh(`<head>${tag}<title>T</title></head>`)).toBe('<head><title>T</title></head>')
  })

  it('keeps every other meta tag and the rest of the page as it is', () => {
    const page =
      '<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' +
      '<meta name="refresh" content="0"><meta name="viewport" content="width=device-width"></head><body>refresh</body>'
    expect(stripMetaRefresh(page)).toBe(page)
  })
})

describe('retargetWebLinks', () => {
  it('sends a plain https link to _top', () => {
    expect(retargetWebLinks('<p><a href="https://x.test/a">x</a></p>')).toBe('<p><a href="https://x.test/a" target="_top">x</a></p>')
  })

  it('replaces an existing target, any case and quoting', () => {
    expect(retargetWebLinks("<A TARGET=_blank HREF='HTTPS://x.test'>x</A>")).toBe(`<A HREF='HTTPS://x.test' target="_top">x</A>`)
    expect(retargetWebLinks('<area href=https://x.test target="_self">')).toBe('<area href=https://x.test target="_top">')
  })

  it('reads a character-encoded scheme as the parser does', () => {
    expect(retargetWebLinks('<a href="&#104;ttps://x.test">x</a>')).toBe('<a href="&#104;ttps://x.test" target="_top">x</a>')
  })

  it('leaves fragments, http, other schemes and non-link tags alone', () => {
    const html = '<a href="#top">t</a><a href="http://x.test">h</a><a href="mailto:a@b.test">m</a><abbr title="https://x">a</abbr><a name="n">n</a>'
    expect(retargetWebLinks(html)).toBe(html)
  })

  it('is applied to what the frame serves', async () => {
    const server = createAgentDetailsFrameServer({ currentUserId: () => 'u1' })
    const { url } = server.register('<a href="https://x.test">x</a>', 'u1')
    const answer = await server.handle({ url, method: 'GET' })
    expect(await answer.text()).toBe('<a href="https://x.test" target="_top">x</a>')
  })
})
