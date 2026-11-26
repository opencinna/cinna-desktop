import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createAgentDetailsService, parseAgentDetailsTarget } = await import('./agentDetailsService')
const { MAX_AGENT_DETAILS_BYTES } = await import('../../../shared/agentDetails')
type AgentFileFailure = import('../../../shared/agentFiles').AgentFileFailure

/** Agent Details as main reads it: core's answers with their ETag, and a folder agent's own files. */

const ITEM = '0f8fad5b-d9cb-469f-a165-70867728950e'
const AGENT = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const HTML = '<!DOCTYPE html><html><head><title>Weather</title></head><body><p>Hi</p></body></html>'

const body = (over: Record<string, unknown> = {}) => ({
  source: 'custom',
  format: 'markdown',
  content: '# Weather Desk\n',
  generated: { format: 'markdown', content: '## About\n\nGenerated.' },
  warnings: [],
  revision_number: 10,
  etag: '"sha256-1"',
  ...over
})

interface Sent {
  path: string
  headers?: Record<string, string>
}

let sent: Sent[]
let answers: Array<{ status: number; body: unknown } | Error>
let discovery: { agent_details?: number } | Error
let account: { serverUrl: string; signedIn: boolean } | null
let files: Record<string, Buffer | AgentFileFailure['code']>

function service(maxCacheEntries?: number) {
  return createAgentDetailsService({
    profileId: () => 'p1',
    account: () => account,
    discover: async () => {
      if (discovery instanceof Error) throw discovery
      return discovery
    },
    send: async (_profileId, path, opts) => {
      sent.push({ path, ...(opts.headers ? { headers: opts.headers } : {}) })
      const next = answers.shift()
      if (!next) throw new Error('no answer scripted')
      if (next instanceof Error) throw next
      return next
    },
    readLocalFile: async (agentId, rel, maxBytes) => {
      if (agentId !== 'folder:a') return { success: false, code: 'agent_not_found', error: 'gone' }
      const file = files[rel]
      if (file === undefined) return { success: false, code: 'not_found', error: 'missing' }
      if (typeof file === 'string') return { success: false, code: file, error: file }
      if (file.length > maxBytes) return { success: false, code: 'too_large', error: 'big' }
      return { success: true, bytes: file }
    },
    ...(maxCacheEntries ? { maxCacheEntries } : {})
  })
}

beforeEach(() => {
  sent = []
  answers = []
  discovery = { agent_details: 1 }
  account = { serverUrl: 'https://core.example', signedIn: true }
  files = {}
})

const catalog = (revisionNumber?: number) => ({ kind: 'catalog' as const, itemUuid: ITEM, ...(revisionNumber ? { revisionNumber } : {}) })

describe('the capability', () => {
  it('is unsupported without the discovery flag, and asks again on the next call', async () => {
    discovery = {}
    const s = service()
    expect(await s.get(catalog())).toMatchObject({ ok: false, code: 'unsupported' })
    discovery = { agent_details: 0 }
    expect(await s.get(catalog())).toMatchObject({ ok: false, code: 'unsupported' })
    discovery = new Error('offline')
    expect(await s.get(catalog())).toMatchObject({ ok: false, code: 'unsupported' })
    discovery = { agent_details: 1 }
    answers.push({ status: 200, body: body() })
    expect(await s.get(catalog())).toMatchObject({ ok: true })
    expect(sent).toHaveLength(1)
  })

  it('is unsupported for a profile that is not a signed-in Cinna account', async () => {
    account = null
    expect(await service().get({ kind: 'agent', remoteAgentId: AGENT })).toMatchObject({ ok: false, code: 'unsupported' })
    account = { serverUrl: 'https://core.example', signedIn: false }
    expect(await service().get({ kind: 'agent', remoteAgentId: AGENT })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(sent).toEqual([])
  })
})

describe('core answers', () => {
  it('revalidates with the ETag, and a 304 returns the cached view', async () => {
    const s = service()
    answers.push({ status: 200, body: body() }, { status: 304, body: null })
    const first = await s.get(catalog())
    const second = await s.get(catalog())
    expect(sent[0]).toEqual({ path: `/api/v1/catalog/items/${ITEM}/details` })
    expect(sent[1]).toEqual({ path: `/api/v1/catalog/items/${ITEM}/details`, headers: { 'If-None-Match': '"sha256-1"' } })
    expect(second).toEqual(first)
    expect(second).toMatchObject({ ok: true, details: { markdown: '# Weather Desk\n', revisionNumber: 10 } })
  })

  it('keys the cache by the URL, revision_number included', async () => {
    const s = service()
    answers.push({ status: 200, body: body() }, { status: 200, body: body({ etag: '"sha256-3"', revision_number: 3 }) })
    await s.get(catalog())
    await s.get(catalog(3))
    expect(sent[1]).toEqual({ path: `/api/v1/catalog/items/${ITEM}/details?revision_number=3` })
    answers.push({ status: 304, body: null })
    expect(await s.get(catalog(3))).toMatchObject({ ok: true, details: { revisionNumber: 3 } })
    expect(sent[2].headers).toEqual({ 'If-None-Match': '"sha256-3"' })
  })

  it('a target that is not one is not_found, so no button', async () => {
    expect(await service().get({ kind: 'catalog', itemUuid: ITEM, revisionNumber: 0 })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await service().htmlFor({ kind: 'agent', remoteAgentId: 'x' }, 'p1')).toMatchObject({ ok: false, code: 'not_found' })
    expect(sent).toEqual([])
  })

  it('forgets the kept page on any failure, so the frame never serves a revoked one', async () => {
    for (const failing of [{ status: 404, body: null }, { status: 500, body: null }]) {
      const s = service()
      answers.push({ status: 200, body: body({ format: 'html', content: HTML }) }, failing)
      await s.get(catalog())
      expect((await s.get(catalog())).ok).toBe(false)
      answers.push({ status: 404, body: null })
      expect(await s.htmlFor(catalog(), 'p1')).toMatchObject({ ok: false, code: 'not_found' })
    }
    // Unsupported now (the flag went away): forgotten too.
    const s = service()
    answers.push({ status: 200, body: body({ format: 'html', content: HTML }) })
    await s.get(catalog())
    discovery = {}
    await s.get(catalog())
    expect(await s.htmlFor(catalog(), 'p1')).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('never sends a revision_number core would refuse', () => {
    expect(parseAgentDetailsTarget({ kind: 'catalog', itemUuid: ITEM, revisionNumber: 0 })).toBeNull()
    expect(parseAgentDetailsTarget({ kind: 'catalog', itemUuid: ITEM, revisionNumber: 1.5 })).toBeNull()
    expect(parseAgentDetailsTarget({ kind: 'catalog', itemUuid: 'not-a-uuid' })).toBeNull()
    expect(parseAgentDetailsTarget({ kind: 'agent', remoteAgentId: '../x' })).toBeNull()
    expect(parseAgentDetailsTarget({ kind: 'local', agentId: '' })).toBeNull()
  })

  it('reads an agent by its core id', async () => {
    answers.push({ status: 200, body: body({ revision_number: null, source: 'generated', content: '## About' }) })
    expect(await service().get({ kind: 'agent', remoteAgentId: AGENT })).toMatchObject({
      ok: true,
      details: { source: 'generated', markdown: '## About', revisionNumber: null }
    })
    expect(sent[0].path).toBe(`/api/v1/agents/${AGENT}/details`)
  })

  it('a 404 is not_found and drops the cached answer', async () => {
    const s = service()
    answers.push({ status: 200, body: body() }, { status: 404, body: { detail: 'Catalog item not found' } }, { status: 200, body: body() })
    await s.get(catalog())
    expect(await s.get(catalog())).toMatchObject({ ok: false, code: 'not_found' })
    expect(s.cacheSize()).toBe(0)
    await s.get(catalog())
    expect(sent[2].headers).toBeUndefined()
  })

  it.each([403, 422, 500, 502])('a %i is unavailable, so the button stays', async (status) => {
    answers.push({ status, body: { detail: 'nope' } })
    expect(await service().get(catalog())).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('a request that throws (reauth, network) is unavailable', async () => {
    answers.push(new Error('reauth_required'))
    expect(await service().get(catalog())).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it.each([
    ['an unknown source', { source: 'publisher' }],
    ['an unknown format', { format: 'pdf' }],
    ['a generated html answer', { source: 'generated', format: 'html' }],
    ['no content', { content: 3 }],
    ['no generated summary', { generated: null }],
    ['a generated summary in html', { generated: { format: 'html', content: 'x' } }],
    ['warnings not a list', { warnings: 'both_present' }],
    ['a revision that is not a number', { revision_number: '10' }],
    ['no etag', { etag: undefined }]
  ])('a 200 with %s is unavailable', async (_name, over) => {
    answers.push({ status: 200, body: body(over) })
    expect(await service().get(catalog())).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('keeps only string warnings, and reads the winner from source and format, never from warnings', async () => {
    answers.push({ status: 200, body: body({ warnings: ['both_present', 7, null] }) })
    expect(await service().get(catalog())).toEqual({
      ok: true,
      details: {
        source: 'custom',
        format: 'markdown',
        markdown: '# Weather Desk\n',
        generated: '## About\n\nGenerated.',
        warnings: ['both_present'],
        revisionNumber: 10
      }
    })
  })

  it('never gives the renderer the HTML, and keeps it for the frame', async () => {
    const s = service()
    answers.push({ status: 200, body: body({ format: 'html', content: HTML, warnings: ['both_present'] }) })
    const result = await s.get(catalog())
    expect(result).toMatchObject({ ok: true, details: { format: 'html', markdown: null, generated: '## About\n\nGenerated.' } })
    expect(JSON.stringify(result)).not.toContain('<!DOCTYPE')
    expect(await s.htmlFor(catalog(), 'p1')).toEqual({ ok: true, html: HTML })
    // Another profile has nothing kept and reads again.
    answers.push({ status: 200, body: body({ format: 'html', content: HTML }) })
    expect(await s.htmlFor(catalog(), 'p2')).toEqual({ ok: true, html: HTML })
    expect(sent).toHaveLength(2)
  })

  it('htmlFor a markdown answer is not_found', async () => {
    answers.push({ status: 200, body: body() })
    expect(await service().htmlFor(catalog(), 'p1')).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('bounds the cache, dropping the oldest', async () => {
    const s = service(2)
    for (const n of [1, 2, 3]) answers.push({ status: 200, body: body({ etag: `"e${n}"` }) })
    await s.get(catalog(1))
    await s.get(catalog(2))
    await s.get(catalog(3))
    expect(s.cacheSize()).toBe(2)
    answers.push({ status: 200, body: body() })
    await s.get(catalog(1))
    expect(sent[3].headers).toBeUndefined()
  })
})

describe("a folder agent's own file (D6)", () => {
  const local = { kind: 'local' as const, agentId: 'folder:a' }
  const md = Buffer.from('# Local\n')
  const html = Buffer.from(HTML)

  it('works without a Cinna account', async () => {
    account = null
    files['docs/AGENT_DETAILS.md'] = md
    expect(await service().get(local)).toEqual({
      ok: true,
      details: { source: 'custom', format: 'markdown', markdown: '# Local\n', generated: null, warnings: [], revisionNumber: null }
    })
  })

  it('HTML wins over markdown, with both_present, and stays in main', async () => {
    files['docs/AGENT_DETAILS.html'] = html
    files['docs/AGENT_DETAILS.md'] = md
    const s = service()
    const result = await s.get(local)
    expect(result).toEqual({
      ok: true,
      details: { source: 'custom', format: 'html', markdown: null, generated: null, warnings: ['both_present'], revisionNumber: null }
    })
    expect(await s.htmlFor(local, 'p1')).toEqual({ ok: true, html: HTML })
  })

  it('an HTML file over 1 MiB falls back to the markdown with too_large', async () => {
    files['docs/AGENT_DETAILS.html'] = Buffer.alloc(MAX_AGENT_DETAILS_BYTES + 1, 'a')
    files['docs/AGENT_DETAILS.md'] = md
    expect(await service().get(local)).toMatchObject({ ok: true, details: { format: 'markdown', markdown: '# Local\n', warnings: ['too_large'] } })
  })

  it('a file that exists but cannot be shown, with nothing else usable, is unavailable and says why', async () => {
    files['docs/AGENT_DETAILS.html'] = Buffer.alloc(MAX_AGENT_DETAILS_BYTES + 1, 'a')
    expect(await service().get(local)).toEqual({ ok: false, code: 'unavailable', message: 'docs/AGENT_DETAILS.html is over 1 MiB.' })
    files = { 'docs/AGENT_DETAILS.md': Buffer.from([0xff, 0xfe]) }
    expect(await service().get(local)).toEqual({ ok: false, code: 'unavailable', message: 'docs/AGENT_DETAILS.md is not UTF-8 text.' })
  })

  it('an HTML file that is not UTF-8 falls back with invalid_encoding', async () => {
    files['docs/AGENT_DETAILS.html'] = Buffer.from([0x3c, 0x70, 0xff, 0xfe, 0x3e])
    files['docs/AGENT_DETAILS.md'] = md
    expect(await service().get(local)).toMatchObject({ ok: true, details: { format: 'markdown', warnings: ['invalid_encoding'] } })
  })

  it('a whitespace-only file counts as absent', async () => {
    files['docs/AGENT_DETAILS.html'] = Buffer.from('  \n\t\n')
    files['docs/AGENT_DETAILS.md'] = md
    expect(await service().get(local)).toMatchObject({ ok: true, details: { format: 'markdown', warnings: [] } })
    files['docs/AGENT_DETAILS.md'] = Buffer.from('\n')
    expect(await service().get(local)).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('no file, and an agent that is not a folder agent, are not_found', async () => {
    expect(await service().get(local)).toMatchObject({ ok: false, code: 'not_found' })
    expect(await service().get({ kind: 'local', agentId: 'remote:x' })).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('a locked vault or a failed read is unavailable', async () => {
    files['docs/AGENT_DETAILS.html'] = 'locked'
    expect(await service().get(local)).toMatchObject({ ok: false, code: 'unavailable' })
    files['docs/AGENT_DETAILS.html'] = 'read_failed'
    expect(await service().get(local)).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('reads the files again on every call', async () => {
    const s = service()
    files['docs/AGENT_DETAILS.md'] = md
    await s.get(local)
    files['docs/AGENT_DETAILS.md'] = Buffer.from('# Edited\n')
    expect(await s.get(local)).toMatchObject({ ok: true, details: { markdown: '# Edited\n' } })
  })
})
