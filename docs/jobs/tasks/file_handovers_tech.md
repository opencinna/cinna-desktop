# File Handovers — Technical Details

Business logic and the reasoning behind every rule: [File Handovers](file_handovers.md).

## File Locations

**Shared (main *and* renderer read it)**

- `src/shared/handovers.ts` — the whole contract, and it is **pure**: no Node built-ins (so digests are computed by whoever read the bytes), no logging, no throwing. Every parse failure comes back as data with a reason the caller can show. Constants (`HANDOVERS_DIR`, `HANDOVER_BRIEF_FILE`, `HANDOVER_REPORT_FILE`, `HANDOVER_REVISIONS_DIR`, `HANDOVER_ID_PATTERN`, `MAX_HANDOVER_DEPTH`, `HANDOVER_PACKET_CAP`), the parsers (`parseHandoverBrief`, `parseHandoverReport`, `parseHandoverRevision`), the vocabularies (`HandoverState`, `HandoverReportStatus`, `HandoverWarning` with `HANDOVER_WARNING_KINDS` — the union is a type and a type cannot be iterated, so the list is what a test walks to prove the renderer covers every kind — `HandoverAutoRefusal`, `HandoverIgnoreCheck`), the gate (`handoverGateQuestion`, `handoverGateRequestId`, `parseHandoverGateRequestId`, `HANDOVER_GATE_OPTIONS`), the protocol texts (`HANDOVER_HOW_TO_REPORT`, `handoverRequesterSection`, `handoverProtocolParagraph`) and the packet builders (`buildHandoverReturnPacket`, `buildHandoverRevisionTurn`, `buildHandoverGroupPacket`)
- `src/shared/turnOrigin.ts` — `TurnInputOrigin` (`user | runner | handover`) and `isDesktopAuthored()`, the one predicate behind "system row, no title generation, no A2A message id"
- `src/shared/localAgents.ts` — `LocalAgentDesktopSummary.handovers`
- `src/shared/inbox.ts` — `InboxEntry.deliveryOwner` gains `handover`

**Main — database**

- `src/main/db/migrations/handovers.ts` — `migrateHandovers()`, registered from `migrations/index.ts` *after* `migrateTasks` (it references `tasks`). No DML: a `CREATE TABLE IF NOT EXISTS`, then a guarded `ALTER TABLE ADD COLUMN` for every column added after the table's first shape (`ADDED_COLUMNS`), then the indexes. The table is unreleased, so no shipped profile needs the ALTERs — but the feature grew a column at a time across development builds and `IF NOT EXISTS` does nothing to a table that already exists, so a machine that ran an intermediate build would be short every later column for ever and every read of a row would throw. The list is the nullable and defaulted part of the create; `NOT NULL` with no default cannot be added by ALTER anyway. The indexes come **after** the ALTERs because `idx_handovers_group` is over `origin_chat_id`, and indexing a column the table does not have yet would abort the whole migration pass on exactly the databases the ALTERs exist for
- `src/main/db/schema.ts` — the `handovers` table, and `task_input_requests.delivery_owner` widened to `driver | runner | handover`
- `src/main/db/handovers.ts` — `handoverRepo`: `insert`, `byAgentAndHandoverId` (**unscoped**, because it must match the unique index), `getById`, `byTaskId`, `listForAgent`, `listForGroup`, `orphaned`, `update`, `toDto`
- `src/main/db/taskInputRequests.ts` — `open()`'s invariant now treats `handover` like `runner` (null agent, `resume: 'reply'`), and `expireNextMessageForTask` expires handover gates too

**Main — services**

- `src/main/services/handoverService.ts` — intake, reconcile, the gate and its answer, report and outcome application, revisions, groups, the lost-run sweep. Built as `createHandoverService(deps)` over injected collaborators, with the production wiring at the bottom
- `src/main/services/handoverWake.ts` — the return packet and the group packet, and the turn that carries them
- `src/main/services/handoverRevisions.ts` — a `revisions/NNN.md` as a follow-up turn on the executor's own chat
- `src/main/services/handoverChatQueue.ts` — `createChatTurnQueue()`: "start a turn in that chat, when that chat is free", shared by the two above
- `src/main/services/handoverGit.ts` — `handoverGit.check(agentDir)`, and the static `.gitignore` reading for a machine with no `git`
- `src/main/services/handoverScheduler.ts` — a second `createLocalScheduleScheduler` instance running `scanAll` on the wall-clock minute
- `src/main/services/chatRouting.ts` — `chatAnswersToAgent()`, lifted out of `followUpTurnService` so the follow-up path and the handover path ask one question in one place

**Main — touched**

- `src/main/services/localAgents/watcherService.ts` — the `handover` watch target, its own pending set and its own flush arm
- `src/main/services/localAgents/localAgentService.ts` — `setHandovers()`, `handoversCheck()`, and the watcher's `onHandover` wiring (dynamic import, because `handoverService` imports this service)
- `src/main/services/localAgents/desktopStateService.ts` — `DesktopState.handovers`, its coercion and its summary field
- `src/main/services/localAgents/promptAssembly.ts` — `DesktopPromptContext.agentId`, the agent-id bullet and the requester protocol section on every folder prompt: `assembleAgentPrompt` (kit), `assembleBareAgentPrompt` (a bare folder on the isolated path) and `assembleBareNativePrompt` (a bare folder on its own runtime, where the section arrives through the `trailingSections` seam after the desktop's context block)
- `src/main/services/threadContextService.ts` — `buildTurnHeader()`
- `src/main/services/runExecutionService.ts` — `inputOrigin` widened, `turnHeaderFor()`, the header prepended in front of the catch-up packet, and the recovery marker suppressed for desktop-authored turns
- `src/main/services/messageRoutingService.ts` — `origin` widened; a desktop-authored send stores a system row and generates no title
- `src/main/services/taskExecutionService.ts` — `TaskStartOptions.reuseChatId`, `adoptChat()`, and `completed` on the main-side start result
- `src/main/services/inboxService.ts` — the `reply`-branch allowlist
- `src/main/index.ts` — the scheduler started, refreshed on focus, suspended on sleep, stopped on quit
- `src/main/errors.ts` — `handovers_not_ignored`

**Renderer**

- `src/renderer/src/hooks/useHandovers.ts` — `useHandoverForTask()`, polling while the row is unsettled
- `src/renderer/src/hooks/useLocalAgents.ts` — `useHandoversCheck()`, `useSetHandovers()`
- `src/renderer/src/utils/handoverText.ts` — `handoverStateLabel` and `handoverStateTitle` (the one-line phrase and the longer sentence on hover), `handoverWarningText` (a sentence for every kind in `HANDOVER_WARNING_KINDS`; the suffixed kinds append main's own reason rather than translating it, since it is already written for a human), `handoverNoteText` (the warning, or the withdrawal that has no warning), `handoverIgnoreText` and `handoverAutoOverriddenText` (git's verdict, or the stored `auto` that is not in force), `handoverFolderPath` and `handoverFolderPathShort` (elided around the handover id, which is never cut; the separator is taken from the stored path so a Windows path stays one). Every function total: an unfamiliar value from a newer build still renders something true
- `src/renderer/src/components/tasks/TaskView.tsx` — the Requested by / Handover / Folder / Note rows in the existing Details panel
- `src/renderer/src/components/agents/local/PermissionsCard.tsx` — the `HandoversSetting` block, bare folders only
- `src/renderer/src/components/chat/AskUserQuestionBlock.tsx` / `AnswerQuestionsModal.tsx` — `askedByDesktop` and `allowCustomAnswer`: who the card says is asking, the question's `header` as a badge, and the synthetic *Other* option dropped. `InboxView.tsx` passes `askedByDesktop={entry.deliveryOwner === 'handover'}` — the one place that screen reads the delivery owner, and it changes copy and an option, not the rendering
- `src/renderer/src/components/chat/SystemTurnBlock.tsx` — a `system` row as a collapsed `Cinna Desktop · <first line>` disclosure
- `src/renderer/src/components/chat/MessageStream.tsx` — the `system` branch, and `addressedAgentId` read off system rows so file references resolve in the right folder

## Database Schema

`handovers` (`src/main/db/migrations/handovers.ts`) — one row per `.cinna/handovers/<id>/` directory the desktop has seen.

| Group | Columns |
|---|---|
| identity | `id`, `user_id` (profile scope), `agent_id` (executor), `folder_path`, `handover_id` |
| links | `task_id`, `origin_agent_id`, `origin_chat_id`, `origin_task_id`, `group_id`, `run_id`, `wake_run_id` |
| decision | `depth`, `execution`, `state`, `refusal_reason`, `warning` |
| reconciliation | `brief_digest`, `brief_stat`, `report_digest`, `report_stat`, `report_status`, `summary`, `revisions_delivered`, `last_scanned_at` |
| gate | `gate_request_id`, `gate_chat_id` |
| times | `woke_at`, `brief_missing_at`, `created_at`, `updated_at` |

Four column decisions carry weight:

- **`UNIQUE(agent_id, handover_id)`** is the dedupe, and therefore the database's own statement of "one brief, one task, forever". The handover id is the requester's and unique per folder only, so the pair is the identity.
- **`agent_id` carries no foreign key.** A bare agent's row id is derived from its path, so removing a folder from the agents list drops the `agents` row and putting it back re-creates the same id. A cascade would delete the history of work done in a folder because the user tidied a list; a restrained key would refuse the re-adoption.
- **`task_id` is `ON DELETE SET NULL`.** A deleted task must not make the brief look new again — the unique index can only stop a second task if the row survives. A row with a null task reads as `skipped` in the DTO, whatever the column says.
- **`brief_missing_at` is a column, not a state.** A withdrawn handover keeps every other fact it had — the task still names the work and the requester — and only the row that points at `.cinna/handovers/<id>` has to stop claiming that directory is there. It is also what tells a **Withdrawn** label from a **Skipped** one, since both end in `skipped`. Cleared when a brief with that id is read again.

`brief_stat` and `report_stat` are `mtimeNs:size` as the last scan found the two files; `revisions_delivered` is a JSON array of file names rather than a table, because a revision has no state of its own beyond "sent or not" and is never read apart from its row. `summary` is the last thing the executor said, kept on the row so a group packet can be built from its members without reading five tasks.

Indexes: `(user_id, state)`, `(task_id)`, `(agent_id)`, `(user_id, origin_chat_id, group_id)`.

`handoverRepo.update` **does not bump `updated_at` when the only field written is `last_scanned_at`**: the scan touches every live row every minute, and the lost-run check reads exactly that column — a freshness it can never outlive is a check that never fires.

Digests are sha256 of the file bytes, computed in main. They are the only reason a rescan of an unchanged folder writes nothing at all — and `brief_stat`/`report_stat` (`fileStamp`, nanoseconds because two writes in one millisecond are ordinary and `size` alone misses a same-length rewrite) are why an unchanged file is not opened or hashed in the first place. A file that cannot be stat'ed has a null stamp, which matches nothing and always falls through to the read: a stamp may only ever skip work, never decide anything.

## IPC Channels

| Channel | Signature | Notes |
|---|---|---|
| `handover:for-task` | `{ taskId }` → `HandoverDto \| null` | Profile-scoped. Keyed by task because that is what the page has, and because `tasks.origin` is a closed `local \| remote` union that cannot say "handover" |
| `local-agent:set-handovers` | `{ agentId, handovers }` → `LocalAgentOutcome<LocalAgentDto>` | **Async**, unlike the approval setters: `auto` is checked against git before it is granted, and a refusal returns `handovers_not_ignored` |
| `local-agent:handovers-check` | `{ agentId }` → `LocalAgentOutcome<HandoverIgnoreCheck>` | The evidence behind the `auto` option, so a surface can explain the refusal *before* the click |

There is deliberately **no channel for creating a handover.** The feature's claim is that anything able to write a file can ask for work; an IPC seed would be a second way in that the file contract does not have. Preload exposes `window.api.handovers.forTask` and the two `window.api.localAgents` methods.

## Services & Key Methods

`src/main/services/handoverService.ts`

- `scanAll(scope)` — every bare, enabled agent of the profile, one folder at a time. Never throws, and one folder's failure never reaches the next: this runs on a minute tick, and a scan that threw would stop scanning the user's other projects silently
- `scanAgent(scope, agent)` — **serialized per agent** over `scanFolderPass`: `activeScans` holds the pass in flight and `queuedScans` at most one follow-up, which every further caller shares. A pass awaits `git` and a start, so the minute tick and a watch event would otherwise run two passes over one folder and act on the same rows twice — the same report applied twice, the origin woken twice
- `scanFolderPass(scope, agent)` — reads the folder, then for each brief **re-reads the row** (`getById`) instead of using the map taken at the top of the pass, intakes or reconciles, settles the briefs that have gone (`briefRemoved`, also re-read), and finally sweeps lost runs off a freshly listed set. The dedupe read `byAgentAndHandoverId` is unscoped to match the unique index, so a row belonging to another profile is recognised and skipped
- `scanFolderNow(agentDir)` — what a watch event asks for. Resolves the scope itself and does nothing at all when no profile is activated
- `intake(...)` — row and task in **one transaction**, the row **first**: `taskService.create` exports the task's handoff file to `<userData>/tasks/<id>.md`, and a filesystem write inside a transaction survives the rollback the unique index causes, so the loser of a race used to leave a file for a task that never existed. Then the decision: over the depth cap → `refused` (and the group is checked, since a refused member is a finished member); a readable report already there → `waiting_external` and the report applied at once; brief `auto` + agent setting `auto` + git allows → start; otherwise the gate, with an `auto_not_allowed:<reason>` warning when the brief had asked. A unique-index violation means a concurrent scan won the race, and the loser does nothing
- `reconcile(...)` — stamp then digest comparison; `brief_missing_at` cleared when a brief is back; `brief_edited` recorded and never acted on; a changed report clears `woke_at`/`wake_run_id` (so a genuinely new report may wake again) and is applied; `retryGate` for a row whose gate never opened; then revisions, **after** the report
- `retryGate(...)` — reopens a gate that failed to open. Only for a `seen` row with a live task, no `gate_request_id` and `report_status === null`: `seen` is reached through intake alone and a known row never returns there, so without this a brief nobody was asked about sat in a folder for ever
- `briefRemoved(...)` — the withdrawal: `brief_missing_at` recorded first and for a terminal task too, then the gate withdrawn, the task cancelled and the row `skipped` — except a `running` row, which only takes the `brief_removed_while_running` warning
- `answer(userId, requestId, resolution)` — the gate. Returns `null` for any request id that is not a gate, because this runs through `taskRunnerBridge`, which asks every hook in turn. Registered with `installTaskRunnerHooks(..., 'handover')` so it is reached **before** `inboxService.answer`'s `runner`-or-no-agent arm, which a handover row would otherwise fall into. The ask is settled and the row claimed `running` in **one transaction ahead of the start**, because `taskExecutionService.start` refuses while any ask is open and because a minute scan landing in the window between the two used to find the row still `gated`, take it for an undecided brief and cancel the task under a Run the user had just clicked. A refused *Run and auto-run* records `auto_not_allowed:<reason>` taken from the `LocalAgentError`'s own `detail` — sniffing the message text for "track" reported `not_ignored` for a tracked folder whenever that sentence's wording changed, and for `unknown` always
- `applyReport` (`applyReportEffects`) — what a parsed report means for the task and the row, and where the wake fires from: after every write this function makes, never inside a transaction, never before the task carries the note the packet quotes. A `gated` row has its gate withdrawn first **whatever the status says**, and an `in_progress` report on a `gated` or a `seen` row (a gate that never opened) moves it to `waiting_external` with the task `in_progress`
- `wakeOnce(...)` — the single-handover wake, re-reading the row and refusing when `woke_at` is set, which with `reconcile`'s clearing is what makes "one wake per (row, report digest)" true on the group path and the single path alike. A terminal member of a group defers to `wakeGroupIfComplete`; `blocked` never does
- `applyOutcome` / `settleWithoutReport` — the turn's own ending, and a run the app lost. `HANDOVER_RUN_LOST_AFTER_MS` is two minutes. `settleWithoutReport` keeps an existing `report_unparseable` rather than overwriting it with `report_missing`
- `sweepLostRuns` / `hasOpenAsk` — a `running` row older than the grace period whose chat has no live turn, **unless the Inbox still holds a question about its task**: `applyOutcome` returns on `needs_input` and leaves the row `running` on purpose, so `updated_at` goes stale while the user reads the card. A failed read of that answers *yes*, because the sweep's write closes a task and wakes an origin
- `deliverRevisions` — the pending `revisions/NNN.md`, claimed in one write *before* the sends, and each send's turn watched through the same `watchTurn` the first turn gets. Without that watch the row sat `running` behind a turn nobody followed and the lost-run sweep closed the task as "the app closed" two minutes later, with the app open and the turn finished normally
- `wakeGroupIfComplete` / `checkGroup` — the fan-in, and the two states (`skipped`, `refused`) that finish a member without a packet of its own
- `resolveOrigin(...)` — the brief's `origin:` block into ids this profile can reach, plus the `parentTaskId` the new task is filed under. A requesting task that is itself a subtask cannot be a parent (`taskService.create` throws `nested_too_deep` rather than flattening), so it warns `origin_parent_nested` and the task hangs off nothing
- `forTask`, `listForAgent` — the read side

`src/main/services/handoverWake.ts` — `wake(input)` and `wakeGroup(input)`, both fire-and-forget and neither throwing. `HANDOVER_WAKE_POLL_MS` 1 s, `HANDOVER_WAKE_MAX_WAIT_MS` 30 minutes (shorter than the follow-up service's ceiling: a follow-up is part of the turn that requested it, this is a notification about work already recorded). The turn is `runExecutionService.start(scope, { chatId, content }, { observe: inboxService.recordRunEvent, inputOrigin: 'handover' })` — with **no** `runnerTaskId`, because the packet belongs to the origin's chat, not to the handover's task.

`src/main/services/handoverGit.ts` — `check(agentDir)` asks three questions in order, and they are not interchangeable: *is this a repository at all* (if not, nothing can arrive by pull → `not_a_repo`), *is the directory already tracked* (`ls-files --error-unmatch`, the worst case and the loudest), and only then *is it ignored* (`check-ignore -q`, where exit 1 is `not_ignored`). Asking `check-ignore` first would answer `not_ignored` for a tracked directory and lose the distinction the user most needs. **A git that never answered is not a git that said "no repository"**: a kill with no exit code (the 5 s timeout, an OOM kill, `index.lock` contention, a slow network mount) is `unknown`, which forbids `auto`. `ENOENT` falls back to the static `.gitignore` reading; a `git -C` failure for a path that has *gone* is `unknown` rather than `not_a_repo`.

`src/main/services/localAgents/watcherService.ts` — `classifyExternalEvent` returns `{ kind: 'handover', agentDir }` for any path holding the `.cinna` + `handovers` **pair**, matched **before** the ignore-dot-entries rule and never on `.cinna` alone (`localDevService` writes an unrelated `.cinna/account.json`). Handover events get their own pending set: a whole-root rescan answers every ordinary `pending` entry and answers none of these. They are **not deferred through `turnLock.whenFree`** — the turn holding the lock is very often the thing that just wrote `report.md`, and nothing in a handover scan reads the agent's definition.

`src/main/services/localAgents/localAgentService.ts` — `setHandovers()` runs the git check *before* taking the per-agent turn lock (it spawns a subprocess; holding the lock across it would block a turn on somebody else's disk) and rescans the folder afterwards, because the watcher sees neither file.

## The prompt and the wire

- **The agent's own id lives in the system prompt** (`promptAssembly`, both folder kinds, every engine, and on the native runtime too — there appended to the engine's own preset rather than replacing it). It is stable per agent, which is the only reason it may: Codex keys its pooled process on the prompt bytes, so a per-turn value there would start a process per turn. Without an id the identity bullet and the whole requester protocol section are left out rather than written blank — two callers assemble a prompt for something that has no agent row.
- **The chat id, task id and depth travel in a wire-only turn header** (`threadContextService.buildTurnHeader`), prepended in front of the catch-up packet and never persisted — the transcript row is written from the user's text alone, before the driver call. It is built **only for a driver whose capabilities include `cwd`**: acting on a chat id means writing a brief into a folder, and a remote agent has no path on this disk.
- **Depth is read from the chain this chat is already in** — the chat's task, and the handover row that task belongs to. No task, or a task nobody handed over, is depth 0, which is what makes a brief written from that turn depth 1. A header that cannot be built is logged and skipped: it is context, never a precondition.
- **`inputOrigin: 'handover'` makes the send desktop-authored**: a system row instead of a user bubble, no chat-title generation, no A2A `messageId`, `wireRole: 'system'`, and a null `user_message_id` in the interrupted-turn marker — otherwise a relaunch would offer to resend a message nobody typed, with an id `resendAgentTurn` refuses.

## Renderer Components

- `TaskView.tsx` — `useHandoverForTask(task.id)`; `Detail` rows in the panel that already exists, never a banner. **Requested by** is a button to the requester's own page on the same terms as the Assignee row (a deleted agent or a remote one hidden from the desktop stays text), and it waits while the agent list is pending rather than claiming *Outside the app*, which is a real answer and must not double as "not loaded yet". **Folder** renders only while `briefMissingAt` is null. **Note** is `handoverNoteText`, last in the panel
- `PermissionsCard.tsx` → `HandoversSetting` — the select, an always-rendered git line (truncated, full sentence on hover), and an error line only when there is one. The pick is held optimistically across the round trip, because main rescans the folder before answering and the control otherwise snapped back. `auto` is **disabled, not hidden**, and only once the check has answered; a failed check reads as `unknown` rather than staying "Checking git…" for ever. The select shows the **effective** value, so a stored `auto` that git overrules displays `ask` — and because choosing `ask` there is then not a change and would fire nothing, the status line carries a **Switch to ask** button (accent, on the line that is already there) as the only way to clear the stored setting
- `SystemTurnBlock.tsx` — the collapsible-block pattern, collapsed by default, header `Cinna Desktop · <first line>` (heading marks and bullets stripped, capped at 80 characters). One text node, because a button's accessible name is its element texts trimmed and joined, and a two-span header announces the separator glued to the label
- The Inbox renders a gate through its existing question card. The only thing the owner changes there is the card's copy and the free-text option: `askedByDesktop` makes the header read *Cinna Desktop is asking…*, shows the question's own `Handover` badge, and drops the modal's synthetic *Other* — a reply main would refuse, since it matches the answer against `HANDOVER_GATE_OPTIONS`

## Configuration

No settings. The constants are `MAX_HANDOVER_DEPTH` (2), `HANDOVER_PACKET_CAP` (4000 — the same number as the catch-up cap, deliberately *not* imported from it, since `threadContextService` is main-only and this module is read by the renderer), `HANDOVER_RUN_LOST_AFTER_MS` (2 min), `HANDOVER_WAKE_POLL_MS` (1 s), `HANDOVER_WAKE_MAX_WAIT_MS` (30 min) and `GIT_TIMEOUT_MS` (5 s). The one per-agent setting, `handovers: 'ask' | 'auto'`, lives in Desktop State under `userData`, keyed by path hash — never in the folder.

## Security

- **The permission is the desktop's setting, not the brief's `execution` key.** `desktopStateService.coerce` accepts only the literal `'ask'` or `'auto'`; anything else off disk is no choice at all, so a foreign or hand-edited state file cannot grant a standing permission by writing something that merely looks affirmative.
- **`auto` is refused unless git says `ignored` or `not_a_repo`** (`allowsAuto`). `unknown` is not a permission. The refusal is a thrown `LocalAgentError('handovers_not_ignored', …)` carrying the check's own sentence, so the card can say what to change.
- **Origin is validated at intake and again after the queue wait** (`chatAnswersToAgent`): the chat must be owned by this profile, not in the trash, and still answer to the named agent. `origin.chat` is a string out of a file in a project folder.
- **A folder two profiles can both see is left alone by the second.** Bare agents are settings-scoped and therefore visible from every profile, while handover rows are profile-scoped; the dedupe read is unscoped to match the index, so profile B finds profile A's row — and skips it. Every write B made would otherwise be silently scoped away and its task moves swallowed, once a minute, for ever.
- **The gate's answer path refuses without an activated profile** rather than guessing a settings scope: `setHandovers` writes a standing permission to run code, and guessing the scope wrong would put it on the wrong scope's agent. Unreachable from IPC (every handler calls `requireActivated` first), and kept as the belt-and-braces refusal.
- **Running a brief is running the folder's own setup.** See [Bare Agents](../../agents/local_agents/bare_agents.md) for what that includes — settings, hooks, skills and a project `.mcp.json` that attaches with no trust step (watched 2026-09-17 against `claude` 2.1.274).

## Tests

- `src/shared/handovers.test.ts` — the parse/reject matrix (no marker, `draft`, missing `status`, bad id, depth over the cap, an unknown report status, a fence inside the frontmatter, BOM and CRLF), the id rule, the gate question's options and request ids, the protocol texts, the warning vocabulary, and all three packet builders including the cap dropping from the **end**
- `src/main/services/handoverService.test.ts` — intake and dedupe across repeated scans, `auto` honoured and refused, the gate's shape and its three answers, a claim from outside the app, report application and the origin wake, a turn that ended without a report, a run the app lost (including a row left `running` by a parked executor, which is never swept), a run whose report would not parse keeping that warning, the chat the gate borrows (deleted when unused, kept and revealed when the user talked in it), a folder two profiles can both see, a withdraw racing an accepted Run, an answer with no profile activated, revisions and a fan-out group. The later rounds added: two scans of one folder at once applying a report once and waking once, the stamp that makes an unchanged folder free (no file opened, `updated_at` untouched), a report landing on a gated brief withdrawing the card on every status, a gate that failed to open being asked again — and *not* being asked again for a brief somebody else is running, a brief another scan got to first creating no task, and the origin being told again only when the report is genuinely new
- `src/main/services/handoverWake.test.ts` / `handoverRevisions.test.ts` — the busy-chat wait, the row a send stores, the refusals and the timeout warning
- `src/main/services/handoverGit.test.ts` — a real repository where `git` exists, the no-binary fallback, and an answerless `git` reading as `unknown`
- `src/main/db/handovers.test.ts` — the repo, including `update` not bumping `updated_at` on a scan-only write and `toDto` reporting a task-less row as `skipped`
- `src/main/db/migrations/migrations.test.ts` — the table created on a profile that predates it, and a profile that stopped at an intermediate development build getting every column the feature has grown since, plus its indexes; and a handover-owned input request accepted with no agent
- `src/renderer/src/utils/handoverText.test.ts` — a sentence for every kind in `HANDOVER_WARNING_KINDS` (the test that made the gap visible), every state label fitting one line of a 13rem column, a withdrawal told from a Skip, the refusal's reason kept in the row, the elided path never cutting the handover id and a Windows path staying one, and the overridden-`auto` line fitting the 800px card
- `src/renderer/src/components/tasks/TaskView.test.tsx` — the rows a handover adds and none on an ordinary task, the requester's page opening from the row that names it, *Outside the app* for an unsigned brief and never while the agent list is still loading, the Folder row disappearing when the brief is deleted, and a warning read back as a note
- `src/renderer/src/components/agents/local/PermissionsCard.test.tsx` — the choice on a bare folder and on no kit agent, git's answer before anyone clicks, `auto` refused for it and allowed in a folder that is no repository, a failed check forbidding `auto`, the select showing what would happen when git overrules a stored `auto`, and **Switch to ask** offered only where something is actually overruled
- `src/main/services/localAgents/watcherService.test.ts` — `classifyExternalEvent` returning `handover` for the new path, ahead of the dot-entry rule
- `src/main/services/messageRoutingService.test.ts` and `src/renderer/src/components/chat/MessageStream.systemRow.test.tsx` — a desktop-authored send storing a system row and generating no title, and that row rendering as a `SystemTurnBlock` rather than an assistant bubble
- `src/main/services/threadContextService.test.ts`, `taskExecutionService.test.ts`, `inboxService.test.ts`, `src/main/ipc/task.ipc.test.ts` — the turn header's three labelled lines, `reuseChatId` adoption and each of its refusals (used, foreign agent, unowned, trashed) plus the reused chat surviving a refused start, a handover gate listed while its task has not started, and `handover:for-task` answering in the profile scope
- `e2e/specs/handover-flow.spec.ts` — the whole path against the real app with a scripted ACP engine: a real `brief.md` written into an adopted bare folder, the gate card, Run, a `report.md` written by the *spec* (the scripted agent cannot touch the disk), the task page's rows, and the return packet's system row in the origin chat. Writing rules and locators: [`e2e_llm.md`](../../development/e2e/e2e_llm.md)
