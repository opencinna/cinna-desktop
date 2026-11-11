import { migrateServiceCredentials } from './service-credentials'
import { migrateConductorSessions } from './conductor-sessions'
import type Database from 'better-sqlite3'
import { migrateProviders } from './providers'
import { migrateMcp } from './mcp'
import { migrateMcpRegistryRef } from './mcp-registry-ref'
import { migrateMcpManagedBy } from './mcp-managed-by'
import { migrateMcpManagedEnv } from './mcp-managed-env'
import { migrateChats } from './chats'
import { migrateChatRouter } from './chat-router'
import { migrateChatRunResults } from './chat-run-results'
import { migrateChatOrigin } from './chat-origin'
import { migrateChatGuidedBuild } from './chat-guided-build'
import { migrateInflightTurns } from './inflight-turns'
import { migrateRetireChatMirror } from './retire-chat-mirror'
import { migrateMessages } from './messages'
import { migrateMessagesSearch } from './messages-search'
import { migrateChatModes, migrateChatModeRuntimeIndex } from './chat-modes'
import { migrateAgents } from './agents'
import { migrateAcpDriver } from './acp-driver'
import { migrateAgentDrivers } from './agent-drivers'
import { migrateAgentRoots } from './agent-roots'
import { migrateA2aSessions } from './a2a-sessions'
import { migrateAgentOverrides } from './agent-overrides'
import { migrateAgentShortcuts } from './agent-shortcuts'
import { migrateAgentColors } from './agent-colors'
import { migrateAgentPinnedFiles } from './agent-pinned-files'
import { migrateAgentMcpProviders } from './agent-mcp-providers'
import { migrateAccountConfig } from './account-config'
import { migrateUsers, migrateUserIdColumns } from './users'
import { migrateChatFiles } from './chat-files'
import { migrateJobs } from './jobs'
import { migrateTasks } from './tasks'
import { migrateLocalScheduleCursors } from './local-schedule-cursors'
import { migrateLocalSchedules } from './local-schedules'
import { migrateHandovers } from './handovers'
import { migrateDelegations } from './delegations'
import { migrateNotes } from './notes'
import { migrateAppSettings, backfillAiFunctionsCredential, pinLegacyAgentsHome, pinVoiceCloudService } from './app-settings'
import { migrateInboxDismissals } from './inbox-dismissals'
import { migrateRuntimeModelCatalogs } from './runtime-model-catalogs'
import { migratePublishedArtifacts } from './published-artifacts'
import { migrateArtifactSupport } from './artifact-support'
import { migrateDashboards } from './dashboards'
import { migrateBrandThemes } from './brand-themes'
import { runSyncMigrations } from './sync'
import { runSyncDepsMigrations } from './sync-deps'
import { shareLocalAgentChats } from './share-local-agent-chats'

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
  migrateServiceCredentials(sqlite)
  migrateProviders(sqlite)
  migrateMcp(sqlite)
  // `mcp_providers.registry_ref`: a nullable column on the table just created; no DML.
  migrateMcpRegistryRef(sqlite)
  // `mcp_providers.managed_by`: a nullable column on the same table; no DML.
  migrateMcpManagedBy(sqlite)
  // `mcp_providers.env_secret_enc` + `managed_spec`: nullable columns on the same table; no DML.
  migrateMcpManagedEnv(sqlite)
  migrateAgents(sqlite)
  // `agent_roots` before anything that reads it. It creates only its own table
  // (no FK, no cross-table DML), so its position here is about keeping it
  // beside the table it extends, not about necessity.
  migrateAgentRoots(sqlite)
  migrateChats(sqlite)
  migrateChatRunResults(sqlite)
  // In-flight turn markers reference `chats`; creation only, no DML.
  migrateInflightTurns(sqlite)
  migrateMessages(sqlite)
  migrateChatModes(sqlite)
  // Account-provisioned (Cinna-managed) provider/mode columns + overrides table.
  // Must come after providers + chat-modes tables exist.
  migrateAccountConfig(sqlite)
  migrateAgentOverrides(sqlite)
  migrateAgentShortcuts(sqlite)
  migrateAgentColors(sqlite)
  // Per-profile pinned files of an agent; creation only, no FK, no DML.
  migrateAgentPinnedFiles(sqlite)
  // Folder-agent MCP addons reference `agents` and `mcp_providers`; creation only.
  migrateAgentMcpProviders(sqlite)
  migrateA2aSessions(sqlite)
  migrateConductorSessions(sqlite)
  migrateChatFiles(sqlite)
  // Jobs depend on chats + mcp_providers being present (FK references).
  migrateJobs(sqlite)
  // `tasks` + `task_input_requests` + `job_runs.task_id`. After `chats` (the
  // task's chat is a `SET NULL` reference) and after `jobs`, whose `job_runs`
  // table it alters.
  migrateTasks(sqlite)
  // `handovers` references `tasks` (SET NULL) and `users`, so it lands after
  // `migrateTasks`. Creation only, no DML.
  migrateHandovers(sqlite)
  migrateDelegations(sqlite)
  migrateLocalSchedules(sqlite)
  migrateLocalScheduleCursors(sqlite)
  migrateNotes(sqlite)
  migrateAppSettings(sqlite)
  // Dismissed Inbox cards; creation only, no FK, no DML.
  migrateInboxDismissals(sqlite)
  // CLI runtimes' last advertised model catalogues; creation only, no FK, no DML.
  migrateRuntimeModelCatalogs(sqlite)
  // Published artifacts and their chat cards; FK → users, chats; creation only.
  migratePublishedArtifacts(sqlite)
  // The last supported artifacts answer per profile+server; FK → users; creation only.
  migrateArtifactSupport(sqlite)
  // Dashboards, their tiles and the tiles' last results; FK → users; creation only.
  migrateDashboards(sqlite)
  // The last good brand theme per server origin and its assets; no FK, creation only.
  migrateBrandThemes(sqlite)
  // Sync bookkeeping tables (must come after notes/jobs exist).
  runSyncMigrations(sqlite)
  // Portable-dependency-sync columns (jobs.sync_deps + created_by_sync flags).
  runSyncDepsMigrations(sqlite)
  // `agents.driver` + its backfill. DML on a table another migration created,
  // so it runs after every table exists and is `hasTable`-guarded.
  migrateAgentDrivers(sqlite)
  // …and then the collapse of both engine drivers into `acp`, which reads the
  // value the line above backfills. Order, not preference.
  migrateAcpDriver(sqlite)
  // `chats.router` + `chat_agent_cursors`. After `agents` and `chats` both
  // exist (the cursor table references each), and after the driver migrations
  // so the whole agent-runtime set reads in plan order.
  migrateChatRouter(sqlite)
  migrateRetireChatMirror(sqlite)
  // `chats.origin` + its one-time backfill, which reads `tasks`, `delegations`
  // and `handovers`: DML, so after every table exists.
  migrateChatOrigin(sqlite)
  // `chats.guided_build`; a column with a default, no DML.
  migrateChatGuidedBuild(sqlite)
  // Backfill `user_id` on legacy tables — must run AFTER table creation so
  // fresh installs don't ALTER tables that don't exist yet.
  migrateUserIdColumns(sqlite)
  // One runtime mode per user and engine; needs the `user_id` backfilled above.
  migrateChatModeRuntimeIndex(sqlite)
  // One-time AI Functions credential backfill. Reads `chat_modes.user_id`, so
  // it runs after the legacy `user_id` backfill above.
  backfillAiFunctionsCredential(sqlite)
  // One-time move of local-agent chats a stamped account mode kept in a
  // profile. Reads `chats.origin`, `chats.router`, `agents.driver_config` and
  // the legacy `user_id` columns, so it runs after all of them.
  shareLocalAgentChats(sqlite)
  // The agents home default moved out of `~/Documents`; an install already
  // using the old default keeps it. Reads `agent_roots`, writes `app_settings`,
  // both created above; string comparison only, no filesystem access.
  pinLegacyAgentsHome(sqlite)
  // Cloud transcription gained a Service setting (the Cinna server relay or
  // the Gemini key): an install with a mode already on keeps the key it chose.
  // Writes `app_settings` only; once per database.
  pinVoiceCloudService(sqlite)
  // The all-chats search index over `messages` and its triggers, last: after
  // every migration that alters or rewrites `messages`, so none of them runs
  // under the triggers or renumbers rowids the index already holds. Its
  // one-time backfill reads `messages` only.
  migrateMessagesSearch(sqlite)
}
