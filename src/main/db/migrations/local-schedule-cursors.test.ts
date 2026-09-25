import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import { adaptDatabase } from '../testSupport/nodeSqlite'
import { migrateLocalSchedules } from './local-schedules'
import { migrateLocalScheduleCursors } from './local-schedule-cursors'

const NOW = Date.parse('2026-09-21T11:00:00Z')
const databases: DatabaseSync[] = []
afterEach(() => { for (const raw of databases.splice(0)) raw.close() })

function oldDatabase() {
  const raw = new DatabaseSync(':memory:')
  databases.push(raw)
  raw.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  raw.exec("INSERT INTO users (id) VALUES ('user')")
  const sqlite = adaptDatabase(raw)
  migrateLocalSchedules(sqlite)
  const add = (id: string, enabled = true, definition: object = { cron: '0 8 * * 1-5', timezone: 'UTC', prompt: 'Check work' }) => {
    raw.prepare(`INSERT INTO local_schedule_bindings (id,user_id,manifest_id,name,definition,revision,job_id,job_fingerprint,job_ids,enabled,watermark)
      VALUES (?,'user','manifest',?,?,'revision','job','fingerprint','["job","historical-job"]',?,42)`).run(id, id, JSON.stringify(definition), enabled ? 1 : 0)
  }
  return { raw, sqlite, add }
}

describe('durable local schedule cursor migration', () => {
  it('starts enabled prompt schedules strictly after upgrade and preserves consent, jobs, and history', () => {
    const { raw, sqlite, add } = oldDatabase()
    add('enabled'); add('disabled', false)
    raw.exec(`INSERT INTO local_schedule_occurrences (id,binding_id,user_id,civil_key,utc_minute,definition,revision,status,task_id)
      VALUES ('old-receipt','enabled','user','UTC|2026-09-11T08:00',42,'{}','old-revision','interrupted','old-task')`)
    migrateLocalScheduleCursors(sqlite, NOW)
    expect(raw.prepare('SELECT enabled,next_due_at,enabled_since,job_ids,revision,watermark FROM local_schedule_bindings WHERE id=?').get('enabled')).toEqual({
      enabled: 1, next_due_at: Date.parse('2026-09-22T08:00:00Z'), enabled_since: NOW, job_ids: '["job","historical-job"]', revision: 'revision', watermark: 42
    })
    expect(raw.prepare('SELECT enabled,next_due_at,enabled_since FROM local_schedule_bindings WHERE id=?').get('disabled')).toEqual({ enabled: 0, next_due_at: null, enabled_since: null })
    expect(raw.prepare('SELECT id,status,task_id,revision FROM local_schedule_occurrences').all()).toEqual([{ id: 'old-receipt', status: 'interrupted', task_id: 'old-task', revision: 'old-revision' }])
    expect(raw.prepare('PRAGMA index_list(local_schedule_bindings)').all().some(row => row.name === 'idx_local_schedule_due')).toBe(true)
  })

  it('is idempotent and never moves an existing due cursor on a later startup', () => {
    const { raw, sqlite, add } = oldDatabase()
    add('enabled')
    migrateLocalScheduleCursors(sqlite, NOW)
    const before = raw.prepare('SELECT * FROM local_schedule_bindings').all()
    migrateLocalScheduleCursors(sqlite, NOW + 14 * 86400000)
    migrateLocalScheduleCursors(sqlite, NOW + 21 * 86400000)
    expect(raw.prepare('SELECT * FROM local_schedule_bindings').all()).toEqual(before)
  })

  it('suspends invalid, impossible, and old unsupported script definitions without enabling disabled ones', () => {
    const { raw, sqlite, add } = oldDatabase()
    add('invalid', true, { cron: '@daily', timezone: 'UTC' })
    add('impossible', true, { cron: '0 0 30 2 *', timezone: 'UTC' })
    add('script', true, { executionType: 'script_trigger', cron: '* * * * *', timezone: 'UTC', command: 'echo OK' })
    add('disabled-script', false, { executionType: 'script_trigger', cron: '* * * * *', timezone: 'UTC', command: 'echo OK' })
    migrateLocalScheduleCursors(sqlite, NOW)
    expect(raw.prepare('SELECT enabled,next_due_at FROM local_schedule_bindings').all()).toEqual(Array.from({ length: 4 }, () => ({ enabled: 0, next_due_at: null })))
    expect(raw.prepare('SELECT reason FROM local_schedule_bindings WHERE id=?').get('disabled-script')).toEqual({ reason: null })
  })

  it('recovers safely when an upgrade is interrupted after the cursor column is added', () => {
    const { raw, sqlite, add } = oldDatabase()
    add('enabled')
    let injected = false
    const failing = { ...sqlite, exec(sql: string) {
      const result = sqlite.exec(sql)
      if (!injected && sql.includes('ADD COLUMN next_due_at')) { injected = true; throw new Error('Interrupted upgrade') }
      return result
    } } as Database.Database
    expect(() => migrateLocalScheduleCursors(failing, NOW)).toThrow('Interrupted upgrade')
    migrateLocalScheduleCursors(sqlite, NOW + 86400000)
    expect(raw.prepare('SELECT enabled,next_due_at FROM local_schedule_bindings WHERE id=?').get('enabled')).toEqual({ enabled: 1, next_due_at: Date.parse('2026-09-23T08:00:00Z') })
  })
})
