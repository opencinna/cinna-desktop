import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { CinnaApiError } from '../../errors'
import type { PublishedArtifactRow } from '../../db/publishedArtifacts'
import type { CinnaSendResult } from '../cinna-http'
import { createArtifactService, type ArtifactServiceDeps } from './publishService'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const LINK_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SERVER = 'https://core.example'

let root: string
let agentDir: string
let outside: string

interface SendCall {
  path: string
  method: string
  json?: unknown
  fields?: Record<string, string>
  archive?: { filename: string; names: string[] }
}

/** The text fields and the archive of a multipart body, as core would read them. */
function readMultipart(data: Uint8Array, contentType: string): Pick<SendCall, 'fields' | 'archive'> {
  const boundary = /boundary=(.+)$/.exec(contentType)![1]
  const raw = Buffer.from(data)
  const fields: Record<string, string> = {}
  let archive: SendCall['archive']
  const marker = Buffer.from(`--${boundary}`)
  let at = raw.indexOf(marker)
  while (at >= 0) {
    const next = raw.indexOf(marker, at + marker.length)
    if (next < 0) break
    const part = raw.subarray(at + marker.length + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    const head = part.subarray(0, split).toString('utf8')
    const body = part.subarray(split + 4)
    const name = /name="([^"]+)"/.exec(head)![1]
    const filename = /filename="([^"]+)"/.exec(head)?.[1]
    if (filename) archive = { filename, names: zipNames(body) }
    else fields[name] = body.toString('utf8')
    at = next
  }
  return { fields, archive }
}

function zipNames(zip: Buffer): string[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let at = zip.readUInt32LE(end + 16)
  const names: string[] = []
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const length = zip.readUInt16LE(at + 28)
    names.push(zip.subarray(at + 46, at + 46 + length).toString('utf8'))
    // The body inflates: the archive is a real one.
    const local = zip.readUInt32LE(at + 42)
    const start = local + 30 + zip.readUInt16LE(local + 26)
    if (zip.readUInt16LE(at + 10) === 8) inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(at + 20)))
    at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
  }
  return names
}

function published(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    title: 'Q3 churn',
    kind: 'site',
    entry_path: 'index.html',
    visibility: 'private',
    current_revision_number: 1,
    revision_number: 1,
    live_link_count: 0,
    is_owner: true,
    owner_name: 'Ann',
    url: `http://localhost:5173/artifact/${ID}`,
    excluded: [],
    ...overrides
  }
}

function makeRepo() {
  const rows: PublishedArtifactRow[] = []
  const cards: Array<{ id: string; chatId: string; messageId: string; artifactId: string }> = []
  const repo: ArtifactServiceDeps['repo'] = {
    findBySource: (profile, server, source) => rows.filter((row) => row.profileUserId === profile && row.serverUrl === server && row.sourcePath === source).at(-1) ?? null,
    get: (profile, server, id) => rows.find((row) => row.profileUserId === profile && row.serverUrl === server && row.artifactId === id) ?? null,
    recordPublish: (profile, server, source, state) => {
      const existing = repo.get(profile, server, state.artifactId)
      if (existing) Object.assign(existing, source, state)
      else rows.push({ id: `row-${rows.length}`, profileUserId: profile, serverUrl: server, ...source, ...state, approvedAgentId: null, createdAt: new Date(), updatedAt: new Date() })
    },
    sync: (profile, server, state) => {
      const existing = repo.get(profile, server, state.artifactId)
      if (existing) Object.assign(existing, state)
    },
    forget: (profile, server, id) => {
      const index = rows.findIndex((row) => row.profileUserId === profile && row.serverUrl === server && row.artifactId === id)
      if (index >= 0) rows.splice(index, 1)
    },
    addCard: (_profile, chatId, messageId, artifactId) => {
      cards.push({ id: `card-${cards.length}`, chatId, messageId, artifactId })
    },
    cards: (profile, server, chatId) =>
      cards.filter((card) => card.chatId === chatId).flatMap((card) => {
        const artifact = repo.get(profile, server, card.artifactId)
        return artifact ? [{ card, artifact }] : []
      }),
    urls: (profile, server) => [...new Set(rows.filter((row) => row.profileUserId === profile && row.serverUrl === server).map((row) => row.url))]
  }
  return { repo, rows, cards }
}

function setup(overrides: Partial<ArtifactServiceDeps> & { answers?: Array<CinnaSendResult | Error> } = {}) {
  const calls: SendCall[] = []
  const events: Array<{ channel: string; payload: unknown }> = []
  const answers = [...(overrides.answers ?? [])]
  const memory = makeRepo()
  const deps: ArtifactServiceDeps = {
    profileId: () => 'profile-1',
    account: () => ({ serverUrl: SERVER, signedIn: true }),
    discover: async () => ({ artifacts: 1, instance_name: 'Acme' }),
    fetchJson: async (_profile, path) => {
      if (path.endsWith('/capabilities')) return { version: 1, limits: { max_revision_bytes: 1000, max_revision_files: 10, max_file_bytes: 500, user_quota_bytes: 10_000 } }
      return published({ links: [] })
    },
    send: async (_profile, path, opts) => {
      const call: SendCall = { path, method: opts.method, json: opts.json }
      if (opts.bytes) Object.assign(call, readMultipart(opts.bytes.data, opts.bytes.contentType))
      calls.push(call)
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next ?? { status: 200, ok: true, body: published() }
    },
    locateAgent: (agentId) => {
      if (agentId !== 'folder:analyst') throw new Error('no such agent')
      return agentDir
    },
    agentName: () => 'Analyst',
    realpath: async (path) => realpathSync(path),
    repo: memory.repo,
    publishEvent: (channel, payload) => events.push({ channel, payload }),
    latestMessageId: (chatId) => (chatId === 'chat-1' ? 'latest-1' : null),
    // No real timers: a retry waits until a test fires it.
    schedule: () => () => {},
    ...overrides
  }
  return { service: createArtifactService(deps), calls, events, deps, ...memory }
}

const ctxDeps = (ctx: { deps: ArtifactServiceDeps }): ArtifactServiceDeps => ctx.deps

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-publish-')))
  agentDir = join(root, 'analyst')
  outside = join(root, 'elsewhere')
  mkdirSync(join(agentDir, 'reports', 'q3'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(agentDir, 'reports', 'q3', 'index.html'), '<h1>Q3</h1>')
  writeFileSync(join(agentDir, 'reports', 'q3', 'data.csv'), 'a,b\n')
  writeFileSync(join(agentDir, 'reports', 'q3', '.env'), 'SECRET=1')
  writeFileSync(join(outside, 'leak.txt'), 'nope')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const q3 = (): string => join(agentDir, 'reports', 'q3')

describe('support', () => {
  it('needs a signed-in Cinna profile on an instance that advertises artifacts', async () => {
    expect((await setup({ account: () => null }).service.support()).supported).toBe(false)
    expect((await setup({ account: () => ({ serverUrl: SERVER, signedIn: false }) }).service.support()).supported).toBe(false)
    expect((await setup({ discover: async () => ({ instance_name: 'Old' }) }).service.support()).supported).toBe(false)
    expect((await setup({ discover: async () => { throw new Error('offline') } }).service.support()).supported).toBe(false)
    expect(await setup().service.support()).toEqual({
      supported: true,
      instanceName: 'Acme',
      limits: { maxRevisionBytes: 1000, maxRevisionFiles: 10, maxFileBytes: 500 },
      linkOrigins: [SERVER]
    })
  })

  it('link origins: the server, and every frontend origin core named in an artifact URL', async () => {
    const ctx = setup()
    expect((await ctx.service.support()).linkOrigins).toEqual([SERVER])
    // A publish answers with the page on core's frontend (another host than the API).
    expect(await ctx.service.publish({ agentId: 'folder:analyst', path: q3(), title: 'Q3', visibility: 'private' })).toMatchObject({ ok: true })
    expect((await ctx.service.support()).linkOrigins).toEqual([SERVER, 'http://localhost:5173'])
    // Remembered rows survive a restart: a fresh service derives the origin from them.
    const restarted = createArtifactService({ ...ctxDeps(ctx), repo: ctx.repo })
    expect((await restarted.support()).linkOrigins).toEqual([SERVER, 'http://localhost:5173'])
    // An artifact read but not owned (no row) is learned for the session.
    const viewer = setup({ fetchJson: async (_p, path) => (path.endsWith('capabilities') ? {} : published({ is_owner: false, url: `https://web.example/artifact/${ID}` })) })
    expect(await viewer.service.detail(ID)).toMatchObject({ ok: true })
    expect((await viewer.service.support()).linkOrigins).toEqual([SERVER, 'https://web.example'])
  })

  it('falls back to core’s default limits when capabilities cannot be read', async () => {
    const { service } = setup({ fetchJson: async () => { throw new CinnaApiError('request_failed', 'down') } })
    expect((await service.support()).limits).toEqual({ maxRevisionBytes: 50 * 1024 * 1024, maxRevisionFiles: 2000, maxFileBytes: 25 * 1024 * 1024 })
  })

  it('every verb refuses as data when unsupported', async () => {
    const { service, calls } = setup({ discover: async () => ({}) })
    expect(await service.inspect({ agentId: 'folder:analyst', path: q3() })).toMatchObject({ ok: false, code: 'not_supported' })
    expect(await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'private' })).toMatchObject({ ok: false, code: 'not_supported' })
    expect(await service.detail(ID)).toMatchObject({ ok: false, code: 'not_supported' })
    expect(calls).toEqual([])
  })
})

/** Timers a test fires by hand: `delays` is every delay asked for, in order. */
function manualClock() {
  const live: Array<{ run: () => void; cancelled: boolean }> = []
  const delays: number[] = []
  return {
    delays,
    schedule: (run: () => void, ms: number) => {
      const timer = { run, cancelled: false }
      live.push(timer)
      delays.push(ms)
      return () => {
        timer.cancelled = true
      }
    },
    pending: () => live.filter((timer) => !timer.cancelled).length,
    /** Run the oldest live timer, then let the work it started settle. */
    async fire() {
      const timer = live.find((t) => !t.cancelled)
      if (!timer) throw new Error('no timer pending')
      live.splice(live.indexOf(timer), 1)
      timer.run()
      await settleWork()
    }
  }
}

const settleWork = () => new Promise((resolve) => setTimeout(resolve, 0))

function supportMemory(initial: Record<string, { instanceName?: string; limits: { maxRevisionBytes: number; maxRevisionFiles: number; maxFileBytes: number } }> = {}) {
  const rows = new Map(Object.entries(initial))
  return {
    rows,
    memory: {
      get: (profile: string, server: string) => rows.get(`${profile}\n${server}`) ?? null,
      set: (profile: string, server: string, value: { instanceName?: string; limits: { maxRevisionBytes: number; maxRevisionFiles: number; maxFileBytes: number } }) => {
        rows.set(`${profile}\n${server}`, value)
      },
      forget: (profile: string, server: string) => {
        rows.delete(`${profile}\n${server}`)
      }
    }
  }
}

const KEPT = { instanceName: 'Acme', limits: { maxRevisionBytes: 1000, maxRevisionFiles: 10, maxFileBytes: 500 } }
const supportEvents = (events: Array<{ channel: string; payload: unknown }>) =>
  events.filter((event) => event.channel === 'artifacts:support-changed').map((event) => event.payload as { profileId: string; support: { supported: boolean; instanceName?: string } })

describe('support across outages and launches', () => {
  it('retries an unreachable core with backoff and pushes supported when it answers, with no caller asking again', async () => {
    const clock = manualClock()
    const store = supportMemory()
    let failures = 2
    const ctx = setup({
      schedule: clock.schedule,
      supportMemory: store.memory,
      discover: async () => {
        if (failures-- > 0) throw new Error('ECONNREFUSED')
        return { artifacts: 1, instance_name: 'Acme' }
      }
    })
    expect((await ctx.service.support()).supported).toBe(false)
    expect(clock.delays).toEqual([1000])
    await clock.fire()
    expect(clock.delays).toEqual([1000, 2000])
    expect(supportEvents(ctx.events)).toEqual([])
    await clock.fire()
    expect(supportEvents(ctx.events)).toEqual([{ profileId: 'profile-1', support: expect.objectContaining({ supported: true, instanceName: 'Acme' }) }])
    expect(clock.pending()).toBe(0)
    expect(store.rows.get(`profile-1\n${SERVER}`)).toEqual(KEPT)
    expect(ctx.service.supportedNow().supported).toBe(true)
  })

  it('caps the backoff at 30 seconds and keeps going while core stays unreachable', async () => {
    const clock = manualClock()
    const ctx = setup({ schedule: clock.schedule, discover: async () => { throw new Error('ECONNREFUSED') } })
    await ctx.service.support()
    for (let i = 0; i < 6; i++) await clock.fire()
    expect(clock.delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    expect(clock.pending()).toBe(1)
    // A caller asking meanwhile does not restart the backoff or stack a second timer.
    await ctx.service.support()
    expect(clock.pending()).toBe(1)
    expect(clock.delays).toHaveLength(7)
  })

  it('does not retry a definite "no artifacts", and forgets the kept answer', async () => {
    const clock = manualClock()
    const store = supportMemory({ [`profile-1\n${SERVER}`]: KEPT })
    const ctx = setup({ schedule: clock.schedule, supportMemory: store.memory, discover: async () => ({ instance_name: 'Acme' }) })
    // Kept from the last launch: offered at once…
    expect((await ctx.service.support()).supported).toBe(true)
    await settleWork()
    // …and the background read finds core dropped artifacts: pushed, forgotten, not retried.
    expect(supportEvents(ctx.events)).toEqual([{ profileId: 'profile-1', support: expect.objectContaining({ supported: false }) }])
    expect(store.rows.size).toBe(0)
    expect(clock.pending()).toBe(0)
    expect(ctx.service.supportedNow().supported).toBe(false)
    expect((await ctx.service.support()).supported).toBe(false)
    expect(clock.pending()).toBe(0)
  })

  it('a fresh service answers from the kept answer at once — supportedNow too — and revalidates in the background', async () => {
    const store = supportMemory({ [`profile-1\n${SERVER}`]: KEPT })
    let release!: () => void
    const discoveryHeld = new Promise<void>((resolve) => (release = resolve))
    let discoveries = 0
    const ctx = setup({
      supportMemory: store.memory,
      discover: async () => {
        discoveries++
        await discoveryHeld
        return { artifacts: 1, instance_name: 'Acme 2' }
      }
    })
    // Right from startup, before anything asked core: the agent tool's offer and the skill gate.
    expect(ctx.service.supportedNow()).toMatchObject({ supported: true, instanceName: 'Acme' })
    // Returned while discovery is still held: no wait on core.
    expect(await ctx.service.support()).toEqual({ supported: true, instanceName: 'Acme', limits: KEPT.limits, linkOrigins: [SERVER] })
    expect(discoveries).toBe(1)
    release()
    await settleWork()
    expect(supportEvents(ctx.events)).toEqual([{ profileId: 'profile-1', support: expect.objectContaining({ supported: true, instanceName: 'Acme 2' }) }])
    expect(store.rows.get(`profile-1\n${SERVER}`)).toEqual({ ...KEPT, instanceName: 'Acme 2' })
  })

  it('pushes a link origin learned since the last answer, even while core is unreachable', async () => {
    const clock = manualClock()
    const store = supportMemory({ [`profile-1\n${SERVER}`]: KEPT })
    const ctx = setup({ schedule: clock.schedule, supportMemory: store.memory, discover: async () => { throw new Error('ECONNREFUSED') } })
    await ctx.service.support()
    await settleWork()
    expect(supportEvents(ctx.events)).toEqual([])
    ctx.rows.push({ ...ctx.rows[0], id: 'row-x', profileUserId: 'profile-1', serverUrl: SERVER, artifactId: 'x', url: 'https://app.acme.test/artifact/x' } as PublishedArtifactRow)
    await clock.fire()
    expect(supportEvents(ctx.events)).toEqual([{ profileId: 'profile-1', support: expect.objectContaining({ supported: true, linkOrigins: [SERVER, 'https://app.acme.test'] }) }])
  })

  it('keeps a kept "supported" through an unreachable core instead of flapping, and retries', async () => {
    const clock = manualClock()
    const store = supportMemory({ [`profile-1\n${SERVER}`]: KEPT })
    const ctx = setup({ schedule: clock.schedule, supportMemory: store.memory, discover: async () => { throw new Error('ECONNREFUSED') } })
    expect((await ctx.service.support()).supported).toBe(true)
    await settleWork()
    expect(clock.pending()).toBe(1)
    await clock.fire()
    expect(supportEvents(ctx.events)).toEqual([])
    expect(ctx.service.supportedNow().supported).toBe(true)
    expect(store.rows.size).toBe(1)
    // A verb still finds the account (and fails on the network, not as unsupported).
    expect(await ctx.service.inspect({ agentId: 'folder:analyst', path: q3() })).toMatchObject({ ok: true })
  })

  it('a kept answer is for its server and a signed-in profile only', async () => {
    const store = supportMemory({ [`profile-1\nhttps://other.example`]: KEPT })
    const signedOut = setup({ supportMemory: supportMemory({ [`profile-1\n${SERVER}`]: KEPT }).memory, account: () => ({ serverUrl: SERVER, signedIn: false }) })
    expect(signedOut.service.supportedNow().supported).toBe(false)
    expect((await signedOut.service.support()).supported).toBe(false)
    const elsewhere = setup({ supportMemory: store.memory, discover: async () => { throw new Error('offline') } })
    expect(elsewhere.service.supportedNow().supported).toBe(false)
    expect((await elsewhere.service.support()).supported).toBe(false)
  })

  it('a change of active profile ends the retry', async () => {
    const clock = manualClock()
    const active = { profile: 'profile-1' }
    let discoveries = 0
    const ctx = setup({
      schedule: clock.schedule,
      profileId: () => active.profile,
      account: (profile) => (profile === 'profile-1' ? { serverUrl: SERVER, signedIn: true } : null),
      discover: async () => {
        discoveries++
        throw new Error('ECONNREFUSED')
      }
    })
    await ctx.service.support()
    expect(clock.pending()).toBe(1)
    active.profile = 'profile-2'
    // A timer that fires after the switch asks nothing and schedules nothing.
    await clock.fire()
    expect(discoveries).toBe(1)
    expect(clock.pending()).toBe(0)
    // And the new profile's first question cancels a pending one at once.
    active.profile = 'profile-1'
    await ctx.service.support()
    expect(clock.pending()).toBe(1)
    active.profile = 'profile-2'
    await ctx.service.support()
    expect(clock.pending()).toBe(0)
  })
})

describe('path confinement', () => {
  it('refuses a path outside the agent’s folder, and a symlink inside that points out', async () => {
    symlinkSync(join(outside, 'leak.txt'), join(agentDir, 'leak-link.txt'))
    const { service, calls } = setup()
    expect(await service.inspect({ agentId: 'folder:analyst', path: join(outside, 'leak.txt') })).toMatchObject({ ok: false, code: 'path_refused' })
    expect(await service.inspect({ agentId: 'folder:analyst', path: join(agentDir, 'leak-link.txt') })).toMatchObject({ ok: false, code: 'path_refused' })
    expect(await service.inspect({ agentId: 'folder:analyst', path: join(agentDir, '..', 'elsewhere') })).toMatchObject({ ok: false, code: 'path_refused' })
    expect(await service.publish({ agentId: 'folder:analyst', path: outside, title: 'x', visibility: 'private' })).toMatchObject({ ok: false, code: 'path_refused' })
    expect(calls).toEqual([])
  })

  it('refuses a malformed request, an unknown agent and a missing path', async () => {
    const { service } = setup()
    expect(await service.inspect(null)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await service.inspect({ agentId: 'folder:analyst', path: 7 })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await service.inspect({ agentId: 'folder:gone', path: q3() })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await service.inspect({ agentId: 'folder:analyst', path: join(agentDir, 'nope') })).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('refuses a path under (or naming) anything A10 never publishes, saying why — the dialog and the agent alike', async () => {
    const cases: Array<[string, RegExp]> = [
      ['credentials/token.json', /^credentials\/ is never published \(credentials\)/],
      ['credentials', /^credentials\/ is never published/],
      ['.claude/settings.local.json', /^\.claude\/ is never published \(agent settings\)/],
      ['app-data/db', /^app-data\/ is never published \(app data\)/],
      ['.git/config', /^\.git\/ is never published \(git data\)/],
      ['node_modules/lib/index.js', /^node_modules\/ is never published \(dependencies\)/],
      ['.env.local/x.txt', /^\.env\.local\/ is never published \(secret file\)/],
      ['reports/.env', /^\.env is never published \(secret file\)/],
      ['reports/server.pem', /^server\.pem is never published \(secret file\)/],
      ['reports/id.key', /^id\.key is never published \(secret file\)/],
      ['reports/.DS_Store', /^\.DS_Store is never published \(system file\)/],
      ['reports/deep/credentials/inner/a.md', /^credentials\/ is never published/],
      ['.cache/report.md', /^\.cache\/ is never published \(hidden file\)/],
      ['reports/.notes.md', /^\.notes\.md is never published \(hidden file\)/]
    ]
    for (const [rel] of cases) {
      const abs = join(agentDir, rel)
      const isDirectoryCase = rel === 'credentials'
      mkdirSync(isDirectoryCase ? abs : join(abs, '..'), { recursive: true })
      if (!isDirectoryCase) writeFileSync(abs, 'x')
    }
    const { service, calls } = setup()
    for (const [rel, message] of cases) {
      expect(await service.inspect({ agentId: 'folder:analyst', path: rel }), rel).toMatchObject({ ok: false, code: 'path_refused', message: expect.stringMatching(message) })
      expect(await service.inspect({ agentId: 'folder:analyst', path: join(agentDir, rel) }), rel).toMatchObject({ ok: false, code: 'path_refused' })
      expect(await service.publish({ agentId: 'folder:analyst', path: join(agentDir, rel), title: 'x', visibility: 'private' }), rel).toMatchObject({ ok: false, code: 'path_refused' })
    }
    expect(calls).toEqual([])
    // A name that is only excluded as a folder is fine as a file, and the folder itself still publishes.
    writeFileSync(join(agentDir, 'reports', 'credentials'), 'x')
    expect(await service.inspect({ agentId: 'folder:analyst', path: 'reports/credentials' })).toMatchObject({ ok: true })
    expect(await service.inspect({ agentId: 'folder:analyst', path: agentDir })).toMatchObject({ ok: true })
  })

  it('resolves a path relative to the agent’s folder (the agent tool’s way)', async () => {
    const result = await setup().service.inspect({ agentId: 'folder:analyst', path: 'reports/q3' })
    expect(result).toMatchObject({ ok: true, inspection: { relativePath: 'reports/q3', name: 'q3', isFolder: true } })
  })
})

describe('inspect', () => {
  it('describes the files, the exclusions, the limits and what it was published as before', async () => {
    const { service, repo } = setup()
    const first = await service.inspect({ agentId: 'folder:analyst', path: q3() })
    expect(first).toMatchObject({
      ok: true,
      inspection: {
        kind: 'site',
        entry: 'index.html',
        files: [{ path: 'data.csv', size: 4 }, { path: 'index.html', size: 11 }],
        excluded: [{ path: '.env', reason: 'secret file' }],
        size: 15,
        overLimits: null,
        instanceName: 'Acme',
        previous: null
      }
    })
    repo.recordPublish('profile-1', SERVER, { sourcePath: q3(), agentId: 'folder:analyst' }, {
      artifactId: ID, title: 'Q3 churn', kind: 'site', revision: 3, visibility: 'instance', url: 'u', liveLinkCount: 0
    })
    const again = await service.inspect({ agentId: 'folder:analyst', path: q3() })
    expect(again).toMatchObject({ ok: true, inspection: { previous: { artifactId: ID, title: 'Q3 churn', revision: 3, visibility: 'instance' } } })
  })
})

describe('publish', () => {
  it('uploads a zip of exactly the kept files with core’s field names, and remembers it', async () => {
    const { service, calls, rows, cards, events } = setup()
    const result = await service.publish({
      agentId: 'folder:analyst', path: q3(), title: '  Q3 churn ', description: 'Churn by plan',
      visibility: 'private', operationId: 'op-1', anchor: { chatId: 'chat-1', messageId: 'msg-1' }
    })
    expect(result).toEqual({
      ok: true,
      artifact: { id: ID, title: 'Q3 churn', kind: 'site', revision: 1, visibility: 'private', liveLinkCount: 0, url: `http://localhost:5173/artifact/${ID}` },
      excluded: [],
      sent: { fileCount: 2, sizeBytes: 15, excluded: ['.env'] },
      sourcePath: q3()
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      path: '/api/v1/artifacts',
      method: 'POST',
      fields: { title: 'Q3 churn', description: 'Churn by plan', entry_path: 'index.html', source_kind: 'desktop', source_label: 'Analyst · reports/q3' },
      archive: { filename: 'q3.zip', names: ['data.csv', 'index.html'] }
    })
    expect(rows).toMatchObject([{ sourcePath: q3(), agentId: 'folder:analyst', artifactId: ID, revision: 1, visibility: 'private' }])
    expect(cards).toEqual([{ id: 'card-0', chatId: 'chat-1', messageId: 'msg-1', artifactId: ID }])
    expect(events.filter((event) => event.channel !== 'artifacts:support-changed')).toEqual([
      { channel: 'artifacts:progress', payload: { operationId: 'op-1', phase: 'packing' } },
      { channel: 'artifacts:progress', payload: { operationId: 'op-1', phase: 'uploading' } },
      { channel: 'artifacts:changed', payload: { artifactId: ID } }
    ])
  })

  it('updates an existing artifact as a new revision, without the create-only fields', async () => {
    const { service, calls, rows } = setup({ answers: [{ status: 200, ok: true, body: published({ revision_number: 2, current_revision_number: 2 }) }] })
    const result = await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'Q3 churn', visibility: 'private', artifactId: ID })
    expect(result).toMatchObject({ ok: true, artifact: { revision: 2 } })
    expect(calls[0].path).toBe(`/api/v1/artifacts/${ID}/revisions`)
    expect(calls[0].fields).toEqual({ title: 'Q3 churn', entry_path: 'index.html' })
    expect(rows[0].revision).toBe(2)
  })

  it('sends the chosen start page of a folder without index.html', async () => {
    writeFileSync(join(agentDir, 'reports', 'q3', 'index.html'), '')
    rmSync(join(agentDir, 'reports', 'q3', 'index.html'))
    writeFileSync(join(agentDir, 'reports', 'q3', 'dashboard.html'), '<p>d</p>')
    writeFileSync(join(agentDir, 'reports', 'q3', 'other.html'), '<p>o</p>')
    const { service, calls } = setup()
    expect(await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'private', entry: 'dashboard.html' })).toMatchObject({ ok: true })
    expect(calls[0].fields?.entry_path).toBe('dashboard.html')
    // A start page no longer there is refused before anything is sent.
    expect(await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'private', entry: 'gone.html' })).toMatchObject({ ok: false, code: 'rejected' })
    expect(calls).toHaveLength(1)
  })

  it('Everyone on the instance: patches the visibility after the upload', async () => {
    const { service, calls, rows, events } = setup({
      answers: [{ status: 200, ok: true, body: published() }, { status: 200, ok: true, body: published({ visibility: 'instance' }) }]
    })
    const result = await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'instance', operationId: 'op' })
    expect(result).toMatchObject({ ok: true, artifact: { visibility: 'instance' } })
    expect(calls[1]).toMatchObject({ path: `/api/v1/artifacts/${ID}`, method: 'PATCH', json: { visibility: 'instance' } })
    expect(rows[0].visibility).toBe('instance')
    expect(events.filter((event) => event.channel !== 'artifacts:support-changed').map((event) => (event.payload as { phase?: string }).phase)).toEqual(['packing', 'uploading', 'sharing', undefined])
  })

  it('Anyone with a link: creates a link and returns its URL once, never stored', async () => {
    const { service, calls, rows } = setup({
      answers: [{ status: 200, ok: true, body: published() }, { status: 200, ok: true, body: { id: LINK_ID, token: 'tok', url: 'http://localhost:5173/s/tok', token_prefix: 'tok' } }]
    })
    const result = await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'link' })
    expect(result).toMatchObject({ ok: true, link: { url: 'http://localhost:5173/s/tok' }, artifact: { liveLinkCount: 1, visibility: 'private' } })
    expect(calls[1]).toMatchObject({ path: `/api/v1/artifacts/${ID}/links`, method: 'POST', json: {} })
    expect(JSON.stringify(rows)).not.toContain('/s/tok')
    expect(rows[0].liveLinkCount).toBe(1)
  })

  it('a failed follow-up keeps the publish and says so once', async () => {
    const { service } = setup({ answers: [{ status: 200, ok: true, body: published() }, { status: 500, ok: false, body: { detail: 'boom' } }] })
    const result = await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'instance' })
    expect(result).toMatchObject({ ok: true, artifact: { visibility: 'private' } })
    expect(result.ok && result.warning).toMatch(/still visible only to you/)
  })

  it('returns every refusal as data', async () => {
    const run = async (answer: CinnaSendResult | Error, artifactId?: string) =>
      setup({ answers: [answer] }).service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'private', artifactId })
    expect(await run({ status: 413, ok: false, body: { detail: 'Over your quota' } })).toEqual({ ok: false, code: 'too_large', message: 'Over your quota. Nothing was published.' })
    expect(await run({ status: 400, ok: false, body: { detail: 'Duplicate path a.txt' } })).toEqual({ ok: false, code: 'rejected', message: 'Duplicate path a.txt' })
    expect(await run({ status: 404, ok: false, body: { detail: 'Not found' } }, ID)).toMatchObject({ ok: false, code: 'gone' })
    expect(await run({ status: 403, ok: false, body: { detail: 'Not yours' } }, ID)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await run({ status: 502, ok: false, body: null })).toMatchObject({ ok: false, code: 'request_failed' })
    expect(await run(new CinnaApiError('reauth_required', 'Cinna 401', '401', 401))).toMatchObject({ ok: false, code: 'reauth_required' })
    expect(await run(new CinnaApiError('request_failed', 'socket hang up'))).toMatchObject({ ok: false, code: 'request_failed' })
  })

  it('forgets an artifact that is gone, so Update is no longer offered', async () => {
    const { service, repo, rows } = setup({ answers: [{ status: 404, ok: false, body: { detail: 'Not found' } }] })
    repo.recordPublish('profile-1', SERVER, { sourcePath: q3(), agentId: 'folder:analyst' }, {
      artifactId: ID, title: 'x', kind: 'site', revision: 1, visibility: 'private', url: 'u', liveLinkCount: 0
    })
    expect(await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'private', artifactId: ID })).toMatchObject({ code: 'gone' })
    expect(rows).toEqual([])
  })

  it('refuses before sending: nothing kept, over the limits, a bad title or visibility', async () => {
    mkdirSync(join(agentDir, 'secrets'))
    writeFileSync(join(agentDir, 'secrets', '.env'), 'A=1')
    mkdirSync(join(agentDir, 'big'))
    for (let i = 0; i < 12; i++) writeFileSync(join(agentDir, 'big', `f${i}.txt`), 'x')
    const { service, calls } = setup()
    expect(await service.publish({ agentId: 'folder:analyst', path: join(agentDir, 'secrets'), title: 'x', visibility: 'private' })).toMatchObject({ ok: false, code: 'empty' })
    const over = await service.publish({ agentId: 'folder:analyst', path: join(agentDir, 'big'), title: 'x', visibility: 'private' })
    expect(over).toMatchObject({ ok: false, code: 'over_limits' })
    expect(over.ok === false && over.message).toMatch(/more than 10 files/)
    expect(await service.publish({ agentId: 'folder:analyst', path: q3(), title: '   ', visibility: 'private' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'public' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'private', artifactId: '../x' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(calls).toEqual([])
  })
})

describe('share', () => {
  it('detail reads core and keeps the local row in sync', async () => {
    const { service, repo, rows } = setup({
      fetchJson: async () => published({ visibility: 'instance', live_link_count: 1, links: [
        { id: LINK_ID, token_prefix: 'ab12', label: null, created_at: '2026-10-16T10:00:00Z', expires_at: null, revoked_at: null, needs_code: false, expired: false, blocked: false },
        { id: 'old', token_prefix: 'zz99', created_at: '2026-10-01T10:00:00Z', revoked_at: '2026-10-02T10:00:00Z' }
      ] })
    })
    repo.recordPublish('profile-1', SERVER, { sourcePath: q3(), agentId: 'folder:analyst' }, {
      artifactId: ID, title: 'x', kind: 'site', revision: 1, visibility: 'private', url: 'u', liveLinkCount: 0
    })
    const result = await service.detail(ID)
    expect(result).toMatchObject({ ok: true, detail: { isOwner: true, visibility: 'instance', links: [{ id: LINK_ID, live: true, tokenPrefix: 'ab12' }, { id: 'old', live: false }] } })
    expect(rows[0]).toMatchObject({ visibility: 'instance', liveLinkCount: 1, title: 'Q3 churn' })
    expect(await service.detail('not-a-uuid')).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('reads under the profile it is told (an agent’s session); a 404 forgets only that profile’s row', async () => {
    const reads: string[] = []
    const ctx = setup({
      fetchJson: async (profile, path) => {
        reads.push(profile)
        if (path.endsWith('capabilities')) return {}
        throw new CinnaApiError('request_failed', 'Cinna API 404: Not found', 'Not found', 404)
      }
    })
    const state = { artifactId: ID, title: 'Q3', kind: 'site' as const, revision: 1, visibility: 'private' as const, url: '', liveLinkCount: 0 }
    ctx.repo.recordPublish('profile-1', SERVER, { sourcePath: q3(), agentId: 'folder:analyst' }, state)
    ctx.repo.recordPublish('session-profile', SERVER, { sourcePath: q3(), agentId: 'folder:analyst' }, state)
    expect(await ctx.service.detail(ID, { profileUserId: 'session-profile' })).toMatchObject({ ok: false, code: 'gone' })
    expect(reads.filter((profile) => profile !== 'session-profile')).toEqual([])
    expect(ctx.rows.map((row) => row.profileUserId)).toEqual(['profile-1'])
  })

  it('a 404 or 403 on detail is data', async () => {
    const gone = setup({ fetchJson: async (_p, path) => { if (path.endsWith('capabilities')) return {}; throw new CinnaApiError('request_failed', 'Cinna API 404: Not found', 'Not found', 404) } })
    expect(await gone.service.detail(ID)).toMatchObject({ ok: false, code: 'gone' })
    const forbidden = setup({ fetchJson: async (_p, path) => { if (path.endsWith('capabilities')) return {}; throw new CinnaApiError('reauth_required', 'Cinna 403', '403', 403) } })
    expect(await forbidden.service.detail(ID)).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('setVisibility, createLink and revokeLink call core and announce the change', async () => {
    const { service, calls, events } = setup({
      answers: [
        { status: 200, ok: true, body: published({ visibility: 'instance' }) },
        { status: 200, ok: true, body: { id: LINK_ID, token: 'tok', url: 'http://localhost:5173/s/tok', code: '1234' } },
        { status: 200, ok: true, body: { message: 'ok' } }
      ]
    })
    expect(await service.setVisibility(ID, 'instance')).toMatchObject({ ok: true })
    expect(await service.createLink(ID, { withCode: true })).toMatchObject({ ok: true, link: { url: 'http://localhost:5173/s/tok', code: '1234' } })
    expect(await service.revokeLink(ID, LINK_ID)).toMatchObject({ ok: true })
    expect(calls.map((call) => [call.method, call.path, call.json])).toEqual([
      ['PATCH', `/api/v1/artifacts/${ID}`, { visibility: 'instance' }],
      ['POST', `/api/v1/artifacts/${ID}/links`, { with_code: true }],
      ['DELETE', `/api/v1/artifacts/${ID}/links/${LINK_ID}`, undefined]
    ])
    expect(events.filter((event) => event.channel === 'artifacts:changed')).toHaveLength(3)
    expect(await service.setVisibility(ID, 'public')).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await service.revokeLink(ID, '../../x')).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('cards come from the local memory of the active profile and server', async () => {
    const { service } = setup()
    await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'private', anchor: { chatId: 'chat-1', messageId: 'm1' } })
    expect(service.cards('chat-1')).toEqual([
      { id: 'card-0', chatId: 'chat-1', messageId: 'm1', artifact: expect.objectContaining({ id: ID, revision: 1 }) }
    ])
    expect(service.cards('other')).toEqual([])
    // No message named (the file preview opened from elsewhere): after the chat's newest.
    await service.publish({ agentId: 'folder:analyst', path: q3(), title: 'x', visibility: 'private', anchor: { chatId: 'chat-1', messageId: null } })
    expect(service.cards('chat-1').map((card) => card.messageId)).toEqual(['m1', 'latest-1'])
    expect(service.cards(5)).toEqual([])
  })
})

describe('view', () => {
  const VIEW = {
    content_base: 'https://content.example/a/v/cap123/',
    entry: 'index.html',
    files: [
      { path: 'index.html', size: 12, sha256: 'x', mime: 'text/html' },
      { path: 'css/site.css', size: 3, sha256: 'y', mime: 'text/css' },
      { path: '../escape.txt', size: 1, sha256: 'z', mime: 'text/plain' }
    ],
    revision_number: 4,
    expires_at: '2026-10-17T12:00:00Z',
    download_url: 'https://content.example/a/z/cap123'
  }

  it('mints a view capability on core and returns its base, entry and files', async () => {
    const { service, calls, events } = setup({ answers: [{ status: 200, ok: true, body: VIEW }] })
    expect(await service.view(ID.toUpperCase())).toEqual({
      ok: true,
      view: {
        contentBase: 'https://content.example/a/v/cap123/',
        entry: 'index.html',
        files: [
          { path: 'index.html', size: 12, mime: 'text/html' },
          { path: 'css/site.css', size: 3, mime: 'text/css' }
        ],
        revision: 4,
        expiresAt: '2026-10-17T12:00:00Z'
      }
    })
    expect(calls.map((call) => [call.method, call.path])).toEqual([['POST', `/api/v1/artifacts/${ID}/view`]])
    // Reading is not a change: no card reads again.
    expect(events.filter((event) => event.channel !== 'artifacts:support-changed')).toEqual([])
  })

  it('a deleted (or unviewable) artifact is gone, as data', async () => {
    const { service } = setup({ answers: [{ status: 404, ok: false, body: { detail: 'Not found' } }] })
    expect(await service.view(ID)).toMatchObject({ ok: false, code: 'gone' })
  })

  it('refusals and malformed answers are data, never thrown', async () => {
    const forbidden = setup({ answers: [{ status: 403, ok: false, body: { detail: 'No.' } }] })
    expect(await forbidden.service.view(ID)).toMatchObject({ ok: false, code: 'forbidden', message: 'No.' })
    const thrown = setup({ answers: [new CinnaApiError('request_failed', 'down', 'down', 502)] })
    expect(await thrown.service.view(ID)).toMatchObject({ ok: false, code: 'request_failed' })
    const odd = setup({ answers: [{ status: 200, ok: true, body: { ...VIEW, content_base: 'file:///etc/' } }] })
    expect(await odd.service.view(ID)).toMatchObject({ ok: false, code: 'request_failed' })
    const unsupported = setup({ discover: async () => ({}) })
    expect(await unsupported.service.view(ID)).toMatchObject({ ok: false, code: 'not_supported' })
    expect(await setup().service.view('../x')).toMatchObject({ ok: false, code: 'invalid_input' })
  })
})
