import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * `localAgentsHome` is the first setting whose *type* does not make it safe: it
 * names a directory the app creates files in and hands to the "open in…" guard
 * as an allowed root. The `typeof` check every other setting relies on would
 * accept `/etc`.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))

const { appSettingsService } = await import('./appSettingsService')

beforeEach(() => {
  holder.current = createTestDatabase()
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('app settings', () => {
  it('still round-trips the boolean settings', () => {
    appSettingsService.set('autoChatTitles', true)
    expect(appSettingsService.getAll().autoChatTitles).toBe(true)
  })

  it('reports the string default for a fresh install', () => {
    expect(appSettingsService.getAll().localAgentsHome).toBe('')
  })

  it('accepts a usable agents home and reads it back as a string', () => {
    const path = join(homedir(), 'Documents', 'CinnaAgents')
    appSettingsService.set('localAgentsHome', path)
    expect(appSettingsService.getAll().localAgentsHome).toBe(path)
  })

  it('accepts empty, which means "use the built-in default"', () => {
    appSettingsService.set('localAgentsHome', '')
    expect(appSettingsService.getAll().localAgentsHome).toBe('')
  })

  it('refuses a system location, though it is the right type', () => {
    expect(() => appSettingsService.set('localAgentsHome', '/etc')).toThrow(/Choose a folder/i)
    expect(appSettingsService.getAll().localAgentsHome).toBe('')
  })

  it('refuses a relative path', () => {
    expect(() => appSettingsService.set('localAgentsHome', 'Documents/Agents')).toThrow(
      /Choose a folder/i
    )
  })

  it('still enforces the type, in both directions', () => {
    expect(() => appSettingsService.set('localAgentsHome', true)).toThrow(/expects string/i)
    expect(() => appSettingsService.set('autoChatTitles', '/tmp/x')).toThrow(/expects boolean/i)
  })

  it('rejects an unknown key, and an inherited one', () => {
    expect(() => appSettingsService.set('nope', true)).toThrow(/Unknown app setting/i)
    expect(() => appSettingsService.set('__proto__', true)).toThrow(/Unknown app setting/i)
  })
})
