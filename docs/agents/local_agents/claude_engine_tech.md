# The Claude Engine — Technical Details

Implementation reference for [The Claude Engine](claude_engine.md). What the SDK and the binary actually do is in [The Claude Engine Contract](claude_contract.md); this file says where the code is and why it is shaped the way it is.

## File Locations

### Shared

| File | What it carries |
|---|---|
| `src/shared/engine.ts` | `AgentEngine = 'opencode' \| 'claude'`, `DEFAULT_AGENT_ENGINE`, `isAgentEngine()`, `claudeModelForComplexity()`, `engine` on `ResolvedRuntime`, `engine` on `LocalAgentRuntimeInput` |
| `src/shared/kit/manifest.ts` | `AgentRuntimeRef.engine?: string \| null` — typed as a loose string, not as `AgentEngine`, because an unrecognised value must read rather than fail |
| `src/shared/runtimeMessages.ts` | `EngineSkipCode` gains `claude_not_installed` and `claude_not_logged_in`; `describeEngineSkip()` writes both sentences |
| `src/shared/localAgentRequests.ts` | `describePermissionAction()` gains Claude's tool vocabulary beside OpenCode's |

### Main process

| File | Role |
|---|---|
| `src/main/services/agentTurn/claudeAgentTurnRunner.ts` | `ClaudeAgentTurnRunner` — the third `AgentTurnRunner`. Readiness, lock, environment, the SDK call, the permission gate, session save, the never-throws contract |
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
| `src/renderer/src/hooks/useLocalTools.ts` | `useLocalTools()` — the detected-tools query the Claude option and status column read (`staleTime: Infinity`, cached in main for the app's lifetime) |

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

None added. The engine travels on the existing runtime writes:

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
| `shellEnv` | `getShellEnv()` |
| `appVersion` | `app.getVersion()` |
| `query`, `turnCeilingMs` | tests only |

`runTurn(input)` order: agent exists → enabled → readiness is not `invalid` / `contract_too_new` → `claudePath()` → `withLock(...)` → `stream(...)`. A lock refusal is caught and returned as a result: `turnLock.acquire` throws a user-facing message, and letting it escape would close the port having posted neither `done` nor `error`, so the chat streams forever.

`stream(...)` internals worth knowing:

- `CLAUDE_TURN_CEILING_MS` = 20 minutes, armed around the whole iteration because this loop *is* the turn; aborting the controller is what actually stops the child
- an explicit **pre-flight abort check** after the awaits and immediately before `query()` — a listener attached to an already-aborted signal never fires, and there is no await between the check and the call
- `drain(resume)` — one pass over the generator, returning the error message or `null`. Called a second time with `null` only when the error matches `isMissingSession` (`/no conversation found/i`) **and** there was a remembered session **and** the turn was not aborted **and** nothing has streamed yet
- `isNotLoggedIn(message)` (`/not logged in|\/login/i`) maps a failure to `describeEngineSkip('claude_not_logged_in')`. Substring matching is not a shortcut: the SDK wraps every error result identically with `errorClass: 'error_result'`, so the text is the only discriminator
- exit order: **aborted → ceiling → error → `result.is_error`**. Abort first, so a deliberate stop is never reported as a failure
- `finish(...)` is the single exit: it saves the session (a failure there is logged, never fatal — continuity is a convenience) and returns `parts`, `text`, `notices` and `contextId`, keeping whatever streamed even on the error paths. It also takes the observed `apiKeySource` and appends the billing notice when that is anything but `'none'`. **All four exits pass it — completion, error, cancel and ceiling — because the observation is made at the init message, so the exit path a turn happens to take cannot decide whether the user is told.** A turn that reported the wrong account and then failed has still been billed to it, and the ceiling is the most expensive way to get this wrong: twenty minutes of work on an account nobody chose. The completion path alone carried it at first, and nothing failed, because the test written for it covered a turn that failed *before* init — a different case
- a `finally` cancels every request this turn parked on. A request left registered keeps reporting as pending, so a persisted block goes on rendering as answerable and answering it reports success into a turn that ended

The SDK options passed, and why each is not a default: `cwd` (the agent folder), `pathToClaudeCodeExecutable` (**the user's binary, never the SDK's bundled one**), `systemPrompt` (a plain string, never the `claude_code` preset), `model` (omitted entirely when the runtime names none), `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`, `includePartialMessages: true` (without it the turn appears to hang until the first tool call and the text path never runs), `env`, `canUseTool`, `abortController`, `resume`. **No `allowedTools`** — see the contract, and the `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning the SDK prints when one is present.

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
| `ClaudeStatus` (private) | `Checking…` while detection is in flight, `Claude Code <version>` (muted dot) when found, `Not installed` (danger) when not. **No Start button** — this app starts nothing there. The `title` carries the resolved path |
| `changeRuntimeTarget(value)` | The one picker's answer, now either an engine or a credential. To Claude: clear the credential and the model, keep the tier, note what was dropped. Away from Claude: clear the engine, keep the tier |
| `commitCredential(value)` | Returns `null` on the Claude path, always. A manifest may legally carry both an engine and a credential, and forwarding the credential from a control that is not on screen handed `validate` the one pair it refuses |
| `commit(..., {engine})` | `engine` **absent means "the engine the manifest already names"**. The panel rewrites the whole `runtime` block, so a save about the model that did not carry the engine would delete the user's engine choice |

Renderer rules that are decisions, not styling:

- **`declaredEngine` is read through `isAgentEngine`**, so a value a newer tool wrote is carried as "none" rather than written back as itself
- **Three tool-detection states, not two.** `tools === undefined` is `Checking…` with the status line silent; collapsing it with "no" showed the full not-installed alarm for half a second on machines that have Claude Code
- **The Claude option is offered when detection found one *or* the manifest already names the engine.** The second half stops the select rendering blank over a file that plainly says what it runs on — the same rule the credential list already follows for a keyless credential
- **`advanced` is forced `false` and the Advanced checkbox is removed** (not disabled) on this engine, from *inside* the fixed-height row, so the panel's footprint and the page's tab strip do not move
- **The model-registry gate is branched around.** Gating on it would leave both pickers disabled forever on a machine with no AI credential at all, which is exactly the machine most likely to be on this engine
- **`(none listed)` is suppressed** on tier options: it is a statement about a credential's catalogue, and here every tier resolves
- **The tier picker's empty option reads `Default (sonnet)`** — the Medium floor, named, because no catalogue could make it "none set"
- **The status line's Claude branch sits above every credential and loading branch**, and says *install*, not *login*. It names both "Claude Agent" and "Claude Code" in one sentence, because both are on screen and it is the only line with the width to tie them together — the option and the status column are the two width-constrained places
- **"Claude Agent" in the picker, "Claude Code" in the status column.** The first is a product-name constraint on a third-party surface; the second is a factual statement about the user's machine, which is what makes the line diagnosable
- `CLAUDE_OPTION` is `engine:claude`, prefixed so it cannot collide with a credential *name*. A credential literally called `engine:claude` would be shadowed; that is accepted rather than defended against

## Configuration

- **Contract version** — `1.2.0` in `resources/cinna-kit-contract/{VERSION,kit.json}` and mirrored in `layout.json`. Added `runtime.engine`
- **No app setting, no environment variable, no user-facing configuration.** The engine is a per-agent choice and nothing else
- **`CLAUDE_AGENT_SDK_CLIENT_APP`** is set *into the child*, never read from the parent
- **Packaging** — `!node_modules/@anthropic-ai/claude-agent-sdk-*/**` in `electron-builder.yml`. The SDK declares eight optional platform packages, each a single ~190 MB `claude`. Verified safe to drop on `darwin-arm64`: with the platform package deleted outright the SDK still imports and runs a full turn, because the bundled-binary resolution path is reached only when `pathToClaudeCodeExecutable` is absent — and it never is. The other seven targets are not built here

## Security

- **No credential of any kind is involved on this path.** The desktop stores no token, implements no login and never reads or writes anything under `~/.claude/`
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
| `claudeMessages.test.ts` | text, tool calls, subagents, the wider union, and the facts off `system/init` and `result` |
| `claudeAgentTurnRunner.test.ts` | who paid for the turn — silent on `'none'`, the notice on anything else with the answer still intact, and the same notice on **each of the four exits** (one test per path, each mutation-checked separately), silent again when no turn ever reported one; the options handed to the SDK (boundary closed, partial messages on, **no `allowedTools`**, the user's binary, a plain-string prompt, a key-free environment, model omitted when none); readiness before the turn; never-throws across a thrown failure, a yielded error result and a lock refusal; cancellation including an abort that lands during pre-flight (**no child spawned at all**); the four negative cases of the session retry; the ceiling; and the permission paths, including that an unreadable grant store asks rather than allows, and that an expired park denies and says so |
| `dispatch.test.ts` | `resolveTurnRunner`'s three-way choice, with the whole module graph below `index.ts` mocked. It exists because the failure it replaced was silent and permanent: an agent whose manifest said `engine: "claude"` went to the OpenCode runner, which could not find it in the config (now skipped there deliberately), found no skip reason to explain that, and answered *"This agent is not available in the running engine yet"* every turn, for ever |
| `runtimeService.test.ts`, `validator.test.ts`, `desktopStateService.test.ts`, `engineConfigSource.test.ts`, `RuntimePanel.test.tsx` | the engine field through resolution, validation, the bare agent's state, the config skip and the panel |

`e2e/specs/claude-engine.spec.ts` drives the built app through the choice itself: the option under its own `optgroup`, the manifest rewritten in **both** directions (to Claude clears `credential`, back clears `engine`, the tier survives either way), the panel reporting the detected install with no model list, and the panel's height measured before and after at both the default width and the 800px minimum, because the page's tab strip sits directly below it.

**It never runs a turn.** Spawning `claude` bills a real person's subscription on every developer's machine and in CI, so everything asserted there is knowable from the picker, the panel and the file; whether that install can actually answer is out of scope. Detection is **not** faked — the fixture writes the real `PATH` into the sandbox's rc files and the app's own detection answers, so on a machine without Claude Code the spec skips rather than asserting on an option that must not exist there. The absent case belongs to `RuntimePanel.test.tsx`, which can fake detection.

`agent-runtime.spec.ts` and `bare-agent.spec.ts` were updated for the renamed `Runs on` label and the required `engine` field, and nothing more.

## Related

- [The Claude Engine](claude_engine.md) — the rules and the reasons
- [The Claude Engine Contract](claude_contract.md) — what was watched, and what is still unverified (§8 is the list of open risks)
- [The Agent Turn Runner (tech)](agent_turn_tech.md) — the seam, the shared input/result, and the OpenCode implementation this shares nothing below
- [The Local Engine (tech)](engine_tech.md) — runtime resolution, config generation and the "Runs with" panel's other half
- [Local Agent Permissions (tech)](permissions_tech.md) — the grant store both engines write to
