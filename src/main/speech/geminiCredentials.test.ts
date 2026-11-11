import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null, decrypt: (b: Buffer): Promise<string> => Promise.resolve(b.toString()) }))
const logged = vi.hoisted(() => [] as unknown[])
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: (...args: unknown[]) => { logged.push(args) }, error: () => {} })
}))
vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  }
}))
vi.mock('../auth/scope', () => ({ DEFAULT_SCOPE_USER_ID: '__default__', getManagedResourceScopes: () => ['__default__', 'alice'] }))
vi.mock('../security/keystore', () => ({ decryptApiKey: (b: Buffer) => holder.decrypt(b) }))

const { readCloudConfig, resolveGeminiKey } = await import('./geminiCredentials')
const { llmProviders } = await import('../db/schema')
const { appSettingsRepo } = await import('../db/appSettings')

function provider(row: { id: string; name?: string; type?: string; enabled?: boolean; key?: string | null; unsupported?: boolean; userId?: string }): void {
  holder.current!.db.insert(llmProviders).values({
    id: row.id,
    userId: row.userId ?? '__default__',
    type: row.type ?? 'gemini',
    name: row.name ?? row.id,
    enabled: row.enabled ?? true,
    apiKeyEncrypted: row.key === null ? null : Buffer.from(row.key ?? `key-${row.id}`),
    unsupported: row.unsupported ?? false
  }).run()
}

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.decrypt = (b) => Promise.resolve(b.toString())
  logged.length = 0
})
afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('Gemini credentials for transcription', () => {
  it('lists only enabled, keyed, supported Gemini rows from the Default scope, never the key', () => {
    provider({ id: 'openai', type: 'openai' })
    provider({ id: 'off', enabled: false })
    provider({ id: 'nokey', key: null })
    provider({ id: 'unsupported', unsupported: true })
    provider({ id: 'other-profile', userId: 'bob' })
    provider({ id: 'mine', name: 'My Gemini' })
    provider({ id: 'managed', name: 'Team Gemini', userId: 'alice' })
    const config = readCloudConfig()
    expect(config.mode).toBe('off')
    expect(config.service).toBe('')
    expect(config.providers.map((p) => p.id).sort()).toEqual(['mine'])
    expect(JSON.stringify(config)).not.toContain('key-')
  })

  it('never offers or uses a Gemini key the active account provisioned, even when it is the chosen one', async () => {
    provider({ id: 'managed', name: 'Team Gemini', userId: 'alice' })
    appSettingsRepo.set('voiceCloudProviderId', 'managed')
    expect(readCloudConfig()).toMatchObject({ providers: [], chosen: null })
    expect(await resolveGeminiKey()).toEqual({ ok: false, message: expect.stringMatching(/Gemini provider/) })
    provider({ id: 'mine', name: 'My Gemini' })
    expect(readCloudConfig().chosen).toEqual({ id: 'mine', name: 'My Gemini' })
    expect(await resolveGeminiKey()).toMatchObject({ ok: true, apiKey: 'key-mine' })
  })

  it('picks the chosen provider when usable, else the first usable one', async () => {
    provider({ id: 'first', name: 'First' })
    provider({ id: 'second', name: 'Second' })
    provider({ id: 'disabled', enabled: false })
    appSettingsRepo.set('voiceCloudProviderId', 'second')
    expect(readCloudConfig().chosen).toEqual({ id: 'second', name: 'Second' })
    expect(await resolveGeminiKey()).toEqual({ ok: true, apiKey: 'key-second', provider: { id: 'second', name: 'Second' } })
    appSettingsRepo.set('voiceCloudProviderId', 'disabled')
    expect(readCloudConfig().chosen?.id).toBe('first')
    expect(await resolveGeminiKey()).toMatchObject({ ok: true, apiKey: 'key-first' })
  })

  it('answers no key when there is no usable provider, and when the key does not decrypt (without logging it)', async () => {
    expect(readCloudConfig().chosen).toBeNull()
    expect(await resolveGeminiKey()).toEqual({ ok: false, message: expect.stringMatching(/Gemini provider/) })
    provider({ id: 'g', name: 'Locked' })
    holder.decrypt = () => Promise.reject(new Error('keychain reset'))
    expect(await resolveGeminiKey()).toEqual({ ok: false, message: expect.stringMatching(/Locked could not be read/) })
    expect(JSON.stringify(logged)).not.toContain('key-g')
  })
})
