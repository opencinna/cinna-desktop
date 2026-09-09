# The Claude Engine — Technical Details

Implementation reference for [The Claude Engine](claude_engine.md). What the SDK and the binary actually do is in [The Claude Engine Contract](claude_contract.md); this file says where the code is and why it is shaped the way it is.

## File Locations

### Shared

| File | What it carries |
|---|---|
| `src/shared/engine.ts` | `AgentEngine = 'opencode' \| 'claude'`, `DEFAULT_AGENT_ENGINE`, `isAgentEngine()`, `claudeModelForComplexity()`, `engine` on `ResolvedRuntime`, `engine` on `LocalAgentRuntimeInput`, and `ClaudeAuthState` / `ClaudeAuthStatus` — the login answer as a caller may see it: a state, the CLI's own `authMethod` word, and a plan tier. **The account's email, organisation id and organisation name are in the CLI's response and are not in this type** |
| `src/shared/kit/manifest.ts` | `AgentRuntimeRef.engine?: string \| null` — typed as a loose string, not as `AgentEngine`, because an unrecognised value must read rather than fail |
| `src/shared/runtimeMessages.ts` | `EngineSkipCode` gains `claude_not_installed` and `claude_not_logged_in`; `describeEngineSkip()` writes both sentences. The logged-out one ends with the panel's own instruction verbatim — *Run `claude` in a terminal.* — because the user meets that condition on two surfaces, and the panel is the one that could not be reworded (it is measured to the pixel). It is still not the same string: the opening clause names the engine, which a turn error in a transcript needs and the panel already says two rows up |
| `src/shared/localAgentRequests.ts` | `describePermissionAction()` gains Claude's tool vocabulary beside OpenCode's |

### Main process

| File | Role |
|---|---|
| `src/main/services/agentTurn/claudeAgentTurnRunner.ts` | `ClaudeAgentTurnRunner` — the third `AgentTurnRunner`. Readiness, lock, environment, the SDK call, the permission gate, session save, the never-throws contract |
| `src/main/services/agentTurn/claudeAuth.ts` | `parseClaudeAuthStatus()`, `probeClaudeAuth()`, `ClaudeAuthProbe` — the free login probe, its parse rules and its short-lived cache |
| `src/main/ipc/local_tools.ipc.ts` | `local-tools:claude-auth`, and the ordering rule that makes `local-tools:refresh` re-ask the login *after* detection has been rebuilt |
| `src/main/services/agentTurn/claudeMessages.ts` | `ClaudeMessageStream` — the fold from SDK messages to the A2A-shaped cumulative message, plus `describeClaudeToolCall()` and `describeClaudePermission()` |
| `src/main/services/agentTurn/claudeEnv.ts` | `buildClaudeEnv()`, `auditClaudeEnv()`, `CLAUDE_STRIPPED_ENV`, `ENGINE_KEY_PREFIX`, `CLIENT_APP_ENV` |
| `src/main/services/agentTurn/claudePermissions.ts` | `toClaudePermissionRequest()`, `claudePermissionResources()`, `mintPermissionRequestId()` |
| `src/main/services/agentTurn/index.ts` | Production wiring: `claudeDeps`, `claudeAgentTurnRunner`, `resolveTurnRunner()` and the private `folderEngine()` |
| `src/main/services/localAgents/runtimeService.ts` | `declaredEngine()`, the Claude early return in `resolve()`, the engine refusals in `validate()`, `engine` in `toRuntimeRef()` and `applyToManifest()` |
| `src/main/services/localAgents/desktopStateService.ts` | `coerceRuntime()` — `engine` joins the bare agent's runtime allowlist |
| `src/main/engine/engineConfigSource.ts` | `collectEngineAgents()` skips any agent whose resolved engine is not `opencode` |
| `src/main/kit/validator.ts` | `checkRuntime()` — `engine` type check, the unrecognised-value warning, the engine-with-credential warning |

### Renderer

| File | Role |
|---|---|
| `src/renderer/src/components/agents/local/RuntimePanel.tsx` | The "Runs with" panel: the `Runs on` select with two `optgroup`s, `EngineRow`, `ClaudeStatus`, `commitCredential()`, `changeRuntimeTarget()`, the Claude branches of the status line and the disabled/advanced gates |
| `src/renderer/src/hooks/useLocalTools.ts` | `useLocalTools()` — the detected-tools query the Claude option and status column read (`staleTime: Infinity`, cached in main for the app's lifetime) — plus `useClaudeAuth()`, `CLAUDE_AUTH_KEY` and `CLAUDE_AUTH_POLL_MS`, the login query the status line reads |

### Resources and packaging

| File | Change |
|---|---|
| `resources/cinna-kit-contract/VERSION`, `kit.json`, `layout.json` | contract `1.1.0` → `1.2.0` (all three move together) |
| `resources/cinna-kit-contract/schema/cinna-agent.schema.json` | `runtime.engine`, `["string","null"]`, **no enum** |
| `resources/cinna-kit-contract/CHANGELOG.md` | the 1.2.0 entry, and the rule that an unrecognised value is not a broken folder |
| `electron-builder.yml` | `!node_modules/@anthropic-ai/claude-agent-sdk-*/**` |
| `package.json` | `@anthropic-ai/claude-agent-sdk` added; `@anthropic-ai/sdk` `^0.89.0` → `^0.93.0` |

## Database Schema

**No migration.** The engine choice lives in the same two places every other runtime field does:

- a kit agent's `cinna-agent.json`, under the file's stamp
- a bare agent's Desktop State (`<userData>/external-agents/<name>-<hash>.json`), whose folder is never written into

Session continuity reuses `a2a_sessions.context_id` and the `sessions` map in that agent's Desktop State, through the **same** `readSession` / `saveSession` implementations the OpenCode runner uses — deliberately, so "this chat remembers a session" cannot mean two different things depending on which engine answered.

## IPC Channels

**One added — `local-tools:claude-auth`** — and it sits on the `local-tools:*` surface rather than `local-agent:*` on purpose: it is a fact about the machine's `claude`, the same kind of fact as detection, and not about any one agent. The rest of the engine travels on the existing runtime writes:

| Channel | Signature |
|---|---|
| `local-tools:claude-auth` | `() → ClaudeAuthStatus`. `requireActivated()`, then the shared probe's cached answer. Carries the account's email and plan and no more: `claudeAuth.ts` never reads the organisation id or name out of the CLI's JSON, so nothing at this boundary has to remember not to forward them |
| `local-tools:refresh` | Unchanged signature (`() → DetectedTool[]`), one added effect: it also drops the cached login answer. **After the `await`, and the order is the point** — the probe resolves its path through `toolDetectionService.get`, which reads the memoized detection promise synchronously, so a refresh started first would answer from the cache the button is about to discard. That is exactly the machine the button exists for: someone who has just installed Claude Code. The re-ask is fire-and-forget, so a refused login probe cannot fail the detection the button is named after |

| Channel | Signature change |
|---|---|
| `local-agent:update-field` | `{field: 'runtime', value: LocalAgentRuntimeInput}` — `value` gains `engine`. Stamped (kit agents) |
| `local-agent:set-runtime` | `{agentId, runtime: LocalAgentRuntimeInput}` — same input type. Unstamped (bare agents), since the write touches no file in the folder |
| `agent:answer-request` | Unchanged and engine-agnostic. The Claude runner registers its ask in the same `pendingRequests` registry, so the answer path — including the *always* → grant → `once` conversion — is reused verbatim |

**`LocalAgentRuntimeInput.engine` is required, not optional, and that is the whole point.** `applyToManifest` deletes the key before rewriting the block, so a caller that simply omits it *erases the user's engine choice* from a file they commit. While `engine` was merely an unknown key the manifest layer preserved it verbatim; making it known removed that protection for exactly the field being added, so the compiler is made to ask every caller instead. Every existing caller — including the E2E specs — was updated to pass `engine: null` or the manifest's own value.

## Services & Key Methods

### `runtimeService` (`src/main/services/localAgents/runtimeService.ts`)

- `declaredEngine(runtime)` — `runtime.engine` if `isAgentEngine` accepts it, else `null`. The tolerant read
- `resolve(runtime, providers, models)` — returns early for `engine === 'claude'` with `source: 'manifest'`, no credential of any kind, `modelId` = a declared model or `claudeModelForComplexity(complexity)`, `modelSource` `declared` / `tier` / `floor`, and `reason: null`. **The early return is above `resolveDefault`**, so a throw in the default-chat-mode or credential-override store cannot demote a Claude agent to OpenCode at dispatch
- `validate(input)` — now returns `engine` alongside the other three. Throws `LocalAgentError('invalid_input')` for an engine this build does not know, and for `claude` together with a credential. Shared by both write paths, so the refusal is not something the bare-agent writer can skip
- `toRuntimeRef(input)` / `applyToManifest(manifest, input)` — write `engine` first and treat all-four-null as "remove the block"

### `ClaudeAgentTurnRunner` (`claudeAgentTurnRunner.ts`)

`ClaudeTurnDeps` is the injected world, so the runner is drivable with no child process, no Electron and no database:

| Dep | Supplied in `index.ts` by |
|---|---|
| `getAgent`, `readSession`, `saveSession`, `withLock`, `userId`, `isGranted` | **the same implementations `localDeps` uses** |
| `systemPrompt` | `assembleAgentPrompt` (kit) or `assembleBareAgentPrompt` (bare), with `resolveDesktopPromptContext()` |
| `model` | `runtimeService.resolve(...).modelId` — a plan alias on this path, `null` on failure, which hands the choice to the CLI's own default |
| `claudePath` | `toolDetectionService.get('claude')?.path ?? null`. Async, and resolved **before the lock is taken**, so "there is no Claude Code here" never queues behind another chat's turn |
| `claudeAuth` | `claudeAuthProbe.status()` — the shared `ClaudeAuthProbe`, built in `index.ts` on `buildClaudeEnv(...)` so the probe runs in the environment the turn will |
| `shellEnv` | `getShellEnv()` |
| `appVersion` | `app.getVersion()` |
| `query`, `turnCeilingMs` | tests only |

`runTurn(input)` order: agent exists → enabled → readiness is not `invalid` / `contract_too_new` → `claudePath()` → `claudeAuth()` → `withLock(...)` → `stream(...)`. The login rung is **`unknown`-tolerant**: only `state === 'logged_out'` returns `describeEngineSkip('claude_not_logged_in')`, and anything else falls through to the run, where `isNotLoggedIn` still catches the thrown error as the second line. It is awaited with a `.catch` returning `unknown` rather than inside the `try` below, because a rejection there would escape `runTurn` — the never-throws contract broken by the check that exists to make turns fail less. A lock refusal is caught and returned as a result: `turnLock.acquire` throws a user-facing message, and letting it escape would close the port having posted neither `done` nor `error`, so the chat streams forever.

`stream(...)` internals worth knowing:

- `CLAUDE_TURN_CEILING_MS` = 20 minutes, armed around the whole iteration because this loop *is* the turn; aborting the controller is what actually stops the child
- an explicit **pre-flight abort check** after the awaits and immediately before `query()` — a listener attached to an already-aborted signal never fires, and there is no await between the check and the call
- `drain(resume)` — one pass over the generator, returning the error message or `null`. Called a second time with `null` only when the error matches `isMissingSession` (`/no conversation found/i`) **and** there was a remembered session **and** the turn was not aborted **and** nothing has streamed yet
- `isNotLoggedIn(message)` (`/not logged in|\/login/i`) maps a failure to `describeEngineSkip('claude_not_logged_in')`. Substring matching is not a shortcut: the SDK wraps every error result identically with `errorClass: 'error_result'`, so the text is the only discriminator
- exit order: **aborted → ceiling → error → `result.is_error`**. Abort first, so a deliberate stop is never reported as a failure
- `finish(...)` is the single exit: it saves the session (a failure there is logged, never fatal — continuity is a convenience) and returns `parts`, `text`, `notices` and `contextId`, keeping whatever streamed even on the error paths. It also takes the observed `apiKeySource` and appends the billing notice when that is anything but `'none'`. **All four exits pass it — completion, error, cancel and ceiling — because the observation is made at the init message, so the exit path a turn happens to take cannot decide whether the user is told.** A turn that reported the wrong account and then failed has still been billed to it, and the ceiling is the most expensive way to get this wrong: twenty minutes of work on an account nobody chose. The completion path alone carried it at first, and nothing failed, because the test written for it covered a turn that failed *before* init — a different case
- a `finally` cancels every request this turn parked on. A request left registered keeps reporting as pending, so a persisted block goes on rendering as answerable and answering it reports success into a turn that ended

The SDK options passed, and why each is not a default: `cwd` (the agent folder), `pathToClaudeCodeExecutable` (**the user's binary, never the SDK's bundled one**), `systemPrompt` (a plain string, never the `claude_code` preset), `model` (omitted entirely when the runtime names none), `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`, `includePartialMessages: true` (without it the turn appears to hang until the first tool call and the text path never runs), `env`, `canUseTool`, `abortController`, `resume`. **No `allowedTools`** — see the contract, and the `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning the SDK prints when one is present.

### `claudeAuth.ts` — the free login probe

Three pieces, and the split is what makes the rules testable without a binary:

- `parseClaudeAuthStatus(stdout)` — pure. `loggedIn` **must be a boolean** or the answer is `unknown`; `!!record.loggedIn` would read a missing field as a definite "logged out" and lock the user out of a working engine. Reads `authMethod`, `subscriptionType` and `email`, and **nothing else** — `orgId` and `orgName` are in that JSON and are never lifted out of it
- `probeClaudeAuth({claudePath, env, timeoutMs, exec})` — one `execFile(claudePath, ['auth', 'status'])`. **The callback's `err` is not the signal**: a logged-out install exits **1** with valid JSON on stdout (contract §5, re-measured), so branching on the error collapses the one state this module exists to detect into `unknown`. Never rejects — every failure is `unknown`, since the only thing a failed probe justifies is not blocking the turn. Raced against an own timer at `timeoutMs + 500` for the reason `toolDetectionService.probeVersion` documents: `execFile`'s own `timeout` fires on **close**, which waits for the stdio pipes to reach EOF, so a shim whose grandchild inherits stdout leaves the callback pending after the direct child is dead. `CLAUDE_AUTH_TIMEOUT_MS` is 5 s against an observed ~0.27 s — a hang guard, not a budget
- `ClaudeAuthProbe` — the cache. `CLAUDE_AUTH_TTL_MS` is **30 s, not the app's lifetime**: this is the answer that changes while the app is open, because the app has just told the user to go and change it. The in-flight promise is shared, so a panel render and a turn starting together spawn one child. `refresh()` drops the answer, and a refresh landing while a probe is in flight **joins that one** — deliberately, since that child was spawned moments ago under a five-second bound. `run()` catches, because `claudePath()` and `env()` both do real work (a PATH walk, a profile source) and a rejection would surface at the runner's `await`, outside its `try`. No install at all is remembered as `unknown` and **nothing is spawned to find out** — `claude_not_installed` outranks a login everywhere it is read, so keeping that ordering is the caller's decision, not this module's

Logging is **states and durations only, never `stdout`**. An `unknown` verdict logs a warning with the byte count standing in for the output, because four different causes land there and without a line "it never says I am logged in" leaves no trace anywhere.

Wiring lives in `agentTurn/index.ts`: `export const claudeAuthProbe = new ClaudeAuthProbe({ claudePath: toolDetectionService.get('claude'), env: buildClaudeEnv({shellEnv, appVersion}) })`. Constructed there rather than at either call site **because of the environment**: the binary answers differently depending on its child environment (the `USER` finding), so a probe under the full shell environment would report a login for a child that then cannot authenticate.

### `buildClaudeEnv` (`claudeEnv.ts`)

`shellEnvForChild(shellEnv, allowlist, processEnv)` → drop everything in `CLAUDE_STRIPPED_ENV` → drop every `CINNA_ENGINE_KEY_*` → add `CLAUDE_AGENT_SDK_CLIENT_APP = cinna-desktop/<version>`. Deliberately pure and Electron-free.

Starting from the shared helper rather than hand-assembling a dictionary is what makes `USER` present automatically — the shared allowlist begins with the MCP SDK's inherited set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), and the hand-assembled version is what left `USER` out and produced "Not logged in" on a logged-in machine.

`CLAUDE_CODE_ENTRYPOINT` is **not** set: the SDK owns it, and overwriting it would misreport how the CLI was invoked.

`ClaudeEnvInput.allowlist` is injectable for one specific reason and it is not general testability. The real allowlist happens not to contain `ANTHROPIC_API_KEY` or any `CINNA_ENGINE_KEY_*`, so the narrowing alone removes them and the explicit strip is untestable through the front door — a mutation deleting the strip passes every test written against the real list. That is exactly the state in which a later widening silently restores the billing trap.

`auditClaudeEnv(env)` returns the offending **names, never values**, and the runner logs at `error` if it finds any.

### `ClaudeMessageStream` (`claudeMessages.ts`)

`apply(raw)` folds one SDK message and returns a `ClaudeStreamUpdate`. **Unknown message kinds return an empty update** — the union has 37 members at 0.3.266, two of which appeared in the first probe turn, and a turn must not die because the CLI learned a new trick.

The class maintains the *cumulative* message and hands the whole thing back for re-ingestion, because `StreamPartsAccumulator` was built for A2A, where each update carries every part's full text so far and the accumulator computes the delta itself. The SDK emits **true deltas**; feeding one straight in looks right for one chunk and duplicates every character after it.

Rules that are decisions:

| Rule | Why |
|---|---|
| Text and thinking come from `content_block_delta`; an `assistant` text block only **creates** a part, never overwrites one | Pairing an `assistant` block back to a stream index needs an ordering assumption, and being wrong would write one block's text over another's — a silently corrupted transcript. Not overwriting means the worst case is a truncated block |
| Tool calls come from the `assistant` message, keyed by the block's own `toolu_*` id | `input_json_delta` is partial JSON, useless until complete, and that id is what the `tool_result` pairs back to |
| Part identity is `(current message id, block index)`, tracked per **lane** (`parent_tool_use_id ?? 'main'`) | Only `message_start` names the message; every `content_block_*` event carries a bare index. A single slot is correct today only because subagent frames do not arrive as stream events with our options — a property of an option we do not set, whose failure would be silent |
| `owner()` falls back to an `anon:claude:<lane>` key | Filing blocks under a null key would collapse two messages' parts into one array with colliding indices |
| Tool results are filed under the message that owns the call they answer | They carry no message id of their own, only `tool_use_id` |
| A tool result's content is flattened from a string **or** an array of blocks | A reader that knows only the string case renders `[object Object]` for every tool that returns structured content |
| `askPermission` / `settlePermission` write the ask and its decision into the same message, paired by `tool_id` | The renderer folds the result into the request block; without the pairing the persisted transcript shows a prompt with no record of the answer |

`system/init` yields `apiKeySource`, `model` and `cliVersion`; `result` yields `{isError, text, usage, numTurns}`; `auth_status` yields `authError`. **The runner consumes only `apiKeySource`, `sessionId`, `message` and `ended`.**

`apiKeySource` is the one of those that reaches the user: a completed turn reporting anything but `'none'` carries a notice naming what the CLI said, because that failure otherwise looks exactly like success — see [the rule](claude_engine.md#a-turn-that-did-not-run-on-the-installs-own-login-says-so-where-the-user-is).

`model`, `cliVersion`, `usage` and `numTurns` are folded and read by nothing, deliberately — no cost and no token figure reaches the transcript. `authError` is the same, for a different reason: **`auth_status` was never observed in any probe**, including the not-logged-in run, and it is folded because it is in the union and silently dropping the one message that names an auth problem directly would be worse than handling a message that may never arrive. "Folded but never consumed" is the accurate description of all five and not a defect in any of them.

### Permission mapping (`claudePermissions.ts`)

- `toClaudePermissionRequest(toolName, input)` → `{action: toolName, resources, savable: []}`. `action` is Claude's own tool name, stored as-is. `savable` is empty because there is no second store to report — the desktop derives the grant from `resources` and writes it beside the folder
- `claudePermissionResources` reads the first present field from a per-tool table (`Bash: command`, `Read`/`Edit`/`Write`: `file_path`, `NotebookEdit: notebook_path`, `WebFetch: url`, `WebSearch: query`, `Glob`/`Grep`: `pattern`, `path`, `Agent`/`Task`: `description`, `prompt`), falling back to a generic list. A tool missing from the table produces an ask the user can only remember as the whole action — deliberately the widest and least attractive option
- `Agent` **and** `Task` are both listed: `Agent` is what `claude` 2.1.266 emits, `Task` is the name in the SDK's types
- `mintPermissionRequestId()` mints `per_claude_<base36>_<n>`. The `per_` prefix is required because `isEngineRequestId` gates on it and the renderer's read-only replay rule depends on that: a persisted block bearing such an id is not answerable, since the id is a live address that dies with its turn. Minting the prefix is a smaller change than widening the predicate
- The callback returns `{behavior:'allow', updatedInput}` or `{behavior:'deny', message}` and **never `updatedPermissions`**. The deny message is what the model receives as the tool result, verbatim — observed — so it is written for the model, not for the transcript
- An expired park **resolves** with `{kind:'rejected'}` rather than rejecting, so it is ordinary control flow with its own branch: deny, and the transcript says *"No answer — the request expired."* rather than *"Denied."*
- A throwing grant store is caught and treated as "ask the user"

### Dispatch (`agentTurn/index.ts`)

`resolveTurnRunner(agent)` now takes `Pick<AgentRow, 'source' | 'id'>` and is `source` **then** `engine`: a non-folder agent returns immediately, so no folder is read for an agent this axis has nothing to do with. `folderEngine(agentId)` reads `localAgentService.get(...).runtime` through `runtimeService.resolve` and returns `DEFAULT_AGENT_ENGINE` on any throw, logging a warning.

## Renderer Components

| Component / helper | Renders / manages |
|---|---|
| `RuntimePanel` | The first select is labelled **`Runs on`** (was `Credential`) and carries two `optgroup`s: `On this machine` with a single `Claude Agent` option valued `engine:claude`, and `AI credentials` with the existing list. The pending model placeholder was renamed `Model choice`, because two controls on one surface must not announce the same name |
| `EngineRow` (private) | The third column's row — dot, word, optional button — extracted so both engines render into one fixed `h-[26px]` slot. `dot` and `tone` are passed in, not derived: the two engines mean different things by the same colours |
| `EngineStatus` (private) | Unchanged, and shown only for OpenCode agents |
| `ClaudeStatus` (private) | `Checking…` while detection is in flight, `Claude Code <version>` when found, `Not installed` when not. **No Start button** — this app starts nothing there. The `title` carries the resolved path. **The login is deliberately not in this cell's text** — not because it is unknowable, but because the column is fixed at 219 px and does not widen with the window, so it holds the shortest true thing and the status line carries the meaning. Takes `auth={claudeAuth?.state}`, which decides the **dot only**: danger with no install, `--color-warning` on a definite `logged_out` (the type scale's *"Awaiting auth"*, and warning not danger because the install is fine and one command fixes it), muted for `unknown`, in-flight and `logged_in`. **Never the success colour** — one option away in the same slot a green dot means *the process is running*, so green here would be one indicator in one position meaning two things |
| `planSuffix(subscriptionType)` (private) | `"max"` → `" (Max plan)"`, empty string when the CLI named none. Passed through and capitalised, never mapped: this app does not own the set of plan names, and a lookup table would render an unrecognised plan as blank on the one line meant to say who pays |
| `changeRuntimeTarget(value)` | The one picker's answer, now either an engine or a credential. To Claude: clear the credential and the model, keep the tier, note what was dropped. Away from Claude: clear the engine, keep the tier |
| `commitCredential(value)` | Returns `null` on the Claude path, always. A manifest may legally carry both an engine and a credential, and forwarding the credential from a control that is not on screen handed `validate` the one pair it refuses |
| `commit(..., {engine})` | `engine` **absent means "the engine the manifest already names"**. The panel rewrites the whole `runtime` block, so a save about the model that did not carry the engine would delete the user's engine choice |

Renderer rules that are decisions, not styling:

- **`declaredEngine` is read through `isAgentEngine`**, so a value a newer tool wrote is carried as "none" rather than written back as itself
- **Three tool-detection states, not two.** `tools === undefined` is `Checking…` with the status line silent; collapsing it with "no" showed the full not-installed alarm for half a second on machines that have Claude Code
- **The dot moved because the line alone was not glanceable.** The reserved line turned red on a logged-out machine while the row's one indicator stayed neutral grey about a state the app had just gone and found out. That is the whole reason `ClaudeStatus` takes the auth state at all; nothing in the cell's *text* changed
- **Three login states, and `undefined` is a fourth.** The status line's Claude ladder is: detection unknown → silent; not installed → the danger sentence; `claudeAuth === undefined` (the query in flight) → **silent**; `logged_out` → the remedy-first danger sentence; otherwise the note, which says *login* (plus `planSuffix`) on `logged_in` and *install* on `unknown`. Silence while the probe is in flight is not caution for its own sake: filling the slot with the reassuring install sentence meant a logged-out machine read healthy in muted grey and was contradicted in red ~100 ms later (measured at t=891 ms and t=996 ms). Nothing moves either way — the line is reserved — so what the retraction costs is the credibility of the next reassuring sentence. `unknown` is **not** silence: it is an answer, and *install* is the true thing to say about it
- **The logged-out line leads with the remedy** — `Run \`claude\` in a terminal: that Claude Code install is not logged in.` At the 800 px minimum it needs 432 px and has 414 px, so the problem-first wording lost the half naming the action (rule 7). It is deliberately **not** `describeEngineSkip('claude_not_logged_in')`: that sentence is a *turn error* and opens "This agent runs on Claude…", which is narration on a panel that says so two rows above
- **The Claude option is offered when detection found one *or* the manifest already names the engine.** The second half stops the select rendering blank over a file that plainly says what it runs on — the same rule the credential list already follows for a keyless credential
- **`advanced` is forced `false` and the Advanced checkbox is removed** (not disabled) on this engine, from *inside* the fixed-height row, so the panel's footprint and the page's tab strip do not move
- **The model-registry gate is branched around.** Gating on it would leave both pickers disabled forever on a machine with no AI credential at all, which is exactly the machine most likely to be on this engine
- **`(none listed)` is suppressed** on tier options: it is a statement about a credential's catalogue, and here every tier resolves
- **The tier picker's empty option reads `Default (sonnet)`** — the Medium floor, named, because no catalogue could make it "none set"
- **The status line's Claude branch sits above every credential and loading branch.** It names both "Claude Agent" and "Claude Code" in one sentence, because both are on screen and it is the only line with the width to tie them together — the option and the status column are the two width-constrained places
- **"Claude Agent" in the picker, "Claude Code" in the status column.** The first is a product-name constraint on a third-party surface; the second is a factual statement about the user's machine, which is what makes the line diagnosable
- `CLAUDE_OPTION` is `engine:claude`, prefixed so it cannot collide with a credential *name*. A credential literally called `engine:claude` would be shadowed; that is accepted rather than defended against

### `useClaudeAuth` (`useLocalTools.ts`), and why it polls

A sibling of `useLocalTools`, not a fold into it: detection is one filesystem pass cached for the app's lifetime, while this spawns a process and is cached behind a 30-second window — `staleTime` matches that window rather than `Infinity`, and `undefined` while in flight is what the panel renders as *not knowing*.

`CLAUDE_AUTH_KEY` is `['claude-auth']` and deliberately **not** `['local-tools', 'claude-auth']`: the nested form would be matched by any `invalidateQueries({queryKey: ['local-tools']})`. Nothing does that today, which is the point — the first person to add an invalidation for detection would silently start re-spawning `claude` with it.

**The refetch trigger is an interval gated on `logged_out`, because focus does not work here.** The panel's logged-out line tells the user to go to a terminal; nothing re-asks while the agent page stays mounted, so they come back to an alarm about a machine that is now fine. `refetchOnWindowFocus` looks like the answer and is a trap: `focusManager` in `@tanstack/query-core@5.99.0` registers exactly **one** listener, `visibilitychange`, which does not fire when another application takes the foreground over a still-visible Electron window — precisely the ⌘-Tab-to-Terminal-and-back this exists for. Driven through the built app, the line was unchanged after `blur`/`focus`, `hide`/`show` and `minimize`/`restore` alike, with `document.visibilityState` never leaving `"visible"`. See [Development Setup, gotcha 8](../../development/setup/setup.md#gotchas).

So: `refetchInterval` is `CLAUDE_AUTH_POLL_MS` (10 s) **only** while the answer is `logged_out`, and `false` in every other state — no poll while logged in, none on `unknown`, none before the first answer. The cost exists only on a machine displaying an alarm and stops the moment the alarm is right to go, and one `claude auth status` is a bounded ~0.27 s child that runs no turn. `refetchOnWindowFocus: 'always'` is kept for the cases `visibilitychange` genuinely does cover — minimize, occlude, switch Space — where it beats waiting out the interval; `'always'` and not `true`, because `true` defers to `staleTime` and would hold the stale alarm for the rest of the window.

`useRefreshLocalTools` invalidates this key on success, since main re-asks the login on that same call.

## Configuration

- **Contract version** — `1.2.0` in `resources/cinna-kit-contract/{VERSION,kit.json}` and mirrored in `layout.json`. Added `runtime.engine`
- **No app setting, no environment variable, no user-facing configuration.** The engine is a per-agent choice and nothing else
- **`CLAUDE_AGENT_SDK_CLIENT_APP`** is set *into the child*, never read from the parent
- **Packaging** — `!node_modules/@anthropic-ai/claude-agent-sdk-*/**` in `electron-builder.yml`. The SDK declares eight optional platform packages, each a single ~190 MB `claude`. Verified safe to drop on `darwin-arm64`: with the platform package deleted outright the SDK still imports and runs a full turn, because the bundled-binary resolution path is reached only when `pathToClaudeCodeExecutable` is absent — and it never is. The other seven targets are not built here

## Security

- **No credential of any kind is involved on this path.** The desktop stores no token, implements no login and never reads or writes anything under `~/.claude/`
- **The organisation behind the login is never read; the account is.** `claude auth status` answers with the account's email, organisation id and organisation name; `parseClaudeAuthStatus` lifts the **email** out and leaves `orgId` and `orgName` where they are, so neither reaches `ClaudeAuthStatus`, a log line, or the renderer. **The absence of the read is the defence** — a rule saying "do not log the organisation" is one careless edit from being untrue, whereas a field nothing reads cannot leak. The email is read because it is the answer to the panel's own question, *which login pays for this turn*, which a plan tier cannot give on a machine holding more than one Claude login; it is the user's own account shown back to them, and it still never reaches the logger, which carries states, methods and durations only. What crosses is the state, the CLI's own `authMethod` word, and a plan tier
- **The child environment is constructed, and audited on the value handed over.** See `CLAUDE_STRIPPED_ENV` and `auditClaudeEnv`; the audit logs names only, because logging a key's value to explain that it leaked recreates the leak in the log buffer
- **`settingSources: []` plus `strictMcpConfig: true` plus `mcpServers: {}`** is the isolation boundary, and all three are required. The first alone left the user's own MCP connectors — Gmail, Drive, Calendar in the probe — attached to a folder agent, with no Cinna surface saying so
- **Nothing is pre-approved.** No `allowedTools`, so every gated tool reaches `canUseTool`. Read-only tools are **not** gated by the SDK at all, and the [permissions](permissions.md) surface must not claim a completeness the mechanism does not have
- **Permission grants are per-folder and per-engine-vocabulary.** `Bash` and `bash` are different actions, so a rule written on one engine never authorises the other
- **`apiKeySource` other than `'none'` is logged on every turn it happens** — it means something reached the child that was meant to be stripped, and the user is being billed somewhere they did not choose
- Not a sandbox. As on the other engine, a shell command reaches anything the user can

## Tests

| File | What it pins |
|---|---|
| `claudeEnv.test.ts` | `USER` and `HOME` present; the login-shell `PATH` present; the client-app identifier set and `CLAUDE_CODE_ENTRYPOINT` not; keys and `CINNA_ENGINE_KEY_*` stripped **through a deliberately over-wide injected allowlist**; an API key stripped even when it arrives beside a valid login; the audit finding nothing afterwards, and reporting names rather than values |
| `claudeAuth.test.ts` | the parse (a plan and an account read on a logged-in answer, with the organisation **never** on the returned object; a non-boolean or absent `loggedIn` as `unknown`, not `logged_out`), the probe (**a logged-out answer that exited 1 is still read** — the exit code is not the signal; the path, `auth status` and the given environment actually handed to `execFile`; a callback that never fires resolving `unknown` rather than hanging; an unspawnable binary as `unknown`, not `logged_out`), and the cache (one ask inside the window, a re-ask after it, `refresh` dropping it immediately, one child for two concurrent callers, never rejecting whichever dependency throws, and no spawn at all when there is no install) |
| `local_tools.ipc.test.ts` | that `local-tools:refresh` re-asks the login **against the detection it just refreshed**, and that a failing login probe still lets the channel answer with the detected tools |
| `useClaudeAuth.test.tsx` | that the poll runs while the answer is `logged_out` and stops on every other answer, including `unknown`, and that a `visibilitychange` refetch ignores its own freshness window |
| `claudeMessages.test.ts` | text, tool calls, subagents, the wider union, and the facts off `system/init` and `result` |
| `claudeAgentTurnRunner.test.ts` | readiness on the login rung — a `logged_out` install refused **before anything is spawned**, an `unknown` probe running the turn anyway, a probe that *rejects* not becoming a thrown turn, and no install never consulting the probe at all; who paid for the turn — silent on `'none'`, the notice on anything else with the answer still intact, and the same notice on **each of the four exits** (one test per path, each mutation-checked separately), silent again when no turn ever reported one; the options handed to the SDK (boundary closed, partial messages on, **no `allowedTools`**, the user's binary, a plain-string prompt, a key-free environment, model omitted when none); readiness before the turn; never-throws across a thrown failure, a yielded error result and a lock refusal; cancellation including an abort that lands during pre-flight (**no child spawned at all**); the four negative cases of the session retry; the ceiling; and the permission paths, including that an unreadable grant store asks rather than allows, and that an expired park denies and says so |
| `dispatch.test.ts` | `resolveTurnRunner`'s three-way choice, with the whole module graph below `index.ts` mocked. It exists because the failure it replaced was silent and permanent: an agent whose manifest said `engine: "claude"` went to the OpenCode runner, which could not find it in the config (now skipped there deliberately), found no skip reason to explain that, and answered *"This agent is not available in the running engine yet"* every turn, for ever |
| `runtimeService.test.ts`, `validator.test.ts`, `desktopStateService.test.ts`, `engineConfigSource.test.ts`, `RuntimePanel.test.tsx` | the engine field through resolution, validation, the bare agent's state, the config skip and the panel |
| `RuntimePanel.test.tsx` (login ladder) | each of the five status-line outcomes as its own test: the login named with its plan, the login named without one when the CLI reported none, the logged-out line **leading with the remedy**, silence while the probe is in flight, and `unknown` getting the install sentence rather than silence |

`e2e/specs/claude-engine.spec.ts` drives the built app through the choice itself: the option under its own `optgroup`, the manifest rewritten in **both** directions (to Claude clears `credential`, back clears `engine`, the tier survives either way), the panel reporting the detected install with no model list, and the panel's height measured before and after at both the default width and the 800px minimum, because the page's tab strip sits directly below it.

**It never runs a turn.** Spawning `claude` bills a real person's subscription on every developer's machine and in CI, so everything asserted there is knowable from the picker, the panel and the file; whether that install can actually answer is out of scope. Detection is **not** faked — the fixture writes the real `PATH` into the sandbox's rc files and the app's own detection answers, so on a machine without Claude Code the spec skips rather than asserting on an option that must not exist there. The absent case belongs to `RuntimePanel.test.tsx`, which can fake detection.

`e2e/specs/claude-logged-out.spec.ts` covers the state the unit tests can only fake: an install that is genuinely **not logged in**. It gets there without logging anybody out — every spec already runs under a throwaway `HOME`, and `buildClaudeEnv` passes `HOME` through, so the same binary that answers `loggedIn: true` under the developer's own home answers `false` under the sandbox's. It asserts the remedy-first line **and** that the Engine column still reads `Claude Code <version>`, which is what distinguishes *logged out* from *not installed* — the two rungs that share the danger tone — and it asserts the reassuring install sentence **absent** rather than tolerated, since a spec that accepted either would also pass where the probe had silently degraded to `unknown`. `claude auth status` is the only `claude` invocation it causes; it runs no turn and bills nothing, which is why it is allowed where a turn is not.

`agent-runtime.spec.ts` and `bare-agent.spec.ts` were updated for the renamed `Runs on` label and the required `engine` field, and nothing more.

## Related

- [The Claude Engine](claude_engine.md) — the rules and the reasons
- [The Claude Engine Contract](claude_contract.md) — what was watched, and what is still unverified (§8 is the list of open risks)
- [The Agent Turn Runner (tech)](agent_turn_tech.md) — the seam, the shared input/result, and the OpenCode implementation this shares nothing below
- [The Local Engine (tech)](engine_tech.md) — runtime resolution, config generation and the "Runs with" panel's other half
- [Local Agent Permissions (tech)](permissions_tech.md) — the grant store both engines write to
