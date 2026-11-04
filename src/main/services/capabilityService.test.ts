import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * Notes and Dashboards nobody has decided are decided once, in main, from
 * whether **any** profile holds a record there — the settings are
 * installation-global, so judging only the active profile would turn off a
 * section whose records live in another one. Over the real migrations, the
 * real app-settings repo and the real cross-profile counts.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const { capabilityService, createCapabilityService } = await import('./capabilityService')
const { appSettingsRepo } = await import('../db/appSettings')
const { capabilityCountsRepo } = await import('../db/capabilityCounts')
const { appSettingsService } = await import('./appSettingsService')

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.exec(
    `INSERT INTO users (id, type, username, display_name, created_at) VALUES
       ('active', 'cinna_user', 'active', 'Active', 1), ('other', 'cinna_user', 'other', 'Other', 1);`
  )
})
afterEach(() => {
  holder.current?.close()
  holder.current = null
})

function seedNote(userId: string, deleted = false): void {
  holder.current!.raw
    .prepare('INSERT INTO notes (id, user_id, title, body, position, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 1, 1)')
    .run(`n-${Math.random()}`, userId, 'A note', '', deleted ? 2 : null)
}

function seedDashboard(userId: string): void {
  holder.current!.raw
    .prepare('INSERT INTO dashboards (id, profile_user_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)')
    .run(`d-${Math.random()}`, userId, 'Sales')
}

describe('capabilityService.resolveUnset', () => {
  it('starts both undecided', () => {
    expect(appSettingsRepo.get('notesCapability')).toBe('unset')
    expect(appSettingsRepo.get('dashboardsCapability')).toBe('unset')
  })

  it('turns a capability on when any profile — not only the active one — holds a record there', () => {
    seedNote('other')
    seedDashboard('other')
    capabilityService.resolveUnset()
    expect(appSettingsRepo.get('notesCapability')).toBe('on')
    expect(appSettingsRepo.get('dashboardsCapability')).toBe('on')
  })

  it('turns it off, and writes that down, when there is none; a trashed note does not count', () => {
    seedNote('active', true)
    capabilityService.resolveUnset()
    expect(appSettingsRepo.get('notesCapability')).toBe('off')
    expect(appSettingsRepo.get('dashboardsCapability')).toBe('off')
    // Decided once: a record that appears later does not turn it on behind the user.
    seedNote('active')
    capabilityService.resolveUnset()
    expect(appSettingsRepo.get('notesCapability')).toBe('off')
  })

  it('leaves a decided capability alone, whatever the records say', () => {
    seedNote('active')
    appSettingsService.set('notesCapability', 'off')
    appSettingsService.set('dashboardsCapability', 'on')
    capabilityService.resolveUnset()
    expect(appSettingsRepo.get('notesCapability')).toBe('off')
    expect(appSettingsRepo.get('dashboardsCapability')).toBe('on')
  })

  it('leaves it undecided, and so off, when the count throws; the next read decides it', () => {
    seedNote('other')
    let broken = true
    const service = createCapabilityService({
      read: (key) => appSettingsRepo.get(key),
      write: (key, value) => appSettingsRepo.set(key, value),
      counts: {
        notes: () => {
          if (broken) throw new Error('database is locked')
          return capabilityCountsRepo.notes()
        },
        dashboards: () => capabilityCountsRepo.dashboards()
      }
    })
    service.resolveUnset()
    expect(appSettingsRepo.get('notesCapability')).toBe('unset')
    expect(service.isOn('notes')).toBe(false)
    // The failure for one does not keep the other undecided.
    expect(appSettingsRepo.get('dashboardsCapability')).toBe('off')
    broken = false
    expect(service.isOn('notes')).toBe(true)
    expect(appSettingsRepo.get('notesCapability')).toBe('on')
  })

  it('isOn decides first, so the dashboard gate never reads a still-undecided key as a real off', () => {
    seedDashboard('other')
    expect(capabilityService.isOn('dashboards')).toBe(true)
    expect(appSettingsRepo.get('dashboardsCapability')).toBe('on')
  })
})

describe('the capability settings at the IPC boundary', () => {
  it('accept on and off, and refuse unset or anything else', () => {
    appSettingsService.set('dashboardsCapability', 'on')
    expect(() => appSettingsService.set('dashboardsCapability', 'unset')).toThrow(/on or off/)
    expect(() => appSettingsService.set('notesCapability', 'yes')).toThrow(/on or off/)
    expect(() => appSettingsService.set('notesCapability', true)).toThrow()
    expect(appSettingsRepo.get('dashboardsCapability')).toBe('on')
  })
})
