# Local Agent Permissions — Technical Details

Implementation reference for [Local Agent Permissions](permissions.md). The engine's own behaviour — how a pattern is matched, which rule wins, what the shell tool is gated on — is **not** restated here; see [The OpenCode Engine Contract](opencode_contract.md) §2 and §4.

Path convention as elsewhere in this folder: `src/...` is this repository; `app-data/desktop.json` is inside an agent folder; `session/request_permission` is an ACP method, spoken over the agent process's own stdio and reachable only through that process's connection.

## Read this first if you are changing the profile

Three of these produce a silent, green-suite failure — and each fails in the direction of **allow**.

1. **Never write `**` in a pattern.** The matcher is not a glob (contract §2). `**/.env` requires a slash and misses a root-level `.env`, which is exactly what a resource is: `path.relative(worktree, file)` with the worktree set to the agent folder. Use `*.env`. `configGenerator.test.ts` asserts no pattern in `read`/`edit`/`write` contains `**`
2. **Inside one permission name, `'*': 'allow'` comes first.** Resolution is `findLast` over the concatenated rules — last match wins, not most specific — and `fromConfig` preserves object key order. Put the narrow shapes above the catch-all and they are dead
3. **`always` must never be posted to the engine.** The lock is `pickPermissionOption` (`src/main/agents/drivers/acp/acpPermissions.ts`), which **filters `allow_always` out of the agent's options before it searches** — a stronger guarantee than the two downgrades it replaced, because there is no id left to send. `rememberIfAlways` (`acpDriver.ts`) still converts the user's answer into a stored grant plus `once`. One `allow_always` writes a rule into the engine's own user-global store: no directory, no session, no agent

## File Locations

### Shared
- `src/shared/localAgentRequests.ts` — the whole permission wire contract and every matching rule. `PERMISSION_TOOL_NAME` (`:36`), `PERMISSION_ID_PREFIX`/`QUESTION_ID_PREFIX` (`:42-43`), `isEngineRequestId()` (`:64`), `REQUEST_PARK_TIMEOUT_MS` (`:84`), `PermissionGrantScope` (`:150`), `LocalPermissionGrant` (`:153`), `StoredPermissionGrant` (`:172`), `permissionGrantKey()` (`:183`), `permissionGrantPatterns()` (`:205`), `permissionGrantMatches()` (`:238`), `isPermissionGranted()` (`:264`), `describePermissionAction()` (`:291`), `describeGrantScope()` (`:317`), `PermissionReply` (`:343`), `LocalPermissionRequest` (`:363`), `parsePermissionRequest()` (`:372`). **Type-only plus pure functions** — imported from main and renderer alike, so it must pull in no runtime dependency
- `src/shared/kit/manifest.ts:84` — `AgentRuntimeRef.permissions`, the manifest's override block; `:183` — `DESKTOP_STATE_FILE`, the file the Permissions card names
- `src/shared/engine.ts:140` — `ClaudeApproval` (`'auto' | 'ask'`); `:150` — `DEFAULT_CLAUDE_APPROVAL` (`'auto'`); `:153` — `isClaudeApproval()`. Its own type and not the SDK's `PermissionMode`, so the two members that would remove the desktop from the decision are not expressible
- `src/shared/localAgents.ts:302` — `LocalAgentDesktopSummary.claudeApproval: ClaudeApproval | null`, the field the Permissions card reads

### Main process
- `src/main/engine/configGenerator.ts` — the static profile. `SECRET_FILES` (`:246`), `IDENTITY_FILES` (`:301`), `CONVERSATION_PERMISSIONS` (`:312`), `mergePermissions()` (`:775`), applied per agent entry at `:647`
- `src/main/services/localAgents/permissionGrantService.ts` — the desktop's own store. `list()` (`:56`), `covers()` (`:70`), `remember()` (`:90`), `forget()` (`:110`), `forgetAll()` (`:120`). Reads disk on every call, deliberately uncached
- `src/main/services/localAgents/desktopStateService.ts:66` — `DesktopState.permissionGrants`; `:107-124` — the coercion, which drops a row naming no action or pattern and reads a missing `scope` as `exact`; `:122` — `DesktopState.claudeApproval`; `:213` — its coercion through `isClaudeApproval`, anything else to null; `:429` — copied into `summarize()`
- `src/main/services/localAgents/localAgentService.ts:1648` — `setClaudeApproval(userId, agentId, approval: unknown)`. `locate()` first, then `invalid_input` for anything that is not `auto`, `ask` or null, then `turnLock.acquire(agentId, 'editor')` around `desktopStateService.patch(agentDir, kindOf(root), {claudeApproval})`, then `scannerService.markRootDirty` and a re-scan of the folder — the watcher acts on neither state file (a bare one is under `userData`, a kit one under `app-data/`, which it ignores by segment), so without the re-read the page would keep rendering the choice it had before the click
- `src/main/agents/drivers/index.ts` — the Claude launcher's `approval` dep, which reads the setting off the agent's desktop state and applies `DEFAULT_CLAUDE_APPROVAL` there, on null and on a throw alike
- `src/main/agents/drivers/acp/acpLaunchers.ts` — `setup.modeId = approval === 'auto' ? 'auto' : 'default'`, the one place the desktop's setting and the engine's modes meet, applied with `session/set_mode` after every `session/new` **and** every `session/load`
- `src/main/agents/drivers/acp/acpDriver.ts` — `noteModeFallback`, which compares the mode the session reports (`current_mode_update`, or a `config_option_update` for `mode`) against the one the launcher asked for, **in either direction**, and writes a notice when they disagree
- `src/main/services/localAgents/localAgentService.ts:860` — `listPermissionGrants`; `:872` — `forgetPermissionGrant`; `:879` — `forgetAllPermissionGrants`. All three go through `locate()`, which is what proves the agent belongs to this user **before** a folder path is derived — and they pass `kindOf(root)` alongside the path, because where an agent's grants are stored is a property of its root, not of its folder ([Bare Agents](bare_agents.md))
- `src/main/agents/drivers/index.ts` — `isGranted`, the reading half; `rememberGrant()`, the writing half. It resolves the agent's **DTO** rather than trusting a path from the caller
- `src/main/agents/drivers/acp/acpDriver.ts` — `answerPermission`, where an ask is either auto-answered from a grant (before any part is created, so nothing is written) or parked; and `acpMessages.ts`'s `askPermission` / `settlePermission`, which write the block and its decision line
- `src/main/agents/drivers/acp/acpPermissions.ts` — `toAcpPermissionRequest(launcher, params, toolName)`, the per-engine vocabulary (OpenCode's `toolCall.kind` → `edit`/`bash`/`webfetch`/`read`; Claude's own tool names, through `claudePermissions.toClaudePermissionRequest`), Codex namespaced complete request scopes, the OpenCode resource-field order, and `mintAcpRequestId`
- `src/main/agents/drivers/pendingRequests.ts` — `Entry.request` carries the engine's ask; `RequestResolution` — re-exported from `src/shared/localAgentRequests.ts`, because an `input_resolved` stream event carries it to the renderer — has `remembered?` on the permission variant; `owner()` returns the ask alongside the ids
- `src/main/ipc/agent_a2a.ipc.ts:139` — `agent:answer-request`, activation/payload validation and `inboxService.answerFromTranscript` routing
- `src/main/services/askDelivery.ts:67` — `deliverAnswer(userId, requestId, resolution)`, the synchronous ACP responder inside the shared durable `deliverAnswerWithCommit` path used by transcript and Inbox (`inbox:answer`, `src/main/services/inboxService.ts`; its own doc lands with the rest of the task work). `:72` — `pendingRequests.owner()`; `:115` — the call into `driverFor(row).respond`, or into `respondToOrphanedAsk` only when the agent's row is gone and the registration is ACP-origin. The conversion itself is `respondToAcpAsk` (`src/main/agents/drivers/acp/acpDriver.ts`) → `rememberIfAlways()`, between the registry lookup and the resolve — **synchronous, and the order is only safe because it is**: the grant is written before the park is settled, because the resolution has to carry `remembered` into the transcript. One function rather than two handlers precisely so what *Always allow* means cannot drift between the two surfaces that offer it
- `src/main/ipc/local_agent.ipc.ts:228` — `local-agent:grants-list`; `:234` — `local-agent:grant-forget`; `:248` — `local-agent:grants-clear`; `:579` — `local-agent:set-claude-approval`

### Preload
- `src/preload/index.ts:647` — `window.api.agents.answerRequest(...)`, which takes an `AskAnswerPayload` and resolves an `InboxAnswerResult` (`src/shared/inbox.ts`) — the same pair `window.api.inbox.answer(...)` uses, because durable replies from both surfaces land in `inboxService.answer` and `deliverAnswerWithCommit`. `{ok, reason?, code?, remembered?}`
- `src/preload/index.ts:1190` — `grantsList`; `:1193` — `grantForget`; `:1196` — `grantsClear`; `:1307` — `setClaudeApproval(agentId, approval)`

### Renderer
- `src/renderer/src/components/chat/PermissionRequestBlock.tsx` — the transcript widget. Three buttons, per-button in-flight state, the wider-than-the-ask scope line, and the decision record. Live when `(interactive || busy !== null) && requestId && !answered`: held live while its own answer is in flight, because the stream's `input_resolved` can turn `interactive` false before `onAnswer` resolves. A refused answer's error renders **below** the buttons, beside the scope hint, so neither moves a control under the pointer. `decision` is the runner's outcome line, from the paired `tool_result`, and replaces the buttons wherever it is set. `awaitingDecision` covers the gap before it: `holding = !live && awaitingDecision && !answered && !decision` keeps the live border, icon, heading and button row, every button disabled, so an ask settled by expiry or by another window keeps its height until its outcome line lands
- `src/renderer/src/components/chat/MessageStream.tsx:347` — where it is mounted; `:353` — `onAnswer={answerPermission}`. `requestId` is always `part.toolId`, and `interactive` alone says whether the ask is open. The streaming path passes the paired streaming `tool_result`'s text as `decision`, exactly as the persisted path does, and sets `awaitingDecision` when the block is not live, has no decision yet, the id is in `settledInputRequestIds`, and the chat is streaming — never on a replayed block, which would otherwise hold for ever if it recorded no outcome. `MessageStream` also passes `hold` to `useStickToBottom` while a top-level `reply` ask is unsettled in the chat store — see [Transcript Scrolling tech](../../chat/conversation_ui/scroll_following_tech.md)
- `src/renderer/src/components/agents/local/PermissionsCard.tsx` — the agent page's **Settings → Permissions** tab body. `:255` — `OpenCodeProfile`, the fixed profile paragraphs; `:351` — `ClaudeApprovals`, the two-setting paragraph, the **Approvals** select and its one-line error slot, rendered when the effective engine is Claude; Codex renders `CodexApprovals` with its independent default and `useSetCodexApproval` mutation
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx` — `AgentPageTab` now has five members; the Permissions entry carries a count badge
- `src/renderer/src/hooks/useLocalAgents.ts:73` — `localAgentGrantsKey`; `:200` — `useLocalAgentGrants`; `:219` — `useForgetAgentGrants`; `:485` — `useSetClaudeApproval`, which writes the returned DTO into the agent's own query with `setQueryData` — a refetch would show the old value for the round trip after the click
- `src/renderer/src/hooks/useAgentRequests.ts` — `AnswerOutcome`; `answerPermission` / `answerQuestion` now resolve with it, and the optimistic removal happens **after** the refusal check — from both sources that can call a block live: the poll's list and, through `resolveInputRequest`, the chat store's stream-announced asks, whose `input_resolved` echo has not arrived yet

### Tests
- `src/main/services/localAgents/permissionGrantService.test.ts` — the store against a real temp folder: a folder that has never run, a remembered decision answered from disk afterwards, a scope-less row read as the narrowest, one grant per resource so one can be revoked without the other, unrelated keys in `desktop.json` left alone, a malformed row dropped rather than displayed, and `forgetAll` doing no write when there is nothing to forget
- `src/main/ipc/agent_a2a.answerRequest.test.ts` — the answer path: `always` stores the rule and settles as `once`; a store that refuses still allows the action and reports `remembered: false`; `once` and `reject` pass through untouched; an `always` for a request whose ask was never recorded invents no grant. Through the driver: an answer for an agent whose row is gone is still delivered with no rule written, and an answer of the wrong kind is refused before any driver sees it. `src/main/agents/drivers/acp/acpDriver.test.ts` pins the same conversion at the driver's `respond`, from either folder driver
- `src/main/engine/configGenerator.test.ts` — the profile, asserted entry by entry, plus the no-`**` rule and the secret-file denies on `read`/`edit`/`write`
- `src/main/agents/drivers/acp/acpDriver.test.ts` — no block written for an ask a standing grant covers; the ask parked, announced once and released on every exit; *Always* stored before the park is settled; an expiry and a stop distinguished in the decision line
- `src/main/agents/drivers/acp/acpPermissions.test.ts` — `allow_always` filtered out of the options rather than deprioritised; an agent offering nothing usable answered `cancelled`; the two engines' vocabularies kept apart; the `filepath` / `filePath` pair both read
- `src/renderer/src/utils/localAgentRequests.test.ts` — every matching rule: a URL remembered by origin and everything else verbatim, an asterisk the model wrote kept as part of the string, the whole-action fallback, a key a URL's colon cannot split, prefix-only origin coverage, exact match including metacharacters, all-resources-not-any, no carry across actions, and what the button promises
- `src/renderer/src/components/agents/local/PermissionsCard.test.tsx` — the fixed paragraph with nothing remembered, the manifest-override sentence and its absence, "nothing yet" withheld while loading, a listed grant, a row dropped on revoke, and a refusal that survives the row that raised it; for a Claude agent, the profile sentence absent and the reviewer's described bluntly, no choice rendering as `auto`, a stored choice rendered, a pick held through the round trip over a live query, a refusal beside the control with the select back on the stored value, and no select on OpenCode
- `src/main/services/localAgents/desktopStateService.test.ts`, `localAgentService.test.ts` — the setting round-tripped for either kind of folder and stored where that kind's grants are; null kept as null; `bypassPermissions` on disk read as null; the setter refusing an unknown value and storing nothing
- `src/main/agents/drivers/acp/acpLaunchers.test.ts` — the approval setting mapped onto the session mode, set after both `new` and `load`; and `acpDriver.test.ts` — the fallback notice, in both directions

## Storage

Codex stores `codexApproval` beside `claudeApproval`, independently. The same `ClaudeApproval` type/guard validates `auto`, `ask` and null; unknown values become null, which Codex reads as `ask`. Kit and bare locations are unchanged and no database migration is needed.

**No table and no column.** Grants live in that agent's desktop-state record under `permissionGrants`, keyed `<action>::<pattern>` — `app-data/desktop.json` inside a kit folder, and a file under `<userData>/external-agents/` for a bare one, whose folder the desktop writes nothing into. Every `permissionGrantService` method therefore takes a `LocalAgentKind` beside the path; see [Bare Agents & External Roots](bare_agents.md#the-state-lives-outside-the-folder-and-the-root-decides-that).

`::` and not `:` because a pattern is very often a URL, which carries a colon of its own — a key that split ambiguously would make "forget this grant" delete a different one.

The Claude engine's **Approvals** setting sits in the same record as `claudeApproval` — `'auto'`, `'ask'` or null — for the reason the grants do: it is the desktop's own decision about a folder, not a fact about the agent, so it is never written into a manifest and never travels in a publication. Null is *no choice made* and is what a record that never had the field reads as; **any other value coerces to null**, so a hand edit reaching for the SDK's `bypassPermissions` reads as the default and not as the more permissive setting. The default itself (`DEFAULT_CLAUDE_APPROVAL`) is applied by the readers, never written in place of null.

Written through `desktopStateService.patch`, which is the same atomic write (temp file, `fsync`, `rename`) the session copy uses. `permissionGrantService.remember` therefore throws `LocalAgentError('write_failed')` on a bad disk; `rememberGrant` (`src/main/agents/drivers/index.ts:300`) catches it and returns `false`.

## IPC Channels

| Channel | Signature | Notes |
|---|---|---|
| `agent:answer-request` | `(AskAnswerPayload) → InboxAnswerResult` | `{ok, reason?, code?, remembered?}`. `remembered` is present only for a permission answered `always`; `code` is the refusal (`no_longer_waiting`, `not_owned`, `malformed`, …) so a surface branches on intent rather than on copy. Outcome as **data**, never a rejection — a thrown error loses its code across `ipcMain.handle` and again across `contextBridge`. `inbox:answer` takes and returns the same pair |
| `local-agent:grants-list` | `(agentId) → StoredPermissionGrant[]` | Newest first |
| `local-agent:grant-forget` | `({agentId, key}) → StoredPermissionGrant[]` | Answers with the list it leaves, so the card does not refetch to stop showing a removed row |
| `local-agent:grants-clear` | `(agentId) → StoredPermissionGrant[]` | Always `[]` |
| `local-agent:set-codex-approval` | `({agentId, approval: ClaudeApproval or null}) → LocalAgentOutcome<LocalAgentDto>` | Same ownership, validation and editor-lock path as Claude; patches `codexApproval`, re-scans and returns the fresh DTO. |
| `local-agent:set-claude-approval` | `({agentId, approval: ClaudeApproval \| null}) → LocalAgentOutcome<LocalAgentDto>` | Either kind of folder, unstamped. `input?.approval` is passed through **as it arrived**: null is a real answer, so a missing one is not turned into it here, and the service refuses anything that is not one of the two values or null (`invalid_input`). Also `not_found`, `turn_in_progress` |

All five `local-agent:*` channels are activation-gated and derive the folder path in main from the agent id. **The renderer never supplies a path** — the same rule `local-agent:open-credentials` follows, and for the same reason: these read and write a file inside an agent folder, and the only proof that folder is the caller's is `localAgentService.locate`'s ownership check on the id.

`local-agent:grant-forget` takes an optional payload (`data?.agentId`) so a payload that never arrived fails as `not_found` from the service, with the code the renderer knows, rather than as a `TypeError` the bridge flattens into an anonymous `Error`.

## Ordering constraint on the answer path

Durable transcript replies first route through `inboxService.answerFromTranscript`; existing rows share `inboxService.answer` with the Inbox and cannot escape a refused durable row via live fallback. `deliverAnswerWithCommit` invokes the synchronous ACP responder and immediately commits effective once with the actual remembered boolean plus aggregate task state before yielding, so the resumed ACP continuation observes settlement before its input_resolved/endTurn cleanup. The local grant write remains the existing synchronous filesystem step; it is not part of the SQLite transaction.

Optional asynchronous driver delivery is a separate contract: captured binding acceptance, exact durable transaction, then park release. Equivalent normalized answers join, uncertainty never resends, and accepted-but-uncommitted retry is local only. An asynchronous registration cannot enter the ACP responder or orphan fallback. See [driver reply delivery](../drivers/drivers_tech.md#captured-asynchronous-reply-delivery).

The ACP branch of `agent:answer-request` writes the grant **before** delivering the answer, and that window stays synchronous. It runs from `pendingRequests.owner()` — in `services/askDelivery.ts` since the inbox started sharing this path, not in the handler — through `findAgent` and `driverFor(row).respond`, to the `pendingRequests.resolve()` inside `respondToParkedAsk`. That is why `AgentDriver.respond` is synchronous by contract. `resolve` can still answer `null` — the turn was cancelled in between — and a grant would then exist for an answer the user is told did not land. Nothing can interleave today. **An `await` inserted anywhere on that path makes it real**, and the write cannot simply move after `resolve`, because the resolution has to carry `remembered` into the transcript.

**An answer is still delivered when the agent's row is gone.** Removing an agents folder prunes its rows without waiting for the turn lock, so a turn can still be parked on an agent `findAgent` no longer knows. The answer goes through `respondToOrphanedAsk` with no rule written: `always` settles as `once`, with `remembered: false`. Refusing the answer instead would leave the turn parked until the request expires.

## The auto-answer path, end to end

1. `session/request_permission` arrives on the connection and is routed to the turn that bound this session id
2. `AcpMessageStream.toolName(toolCallId)` supplies the tool name — **OpenCode's ask does not carry one**; its `title` is the file path on an edit ask — and `toAcpPermissionRequest` builds the `LocalPermissionRequest`
3. `deps.isGranted(folder.path, folder.kind, request)` is consulted **before anything is written**. An unreadable store means "ask the user", the safe direction
4. On a hit the answer is returned straight away: `pickPermissionOption(params.options, 'allow')` → `{outcome: {outcome: 'selected', optionId}}`. **No part, no registry entry, no `needs_input`, nothing in the transcript** — a block that appeared and answered itself milliseconds later would be a widget the user cannot act on, mid-stream
5. There is no retry and nothing to lose: the automatic answer *is* the response to the blocked request, where the HTTP runner had to POST it back and retry once if the post failed

## Configuration

| Constant | Where | Value | Why |
|---|---|---|---|
| `CONVERSATION_PERMISSIONS` | `configGenerator.ts:244` | see [permissions.md](permissions.md#business-rules) | The static profile. Same for every folder agent unless its manifest overrides it |
| `SECRET_FILES` | `configGenerator.ts:218` | `credentials/.env`, `*.env`, `*.pem`, `*.key` → `deny` | Spread into `read`, `edit` **and** `write`. `credentials/.env` is redundant against `*.env` and listed anyway, so a reader need not run the matcher in their head |
| `IDENTITY_FILES` | `configGenerator.ts:301` | `cinna-agent.json`, `docs/WORKFLOW_PROMPT.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md` → `ask` | Exact relative paths, because that is what the tools name. One list for both folder shapes, kit and bare, and all three bare instruction names rather than the one a folder resolved — so a kit agent's scaffolded `AGENTS.md` / `CLAUDE.md` ask too | <!-- nocheck -->
| `ACP_CANCEL_GRACE_MS` | `acpDriver.ts` | 3 s | The bounded wait for a `session/cancel` acknowledgement. The parked asks are answered **before** the cancel, so an agent blocked inside a permission request can unwind and read it |
| `REQUEST_PARK_TIMEOUT_MS` | `src/shared/localAgentRequests.ts` | 60 min | Bounds an abandoned dialog. **Does not apply to an auto-answered ask**, which is why that path retries instead |
| `DEFAULT_CLAUDE_APPROVAL` | `src/shared/engine.ts:150` | `'auto'` | What a Claude agent with no choice made runs on. `auto` because `default` asked for `ls`. Applied at read time, never written |

`write` is kept as the defensive twin of `edit` and is **never consulted today**: the built-in write and apply-patch tools ask under `permission: "edit"` (the engine folds `edit|write|apply_patch` into one visible tool). A tool that did ask under `write` would otherwise land on the bare `'*': 'allow'`. Every assertion about writing a file is load-bearing on the `edit` entry.

## Security

Codex action names are `codex:<kind>`. Execute grant resources are exact compound JSON of raw input, title, content and locations, preserving command/cwd/privilege and SOCKS host/protocol identity together. Edit requests retain all paths. Missing scope becomes an exact request-ID resource. `codexPermissions.test.ts` beside `acpPermissions.ts` pins these boundaries; see [Codex technical details](codex_engine_tech.md#security) for sandbox modes and test evidence.

- **The engine's saved-permission store is never written to.** `always` is converted on the answer path and downgraded again at the engine door. See the two locks in "Read this first"
- **A grant is derived from the engine's ask**, held in `pendingRequests`, never from the payload the renderer sends with the answer
- **Matching is string work.** No regular expression is built from a pattern, so a resource the model wrote cannot widen a rule and no hostile pattern can backtrack on the main thread
- **A missing `scope` coerces to `exact`**, the narrowest reading — a hand-edited or foreign row cannot widen itself by omission
- **An unknown `claudeApproval` coerces to null**, and the setter refuses one. The SDK's `bypassPermissions` and `dontAsk` are therefore unreachable from the select, the channel and the file alike; each would run every tool with no grant consulted and nothing in the transcript
- **On *Automatic* the CLI's reviewer is consulted before `canUseTool`, and across seven probes it declined nothing** — so the grants and the block are a backstop there, not a gate, and the card says so. `canUseTool` is passed on both settings all the same ([Claude contract §10](claude_contract.md#10-auto-mode--the-classifier-in-front-of-canusetool-and-what-it-approved))
- **A grant covers an ask only when *every* resource is covered**
- **Folder paths are derived in main from an ownership-checked agent id**, never sent by the renderer
- **`app-data/` is excluded from a publication** (`cloud_import_excludes`), so a grant cannot arrive pre-approved on another machine
- **Read the profile's own limits before quoting it as a boundary:** `bash: '*': 'allow'` means the shell is gated by command *text* only, and `external_directory` fires only for path arguments of a fixed command list. The secret-file and `rm`/`sudo` entries under `bash` are accident guards, not boundaries

## What is not verified

- **The profile has never been A/B tested across two agents with different `runtime.permissions` in one config.** What is verified is that a per-agent `permission` block takes effect at all (contract §4.1)
- **`findLast` and the `Wildcard.match` compilation were read out of the 1.18.27 binary, not exercised against it from the app.** They are the reason for two spellings in this file; a version bump should re-read both. The runbook is [contract §8](opencode_contract.md#8-runbook--how-to-re-verify)
- **The shell tool's gating** — full command text under `bash`, `external_directory` only for the path arguments of a fixed command list — was likewise read from the binary. Nothing in this repository's tests can fail if it changes
- **The Claude reviewer handing an ask on to `canUseTool` was never observed.** Every probe on *Automatic* was approved before the callback; the SDK's documentation says the hand-off exists. The block's behaviour behind the reviewer is verified only on *Ask every time*. And which models fall back to `default` is known from `haiku` alone — the notice is driven by what the CLI reports at init, not by a list
- **Pre-existing grants in OpenCode's own store are not detected.** There is no HTTP API left to read them from at all — the engine's saved-permission endpoint went with the server — so a grant made outside Cinna, in the user's own OpenCode, still silences an ask here and nothing reports it. Unchanged in substance by the transport, and now harder to fix than it was
