import type Database from 'better-sqlite3'
import { migrateProviders } from './providers'
import { migrateMcp } from './mcp'
import { migrateChats } from './chats'
import { migrateMessages } from './messages'
import { migrateChatModes } from './chat-modes'
import { migrateAgents } from './agents'
import { migrateAgentRoots } from './agent-roots'
import { migrateA2aSessions } from './a2a-sessions'
import { migrateAgentOverrides } from './agent-overrides'
import { migrateAccountConfig } from './account-config'
import { migrateUsers, migrateUserIdColumns } from './users'
import { migrateChatFiles } from './chat-files'
import { migrateJobs } from './jobs'
import { migrateNotes } from './notes'
import { migrateAppSettings } from './app-settings'
import { runSyncMigrations } from './sync'
import { runSyncDepsMigrations } from './sync-deps'

/**
 * The migration chain, in the order it runs on every boot.
 *
 * It lives here rather than inside `client.ts` for one reason: `client.ts`
 * imports `better-sqlite3`, whose native binding is built for Electron and
 * cannot be loaded by plain Node — which would make the fresh-install replay
 * untestable, and section 10 of the review command asks for exactly that replay.
 * Every module imported here takes the database handle as a *type* only, so
 * this file can be driven by any SQLite handle with the same surface
 * (`exec` / `prepare().run()/get()/all()`), including the `node:sqlite` one the
 * test suite uses. See `migrations.test.ts`.
 *
 * Ordering rules, unchanged (`docs/development/migrations/`):
 *
 * * FK-referenced parents before the tables that reference them.
 * * Pure table creation before any backfill or cleanup DML — SQLite compiles
 *   `ON DELETE CASCADE` chains at statement-prepare time, so DML on a table
 *   whose cascade reaches a not-yet-created one throws `no such table` even
 *   with zero rows. (That is the `no such table: main.agents` crash this
 *   project shipped once.)
 * * Legacy-table backfills last, `hasTable`-guarded.
 *
 * FK enforcement is off for the whole pass and re-enabled by `initDatabase`
 * afterwards; nothing here may turn it back on.
 */
export function runAllMigrations(sqlite: Database.Database): void {
  // Users table first (referenced by all data tables)
  migrateUsers(sqlite)
  // Order matters: providers, mcp & agents first (all referenced by chats via
  // FK — `chat_on_demand_agents` references `agents`), then chats, messages,
  // chat-modes. FK enforcement is off during migrations (see initDatabase), so
  // this ordering is belt-and-suspenders, not the sole guard.
  migrateProviders(sqlite)
  migrateMcp(sqlite)
  migrateAgents(sqlite)
  // `agent_roots` before anything that reads it. It creates only its own table
  // (no FK, no cross-table DML), so its position here is about keeping it
  // beside the table it extends, not about necessity.
  migrateAgentRoots(sqlite)
  migrateChats(sqlite)
  migrateMessages(sqlite)
  migrateChatModes(sqlite)
  // Account-provisioned (Cinna-managed) provider/mode columns + overrides table.
  // Must come after providers + chat-modes tables exist.
  migrateAccountConfig(sqlite)
  migrateAgentOverrides(sqlite)
  migrateA2aSessions(sqlite)
  migrateChatFiles(sqlite)
  // Jobs depend on chats + mcp_providers being present (FK references).
  migrateJobs(sqlite)
  migrateNotes(sqlite)
  migrateAppSettings(sqlite)
  // Sync bookkeeping tables (must come after notes/jobs exist).
  runSyncMigrations(sqlite)
  // Portable-dependency-sync columns (jobs.sync_deps + created_by_sync flags).
  runSyncDepsMigrations(sqlite)
  // Backfill `user_id` on legacy tables — must run AFTER table creation so
  // fresh installs don't ALTER tables that don't exist yet.
  migrateUserIdColumns(sqlite)
}
