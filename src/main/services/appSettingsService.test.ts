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

  /**
   * The engine path had no test of its own at all: removing its `isAbsolute`
   * guard entirely left the whole suite green, because every case above names
   * `localAgentsHome`, whose check is a different function.
   *
   * The rules are deliberately not the agents home's. This is a path to an
   * *executable*, not a folder this app writes into, so `assertUsableRoot`'s
   * "inside your home or on a mounted volume" does not apply — `/usr/local/bin`
   * is a perfectly good place for it and the home's check would refuse it.
   */
  it('accepts an absolute engine path outside the agents home rules', () => {
    appSettingsService.set('localAgentsEnginePath', '/usr/local/bin/opencode')
    expect(appSettingsService.getAll().localAgentsEnginePath).toBe('/usr/local/bin/opencode')
  })

  it('refuses a relative engine path, which would resolve against the launch directory', () => {
    // For a packaged app `process.cwd()` is wherever the OS happened to launch
    // it from, so a relative path names a different file run to run — or
    // nothing at all.
    expect(() => appSettingsService.set('localAgentsEnginePath', 'bin/opencode')).toThrow(
      /absolute path/i
    )
    expect(appSettingsService.getAll().localAgentsEnginePath).toBe('')
  })

  it('accepts empty, which means "resolve an engine for me"', () => {
    appSettingsService.set('localAgentsEnginePath', '/usr/local/bin/opencode')
    appSettingsService.set('localAgentsEnginePath', '')
    expect(appSettingsService.getAll().localAgentsEnginePath).toBe('')
  })

  /**
   * Whether the file exists and runs is `binaryResolver`'s question, not this
   * one's: a user pasting a path before installing the binary should be able to
   * save it and hear about the problem from the engine's status line.
   */
  it('accepts a known tool id as the default tool, and empty to clear it', () => {
    appSettingsService.set('localAgentsDefaultTool', 'codex')
    expect(appSettingsService.getAll().localAgentsDefaultTool).toBe('codex')
    appSettingsService.set('localAgentsDefaultTool', '')
    expect(appSettingsService.getAll().localAgentsDefaultTool).toBe('')
  })

  it('refuses a default tool Cinna does not know — that string would be handed to open-in', () => {
    expect(() => appSettingsService.set('localAgentsDefaultTool', 'vim')).toThrow(
      /not a tool/i
    )
    expect(appSettingsService.getAll().localAgentsDefaultTool).toBe('')
  })

  it('round-trips the auto-open flag', () => {
    appSettingsService.set('localAgentsAutoOpen', true)
    expect(appSettingsService.getAll().localAgentsAutoOpen).toBe(true)
  })

  it('does not require the engine path to exist', () => {
    const missing = join(homedir(), 'nothing-is-installed-here', 'opencode')
    expect(() => appSettingsService.set('localAgentsEnginePath', missing)).not.toThrow()
    expect(appSettingsService.getAll().localAgentsEnginePath).toBe(missing)
  })
})
