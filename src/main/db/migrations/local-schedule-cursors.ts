import type Database from 'better-sqlite3'
import { nextScheduleOccurrence } from '../../tasks/scheduleCron'

/** Upgrade once, never reinterpret time skipped by older app versions as debt. */
export function migrateLocalScheduleCursors(sqlite: Database.Database, now = Date.now()): void {
  sqlite.transaction(() => {
  const bindingColumns = new Set((sqlite.prepare('PRAGMA table_info(local_schedule_bindings)').all() as { name: string }[]).map(row => row.name))
  const first = !bindingColumns.has('next_due_at')
  for (const [name, type] of Object.entries({ next_due_at: 'INTEGER', enabled_since: 'INTEGER', last_attempt_at: 'INTEGER', last_completed_at: 'INTEGER', cursor_version: 'INTEGER NOT NULL DEFAULT 0', editor_metadata: 'TEXT' })) {
    if (!bindingColumns.has(name)) sqlite.exec(`ALTER TABLE local_schedule_bindings ADD COLUMN ${name} ${type}`)
  }
  const occurrenceColumns = new Set((sqlite.prepare('PRAGMA table_info(local_schedule_occurrences)').all() as { name: string }[]).map(row => row.name))
  for (const [name, type] of Object.entries({ scheduled_for: 'INTEGER', observed_at: 'INTEGER', started_at: 'INTEGER', finished_at: 'INTEGER', covered_through: 'INTEGER', trigger_kind: 'TEXT', result_kind: 'TEXT', command_outcome: 'TEXT' })) {
    if (!occurrenceColumns.has(name)) sqlite.exec(`ALTER TABLE local_schedule_occurrences ADD COLUMN ${name} ${type}`)
  }
  if (first) {
    for (const row of sqlite.prepare('SELECT id, definition FROM local_schedule_bindings WHERE enabled = 1').all() as { id: string; definition: string }[]) {
      try {
        const definition = JSON.parse(row.definition)
        if (definition.executionType === 'script_trigger') throw new Error('Review this script schedule before enabling it.')
        const due = nextScheduleOccurrence(definition.cron, definition.timezone, now)
        sqlite.prepare('UPDATE local_schedule_bindings SET next_due_at = ?, enabled_since = ? WHERE id = ?').run(due, now, row.id)
      } catch {
        sqlite.prepare('UPDATE local_schedule_bindings SET enabled = 0, reason = ? WHERE id = ?').run('Review this schedule after upgrading.', row.id)
      }
    }
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_local_schedule_due ON local_schedule_bindings(user_id, enabled, next_due_at)')
  })()
}
