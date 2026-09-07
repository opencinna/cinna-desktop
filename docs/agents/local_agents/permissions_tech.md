# Local Agent Permissions — Technical Details

Implementation reference for [Local Agent Permissions](permissions.md). The engine's own behaviour — how a pattern is matched, which rule wins, what the shell tool is gated on — is **not** restated here; see [The OpenCode Engine Contract](opencode_contract.md) §2 and §4.

Path convention as elsewhere in this folder: `src/...` is this repository; `app-data/desktop.json` is inside an agent folder; `/api/...` is a path on the local engine, reachable only through `engineManager.request`.

## Read this first if you are changing the profile

Three of these produce a silent, green-suite failure — and each fails in the direction of **allow**.

1. **Never write `**` in a pattern.** The matcher is not a glob (contract §2). `**/.env` requires a slash and misses a root-level `.env`, which is exactly what a resource is: `path.relative(worktree, file)` with the worktree set to the agent folder. Use `*.env`. `configGenerator.test.ts` asserts no pattern in `read`/`edit`/`write` contains `**`
2. **Inside one permission name, `'*': 'allow'` comes first.** Resolution is `findLast` over the concatenated rules — last match wins, not most specific — and `fromConfig` preserves object key order. Put the narrow shapes above the catch-all and they are dead
3. **`always` must never be posted to the engine.** Two locks: `rememberIfAlways` on the answer path (`agent_a2a.ipc.ts:46`) converts it, and `LocalAgentTurnRunner.reply` (`:591`) downgrades any stray one to `once` and logs at `error`. Removing either leaves a user-global row authorising every folder agent, and no test at the HTTP fake would see it

## File Locations

### Shared
- `src/shared/localAgentRequests.ts` — the whole permission wire contract and every matching rule. `PERMISSION_TOOL_NAME` (`:36`), `PERMISSION_ID_PREFIX`/`QUESTION_ID_PREFIX` (`:42-43`), `isEngineRequestId()` (`:64`), `REQUEST_PARK_TIMEOUT_MS` (`:84`), `PermissionGrantScope` (`:150`), `LocalPermissionGrant` (`:153`), `StoredPermissionGrant` (`:172`), `permissionGrantKey()` (`:183`), `permissionGrantPatterns()` (`:205`), `permissionGrantMatches()` (`:238`), `isPermissionGranted()` (`:264`), `describePermissionAction()` (`:291`), `describeGrantScope()` (`:317`), `PermissionReply` (`:343`), `LocalPermissionRequest` (`:363`), `parsePermissionRequest()` (`:372`). **Type-only plus pure functions** — imported from main and renderer alike, so it must pull in no runtime dependency
- `src/shared/kit/manifest.ts:84` — `AgentRuntimeRef.permissions`, the manifest's override block; `:183` — `DESKTOP_STATE_FILE`, the file the Permissions card names

### Main process
- `src/main/engine/configGenerator.ts` — the static profile. `SECRET_FILES` (`:218`), `IDENTITY_FILES` (`:239`), `CONVERSATION_PERMISSIONS` (`:244`), `mergePermissions()` (`:667`), applied per agent entry at `:543`
- `src/main/services/localAgents/permissionGrantService.ts` — the desktop's own store. `list()` (`:56`), `covers()` (`:70`), `remember()` (`:90`), `forget()` (`:110`), `forgetAll()` (`:120`). Reads disk on every call, deliberately uncached
- `src/main/services/localAgents/desktopStateService.ts:66` — `DesktopState.permissionGrants`; `:107-124` — the coercion, which drops a row naming no action or pattern and reads a missing `scope` as `exact`
- `src/main/services/localAgents/localAgentService.ts:788` — `listPermissionGrants`; `:800` — `forgetPermissionGrant`; `:807` — `forgetAllPermissionGrants`. All three go through `locate()`, which is what proves the agent belongs to this user **before** a folder path is derived
- `src/main/services/agentTurn/index.ts:158` — `localDeps.isGranted`, the reading half; `:179` — `rememberPermissionGrant()`, the writing half, placed here so `agent_a2a.ipc.ts` does not pull the folder stack into its import graph
- `src/main/services/agentTurn/turnStream.ts` — where an ask is either written or auto-answered. `PendingRequest` (`:57`, with `request?` and `auto?`), `TurnStreamOptions` (`:169`), `noteRemembered()` (`:198`), `permissionAsked()` (`:484`), `permissionDecisionText()` (`:647`)
- `src/main/services/agentTurn/localAgentTurnRunner.ts` — `AUTO_REPLY_RETRY_MS` (`:106`), `LocalTurnDeps.isGranted` (`:143`), the `TurnStream` construction that injects it (`:292`), `park()` (`:481`), `autoAllow()` (`:530`), `deliverAutomatic()` (`:560`), `reply()` (`:591`)
- `src/main/services/agentTurn/pendingRequests.ts` — `Entry.request` carries the engine's ask; `RequestResolution` gains `remembered?` on the permission variant; `owner()` returns the ask alongside the ids
- `src/main/ipc/agent_a2a.ipc.ts:46` — `rememberIfAlways()`; `:347` — `agent:answer-request`; `:405` — where the conversion happens, between `owner()` and `resolve()`
- `src/main/ipc/local_agent.ipc.ts:219` — `local-agent:grants-list`; `:225` — `local-agent:grant-forget`; `:239` — `local-agent:grants-clear`

### Preload
- `src/preload/index.ts:564` — `window.api.agents.answerRequest(...)`, whose result widened to `{ok, reason?, remembered?}`
- `src/preload/index.ts:1186` — `grantsList`; `:1189` — `grantForget`; `:1192` — `grantsClear`

### Renderer
- `src/renderer/src/components/chat/PermissionRequestBlock.tsx` — the transcript widget. Three buttons, per-button in-flight state, the wider-than-the-ask scope line, and the decision record
- `src/renderer/src/components/chat/MessageStream.tsx:347` — where it is mounted; `:353` — `onAnswer={answerPermission}`
- `src/renderer/src/components/agents/local/PermissionsCard.tsx` — the agent page's Permissions tab body
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx` — `AgentPageTab` now has five members; the Permissions entry carries a count badge
- `src/renderer/src/hooks/useLocalAgents.ts:69` — `localAgentGrantsKey`; `:196` — `useLocalAgentGrants`; `:215` — `useForgetAgentGrants`
- `src/renderer/src/hooks/useAgentRequests.ts` — `AnswerOutcome`; `answerPermission` / `answerQuestion` now resolve with it, and the optimistic removal happens **after** the refusal check

### Tests
- `src/main/services/localAgents/permissionGrantService.test.ts` — the store against a real temp folder: a folder that has never run, a remembered decision answered from disk afterwards, a scope-less row read as the narrowest, one grant per resource so one can be revoked without the other, unrelated keys in `desktop.json` left alone, a malformed row dropped rather than displayed, and `forgetAll` doing no write when there is nothing to forget
- `src/main/ipc/agent_a2a.answerRequest.test.ts` — the answer path: `always` stores the rule and settles as `once`; a store that refuses still allows the action and reports `remembered: false`; `once` and `reject` pass through untouched; an `always` for a request whose ask was never recorded invents no grant
- `src/main/engine/configGenerator.test.ts` — the profile, asserted entry by entry, plus the no-`**` rule and the secret-file denies on `read`/`edit`/`write`
- `src/main/services/agentTurn/turnStream.test.ts` — no block written for an ask a standing grant covers; "says who remembered a decision, and never mixes the two stores up" (the desktop's line vs an engine-side `always` from another client)
- `src/main/services/agentTurn/localAgentTurnRunner.test.ts` — a permission answer posted as OpenCode's own enum; `always` never posted whatever the runner is settled with; the ask carried into the registry; an ask a standing grant covers answered without parking or rendering; and the automatic allow retried then rejected rather than leaving the turn parked
- `src/renderer/src/utils/localAgentRequests.test.ts` — every matching rule: a URL remembered by origin and everything else verbatim, an asterisk the model wrote kept as part of the string, the whole-action fallback, a key a URL's colon cannot split, prefix-only origin coverage, exact match including metacharacters, all-resources-not-any, no carry across actions, and what the button promises
- `src/renderer/src/components/agents/local/PermissionsCard.test.tsx` — the fixed paragraph with nothing remembered, the manifest-override sentence and its absence, "nothing yet" withheld while loading, a listed grant, a row dropped on revoke, and a refusal that survives the row that raised it

## Storage

**No table and no column.** Grants live in the agent folder's `app-data/desktop.json` under `permissionGrants`, keyed `<action>::<pattern>`.

`::` and not `:` because a pattern is very often a URL, which carries a colon of its own — a key that split ambiguously would make "forget this grant" delete a different one.

Written through `desktopStateService.patch`, which is the same atomic write (temp file, `fsync`, `rename`) the session copy uses. `permissionGrantService.remember` therefore throws `LocalAgentError('write_failed')` on a bad disk; `rememberPermissionGrant` catches it and returns `false`.

## IPC Channels

| Channel | Signature | Notes |
|---|---|---|
| `agent:answer-request` | `({requestId, reply?, answers?}) → {ok, reason?, remembered?}` | `remembered` is present only for a permission answered `always`. Outcome as **data**, never a rejection — a thrown error loses its code across `ipcMain.handle` and again across `contextBridge` |
| `local-agent:grants-list` | `(agentId) → StoredPermissionGrant[]` | Newest first |
| `local-agent:grant-forget` | `({agentId, key}) → StoredPermissionGrant[]` | Answers with the list it leaves, so the card does not refetch to stop showing a removed row |
| `local-agent:grants-clear` | `(agentId) → StoredPermissionGrant[]` | Always `[]` |

All three `local-agent:*` channels are activation-gated and derive the folder path in main from the agent id. **The renderer never supplies a path** — the same rule `local-agent:open-credentials` follows, and for the same reason: these read and write a file inside an agent folder, and the only proof that folder is the caller's is `localAgentService.locate`'s ownership check on the id.

`local-agent:grant-forget` takes an optional payload (`data?.agentId`) so a payload that never arrived fails as `not_found` from the service, with the code the renderer knows, rather than as a `TypeError` the bridge flattens into an anonymous `Error`.

## Ordering constraint on the answer path

`agent:answer-request` writes the grant **before** delivering the answer, and that is only safe because everything from `pendingRequests.owner()` to `pendingRequests.resolve()` is synchronous. `resolve` can still answer `null` — the turn was cancelled between the two — and a grant would then exist for an answer the user is told did not land. Nothing can interleave today. **An `await` inserted anywhere between them makes it real**, and the write cannot simply move after `resolve`, because the resolution has to carry `remembered` into the transcript.

## The auto-answer path, end to end

1. `permission.v2.asked` reaches `TurnStream.permissionAsked` (`:484`)
2. The `LocalPermissionRequest` is built from the event first, then `options.isGranted?.(request)` is consulted
3. On a hit it returns `{asked: {kind:'permission', requestId, request, auto: true}}` and **returns before `messageState` is called** — `messageState` creates a message entry as a side effect, and an ask that renders nothing must not leave an empty message behind for the accumulator to carry. No part, no `requestMessage` entry, no `pendingRequests` registration
4. The runner branches on `update.asked?.auto` (`:377`) to `autoAllow` (`:530`) instead of `park`
5. `deliverAutomatic` (`:560`) posts `once`; on failure waits `AUTO_REPLY_RETRY_MS` (500 ms, overridable via `LocalTurnDeps.autoReplyRetryMs` **in tests only**) and posts once more; on a second failure posts `reject`
6. The engine's `permission.v2.replied` then finds no message for the id and settles silently — the same path a request answered in another window takes

## Configuration

| Constant | Where | Value | Why |
|---|---|---|---|
| `CONVERSATION_PERMISSIONS` | `configGenerator.ts:244` | see [permissions.md](permissions.md#business-rules) | The static profile. Same for every folder agent unless its manifest overrides it |
| `SECRET_FILES` | `configGenerator.ts:218` | `credentials/.env`, `*.env`, `*.pem`, `*.key` → `deny` | Spread into `read`, `edit` **and** `write`. `credentials/.env` is redundant against `*.env` and listed anyway, so a reader need not run the matcher in their head |
| `IDENTITY_FILES` | `configGenerator.ts:239` | `cinna-agent.json`, `docs/WORKFLOW_PROMPT.md` → `ask` | Exact relative paths, because that is what the tools name | <!-- nocheck -->
| `AUTO_REPLY_RETRY_MS` | `localAgentTurnRunner.ts:106` | 500 ms | A stutter, not an outage. An outage ends the turn through `onClosed` |
| `REQUEST_PARK_TIMEOUT_MS` | `src/shared/localAgentRequests.ts:84` | 10 min | Bounds an abandoned dialog. **Does not apply to an auto-answered ask**, which is why that path retries instead |

`write` is kept as the defensive twin of `edit` and is **never consulted today**: the built-in write and apply-patch tools ask under `permission: "edit"` (the engine folds `edit|write|apply_patch` into one visible tool). A tool that did ask under `write` would otherwise land on the bare `'*': 'allow'`. Every assertion about writing a file is load-bearing on the `edit` entry.

## Security

- **The engine's saved-permission store is never written to.** `always` is converted on the answer path and downgraded again at the engine door. See the two locks in "Read this first"
- **A grant is derived from the engine's ask**, held in `pendingRequests`, never from the payload the renderer sends with the answer
- **Matching is string work.** No regular expression is built from a pattern, so a resource the model wrote cannot widen a rule and no hostile pattern can backtrack on the main thread
- **A missing `scope` coerces to `exact`**, the narrowest reading — a hand-edited or foreign row cannot widen itself by omission
- **A grant covers an ask only when *every* resource is covered**
- **Folder paths are derived in main from an ownership-checked agent id**, never sent by the renderer
- **`app-data/` is excluded from a publication** (`cloud_import_excludes`), so a grant cannot arrive pre-approved on another machine
- **Read the profile's own limits before quoting it as a boundary:** `bash: '*': 'allow'` means the shell is gated by command *text* only, and `external_directory` fires only for path arguments of a fixed command list. The secret-file and `rm`/`sudo` entries under `bash` are accident guards, not boundaries

## What is not verified

- **The profile has never been A/B tested across two agents with different `runtime.permissions` in one config.** What is verified is that a per-agent `permission` block takes effect at all (contract §4.1)
- **`findLast` and the `Wildcard.match` compilation were read out of the 1.18.27 binary, not exercised against it from the app.** They are the reason for two spellings in this file; a version bump should re-read both. The runbook is [contract §8](opencode_contract.md#8-runbook--how-to-re-verify)
- **The shell tool's gating** — full command text under `bash`, `external_directory` only for the path arguments of a fixed command list — was likewise read from the binary. Nothing in this repository's tests can fail if it changes
- **Pre-existing grants in OpenCode's own store are not detected.** No start-up read of `GET /api/permission/saved`, so a grant made outside this app allows without asking and nothing here runs (contract §4.2)
