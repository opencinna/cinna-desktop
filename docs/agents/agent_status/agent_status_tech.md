# Agent Status — Technical Details

Covers both legs of the feature: the Cinna-remote leg (original) and the folder-agent leg added in Phase 7b of Local Agents.

## File Locations

### Main Process

| Purpose | File |
|---------|------|
| Service — both legs, error mapping, degradation, logging | `src/main/services/agentStatusService.ts` |
| Folder leg: STATUS.md → snapshot, severity derivation, running `status_refresh_command` | `src/main/services/localAgents/statusRefresh.ts` |
| STATUS.md reader (reused, not rebuilt) | `src/main/services/localAgents/scannerService.ts:185` — `readStatus()` |
| Command subprocess + turn lock (reused, not rebuilt) | `src/main/services/localAgents/commandService.ts:290` — `run()` |
| Folder-agent rows and folder location | `src/main/db/agents.ts:331` — `listFolder()`; `src/main/services/localAgents/localAgentService.ts:265` — `locate()` |
| Manifest read for `status_refresh_command` | `src/main/kit/manifestIo.ts` — `manifestPath()`, `readManifest()` |
| Status-file location (contract, never hard-coded) | `src/main/kit/layout.ts:46` — `status_file`; default `app-data/storage/STATUS.md` at `:101` |
| Validator rule: a `/run:` reference must resolve | `src/main/kit/validator.ts:976` |
| Normative status vocabulary | `resources/cinna-kit-contract/templates/agent/scripts/update_status.py:40` — `STATUSES` |
| IPC handlers (`agent-status:list`, `agent-status:get`) | `src/main/ipc/agent_status.ipc.ts:30` |
| IPC handler registration | `src/main/ipc/index.ts` — `registerAgentStatusHandlers()` |
| Remote-agent repository helpers | `src/main/db/agents.ts` — `listRemote()`, `getOwned()` (`:125`) |
| Typed domain error | `src/main/errors.ts` — `AgentStatusError`, `AgentStatusErrorCode` |
| Logger scopes | `agent-status` (service), `local-agent-status` (`statusRefresh.ts:39`) |
| Cinna JWT token | `src/main/auth/cinna-tokens.ts` — `getCinnaAccessToken(userId)` |
| Reauth signal | `src/main/auth/cinna-oauth.ts` — `CinnaReauthRequired` |

### Shared

| Purpose | File |
|---------|------|
| `status_refresh_command` on the manifest | `src/shared/kit/manifest.ts:117` |
| `/run:<name>` syntax | `src/shared/kit/manifest.ts:147` — `RUN_REFERENCE_PATTERN` |
| Parsed STATUS.md frontmatter | `src/shared/localAgents.ts:189` — `LocalAgentStatusSummary` |
| Folder-agent id predicate (drives the renderer's per-kind branching) | `src/shared/localAgents.ts:47` — `isFolderAgentId()` |

### Preload

| Purpose | File |
|---------|------|
| Bridge API | `src/preload/index.ts` — `api.agentStatus.list()`, `api.agentStatus.get({ agentId, forceRefresh? })` |
| Snapshot type (**declared twice** — here and in `agentStatusService.ts:18`; a field change means editing both) | `src/preload/index.ts:183` |
| `remoteError` on the **list result** (not on the snapshot, so the duplicated type was untouched) | `src/preload/index.ts:603` |

### Renderer

| Purpose | File |
|---------|------|
| Data hook (batch poll, re-raises partial failure) | `src/renderer/src/hooks/useAgentStatus.ts:92` — `useAgentStatus()` |
| Per-agent force refresh | `src/renderer/src/hooks/useAgentStatus.ts:156` — `useForceRefreshAgentStatus()` |
| Per-agent **re-read** (post-turn pull for a folder agent) | `src/renderer/src/hooks/useAgentStatus.ts:175` — `useRereadAgentStatus()` |
| Mass refresh, per-kind | `src/renderer/src/hooks/useAgentStatus.ts:223` — `useForceRefreshAllAgentStatuses()` |
| Cache shape + patch | `src/renderer/src/hooks/useAgentStatus.ts:15` — `AgentStatusCache`; `:264` — `patchAgentStatusCache()` |
| Typed client-side error | `src/renderer/src/hooks/useAgentStatus.ts` — `AgentStatusRequestError` |
| Severity palette, rank, `worstSeverity()` | `src/renderer/src/constants/agentSeverity.ts:6`, `:63` |
| Sidebar-footer activity icon (no account gate) | `src/renderer/src/components/agents/AgentStatusButton.tsx:12` |
| Footer mount point | `src/renderer/src/components/layout/Sidebar.tsx:175` |
| Overlay (grid + detail + "Refresh all" + failure strips) | `src/renderer/src/components/agents/AgentStatusOverlay.tsx` |
| Grid/detail card views, `sortByUrgency` | `src/renderer/src/components/agents/statusViews.tsx:64` |
| Tray popup | `src/renderer/src/components/tray/TrayPanel.tsx` — see [Menu-Bar Tray](../../ui/tray/tray.md) |
| Menu-bar icon painter | `src/renderer/src/hooks/useTrayIcon.ts` |
| Post-turn status pull | `src/renderer/src/hooks/useChatStream.ts:228` |
| Overlay mount point | `src/renderer/src/App.tsx` |
| UI state (`agentStatusOpen`, `agentStatusDetailId`, `pendingAgentId`) | `src/renderer/src/stores/ui.store.ts` |
| Pending-agent effect + focus-return effect | `src/renderer/src/components/layout/MainArea.tsx` |
| CSS tokens (severity + overlay) | `src/renderer/src/assets/main.css` |

## Database Schema

No schema changes in either phase. The remote leg matches backend UUIDs against `agents.remote_target_id`; the folder leg reads `agents` rows with `source = 'folder'` and takes everything else off disk. **Files are the truth, the database is an index** — nothing here writes to SQLite.

## IPC Channels

| Channel | Type | Params | Returns |
|---------|------|--------|---------|
| `agent-status:list` | handle | — | `{ success: true, items: AgentStatusSnapshot[], remoteError: { code, message } \| null }` or `{ success: false, code, error }` |
| `agent-status:get` | handle | `{ agentId, forceRefresh? }` | `{ success: true, item: AgentStatusSnapshot \| null }` or `{ success: false, code, error }` |

Error `code` values: `reauth_required` · `not_found` · `forbidden` · `remote_unreachable` · `unknown`. 7b added **no new channel**, so preload registration tests were untouched; `remoteError` is an added field on the existing list result (`agent_status.ipc.ts:53`).

`success: true` with a non-null `remoteError` is a **partial** success — rows exist and one leg failed. The renderer re-raises it as the same `AgentStatusRequestError` a total failure produces, so `error.code` keeps meaning what consumers already assume; what changes is that `data` can be non-empty at the same time.

## Backend Endpoints (remote leg only)

| Endpoint | Used from | Notes |
|----------|-----------|-------|
| `GET /api/v1/agents/status` | `agentStatusService.list()` | Cache-only, safe to poll. Every agent the authenticated user owns. |
| `GET /api/v1/agents/{agent_id}/status?force_refresh=<bool>` | `agentStatusService.get()` | `force_refresh=true` wakes a suspended env and re-reads STATUS.md. 429 is swallowed (returns `null`). |

**Both legs guard `response.json()`.** A 200 whose body is not JSON — a captive portal, a proxy login page — passes the `!response.ok` check and then rejects with a raw `SyntaxError`; `list` degrades on it and `get` throws a typed `remote_unreachable`. `get` carried the unguarded call for a while after `list` was fixed, and was milder only because the *renderer* had meanwhile learned to render an unrecognised rejection — which is not something a call site should rely on.

Bearer token resolved per request via `getCinnaAccessToken(userId)`. The folder leg makes no network call of any kind.

## Services & Key Methods

| Method | File | Purpose |
|--------|------|---------|
| `agentStatusService.list(scope)` | `agentStatusService.ts:272` | Folder leg first, then remote. Returns `AgentStatusListResult` (`:218`). |
| `degraded(err)` | `agentStatusService.ts:288` | The degrade decision: keep folder rows and report `remoteError`; **rethrow when `folderItems.length === 0`**. |
| `listFolderSnapshots(defaultUserId)` | `agentStatusService.ts:123` | Every folder agent's on-disk status. Never throws; runs no command; one `fetchedAt` for the batch. |
| `folderStatus(defaultUserId, agentId, name, forceRefresh)` | `agentStatusService.ts:167` | Refresh-then-read. A `busy`/`aborted` refusal is swallowed like a 429; a genuine failure throws. |
| `agentStatusService.get(...)` | `agentStatusService.ts:385` | Resolves the row through `agentService.findAgent` (`:397`), then branches on `source` at `:402` — **above both** the `getCinnaContext` guard and the `remoteTargetId` filter. |
| `getCinnaContext(userId)` | `agentStatusService.ts:73` | `null` for any non-`cinna_user` (or one with no server URL) — the gate the folder leg had to be placed above. |
| `errorFromStatus(status, statusText, url)` | `agentStatusService.ts` | HTTP status → `AgentStatusError` (404 → `not_found`, 403 → `forbidden`, 5xx → `remote_unreachable`, else `unknown`). |
| `severityFromState(state)` | `statusRefresh.ts:100` | Free-form word → severity. Table at `:57`. |
| `toStatusSnapshot(...)` | `statusRefresh.ts:131` | `LocalAgentStatusSummary` → `AgentStatusSnapshot`; sets `environmentId`, `raw`, `prevSeverity` deliberately. |
| `readFolderAgentSnapshot(...)` | `statusRefresh.ts:190` | Contract lookup + `readStatus` + map. `null` for "no STATUS.md" **and** "contract unreadable". Never throws. |
| `runStatusRefresh(userId, agentId, command, signal?)` | `statusRefresh.ts:265` | Executes only `/run:<name>`; returns `StatusRefreshOutcome` (`:211`). |
| `readStatus(agentDir, statusFile)` | `scannerService.ts:185` | The one frontmatter reader. `updatedAt` pick list at `:213`. |
| `commandService.run(...)` | `commandService.ts:290` | The subprocess. `CommandRunOutcome.busy` at `:262`. |

### Ordering rules that are load-bearing

1. **`list`: folder leg before the `getCinnaContext` guard, before the network fetch, and before the `remoteTargetId` filter.** Three gates, not the one the plan named. A branch below any of them is dead code for exactly the local-only user Local Agents exists to serve.
2. **`get`: folder branch above the same two gates** (`agentStatusService.ts:402`), after the row is resolved by `agentService.findAgent`.
3. **`folderStatus`: run the command, *then* read.** Reading first would show the status the refresh was about to replace.
4. **`listFolderSnapshots` skips a folder it cannot locate; `folderStatus` throws for the same condition.** Two answers to one question — *who asked* — not an inconsistency: a poll nobody aimed at that agent should lose one row rather than the panel, and a Refresh aimed at exactly that agent owes a reason. Both sides say so in the code.
5. **The batch path runs no command.** `commandService.run()` takes the per-agent turn lock as owner `'command'`, so a 45-second tick that ran a refresh would make editor saves and the user's next message refuse on a timer.

### Scoping: two user ids, one object

The service serves **two differently-scoped kinds of agent**, and a single user id can only ever be right for one of them:

- **Folder agents are default-scoped.** Every write goes through `local_agent.ipc.ts`, which passes `getSettingsScopeUserId()` — unconditionally `DEFAULT_SCOPE_USER_ID` (`src/main/auth/scope.ts:15`) — so their rows are shared machine resources available from every profile.
- **Remote agents, the Cinna account and its tokens are profile-scoped** (`scope.ts:23`).

So both handlers pass an `AgentStatusScope` (`agentStatusService.ts:248`) carrying `defaultUserId` and `profileUserId`, built in one place at `src/main/ipc/agent_status.ipc.ts:22`. The list path uses `scope.defaultUserId` for the folder leg and `scope.profileUserId` for the remote one. `get` is the ambiguous case — the incoming id may name either kind — so it resolves the row through `agentService.findAgent(defaultUserId, profileUserId, agentId)` (`agentStatusService.ts:397`), the established resolver already used at `src/main/ipc/agent_a2a.ipc.ts:175`, and hands the *scope the row was found in* to everything downstream (`localAgentService.locate` and `commandService.run` each do their own strict `getOwned`). **It is not a union query.** `findAgent` (`src/main/services/agentService.ts:238`) picks *one* scope from the id's shape — a `remote:` prefix means the profile scope, a `folder:` id or a bare nanoid means the default scope — and then does a single strict `getOwned` there. Reading it as "looks in both" would predict the wrong behaviour for an id that does not exist in the scope its shape names: the answer is `null`, not a fallback lookup. **The correctness of that dispatch is a standing constraint, not a local detail:** it holds only while every id shape stays in correspondence with the scope its rows live in. A future id shape that is profile-scoped without carrying the `remote:` prefix would resolve in the default scope — answering `null`, or worse resolving a *different* row that happens to share the id — and nothing about the call site would look wrong. Distinguish this from a genuine union like `getAgentLookupScope()`, which returns an array the caller iterates.

**Why an object rather than two strings:** two same-typed positional parameters transpose silently, and the resulting failure is invisible — `listFolder(<profile id>)` is a valid call returning `[]`, which reads as "this user has no folder agents" rather than as a bug. That is not hypothetical: the folder leg was first wired with the profile scope alone and was silently dead for **every user except the Default profile**, with the whole suite green because the repository fakes ignored `userId` and every test used a single id. The suite now uses two distinct ids for exactly this reason.

### `StatusRefreshOutcome`

Three states, and the middle one exists so the caller can stay silent:

| State | Meaning | Caller behaviour |
|-------|---------|------------------|
| `ran` | Command exited clean; STATUS.md may have changed | Read and return |
| `skipped` | No command configured, agent **busy** (turn lock held), or **aborted** | Read and return; report nothing |
| `error` | Non-zero exit, `/run:` name not in the catalog, folder gone, binary missing, ceiling fired, or an unsupported command form | Throw; the UI names the reason |

`busy` is what makes a turn-lock refusal structurally distinguishable from a script exiting non-zero — before it, `commandService` reported both the same way.

### Severity derivation

Anchored on `update_status.py:40` (`STATUSES = ("ok", "attention", "error", "unknown")`), which normalises anything else to `unknown` *before writing*, so those four are normative.

| Frontmatter word (trimmed, lower-cased) | Severity |
|---|---|
| `ok`, `healthy`, `green`, `pass`, `passing`, `success` | `ok` |
| `attention`, `warning`, `warn`, `degraded`, `blocked` | `warning` |
| `error`, `failed`, `failure`, `fail`, `critical` | `error` |
| `info` | `info` |
| `unknown`, **and any unrecognised word** | `unknown` |
| absent / empty / whitespace | `null` |

`null` sorts below `unknown` (`sortByUrgency` maps it to `-1` against `SEVERITY_RANK`'s `unknown: 0`) and is skipped by `worstSeverity`. The `unknown`-not-`ok` rule is asserted directly in `statusRefresh.test.ts`.

### Snapshot fields with no local counterpart

| Field | Value | Why |
|-------|-------|-----|
| `environmentId` | `'local'` | `statusViews.tsx:281` reads `null` as "the remote environment is not running" and prints so; over a file read off local disk that is a visible falsehood. A non-null sentinel says "not applicable" without adding a field to a type declared twice. |
| `remoteAgentId` | the local id | No remote id exists; nothing renders the field. |
| `raw` | `null` | Nothing reads it; `body` carries the markdown. |
| `prevSeverity` / `severityChangedAt` | `null` | Severity history is server-side; a single read cannot observe a transition. |
| `reportedAt` / `reportedAtSource` | frontmatter, else file mtime, else `null` | `file_mtime` is labelled as inferred in both card and detail (`statusViews.tsx:134`). |
| `hasStructuredMetadata` | any of summary/state/timestamp present | "Is there metadata we could use", not "did a `---` block parse". |

## Renderer Components & Hooks

| Component / hook | File | Role |
|------------------|------|------|
| `useAgentStatus()` | `useAgentStatus.ts:92` | `refetchInterval: 45_000`, `staleTime: 15_000`, `refetchOnWindowFocus`. **No `enabled` gate** — it ran only for `cinna_user` (with the interval off otherwise), which made every surface dead for a local-only account. |
| `useForceRefreshAgentStatus()` | `useAgentStatus.ts:156` | `forceRefresh: true` for both kinds — for a folder agent that means running its command. Drives the per-card and detail Refresh. |
| `useRereadAgentStatus()` | `useAgentStatus.ts:175` | `forceRefresh: false`. Used by the post-turn pull for folder agents: no lock, no subprocess. |
| `useForceRefreshAllAgentStatuses()` | `useAgentStatus.ts:223` | `Promise.allSettled` over cached ids with `forceRefresh: !isFolderAgentId(agentId)` (`:237`) — remote forced, folder re-read. Returns `{ refreshed, failed, reauthRequired }`; falls back to a list refetch when nothing is cached. |
| `patchAgentStatusCache()` | `useAgentStatus.ts:264` | Upsert by `agentId`; a standing `remoteError` survives the patch, since a per-agent success says nothing about the batch route. |
| `AgentStatusButton` | `AgentStatusButton.tsx:12` | Activity icon + worst-severity dot. Mounted unconditionally at `Sidebar.tsx:175`. |
| `AgentStatusOverlay` | `AgentStatusOverlay.tsx` | Fade state machine, both mutations, `reauthNeeded`, and the failure-shape decision `const degraded = sorted.length > 0` (`:282`). |
| `ReauthErrorStrip` / `FailureStrip` | `AgentStatusOverlay.tsx:61`, `:99` | The strip forms of the two error panels, rendered *above* the rows. The reauth strip carries the same Re-authenticate button as the panel. |
| `FailureStrips` | `AgentStatusOverlay.tsx:129` | The one component that renders all three strips (reauth, batch failure, per-agent failure), used by **both** render branches. The per-agent error was first added inside the grid branch of `{detail ? <DetailView/> : …}` only, so the detail view — wired to the same mutation — kept the silent-Refresh defect the fix claimed to close, and the tray is the shortest path there (`useTrayActions.openStatusDetail` opens the overlay straight into detail). Adding a fourth strip to one branch only is now impossible. |
| per-card refresh state | `AgentStatusOverlay.tsx:177`, `:178` | A **set keyed by agent id**, not the shared mutation's `variables` — which names only the most recent call, so clicking card B stopped card A's spinner and re-enabled its button mid-flight, inviting a second click whose run is refused by the turn lock, swallowed as `busy`, and returned as a success. The handler uses **`mutateAsync`, not `mutate` with a per-call `onSettled`**: a `useMutation` observer keeps only the *latest* call's callbacks, so with two refreshes in flight the first one's `onSettled` never fires and its card spins for the life of the overlay. **The first implementation of this fix used `mutate(id, { onSettled })` and had the very concurrency bug it was written to fix**, one layer down. **Only the adversarial *concurrent* test caught it — a single-refresh test would have passed**, which is the part worth carrying: it tells the next person what kind of test to write, not just which API to use. Same shape as a decorative test, where an implementation and its absence are indistinguishable until someone constructs the hostile input. The next person here will reach for `mutate` first. The `refreshingIds` early-return is **deliberately untested**: today the card's `disabled={refreshing}` already swallows a second click, so no test can tell the guard from its absence. It stays because the shield is the *caller's* choice — a future call site that renders its own control and forgets `refreshing` would start a concurrent run whose turn-lock refusal returns `{success: true}`. |
| per-agent refresh error | `AgentStatusOverlay.tsx:266` | `perAgentError` — the previously silent failure path. `useForceRefreshAgentStatus` resolves `{success:false}` rather than rejecting (IPC error codes do not survive a thrown `invoke`), and the only consumer was an `onSuccess` that early-returned on it. |
| `TrayPanel` | `TrayPanel.tsx:71`, `:118` | Same `degraded` rule, same strip; `reauth_required` gets its own wording since the popup cannot run OAuth. Refresh-all tooltip at `:110`. |
| `useChatStream` post-turn pull | `useChatStream.ts:228-229` | `isFolderAgentId(agentId)` → re-read; else, for a Cinna account, force refresh. |
| `useTrayIcon` | `useTrayIcon.ts` | Paints the glyph + worst-severity dot to a canvas and pushes it to main. Reads the same hook, so it inherits the widened gate. |

Both "Refresh all" tooltips now read *"Refresh all — wakes Cinna environments; re-reads local agents' STATUS.md"* (`AgentStatusOverlay.tsx:348`, `TrayPanel.tsx:110`). They previously claimed "force refresh from running environments", which was never true for an agent with no environment.

## Tests

The rows below are not decoration. Three claims **this document makes** — that a `null` severity sorts below `unknown`, that a standing `remoteError` survives a per-agent cache patch, and that the poll runs at 45 s — describe behaviour that nothing in the suite would have failed on if it stopped being true. **A doc claim with no test behind it is exactly as fragile as a code comment with no test behind it**, and this feature has a defect of that shape on record: `patchAgentStatusCache` carried a comment asserting an invariant no test defended, one token away from silently clearing the degradation strip. Where a row below names a claim this document makes, that claim is enforced rather than asserted.

| Suite | Covers |
|-------|--------|
| `src/main/services/localAgents/statusRefresh.test.ts` | Severity table incl. "unrecognised is never `ok`", the three `null`/`unknown` outcomes, mtime fallback, sentinel fields, `/run:` only, busy/aborted as no-ops, a non-zero exit as an error. |
| `src/main/services/agentStatusService.test.ts` | Both gate placements (mutation-pinned separately), degrade-vs-throw, the three degrading remote paths (fetch, non-OK, `CinnaReauthRequired`) plus the non-JSON 200, refresh-then-read ordering, unreadable manifest. **Scope-sensitive**: `defaultUserId` and `profileUserId` are deliberately different strings, since collapsing them makes every scope bug in the file untestable. |
| `src/main/ipc/agent_status.ipc.test.ts` | Net-new with the rejected-invoke fix, and where the **guard-placement** claim's evidence lives: an inactive session resolves as `{success:false}` on **both** handlers rather than rejecting; reading the session itself failing does not reject either (which is why `statusScope()` sits inside the `try` too); an active session still answers normally. This is the main-process half — the renderer half is the catch-all in `useAgentStatus.ts`. |
| `src/main/services/agentStatusService.join.test.ts` | The **one** unmocked end-to-end test: a real STATUS.md, in the bytes `render_status()` emits, through to a `list()` result. The suites either side of that seam mock each other, and a convention mismatch hiding in the join is exactly how the `timestamp` defect survived one level down. |
| `src/renderer/src/hooks/useAgentStatus.test.tsx` | The query is issued for a purely local account, for one not signed in yet, and still for a Cinna account — the three the dropped gate would have silenced; partial failure re-raised while `data` stays populated; the two per-agent fetches proven to be different requests; per-kind fan-out in "Refresh all". |
| `src/renderer/src/components/agents/AgentStatusOverlay.test.tsx` | Strip vs panel by row count; reauth strip; the per-agent failure message — as a **differential pair** whose two halves differ by one line (`agentStatusDetailId`), because the grid test passed while the detail view said nothing. Also the concurrency tests for per-card refresh state. One test here was **thrown away rather than kept**: it clicked a refreshing card twice and asserted one call, and deleting the guard it was written for failed nothing, because the button's own `disabled` already swallowed the second click. It now asserts the mechanism that actually stops the second run — the button going disabled — and dies under two mutations. |
| `src/renderer/src/components/tray/TrayPanel.test.tsx` | Same degradation rule in the popup. |
| `src/renderer/src/components/layout/Sidebar.agentStatusButton.test.tsx` | The footer button renders without a Cinna account. |
| `src/renderer/src/hooks/useChatStream.statusRefresh.test.tsx` | Folder agent → re-read, remote → force refresh. |
| `src/main/services/localAgents/scannerService.test.ts` | `timestamp` accepted, using the byte shape `render_status()` produces rather than a synonym. |
| `src/renderer/src/components/agents/sortByUrgency.test.ts` | The ordering claim this document makes: a `null` severity sorts below every real one, **below `unknown` specifically** — the pair the rule exists for — and two silent agents break their tie by recency rather than by chance. |
| `src/renderer/src/hooks/useAgentStatus.test.tsx` (extended) | The two remaining unenforced claims: a per-agent success **keeps** a standing `remoteError`, so one card refreshing cannot clear the degradation strip; and the query really refetches on the 45-second cadence the cache-only route is sized for. |

## Configuration

No user-facing settings (the tray icon itself is gated by `enableTrayIcon` — see [Menu-Bar Tray](../../ui/tray/tray.md)). Hardcoded values worth knowing:

| Value | Location | Rationale |
|-------|----------|-----------|
| Poll interval **45 000 ms** | `useAgentStatus.ts` — `refetchInterval` | Within the 30–60 s range the integration spec recommends for the cache-only route. |
| Stale time **15 000 ms** | `useAgentStatus.ts` — `staleTime` | Lets the overlay reuse a cached value when mounted close to a poll. |
| Fade duration **350 ms** | `AgentStatusOverlay.tsx` — `FADE_MS` | Drives the transition and the post-close unmount timer. |
| Tray min spin **500 ms**, flash hold **500 ms** | `TrayPanel.tsx` | An instant cached refetch still reads as a deliberate action. |
| Remote force-refresh limit **1 / 30 s / env (event-driven only)** | Server-enforced | Desktop treats any 429 as a silent no-op. |
| Severity-changed "recent" window **60 min** | `statusViews.tsx` — `DetailView` | Threshold for the `Changed from …` line. |
| Command timeout / output cap / turn-lock ownership | `commandService.ts` | Owned by the commands feature — see [`/run:<name>` — Catalog Commands](../local_agents/commands_tech.md). |

## Security

- **Cinna JWT** — resolved per call by `getCinnaAccessToken(userId)`; tokens never cross the IPC boundary.
- **Ownership** — the per-agent path is gated by `agentRepo.getOwned(userId, agentId)` (`src/main/db/agents.ts:125`), a strict `userId` equality. What matters is **which** user id it runs against: that is chosen by `agentService.findAgent` from the id's shape, not passed in by the caller, so a caller cannot widen the check by handing it a different scope. The batch remote path is scoped by the JWT and additionally filtered to locally-known rows; the batch folder path is a default-scope query by construction.
- **Activation gate** — both handlers call `userActivation.requireActivated()` **inside** their `try`, not above it. It throws a plain `Error`, and a handler that lets one escape produces a *rejected* invoke, which IPC flattens to a message and a stack — the code is gone, exactly what the `ipcHandle` convention exists to prevent (return the code as data rather than throw it). An inactive session must come back as `{success:false, code}`, because an unclassified rejection is rendered by both surfaces as an empty, healthy panel. `statusScope()` is inside the `try` for the same reason: it reads the session, which an unactivated one has no business answering.
- **Only catalogued commands run.** A `status_refresh_command` is executed only in the `/run:<name>` form, resolved against the agent's own `docs/CLI_COMMANDS.yaml`. Not because shell is dangerous — the commands feature already spawns agent-supplied shell from the same folder — but because a catalog command is *displayed, validated and user-started*, while a status refresh runs unseen on the user's behalf. <!-- nocheck -->
- **Markdown rendering** — `react-markdown` without `rehype-raw`; raw HTML in any STATUS.md, local or remote, is neutralized.
- **Error shape** — `AgentStatusError` crosses IPC through `ipcHandle()` with its `code` intact, which is what lets the renderer offer re-authentication instead of a generic error.

## Observability

`agent-status` scope (remote leg): pre-request (info), OK response (info, with `totalItems` / `localMatches` / `folderItems` / `durationMs`), non-OK (warn), network error (error), 429 (info), and **`agent status list: remote leg failed, folder rows kept`** (warn) on every degrade.

`local-agent-status` scope (folder leg, `statusRefresh.ts:39`): contract unreadable (warn), unsupported command form (warn, with the command text), refresh failed (warn, with the resolved name and the error), refresh deferred because the agent is busy (debug). `listFolderSnapshots` logs a skipped agent (warn) and an unreadable index (error) under the `agent-status` scope.

## Known gaps in the implementation

- **No live run.** Nothing in Phase 7b has been exercised through `npm run dev`.
- **`useTrayIcon` has no test of its own.**
- **`runStatusRefresh`'s `signal` parameter has no production caller** — `folderStatus` calls it with three arguments (`agentStatusService.ts:205`), so the abort branch is covered only by `statusRefresh.test.ts`.
- **The severity mapping assumes the contract's vocabulary.** An agent inventing its own word lands on `unknown` by design.
