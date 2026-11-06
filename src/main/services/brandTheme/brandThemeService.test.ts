import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'
import type { BrandThemeChangedPayload } from '../../../shared/brandTheme/roles'

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
const { createBrandThemeService } = await import('./brandThemeService')
const { brandThemeRepo } = await import('../../db/brandThemes')

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../shared/brandTheme/fixtures')

/** A fixture as a fake core holds it: the served document, and its bytes by sha256. */
function fixture(kind: 'valid' | 'invalid', name: string): { doc: Record<string, unknown>; assets: Map<string, Buffer> } {
  const dir = join(fixtures, kind, name)
  const assets = new Map<string, Buffer>()
  if (existsSync(join(dir, 'assets'))) {
    for (const file of readdirSync(join(dir, 'assets'))) {
      const bytes = readFileSync(join(dir, 'assets', file))
      assets.set(createHash('sha256').update(bytes).digest('hex'), bytes)
    }
  }
  if (existsSync(join(dir, 'served', 'assets'))) {
    for (const sha of readdirSync(join(dir, 'served', 'assets'))) assets.set(sha, readFileSync(join(dir, 'served', 'assets', sha)))
  }
  const doc = JSON.parse(readFileSync(join(dir, 'served', 'served.json'), 'utf8')) as Record<string, unknown>
  return { doc, assets }
}

const withRevision = (doc: Record<string, unknown>, revision: number): Record<string, unknown> => ({ ...doc, revision })

type Reply = { status: number; doc?: unknown; text?: string } | 'network-error'

/** A fake core: answers the theme endpoint with `reply`, serves asset bytes, honours If-None-Match. */
function fakeCore(assets: Map<string, Buffer>) {
  const state = {
    reply: { status: 204 } as Reply,
    calls: [] as Array<{ url: string; ifNoneMatch?: string }>,
    /** Held theme responses, released by the test. */
    gate: null as Promise<void> | null
  }
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>
    state.calls.push({ url, ifNoneMatch: headers['If-None-Match'] })
    const asset = /\/api\/v1\/brand-theme\/assets\/([0-9a-f]{64})$/.exec(url)
    if (asset) {
      const bytes = assets.get(asset[1])
      return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response(null, { status: 404 })
    }
    if (state.gate) await state.gate
    const reply = state.reply
    if (reply === 'network-error') throw new TypeError('fetch failed')
    if (reply.status === 200) {
      const doc = reply.doc as { revision?: number }
      const etag = `"${doc.revision}"`
      if (headers['If-None-Match'] === etag) return new Response(null, { status: 304 })
      return new Response(reply.text ?? JSON.stringify(reply.doc), { status: 200, headers: { ETag: etag } })
    }
    return new Response(null, { status: reply.status })
  }
  return { state, fetch }
}

const SERVERS: Record<string, { origin: string; base: string } | null> = {
  'acme-1': { origin: 'https://acme.example', base: 'https://acme.example' },
  'acme-2': { origin: 'https://acme.example', base: 'https://acme.example' },
  'other': { origin: 'https://other.example', base: 'https://other.example' },
  'local': null
}

function setup(assets: Map<string, Buffer>, startup = 'local') {
  const core = fakeCore(assets)
  const emitted: BrandThemeChangedPayload[] = []
  // Like getProfileScopeUserId(): the guest until an activation sets a profile.
  let active = 'local'
  const service = createBrandThemeService({
    startupProfileId: () => startup,
    activeProfileId: () => active,
    serverOf: (id) => SERVERS[id] ?? null,
    fetch: core.fetch,
    publish: (payload) => emitted.push(payload),
    intervalMs: 60_000
  })
  const activate = (id: string): void => {
    active = id
    service.applyForProfile(id)
  }
  return { core, emitted, service, activate }
}

beforeEach(() => {
  holder.current = createTestDatabase()
})
afterEach(() => {
  holder.current?.close()
})

describe('brandThemeService against a fake core', () => {
  const full = fixture('valid', 'full')

  it('200: fetches, checks, caches theme and assets, emits, and get() resolves data URLs', async () => {
    const { core, emitted, service, activate } = setup(full.assets)
    activate('acme-1')
    expect(emitted).toEqual([null])
    core.state.reply = { status: 200, doc: full.doc }
    await service.refresh('acme-1')
    expect(emitted).toEqual([null, { origin: 'https://acme.example', revision: 1 }])
    expect(core.state.calls[0]).toEqual({ url: 'https://acme.example/api/v1/brand-theme', ifNoneMatch: undefined })
    // Four distinct assets, fetched by sha on the same server.
    expect(core.state.calls.filter((c) => c.url.includes('/assets/'))).toHaveLength(4)
    const theme = service.get()
    expect(theme?.origin).toBe('https://acme.example')
    expect(theme?.modes.light.accent).toBe('#2e88b8')
    expect(theme?.background.dark).toMatch(/^data:image\/webp;base64,/)
    expect(brandThemeRepo.get('https://acme.example')?.etag).toBe('"1"')
  })

  it('304: sends the stored ETag and changes nothing', async () => {
    const { core, emitted, service, activate } = setup(full.assets)
    activate('acme-1')
    core.state.reply = { status: 200, doc: full.doc }
    await service.refresh('acme-1')
    emitted.length = 0
    core.state.calls.length = 0
    await service.refresh('acme-1')
    expect(core.state.calls).toEqual([{ url: 'https://acme.example/api/v1/brand-theme', ifNoneMatch: '"1"' }])
    expect(emitted).toEqual([])
    expect(service.get()?.revision).toBe(1)
  })

  it('a new revision re-uses stored assets and emits the new revision', async () => {
    const { core, emitted, service, activate } = setup(full.assets)
    activate('acme-1')
    core.state.reply = { status: 200, doc: full.doc }
    await service.refresh('acme-1')
    core.state.calls.length = 0
    core.state.reply = { status: 200, doc: withRevision(full.doc, 2) }
    await service.refresh('acme-1')
    expect(core.state.calls.filter((c) => c.url.includes('/assets/'))).toEqual([])
    expect(emitted.at(-1)).toEqual({ origin: 'https://acme.example', revision: 2 })
    expect(service.get()?.revision).toBe(2)
  })

  it.each([204, 404])('%i: forgets the theme and its assets, and emits null', async (status) => {
    const { core, emitted, service, activate } = setup(full.assets)
    activate('acme-1')
    core.state.reply = { status: 200, doc: full.doc }
    await service.refresh('acme-1')
    core.state.reply = { status }
    await service.refresh('acme-1')
    expect(emitted.at(-1)).toBeNull()
    expect(service.get()).toBeNull()
    expect(brandThemeRepo.get('https://acme.example')).toBeNull()
    expect(holder.current!.sqlite.prepare('SELECT COUNT(*) AS n FROM brand_theme_assets').get()).toEqual({ n: 0 })
  })

  it.each([500, 503, 429, 'network-error'] as const)('%s: keeps the cached theme and emits nothing', async (failure) => {
    const { core, emitted, service, activate } = setup(full.assets)
    activate('acme-1')
    core.state.reply = { status: 200, doc: full.doc }
    await service.refresh('acme-1')
    emitted.length = 0
    core.state.reply = failure === 'network-error' ? 'network-error' : { status: failure }
    await service.refresh('acme-1')
    expect(emitted).toEqual([])
    expect(service.get()?.revision).toBe(1)
  })

  it('a response that fails the check keeps the last good theme', async () => {
    const { core, emitted, service, activate } = setup(full.assets)
    activate('acme-1')
    core.state.reply = { status: 200, doc: full.doc }
    await service.refresh('acme-1')
    emitted.length = 0
    const broken = fixture('invalid', 'color-css-injection')
    core.state.reply = { status: 200, doc: withRevision(broken.doc, 9) }
    await service.refresh('acme-1')
    core.state.reply = { status: 200, text: '{not json', doc: { revision: 10 } }
    await service.refresh('acme-1')
    expect(emitted).toEqual([])
    expect(service.get()?.revision).toBe(1)
    expect(brandThemeRepo.get('https://acme.example')?.revision).toBe(1)
  })

  it('a profile switch mid-fetch writes the cache but emits nothing', async () => {
    const { core, emitted, service, activate } = setup(full.assets)
    activate('acme-1')
    let release = () => {}
    core.state.gate = new Promise<void>((resolve) => { release = resolve })
    core.state.reply = { status: 200, doc: full.doc }
    const refreshing = service.refresh('acme-1')
    await Promise.resolve()
    activate('local')
    emitted.length = 0
    release()
    await refreshing
    expect(emitted).toEqual([])
    expect(service.get()).toBeNull()
    expect(brandThemeRepo.get('https://acme.example')?.revision).toBe(1)
    // Back on the branded profile: the cache written by the fetch applies at once.
    activate('acme-1')
    expect(emitted).toEqual([{ origin: 'https://acme.example', revision: 1 }])
  })

  it('two profiles on one origin share the cache', async () => {
    const { core, emitted, service, activate } = setup(full.assets)
    activate('acme-1')
    core.state.reply = { status: 200, doc: full.doc }
    await service.refresh('acme-1')
    activate('other')
    expect(emitted.at(-1)).toBeNull()
    core.state.calls.length = 0
    core.state.reply = 'network-error'
    activate('acme-2')
    expect(emitted.at(-1)).toEqual({ origin: 'https://acme.example', revision: 1 })
    expect(service.get()?.name).toBe('Acme')
    await service.refresh('acme-2')
    expect(service.get()?.revision).toBe(1)
  })

  it('before any activation, answers for the startup profile even if it is locked', async () => {
    const seeded = setup(full.assets)
    seeded.activate('acme-1')
    seeded.core.state.reply = { status: 200, doc: full.doc }
    await seeded.service.refresh('acme-1')

    // A fresh app session starting into a profile on that server.
    const { service, emitted } = setup(full.assets, 'acme-2')
    expect(service.get()?.origin).toBe('https://acme.example')
    expect(emitted).toEqual([])
  })

  it('resolveForProfile reads any profile\'s cached theme without fetching; null for a server with none or no server', async () => {
    const { core, service, activate } = setup(full.assets)
    activate('acme-1')
    core.state.reply = { status: 200, doc: full.doc }
    await service.refresh('acme-1')
    // The active profile is now one on another server: the lock of an acme profile still shows acme.
    activate('other')
    core.state.calls.length = 0
    expect(service.resolveForProfile('acme-2')?.origin).toBe('https://acme.example')
    expect(service.resolveForProfile('acme-2')?.logo?.dark).toMatch(/^data:image\//)
    expect(service.resolveForProfile('other')).toBeNull()
    expect(service.resolveForProfile('local')).toBeNull()
    expect(service.resolveForProfile('no-such-profile')).toBeNull()
    expect(core.state.calls).toEqual([])
    // It does not move what the active profile shows.
    expect(service.get()).toBeNull()
  })

  it('collapses concurrent refreshes of one origin into one request', async () => {
    const { core, service, activate } = setup(full.assets)
    activate('acme-1')
    core.state.reply = { status: 200, doc: full.doc }
    await Promise.all([service.refresh('acme-1'), service.refresh('acme-2')])
    expect(core.state.calls.filter((c) => c.url.endsWith('/brand-theme'))).toHaveLength(1)
  })

  it('prunes assets only the replaced theme used', async () => {
    const { core, service, activate } = setup(full.assets)
    activate('acme-1')
    core.state.reply = { status: 200, doc: full.doc }
    await service.refresh('acme-1')
    const minimal = fixture('valid', 'minimal')
    core.state.reply = { status: 200, doc: withRevision(minimal.doc, 2) }
    await service.refresh('acme-1')
    expect(service.get()?.logo).toBeUndefined()
    expect(holder.current!.sqlite.prepare('SELECT COUNT(*) AS n FROM brand_theme_assets').get()).toEqual({ n: 0 })
  })
})
