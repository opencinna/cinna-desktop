# Database Migrations — LLM Reference

Project-specific conventions for the SQLite (better-sqlite3 + Drizzle) schema-migration subsystem. LLM-targeted — concise patterns only; skip standard SQLite/Drizzle knowledge. This project does **not** use Drizzle Kit / generated migration files; migrations are hand-written, inline, and idempotent.

## Model

- Migrations are plain functions `migrateX(sqlite)` taking the raw `better-sqlite3` handle, each in `src/main/db/migrations/<topic>.ts`. <!-- nocheck -->
- All are invoked sequentially from `runMigrations()` in `src/main/db/client.ts`, called by `initDatabase()` on **every** boot against the user's existing `cinna.db` (`userData/cinna.db`).
- There is no version table and no "already applied" tracking. Every migration runs every launch and **must be idempotent** — running it twice is a no-op the second time.
- A fresh install runs the whole chain top-to-bottom against an empty DB. This is the failure case to design for: a migration that only works because an earlier launch warmed the DB will pass in dev and crash only brand-new users.

## Connection setup (`initDatabase`, `client.ts`)

- `journal_mode = WAL`.
- **`foreign_keys = OFF` for the entire migration pass**, re-enabled (`foreign_keys = ON`) only after `runMigrations()` returns. Reason: SQLite compiles `ON DELETE CASCADE` chains at statement-prepare time, so DML on a table whose FK targets a not-yet-created parent throws `no such table: …` even with zero rows. FK-off makes table-creation order non-fatal; the post-pass re-enable restores runtime enforcement.
- Do **not** re-enable `foreign_keys = ON` inside a migration, and do not add a pre-migration query that relies on FK enforcement — that re-opens the ordering trap.
- After migrations, `runConsistencyChecks()` runs idempotent data-healing inside `safeRun` (e.g. `chatModeRepo.pruneDanglingMcpProviderIds()`); each check is try/caught so it can never block startup.
- Any throw from `runMigrations()` is fatal startup → boot-resilience native dialog + `app.exit(1)`. See [Boot Resilience](../../core/boot_resilience/boot_resilience.md).

## Current run order (`runMigrations`)

Parents before children; pure table-creation before backfills; legacy-table backfills last.

1. `migrateUsers` — `users` table + seeds `__default__` guest row (referenced by all data tables)
2. `migrateProviders` — `llm_providers`
3. `migrateMcp` — `mcp_providers`
4. `migrateAgents` — `agents` (must precede `chats`: `chat_on_demand_agents` FK-references it)
5. `migrateChats` — `chats` + `chat_mcp_providers` + `chat_on_demand_mcps` + `chat_on_demand_agents`
6. `migrateMessages` — `messages`
7. `migrateChatModes` — `chat_modes`
8. `migrateAccountConfig` — managed-provider/mode columns + `managed_overrides` (after providers + chat-modes)
9. `migrateAgentOverrides` — `agent_overrides` (no FK, survives resync)
10. `migrateA2aSessions` — `a2a_sessions` (FK → agents)
11. `migrateChatFiles` — chat file tables
12. `migrateJobs` — `jobs`, `job_mcp_providers`, `job_runs`, `job_folders`, `job_agents` (FK → jobs/chats/mcp_providers/agents)
13. `migrateNotes` — notes tables
14. `migrateAppSettings` — app settings
15. `runSyncMigrations` — `sync_state` / `sync_device_key` / `sync_tombstone` (after notes/jobs)
16. `runSyncDepsMigrations` — `jobs.sync_deps`, `mcp_providers.created_by_sync`, `agents.created_by_sync`
17. `migrateUserIdColumns` — backfill `user_id` on legacy tables; **runs last**, every ALTER `hasTable`-guarded

## Helpers (`migrations/helpers.ts`)

- `hasColumn(sqlite, table, column)` — gate every `ADD COLUMN` on this.
- `hasTable(sqlite, table)` — gate any cross-table `ALTER`/DML on this when the table isn't the one this migration creates.

## Mandatory idempotency patterns

- New table: `CREATE TABLE IF NOT EXISTS …`. New index: `CREATE INDEX IF NOT EXISTS …`.
- Add column: `if (!hasColumn(sqlite, 't', 'c')) sqlite.exec('ALTER TABLE t ADD COLUMN c …')`.
- Drop column/table: `IF EXISTS`, or guard with `hasColumn`/`hasTable` (see `chats.ts` dropping `active_agent_id`, `chat_agent_sessions`).
- One-time backfill that must not re-run: pair the `INSERT … SELECT` with a state change that makes the source predicate false next boot (see `jobs.ts`: copy `jobs.agent_id` → `job_agents`, then `UPDATE jobs SET agent_id = NULL`). Without the null-out the backfill resurrects rows the user deleted.
- Backfill INSERT against an FK target uses an existence guard (`… IN (SELECT id FROM parent)`) so a dangling ref can't throw.

## Ordering rules (enforced by review)

- A table that is FK-referenced by another (parent) must be created by an **earlier** migration than the referencing table (child). E.g. `agents` (4) before `chats` (5).
- Pure `CREATE TABLE` migrations before any backfill/DML that touches the created tables.
- Any `ALTER TABLE x …` / `INSERT INTO x` where `x` is **not** this migration's own table → must run after all table-creation migrations **and** be `hasTable`-guarded. The canonical example is `migrateUserIdColumns` (runs last, loops `hasTable` then `hasColumn`).
- Timestamp comparisons must match the column's scale. `chats.deleted_at` is stored as **Unix seconds** (Drizzle `mode: 'timestamp'`); compare against `Math.floor(Date.now()/1000)`, never raw ms `Date.now()` (which would wipe every trashed row). `created_at` columns here are stored as **ms** — check the column.

## Adding a migration

1. Create `migrations/<topic>.ts` exporting `migrate<Topic>(sqlite)`; import + call it from `runMigrations()` at the correct ordered position (parent tables earlier than referencing tables; backfills touching other tables last).
2. `CREATE TABLE IF NOT EXISTS`; gate every `ADD COLUMN` with `hasColumn`; gate cross-table touches with `hasTable`.
3. Mirror the table in the Drizzle schema under `src/main/db/<entity>.ts` (e.g. `chatOnDemandAgent.ts`) and register in `src/main/db/schema.ts`. <!-- nocheck -->
4. Validate fresh-install safety — see below.

## Validation (run for any `src/main/db/` change)

- **Build:** `npx electron-vite build` (full main+preload+renderer). Type-check renderer: `npx tsc --noEmit --project tsconfig.web.json`. Never bare `npx tsc --noEmit` (hangs).
- **Fresh-DB simulation:** replay the `runMigrations()` statements in order against an empty DB via the `sqlite3` CLI (the `better-sqlite3` native binding is built for Electron and won't load under plain `node`). Watch for FK-cascade DML hitting a not-yet-created table; finish with `PRAGMA foreign_key_check;` (must be clean) — model the FK-off-then-on lifecycle if testing cascade behavior.
- **Idempotency:** run the migration block a second time against the populated DB; it must not throw.
- **Real fresh install (definitive):** remove/relocate `userData/cinna.db`, launch, confirm the window opens with no fatal dialog and no `no such table` / `no such column` in `cinna-errors.log`.

## Gotchas

- `cinna.db` lives in Electron `userData`; deleting it is the only "reset" — there is no down-migration.
- WAL: each `sqlite.exec` auto-commits (no wrapping transaction around the pass), so a mid-pass failure leaves earlier tables committed — relied on for self-healing re-runs, not atomicity.
- A half-migrated DB from a previous crash self-heals on next launch precisely because every statement is idempotent + the FK-off pass tolerates partial schema.
