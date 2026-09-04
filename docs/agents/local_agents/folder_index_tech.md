# Agents Home, Scanner & Folder Index — Technical Details

Implementation reference for [Agents Home, Scanner & Folder Index](folder_index.md). Path convention as in that doc: `src/...` is this repo, `Local/<slug>/...` is inside an agent folder.

## File Locations

### Shared
- `src/shared/localAgents.ts` — the whole wire contract: `FOLDER_AGENT_ID_PREFIX` (`folder:`), `FOLDER_AGENT_SOURCE` (`folder`), `FOLDER_AGENT_PROTOCOL` (`local-folder`), `AGENTS_SUBDIR` (`Local`), `LOCAL_AGENT_CHANGED_CHANNEL`, `isFolderAgentId()`, `folderAgentId()`, and the DTOs (`LocalAgentDto`, `AgentRootDto`, `LocalAgentReadiness`, `LocalAgentValidation`, `LocalAgentCredentialState`, `LocalAgentCommand`, `LocalAgentStatusSummary`, `LocalAgentDesktopSummary`, `FileStamp`, `CreateLocalAgentInput`, `UpdateLocalAgentFieldInput`, `LocalAgentFieldUpdate`, `OpenLocalAgentPathInput`, `RescanResult`, `LocalAgentChangedPayload`). Also the pieces the renderer needs to save correctly: `LOCAL_AGENT_PROMPT_PATHS`, `fieldFilePath(update)` (which file a given update writes, i.e. which stamp to send), `STALE_WRITE_ERROR_CODES` / `isStaleWriteError(error)`, and `slugifyAgentName()` — the slug rule lives here so the new-agent form previews the exact folder the scaffolder will create
- `src/shared/localAgents.test.ts` — the id prefix round-trip. It is the whole file: the suite that pinned the folder-agent counterparty exclusion was **replaced** rather than deleted, by two suites that pin the opposite claim in the pickers where it now lives (`ChatInput.agentMention.test.tsx`, `JobEditForm.agentPicker.test.tsx`)
- `src/shared/appSettings.ts` — `localAgentsHome` joins `AppSettingsSchema`. First non-boolean setting in the store

### Main process — database
- `src/main/db/migrations/agent-roots.ts` — creates `agent_roots` plus its indexes
- `src/main/db/migrations/agents.ts` — adds `local_path` and `local_root_id` in the existing idempotent `PRAGMA table_info` block, and documents the third `source` value
- `src/main/db/migrations/index.ts` — `runAllMigrations()`, the whole chain extracted out of `client.ts`
- `src/main/db/migrations/migrations.test.ts` — fresh-install replay, idempotency, `PRAGMA foreign_key_check`
- `src/main/db/testSupport/nodeSqlite.ts` — **test support only**; adapts `node:sqlite` to the narrow `better-sqlite3` surface Drizzle and the migrations use
- `src/main/db/agentRoots.ts` — `agentRootRepo`, `userId`-scoped, no business logic
- `src/main/db/agents.ts` — `listFolder()`, `replaceFolderIndex()`, `updateFolderIndex()`, `pruneFolderIndexForRoot()`, and the module-private `pruneFolderRows()`
- `src/main/db/agents.test.ts` — the index transaction: insert, update-in-place, `enabled` preservation, per-root prune scoping, protected paths, rollback
- `src/main/db/schema.ts` — `agentRoots` table; `agents.localPath` / `agents.localRootId`
- `src/main/db/client.ts` — still owns the connection, the pragmas and `runConsistencyChecks()`; `runMigrations()` now delegates to `runAllMigrations()`
- `src/main/db/appSettings.ts` — `localAgentsHome: ''` in `DEFAULTS`, plus a per-key `typeof` check on read now that the schema is heterogeneous

### Main process — services (`src/main/services/localAgents/`)
- `agentsHomeService.ts` — the home, extra roots, root templates, `.cinna-kit/` sync, overlap rule
- `scaffoldService.ts` — the TypeScript port of `kit.py new`
- `scannerService.ts` — folder → `LocalAgentDto` → index; the per-root scan cache
- `desktopStateService.ts` — typed, total read/write of `app-data/desktop.json`
- `watcherService.ts` — one debounced watcher per root; `classifyEvent()`
- `turnLock.ts` — the per-agent lock the runner, the editors and the watcher share
- `pathRules.ts` — `assertUsableRoot()` and `resolveWithinRoot()`
- `localAgentService.ts` — the composition root, and the operations IPC calls
- Tests: `agentsHomeService.test.ts`, `scannerService.test.ts`, `localAgentService.test.ts`, `watcherService.test.ts`, `turnLock.test.ts`, `pathRules.test.ts`, and `openInService.test.ts` (Phase 2's merge condition — the open-in allow path only became reachable once this slice registered the real roots provider)

### Main process — elsewhere
- `src/main/services/agentService.ts` — the `folder:` scope branch and the endpoint/token short-circuits
- `src/main/services/appSettingsService.ts` — `VALUE_CHECKS`, the per-key validation hook `localAgentsHome` needs
- `src/main/services/appSettingsService.test.ts` — accepts a usable home, rejects a system location and a relative path, still enforces types
- `src/main/errors.ts` — `LocalAgentError` / `LocalAgentErrorCode`, `KitError` / `KitErrorCode`, and `folder_immutable` on `AgentErrorCode`
- `src/main/ipc/local_agent.ipc.ts` — the handlers, plus the one-time `localAgentService.configure()` call
- `src/main/ipc/index.ts` — registers `registerLocalAgentHandlers()` (enforced by `src/main/ipc/registration.test.ts`)
- `src/main/ipc/agent_a2a.ipc.ts` and `src/main/services/a2aAsMcpProvider.ts` — handle the `null` endpoint a folder agent resolves to

### Preload
- `src/preload/index.ts` — `window.api.localAgents.*`: `list`, `get`, `create`, `updateField`, `rescan`, `validate`, `openPath`, `rootsList`, `rootAdd`, `rootRemove`, `onChanged` (plus `draft`, which belongs to the Agents tab slice). Typed by inference; there is no hand-written interface

### Renderer
- `src/renderer/src/hooks/useLocalAgents.ts` — `useLocalAgents`, `useLocalAgent`, `useAgentRoots`, `useLocalAgentWatch`, `useCreateLocalAgent`, `useUpdateLocalAgentField`, `useRescanLocalAgents`, `useAddAgentRoot`, `useRemoveAgentRoot`, `useOpenAgentPath`, `useValidateLocalAgent`
- `src/renderer/src/components/chat/ChatInput.tsx` and `src/renderer/src/components/jobs/JobEditForm.tsx` — the two counterparty pickers. Both filter on `a.enabled` alone; see [Folder Agents as Counterparties](counterparty.md)

## Database Schema

### `agent_roots` (new — `src/main/db/migrations/agent-roots.ts`)

| Column | Notes |
|---|---|
| `id` | nanoid, primary key |
| `user_id` | Always the settings-scope user in practice; the filter is built in like `messageRepo`'s so a per-profile root needs no repo change |
| `path` | Absolute path of the workshop root (the folder containing `Local/`) |
| `label` | Sidebar group name |
| `is_default` | Exactly one row per user carries it: the agents home |
| `created_at` | ms |

Plus `idx_agent_roots_user_id` and a unique `idx_agent_roots_user_path`. Both indexes and the table are `IF NOT EXISTS`; the migration touches no other table, and carries `user_id` from the start so `migrateUserIdColumns` has nothing to backfill.

**There is deliberately no SQL foreign key from `agents.local_root_id` to `agent_roots.id`.** Two reasons, and they should be read before anyone "tidies it up":

- A folder row is a **derived index**, pruned explicitly and visibly in the same transaction as the scan (`replaceFolderIndex` / `pruneFolderIndexForRoot`). A cascade would hide that decision inside SQLite
- It would put a **second FK edge on `agents`** — the table the fresh-install FK-cascade crash was about. SQLite compiles `ON DELETE CASCADE` chains at statement-prepare time, so DML touching a table whose cascade reaches a not-yet-created one throws `no such table: main.agents` even with zero rows. This project shipped that crash once. See [Boot Resilience](../../core/boot_resilience/boot_resilience.md)

### `agents` (extended — `src/main/db/migrations/agents.ts`)

| Column | Notes |
|---|---|
| `source` | Third value `'folder'` joins `'local'` (hand-added A2A URL) and `'remote'` (Cinna-synced) |
| `local_path` | Folder agents only: absolute path of the agent folder. NULL otherwise |
| `local_root_id` | Folder agents only: the `agent_roots` row it was scanned from. NULL otherwise |

Row id is `folder:<manifest uuid>`; `protocol` is `local-folder` — deliberately not `'a2a'`, so the A2A-only paths (`agentService.testAgent`, `listCliCommands`) keep gating themselves out. `local_path` is machine-local and never synced: sync's descriptor resolver already skips rows whose `source` is not `'local'`.

### The migration chain moved to `src/main/db/migrations/index.ts`

`client.ts` imports `better-sqlite3`, whose native binding is built against Electron's ABI and will not load under plain Node — which made the fresh-install replay section 10 of the review command asks for untestable. Every module the chain imports takes the handle as a *type* only, so the chain can be driven by any SQLite handle with the same surface, including the `node:sqlite` adapter in `src/main/db/testSupport/nodeSqlite.ts`.

Nothing about boot behaviour changed: `client.ts` still owns the connection, `journal_mode = WAL`, the `foreign_keys = OFF` migration pass and its re-enable, `runConsistencyChecks()` and the fatal-startup path. `migrateAgentRoots` runs immediately after `migrateAgents` — beside the table it extends. See [Database Migrations](../../development/migrations/migrations_llm.md).

## IPC Channels

| Channel | Type | Signature |
|---|---|---|
| `local-agent:list` | invoke | `() → { roots: AgentRootDto[]; agents: LocalAgentDto[] }` |
| `local-agent:get` | invoke | `(agentId) → LocalAgentDto` (always a fresh read) |
| `local-agent:create` | invoke | `(CreateLocalAgentInput) → LocalAgentDto` |
| `local-agent:update-field` | invoke | `(UpdateLocalAgentFieldInput) → LocalAgentDto` |
| `local-agent:rescan` | invoke | `(rootId?) → RescanResult[]` |
| `local-agent:validate` | invoke | `(agentId) → LocalAgentValidation` |
| `local-agent:open-path` | invoke | `(OpenLocalAgentPathInput) → { success: true }` |
| `local-agent:roots-list` | invoke | `() → AgentRootDto[]` |
| `local-agent:root-add` | invoke | `() → { cancelled: true } \| { cancelled: false; root: AgentRootDto }` — **takes no path** |
| `local-agent:root-remove` | invoke | `(rootId) → { pruned: number }` |
| `local-agent:draft` | invoke | `(agentId) → DraftLocalAgentResult` — the post-scaffold AI draft. Belongs to the Agents tab slice, not this one; separate from `:create` because the folder must exist the instant the user asks, and a draft can take half a minute |
| `local-agent:changed` | main → renderer | `LocalAgentChangedPayload` — `{ rootId, agentId \| null, reason: 'watch' \| 'rescan' \| 'create' }` |

Every handler calls `userActivation.requireActivated()`, resolves its user with `getSettingsScopeUserId()`, and is wrapped by `ipcHandle()`. They hold no logic beyond that. `registerLocalAgentHandlers()` calls `localAgentService.configure(getSettingsScopeUserId)` first — the composition root — so the open-in roots provider and the watcher callbacks are wired before any handler can run.

`local-agent:root-add` is the pattern for any future path-taking channel: it opens `dialog.showOpenDialog` in main and, when the picked folder is non-empty and does not already look like a workshop, a native `showMessageBox` confirmation. Both prompts live in main, so nothing that reaches the channel can skip them.

## Services & Key Methods

### `src/main/services/localAgents/agentsHomeService.ts`
- `ensureHome(userId)` — resolve → create → register → install templates and `.cinna-kit/`. Idempotent; called from `list`, `rescan`, `listRoots`, `create` and `requireRoot`
- `installRoot(path)` / `syncWorkshopContract(path)` — templates, then the contract copy. The copy runs only when the workshop version is strictly older than the bundled one, and `clearContractCache()` is called only when a copy actually happened
- `listRoots(userId)` / `listRootRows(userId)` — DTOs (home first) and raw rows
- `rootPaths(userId)` — what the open-in guard is given. Deliberately does **not** call `ensureHome`: creating directories as a side effect of a launcher would be surprising, and a failure must mean "nothing is allowed"
- `requireRoot(userId, rootId?)` — the named root, or the home
- `needsAdoptionConfirmation(path)` / `assertNotOverlapping(userId, path)` — the two pre-adoption checks
- `addRoot(userId, rawPath, label?)` / `removeRoot(userId, rootId)` — the home cannot be removed (`root_immutable`)

### `src/main/services/localAgents/scaffoldService.ts`
- `slugify(name)` — delegates to `slugifyAgentName()` in `src/shared/localAgents.ts` (NFKD, strip combining marks, lower-case, hyphenate, ≤ 63 chars; `''` when nothing usable survives, which the caller reports rather than inventing a name). One rule in one place: a form preview that disagreed with the scaffolder would be worse than none
- `scaffoldAgent({rootPath, slug, name, description})` — copies `templates/agent/` into a hidden staging sibling, substitutes `{{TOKEN}}`s in the six markdown files only, applies the contract's `scaffold_ignore_files` renames, writes the manifest from the **parsed** template (not text substitution — a description containing a quote would produce invalid JSON), then renames into place. Any failure removes the staging directory
- `installRootTemplates(rootPath)` — creates `Local/` and `Cloud/`, copies root template files, never overwrites an existing one
- `isAgentFolder(dir)`

### `src/main/services/localAgents/scannerService.ts`
- `scanAgentFolder(agentDir, root)` — one folder → `LocalAgentDto`. Never throws
- `listAgentDirs(rootPath)` — `Local/*/`, dot-entries skipped, symlinks `stat`ed. `null` means the root could not be listed
- `scanRoot(userId, root)` — the full scan and index rebuild. Returns `{agents, rootMissing, indexed, pruned}`
- `scanRootCached(userId, root)` — what the read paths use
- `markRootDirty(rootId)` / `markAllRootsDirty()` — the cache's **exact** invalidation. Every path that can change a folder marks its root dirty; nothing else serves stale data. Before this cache existed, `local-agent:list` re-walked, parsed, validated and re-indexed every agent in every root synchronously on every call — and the renderer refetches on every change push, so watcher bursts compounded
- `readEnvKeys(agentDir)` / `readStatus(agentDir, statusFile)` — exported for tests; names-only and frontmatter-only respectively

Duplicate manifest ids: the first folder alphabetically wins the row; later claimants stay in the returned list marked `invalid` with a finding naming the other folder, so the page can say which two folders claim one identity.

### `src/main/db/agents.ts` — the index transaction
- `replaceFolderIndex(userId, rootId, entries, unresolvedPaths, rootPath)` — upsert every scanned folder, then prune. One transaction, so a mid-scan failure leaves the old index intact. Never writes `enabled`
- `pruneFolderRows(tx, userId, rootId, keep, protectedPaths, rootPath)` — the three survival conditions of [Pruning](folder_index.md#pruning-three-conditions-one-rule). Written select-then-delete rather than one `NOT IN` so the count is exact, matching `syncRemote`'s shape
- `updateFolderIndex(userId, agentId, patch)` — the single-folder counterpart, for a watcher-driven rescan. Refreshes `localPath` and `localRootId` too: a folder renamed in place keeps its manifest id, so it is the same row at a new path, and leaving the old path behind would strand `locate()` until a full root scan happened
- `pruneFolderIndexForRoot(userId, rootId)` — the unscoped prune, for removing a root

### `src/main/services/localAgents/watcherService.ts`
- `configure(deps)` — injected `rescanAgent`, `rescanRoot`, `agentIdForPath`, `agentIdsForRoot`, so this module never imports the scanner and the two cannot cycle. Installs the `will-quit` hook
- `classifyEvent(rootPath, filename)` → `{kind:'ignore'} | {kind:'root'} | {kind:'agent', dir}` — exported because it *is* the rule, and it must be testable without a filesystem race
- `watchRoot(root)` / `refreshRoot(rootId)` / `unwatchRoot(rootId)` / `stopAll()` / `watchedRootIds()`
- Constants: `DEBOUNCE_MS = 400`, `REARM_DELAY_MS = 2000`, ignored segment `app-data`, fallback sub-directories `docs` and `credentials` (the latter because `.env` presence is what flips `credentials_needed` → `ok`; only key names are ever read from it)
- Deferral: the per-agent branch uses `turnLock.whenFree(agentId, …)`; `runWholeRootRescan()` waits on the first held lock in the root and re-invokes itself on release

### `src/main/services/localAgents/turnLock.ts`
- `acquire(agentId, owner)` → handle with an idempotent `release()` carrying a monotonic token, so a stale handle cannot free a lock someone else has since taken. Throws `turn_in_progress` rather than queueing
- `withLock(agentId, owner, fn)` — releases in a `finally`
- `isLocked(agentId)`, `whenFree(agentId, fn)`, `releaseAll()` (shutdown and tests only)

### `src/main/services/localAgents/localAgentService.ts`
- `configure(getUserId)` — registers the open-in roots provider and the watcher deps. Runs once, from the IPC registrar
- `list(userId)` — cached scan per root + `watchRoot`, then `overlayEnabled`
- `overlayEnabled(userId, agents)` — folds the row's `enabled` back onto every scanned snapshot
- `get(userId, agentId)` — always a fresh scan; the agent page is watched while editing
- `locate(userId, agentId)` — id → `{root, agentDir}` **through the index row**, never from a renderer-supplied string
- `reindexAgent(userId, root, agentDir)` — single-folder update; falls back to a full `scanRoot` when the folder has no row yet, because only `replaceFolderIndex` inserts
- `rescan(userId, rootId?)`, `create(userId, input)`, `updateField(userId, input)`, `validate(userId, agentId)`, `openPath(userId, input)`, `listRoots`, `addRoot`, `removeRoot`
- `writeTextIfUnchanged()` (module-private) — the prompt-document counterpart of `manifestIo.writeIfUnchanged`, reusing `manifestIo.stampsMatch` rather than re-implementing the comparison. Atomic: temp → `fsync` → rename
- Field limits: name 255, description 2000, ≤ 20 example prompts of 2000, router trigger 2000, status command 1024, prompt document 512 KB

### `src/main/services/agentService.ts` — seams 2 and 3
- `listMerged()` — the default-scope filter now admits `source === 'folder'` beside `'local'`
- `findAgent()` — dispatch is by id prefix: `remote:` → profile scope, everything else (`folder:` and bare nanoids alike) → default scope. There is no `scope` column and none was added
- `setEnabled()` — a folder agent updates its row directly, like a hand-added A2A agent
- `upsert()` — rejects a `folder:` id the way it rejects `remote:`
- `delete()` — a folder-sourced row throws `folder_immutable`
- `resolveEndpointIfNeeded()` — returns **`string | null`**, `null` for `source === 'folder'`. Null rather than a throw because "no endpoint" is this agent's normal state, not a misconfiguration; null rather than `''` so the compiler forces every caller to decide
- `resolveAccessToken()` — returns `undefined` for `source === 'folder'` before touching the keystore

**This cannot regress A2A.** Both branches are guarded on `source`, a column no existing row can hold `'folder'` in — the value is only ever written by `replaceFolderIndex`. The two `null`-handling call sites are `src/main/ipc/agent_a2a.ipc.ts` (posts a user-facing error and closes the port) and `src/main/services/a2aAsMcpProvider.ts` (returns an `isError` tool result); both are net-new branches, not changes to existing ones.

## Renderer

`src/renderer/src/hooks/useLocalAgents.ts` holds no derived state: every query re-reads the folder through main, and every mutation writes the freshly scanned agent straight into the cache. `useLocalAgentWatch()` subscribes to `local-agent:changed` for the app's lifetime and invalidates the list (plus the named agent, when the payload has one). Nothing polls.

`useUpdateLocalAgentField()` must pass the stamp for **the file that update writes** — `agent.stamps[fieldFilePath(update)]`. The rejection when it no longer matches (`isStaleWriteError(error)`) is the reload prompt's trigger and must be surfaced, not retried.

`AgentRootDto.contractVersion` is resolved **per root**: a workshop carrying its own `.cinna-kit/` runs on that copy, so Settings reports what the root resolves rather than what the app bundles.

## Configuration

| Setting | Where | Notes |
|---|---|---|
| `localAgentsHome` | `src/shared/appSettings.ts`, default `''` in `src/main/db/appSettings.ts` | `''` means the built-in default `~/Documents/CinnaAgents`. Kept as a string, not `string \| null`, so the service's `typeof` check works |

Validation happens twice, on purpose:

- **On the way in**, `appSettingsService.VALUE_CHECKS.localAgentsHome` runs `assertUsableRoot`. Every setting was a boolean until this one, and a boolean is fully described by its type; a filesystem path is not. Rejecting at the boundary means the user is *told*, rather than saving a value that is silently ignored forever
- **On every read**, `agentsHomeService` re-validates and falls back to the default. The generic `settings:set` channel type-checks but cannot know what a plausible agents folder is

`appSettingsRepo.getAll()` also drops any stored row whose parsed value no longer matches its key's declared type — the store is untyped at rest and the schema is now heterogeneous.

The contract root, template trees and `layout.json` come from `src/main/kit/contractStore.ts`; see [Kit Contract (tech)](kit_contract_tech.md).

## Security

- **Secrets.** Only variable *names* are read from `credentials/.env`; no value is read, returned or logged. `app-data/desktop.json`'s `agentToken` stays in main — the renderer receives `hasAgentToken: boolean`
- **`local-agent:root-add` takes no path.** The native dialog in main is the only source of a new root
- **`pathRules` vs `pathGuard`.** `src/main/services/pathGuard.ts` is a TTL allowlist of picker/drop-returned paths for the file-ingest domain; `src/main/services/localAgents/pathRules.ts` answers "may this be a root" and "is this inside a root". Different questions, different lifetimes — do not merge them
- **`assertUsableRoot`** requires a string, absolute, < 4096 chars, NUL-free, `..`-free path under `homedir()`, `tmpdir()` or a removable-media prefix, and re-checks the `realpath` where the path exists. `tmpdir()` is permitted deliberately: it is where the test suite builds real workshops, and a guard that cannot be exercised end-to-end is a guard nobody trusts
- **`resolveWithinRoot`** rejects absolute and climbing agent-relative paths, and re-checks containment after resolving symlinks — a link inside an agent folder must not let a reveal escape it
- **Refusals log lengths, never paths**, so the log cannot be used as a filesystem-layout oracle
- **The open-in guard is closed by default.** `localAgentService.configure()` is what registers the real roots provider; before it runs every open-in request is refused with `no_roots`. See [Open in Tools (tech)](open_in_tools_tech.md)
- **The renderer never names a folder.** `locate()` derives every agent path from the index row

## Error Codes

`LocalAgentError` (`src/main/errors.ts`): `not_found`, `root_not_found`, `root_immutable`, `invalid_path`, `already_exists`, `invalid_input`, `file_modified`, `turn_in_progress`, `write_failed`. Kit-level failures keep using `KitError` (`manifest_modified`, `manifest_invalid_json`, `contract_missing`, …); `folder_immutable` is on `AgentErrorCode`, deliberately distinct from `remote_immutable` whose renderer story ("managed by Cinna sync") would be wrong here.

A stale write reports **two** codes because two writers raise it — `KitError('manifest_modified')` from `manifestIo.writeIfUnchanged` and `LocalAgentError('file_modified')` from `writeTextIfUnchanged`. Both are listed in `STALE_WRITE_ERROR_CODES`, both mean "reload before saving", and neither may be retried. A single `invalid_input` for both would leave the page unable to tell a bad value from an assistant's concurrent edit.

## Testing Notes

- `src/main/db/migrations/migrations.test.ts` drives the **real** chain through `node:sqlite`: replay from empty, `agent_roots` + the folder columns exist, `PRAGMA foreign_key_check` clean, a second and third run are no-ops, a populated database re-migrates cleanly
- Watcher tests must **drain and reset before asserting** — macOS FSEvents replays pre-arm changes, so a test otherwise sees its own setup writes and fails for the wrong reason. The same replay is why a rescan must be idempotent in production
- Probe adversarially rather than reading, and mutation-check any security test: on APFS a metadata-only pre-check can pass by luck and mask a broken content hash, which is how two stamp tests were found to prove nothing
