# The Claude Engine — Technical Details

Implementation reference for [The Claude Engine](claude_engine.md). What the SDK and the binary actually do is in [The Claude Engine Contract](claude_contract.md); this file says where the code is and why it is shaped the way it is.

## File Locations

### Shared

| File | What it carries |
|---|---|
| `src/shared/engine.ts` | `AgentEngine = 'opencode' \| 'claude' \| 'codex'`, `DEFAULT_AGENT_ENGINE`, `isAgentEngine()`, `claudeModelForComplexity()`, `launcher` on `ResolvedRuntime`, `engine` on `LocalAgentRuntimeInput`, and `ClaudeAuthState` / `ClaudeAuthStatus` — the login answer as a caller may see it: a state, the CLI's own `authMethod` word, and a plan tier. **The account's email, organisation id and organisation name are in the CLI's response and are not in this type.** Also `ClaudeApproval = 'auto' \| 'ask'`, `DEFAULT_CLAUDE_APPROVAL` (`'auto'`) and `isClaudeApproval()` — the Approvals setting, deliberately its own two-member type and not the SDK's six-member `PermissionMode` |
| `src/shared/localAgents.ts` | `LocalAgentDesktopSummary.claudeApproval: ClaudeApproval \| null` — the one field of the setting that crosses to the renderer; null is *no choice made* and survives the round trip |
| `src/shared/kit/manifest.ts` | `AgentRuntimeRef.engine?: string \| null` — typed as a loose string, not as `AgentEngine`, because an unrecognised value must read rather than fail |
| `src/shared/runtimeMessages.ts` | `EngineSkipCode` has `claude_not_logged_in`; `describeEngineSkip()` writes its sentence. There is no `claude_not_installed` skip code: the launcher's install refusal is its own `CLAUDE_NOT_INSTALLED` sentence, since the only tool-less state left is an install that failed. The logged-out one ends with the panel's own instruction verbatim — *Run `claude` in a terminal.* — because the user meets that condition on two surfaces, and the panel is the one that could not be reworded (it is measured to the pixel). It is still not the same string: the opening clause names the engine, which a turn error in a transcript needs and the panel already says two rows up |
| `src/shared/localAgentRequests.ts` | `describePermissionAction()` gains Claude's tool vocabulary beside OpenCode's |

### Main process

| File | Role |
|---|---|
| `src/main/agents/drivers/acp/acpLaunchers.ts` | `createClaudeLauncher(deps)` — everything engine-specific left on this path: the spawn spec (this build's Node running the ACP adapter, with `CLAUDE_CODE_EXECUTABLE` naming the pinned binary the Claude binary service resolved), `CLAUDE_NOT_INSTALLED`, the `initialize` capabilities, the `_meta.claudeCode.options`, the session mode, and the two readiness rungs. It **plans or refuses**; it never runs a turn |
| `src/main/agents/drivers/acp/claudeAuth.ts` | `parseClaudeAuthStatus()`, `probeClaudeAuth()`, `ClaudeAuthProbe` — the free login probe, its parse rules and its short-lived cache |
| `src/main/ipc/local_tools.ipc.ts` | `local-tools:claude-auth`, and `local-tools:refresh` re-asking the login once detection has been rebuilt |
| `src/main/engine/binaryResolver.ts` | `CLAUDE_SPEC` (`searchPath: false`, `reusePinnedPath: true`, `acceptsVersion` = exactly `<pin> (Claude Code)`), `CLAUDE_ASSETS`, `configuredClaudePath()`, `realClaudeResolverDeps()` and the `CINNA_CLAUDE_DOWNLOAD=off` switch. The resolver itself is shared — see [The Local Engine (tech)](engine_tech.md) |
| `src/main/engine/engineBinaryService.ts` | `claudeBinaryService` — `state` / `peek` / `ensure` / `refresh` over that resolver, with the `path-pinned` fingerprint check |
| `src/main/ipc/engine.ipc.ts` | `engine:claude-binary`, `engine:claude-resolve`, the `engine:claude-binary-state` push, and the `localAgentsClaudePath` save hook |
| `src/shared/runtimePins.ts` | `RUNTIME_PINS.claude`: `cli`, `versionOutput`, `adapter`, and an `assets` row per platform (`format: 'executable'`, `sha256`, `size`) |
| `src/main/agents/drivers/acp/acpMessages.ts` | The translator, now shared with OpenCode. What is Claude-specific in it is where a tool's real name is read from (`_meta.claudeCode.toolName`, then `name`, then the first title) |
| `src/main/agents/drivers/acp/claudeAgents.ts` | `readFolderAgents()`, `CLAUDE_AGENTS_DIR`, `CLAUDE_AGENT_FIELDS_DROPPED`, `FolderAgentDefinition` — `.claude/agents/*.md` read into `options.agents`, with the permission-moving fields left out |
| `src/main/kit/miniYaml.ts` | `parseFrontmatter()` now returns `issues` beside `data` and `body` — the same list `parseWithIssues` reports — so a caller acting on the values can refuse a file the reader could not represent. See [Kit Contract (tech)](kit_contract_tech.md#srcmainkitminiyamlts) |
| `src/main/agents/drivers/acp/claudeEnv.ts` | `buildClaudeEnv()`, `auditClaudeEnv()`, `CLAUDE_STRIPPED_ENV`, `ENGINE_KEY_PREFIX`, `CLIENT_APP_ENV` |
| `src/main/agents/drivers/acp/claudePermissions.ts` | `toClaudePermissionRequest()`, `claudePermissionResources()`, `mintPermissionRequestId()` |
| `src/main/agents/drivers/index.ts` | Production wiring: `claudeAuthProbe`, the Claude launcher's deps (including `approval`, which reads the setting off the agent's desktop state and applies the default), `claudeAdapterEntry()` and `electronNodeRuntime()`, and the exported `acpProcessPool` that `will-quit` shuts down |
| `src/main/agents/drivers/acp/acpDriver.ts` | The one driver behind OpenCode, Claude and Codex. It asks the **folder** which launcher to use, so a Claude agent is never dispatched on a stale row |
| `src/main/agents/drivers/driverOf.ts` | `launcherOfFolder(runtime)` — the tolerant read of the folder's `runtime.engine`, which never answers null; `launcherOfRow` for the cached value a capability answer has to use |
| `src/main/services/localAgents/runtimeService.ts` | `declaredEngine()`, the Claude early return in `resolve()`, the engine refusals in `validate()`, `engine` in `toRuntimeRef()` and `applyToManifest()` |
| `src/main/services/localAgents/desktopStateService.ts` | `coerceRuntime()` — `engine` joins the bare agent's runtime allowlist; `DesktopState.claudeApproval`, coerced through `isClaudeApproval` so anything unknown reads as null, and copied into the summary |
| `src/main/services/localAgents/localAgentService.ts` | `setClaudeApproval()` — the one write path for the setting, for either kind of folder, under the turn lock, refusing any value that is not `auto`, `ask` or null |
| `src/main/ipc/local_agent.ipc.ts` | `local-agent:set-claude-approval` |
| `src/main/engine/engineConfigSource.ts` | `collectEngineAgents()` collects every folder agent, whichever engine it names — the caller is the OpenCode launcher, chosen from the folder, so it is never asked about a Claude one |
| `src/main/kit/validator.ts` | `checkRuntime()` — `engine` type check, the unrecognised-value warning, the engine-with-credential warning |

### Renderer

| File | Role |
|---|---|
| `src/renderer/src/components/agents/local/RuntimePanel.tsx` | The "Runs with" panel: the `Runs on` select grouping AI credentials, Claude, and Codex — both CLI options always listed, and marked with why when their CLI failed — `EngineRow`, `ClaudeStatus`, `commitCredential()`, `changeRuntimeTarget()`, the Claude branches of the status line and the disabled/advanced gates |
| `src/renderer/src/hooks/useLocalTools.ts` | `useClaudeAuth()`, `CLAUDE_AUTH_KEY` and `CLAUDE_AUTH_POLL_MS`, the login query the status line reads. The panel no longer reads `useLocalTools()`: the Claude option and the Engine column come from `useClaudeBinary()` in `src/renderer/src/hooks/useEngine.ts` |
| `src/renderer/src/components/settings/managedCliStatus.ts`, `claudeStatus.ts` | Every sentence about a managed CLI — the Runtime status line, the picker sub-line, the Developer Tools cell — written once for Codex and Claude Code; `claudeStatus.ts` is that module applied to Claude |
| `src/renderer/src/components/settings/ClaudeSettingsFields.tsx` | The **Claude Path** field, a `RuntimePathField` over `localAgentsClaudePath` |
| `src/renderer/src/components/agents/local/PermissionsCard.tsx` | Branches on the effective engine: the private `ClaudeApprovals` (the two-setting paragraph, the **Approvals** select, the one-line error slot) in place of the private `OpenCodeProfile` |
| `src/renderer/src/hooks/useLocalAgents.ts` | `useSetClaudeApproval()` — writes the returned DTO into the agent's own query with `setQueryData` rather than invalidating it |

### Resources and packaging

| File | Change |
|---|---|
| `resources/cinna-kit-contract/VERSION`, `kit.json`, `layout.json` | contract `1.1.0` → `1.2.0` (all three move together) |
| `resources/cinna-kit-contract/schema/cinna-agent.schema.json` | `runtime.engine`, `["string","null"]`, **no enum** |
| `resources/cinna-kit-contract/CHANGELOG.md` | the 1.2.0 entry, and the rule that an unrecognised value is not a broken folder |
| `electron-builder.yml`, `scripts/packaged-dependencies.cjs` | Root/nested CLI exclusions, automatic adapter runtime dependency unpacking and shipped-tree validation |
| `package.json` | `@anthropic-ai/claude-agent-sdk` added; `@anthropic-ai/sdk` `^0.89.0` → `^0.93.0` |

## Database Schema

**No migration.** The engine choice lives in the same two places every other runtime field does — and the Approvals setting in neither, since it is not a runtime field: it sits in Desktop State beside the grants for **both** kinds of folder, never in a manifest (see [Local Agent Permissions — Technical Details](permissions_tech.md#storage)). The engine:

- a kit agent's `cinna-agent.json`, under the file's stamp
- a bare agent's Desktop State (`<userData>/external-agents/<name>-<hash>.json`), whose folder is never written into

Session continuity reuses `a2a_sessions.context_id` and the `sessions` map in that agent's Desktop State, through the **same** `readSession` / `saveSession` implementations the OpenCode runner uses — deliberately, so "this chat remembers a session" cannot mean two different things depending on which engine answered.

## IPC Channels

**Two added here, and three for the binary.** `local-tools:claude-auth` sits on the `local-tools:*` surface rather than `local-agent:*` on purpose: it is a fact about the machine's `claude`, the same kind of fact as detection, and not about any one agent. `local-agent:set-claude-approval` is the opposite — a fact about one agent, kept beside its grants. The rest of the engine travels on the existing runtime writes:

| Channel | Signature |
|---|---|
| `local-tools:claude-auth` | `() → ClaudeAuthStatus`. `requireActivated()`, then the shared probe's cached answer. Carries the account's email and plan and no more: `claudeAuth.ts` never reads the organisation id or name out of the CLI's JSON, so nothing at this boundary has to remember not to forward them |
| `local-tools:refresh` | Unchanged signature (`() → DetectedTool[]`), one added effect: it also drops the cached login answer. It is dropped **after the `await`** on detection. That order was load-bearing while the probe took its path from `toolDetectionService.get`; the probe now takes it from the binary service, so the order is harmless rather than essential, and the button still means *go and look at this machine again*. The re-ask is fire-and-forget, so a refused login probe cannot fail the detection the button is named after |

| `engine:claude-binary` | `() → EngineBinaryState`. `requireActivated()`, then `claudeBinaryService.peek()` — looks without downloading, so a managed copy from an earlier run or an exact-version install reads `ready` rather than "installs on first use" |
| `engine:claude-resolve` | `() → EngineBinaryState`. Install or re-check now (*Install now* / *Try again*); a failed install **resolves** with the failed state rather than rejecting |
| `engine:claude-binary-state` (push) | `CLAUDE_BINARY_CHANNEL`: every transition, download progress included. Preload: `window.api.engine.claudeBinary()`, `resolveClaude()`, `onClaudeState()` |

Saving `localAgentsClaudePath` takes effect when it is saved: `appSettingsService.onSaved` invalidates the login probe and refreshes the binary service, so the Runtime row, the picker and the login state stop describing the previous binary.

| Channel | Signature change |
|---|---|
| `local-agent:update-field` | `{field: 'runtime', value: LocalAgentRuntimeInput}` — `value` gains `engine`. Stamped (kit agents) |
| `local-agent:set-runtime` | `{agentId, runtime: LocalAgentRuntimeInput}` — same input type. Unstamped (bare agents), since the write touches no file in the folder |
| `local-agent:set-claude-approval` | `{agentId, approval: ClaudeApproval \| null} → LocalAgentOutcome<LocalAgentDto>`. **Either** kind of folder, unstamped: the value is the desktop's own and lands beside the grants, never in a manifest. The handler passes `input?.approval` through **as it arrived** — null is a real answer (clear the choice) and a missing value must not be turned into it — and the service refuses anything but the two values or null with `invalid_input`. Also `not_found` and `turn_in_progress` |
| `agent:answer-request` | Unchanged and engine-agnostic. The Claude runner registers its ask in the same `pendingRequests` registry, so the answer path — including the *always* → grant → `once` conversion — is reused verbatim |

**`LocalAgentRuntimeInput.engine` is required, not optional, and that is the whole point.** `applyToManifest` deletes the key before rewriting the block, so a caller that simply omits it *erases the user's engine choice* from a file they commit. While `engine` was merely an unknown key the manifest layer preserved it verbatim; making it known removed that protection for exactly the field being added, so the compiler is made to ask every caller instead. Every existing caller — including the E2E specs — was updated to pass `engine: null` or the manifest's own value.

## Services & Key Methods

### `runtimeService` (`src/main/services/localAgents/runtimeService.ts`)

- `declaredEngine(runtime)` — `runtime.engine` if `isAgentEngine` accepts it, else `null`. The tolerant read
- `resolve(runtime, providers, models)` — returns early for `engine === 'claude'` with `source` identifying an explicit declaration or machine default, no credential of any kind, `modelId` = a declared model or `claudeModelForComplexity(complexity)`, `modelSource` `declared` / `tier` / `floor`, and `reason: null`. **The early return is above `resolveDefault`**, so a throw in the default-chat-mode or credential-override store cannot demote a Claude agent to OpenCode at dispatch
- `validate(input)` — now returns `engine` alongside the other three. Throws `LocalAgentError('invalid_input')` for an engine this build does not know, and for `claude` together with a credential. Shared by both write paths, so the refusal is not something the bare-agent writer can skip
- `toRuntimeRef(input)` / `applyToManifest(manifest, input)` — write `engine` first and treat all-four-null as "remove the block"

### `createClaudeLauncher` (`acpLaunchers.ts`)

`ClaudeLauncherDeps` is the injected world, so the launcher is drivable with no child process, no Electron and no database:

| Dep | Supplied in `drivers/index.ts` by |
|---|---|
| `binary()` | `claudeBinaryService.ensure()` — the step that may download. A failure comes back as `{error}` carrying the `ManagedAssetError` sentence, or `CLAUDE_NOT_INSTALLED`; it is never thrown |
| `binaryKnown(options?)` | `codexBinaryKnownFrom(...)` over `claudeBinaryService` — `ready` \| `pending` \| `failed`, free, never downloads; `fresh` retries a failed install. The helper is Codex's, reused as is |
| `claudeAuth(options?)` | `claudeAuthProbe.status()`, or `.refresh()` for a fresh check. The probe is built on `buildClaudeEnv(...)`, so it runs in the same environment the turn will use |
| `adapterEntry()` | `claudeAdapterEntry()` — the unpacked path under `app.asar.unpacked` when packaged, `require.resolve` in development. Throws if it is missing, which the launcher turns into a sentence rather than a 30-second protocol timeout |
| `nodeRuntime()` | `electronNodeRuntime()` — `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. **There is no `node` to rely on**: a user who installed Cinna has Electron, and picking a `node` off `PATH` would run the adapter on whatever happens to be there |
| `claudeEnv()` | `buildClaudeEnv({shellEnv, appVersion})` |
| `systemPrompt(userId, agentId, mode)` | forked on the runtime mode the folder view carries: `assembleBareNativePrompt(path, name, context, 'claude')` when `native`, otherwise `assembleAgentPrompt` (kit) or `assembleBareAgentPrompt` (a folder with no manifest that is still isolated — today only reachable through the development path, which returns before this). `resolveDesktopPromptContext()` plus the agent's own id |
| `model(userId, agentId)` | `runtimeService.resolve(...).modelId` — a plan alias on this path, `null` on failure, which hands the choice to the CLI's own default |
| `approval(userId, agentId)` | `desktopStateService.read(agent.path, agent.kind).claudeApproval ?? DEFAULT_CLAUDE_APPROVAL`, and the default again on any throw — the turn still runs, and every ask the classifier declines still reaches the block |
| `folderAgents(agentPath)` | `readFolderAgents(agentPath).agents`, read fresh each turn like the prompt. **Isolated sessions only** — a native session loads `.claude/agents/` from settings, and the launcher does not call this for one |

`plan(ctx)` order: `binary()` — first, because it is the step that may download — → `claudeAuth()`, asked of that binary, refusing only on `logged_out` → `adapterEntry()` → build the environment → read the prompt, model, approval and subagents **through `safely()`**, which falls back rather than failing a turn over a folder that moved or a manifest half-written by an assistant.

What it returns:

- **`spec`** — `command` = this app's binary, `args` = the adapter entry, `cwd` = the agent folder, `env` = `buildClaudeEnv`'s output plus `ELECTRON_RUN_AS_NODE` and `CLAUDE_CODE_EXECUTABLE`, `key` = a digest over the runtime, the adapter, the resolved `claude` path and the environment — so a binary that moved (a Claude Path saved, a self-updated install replaced by the managed copy) replaces the pooled process before the next turn. **Not the environment itself** — the key is logged
- **`init`** — `protocolVersion: 1`, `clientCapabilities: {elicitation: {form: {}}, _meta: airClientMeta(['asyncTasks', 'nativeSubagentSessions'])}`. `elicitation.form` is what keeps `AskUserQuestion` out of the adapter's `disallowedTools`, and it is the whole of this engine's question path. The AIR capabilities make the adapter report background tasks and subagents. `nativeSubagentSessions` also moves a subagent's frames to its own session and stops the parent receiving the `Agent` `tool_call`, which the driver puts back (`acpActivity.ts:SubagentFrames`, [Session Activity (tech)](../session_activity/session_activity_tech.md#the-synthesized-agent-call-subagentframes))
- **`endsTurnsWithCostedUsage: true`** — this adapter ends every turn, including the ones it starts itself, with a `usage_update` carrying `cost`. So a [follow-up turn](agent_turn_tech.md#runfollowup-acpdriverts) on Claude ends only on that marker, a Stop, the process exiting or the ceiling, never on quiet
- **`session`** — `mcpServers: []` and `_meta.claudeCode.options`, **forked on `ctx.folder.runtimeMode`**:
  - *isolated* — `systemPrompt` as a plain string (never the SDK's `claude_code` preset, which is a coding assistant's prompt and would talk over the folder's), `model`, `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`, and `agents` **only when the folder has some**
  - *native* — `systemPrompt: {type: 'preset', preset: 'claude_code', append: <the desktop context>}`, `model`, `settingSources: ['user', 'project', 'local']`, and **nothing else**: no `strictMcpConfig`, no `mcpServers`, no `agents`. Either MCP option would take the folder's own servers back out; the `agents` option would state every definition twice

  **No `allowedTools`** on either branch, because a bare name there shadows the permission request the desktop's grants run through
- **`setup`** — `modeId: approval === 'auto' ? 'auto' : 'default'`, applied after every `session/new` *and* every `session/load`, **on both branches**, and never anything else: every other mode takes the desktop's request, its grants and the transcript's record out of the decision. This call is the only thing that sets the mode — `_meta.claudeCode.options.permissionMode` was watched being ignored (2026-09-17, `claude` 2.1.274 / adapter 0.76.0: sent `default`, the session opened `acceptEdits` from a project `settings.local.json`, under `settingSources: []` as well as under the three scopes)

Everything the old runner owned around this — the lock, the ceiling, the parks, the abort, the session stores, the exits — is the driver's now and is shared by all folder engines. See [The Agent Turn (technical)](agent_turn_tech.md).

**What went with the runner**, because it is the sort of thing a reader will look for: the async-iterable prompt held open past the first `result`, the background-task set and its five-second grace, the `drain(resume)` retry for a forgotten session (now a `catch` around `session/load`), `isNotLoggedIn`'s substring match on a thrown error (readiness answers before the turn instead), and the `CLAUDE_BACKGROUND_GRACE_MS` / `CLAUDE_TURN_FREE_TASK_TYPES` constants.

### `claudeAuth.ts` — the free login probe

Three pieces, and the split is what makes the rules testable without a binary:

- `parseClaudeAuthStatus(stdout)` — pure. `loggedIn` **must be a boolean** or the answer is `unknown`; `!!record.loggedIn` would read a missing field as a definite "logged out" and lock the user out of a working engine. Reads `authMethod`, `subscriptionType` and `email`, and **nothing else** — `orgId` and `orgName` are in that JSON and are never lifted out of it
- `probeClaudeAuth({claudePath, env, timeoutMs, exec})` — one `execFile(claudePath, ['auth', 'status'])`. **The callback's `err` is not the signal**: a logged-out install exits **1** with valid JSON on stdout (contract §5, re-measured), so branching on the error collapses the one state this module exists to detect into `unknown`. Never rejects — every failure is `unknown`, since the only thing a failed probe justifies is not blocking the turn. Raced against an own timer at `timeoutMs + 500` for the reason `toolDetectionService.probeVersion` documents: `execFile`'s own `timeout` fires on **close**, which waits for the stdio pipes to reach EOF, so a shim whose grandchild inherits stdout leaves the callback pending after the direct child is dead. `CLAUDE_AUTH_TIMEOUT_MS` is 5 s against an observed ~0.27 s — a hang guard, not a budget
- The fallback timer is cleared in `finally` when the race settles. Promise races do not cancel their losing timer: leaving it alive previously logged a false timeout after a valid logged-in or logged-out answer. Genuine callback hangs still return unknown at the fallback ceiling; `src/main/agents/drivers/acp/claudeAuth.test.ts` covers both outcomes.
- `ClaudeAuthProbe` — the cache. `CLAUDE_AUTH_TTL_MS` is **30 s, not the app's lifetime**: this is the answer that changes while the app is open, because the app has just told the user to go and change it. The in-flight promise is shared, so a panel render and a turn starting together spawn one child. `refresh()` drops the answer, and a refresh landing while a probe is in flight **joins that one** — deliberately, since that child was spawned moments ago under a five-second bound. `run()` catches, because `claudePath()` and `env()` both do real work (a PATH walk, a profile source) and a rejection would surface at the runner's `await`, outside its `try`. No binary yet answers `unknown`, spawns nothing, and is **not cached**: the pinned CLI is fetched by the first turn that needs it, and an `unknown` held for the window would let the launcher skip the logged-out refusal on the very turn that installed it. `invalidate()` forgets the answer **without asking again** and bumps a generation, so a probe in flight against the previous binary finishes for its own caller and is neither shared nor kept — it is what a saved Claude Path calls, since the new path may still be resolving (`CodexAuthProbe.invalidate`'s twin)

Logging is **states and durations only, never `stdout`**. An `unknown` verdict logs a warning with the byte count standing in for the output, because four different causes land there and without a line "it never says I am logged in" leaves no trace anywhere.

Wiring lives in `src/main/agents/drivers/index.ts` (`:188`), which also hands the `claude` driver a `claudeAuth` that calls `refresh()` on a fresh readiness check (`:341`): `claudeAuthProbe` is a `ClaudeAuthProbe` whose `claudePath` is `runningBinary(claudeBinaryService)` — the service's `peek`, so **the binary the sessions run on** and never the PATH copy detection reports for "Open in…" — and whose `env` is `buildClaudeEnv({shellEnv, appVersion})`. Constructed there rather than at either call site **because of the environment**: the binary answers differently depending on its child environment (the `USER` finding), so a probe under the full shell environment would report a login for a child that then cannot authenticate.

### `buildClaudeEnv` (`claudeEnv.ts`)

`shellEnvForChild(shellEnv, allowlist, processEnv)` → drop everything in `CLAUDE_STRIPPED_ENV` → drop every `CINNA_ENGINE_KEY_*` → add `CLAUDE_AGENT_SDK_CLIENT_APP = cinna-desktop/<version>`. Deliberately pure and Electron-free.

Starting from the shared helper rather than hand-assembling a dictionary is what makes `USER` present automatically — the shared allowlist begins with the MCP SDK's inherited set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), and the hand-assembled version is what left `USER` out and produced "Not logged in" on a logged-in machine.

`CLAUDE_CODE_ENTRYPOINT` is **not** set: the SDK owns it, and overwriting it would misreport how the CLI was invoked.

`ClaudeEnvInput.allowlist` is injectable for one specific reason and it is not general testability. The real allowlist happens not to contain `ANTHROPIC_API_KEY` or any `CINNA_ENGINE_KEY_*`, so the narrowing alone removes them and the explicit strip is untestable through the front door — a mutation deleting the strip passes every test written against the real list. That is exactly the state in which a later widening silently restores the billing trap.

`auditClaudeEnv(env)` returns the offending **names, never values**, and the runner logs at `error` if it finds any.

### The translator, and what is Claude-specific in it

`ClaudeMessageStream` is gone; `AcpMessageStream` (`acpMessages.ts`) folds all folder engines' `session/update` notifications into the cumulative message every consumer already reads. The rules that used to be written about the SDK's message union hold in their ACP form and are documented with the turn ([The Agent Turn](agent_turn.md#the-translator-maintains-a-cumulative-message-the-accumulator-computes-the-delta)).

Two things about this engine's stream still need saying here:

- **The tool name is read from `_meta.claudeCode.toolName` first**, then the adapter's non-standard `toolCall.name`, then the first title. The adapter titles a Bash call `"Terminal"` and then retitles it with the command, so the title alone is not a tool name — and the *action* a grant is stored under is that name (`Bash`, not `bash`)
- **A turn's tool calls can arrive before its first text chunk** under this adapter — five tool calls, then the reply, in the recording — and `tool_call` notifications carry no message id in either engine, so they land in an anonymous message of their own rather than adopting the id of whatever message comes next

What the CLI reports about itself arrives as an extension notification (`_auth/status_update`) or a `current_mode_update` rather than as a `system/init` message, and the driver acts on both:

- **The mode**: asked for `auto` and told `default` — a model with no reviewer — is a notice in the transcript, in the words of whichever way the disagreement went
- **The login**: `authStatus.kind` is `'account'` for a subscription login (recorded: `{kind:'account', label:'Claude Max', account:{plan:'max', …}}`). Anything else means something reached the child that this app intended to strip, and the transcript says so — *"This turn did not run on the agent's own login — it reported "…". It may be billed to that account instead."* — because a turn billed to an account the user did not choose looks exactly like a turn billed to the right one, and a log line is no use to somebody who does not already suspect it. **Only the kind and a scrubbed label are kept**: the same payload carries the account's email address, unasked, and `scrubbed()` strips anything email-shaped so a future adapter cannot smuggle one into the label

`cliVersion`, `usage` and `numTurns` are read by nothing, deliberately: no cost and no token figure reaches the transcript.

### Folder subagents (`claudeAgents.ts`)

`readFolderAgents(agentDir)` → `{agents: Record<name, FolderAgentDefinition>, skipped: {file, reason}[]}`. Never throws: no `.claude/agents/` directory, or one that cannot be listed, is an empty result, and the turn runs as it did before the module existed.

Per file, in name order: `.md` regular files only → `parseFrontmatter` (no frontmatter → skipped) → **any `issues` → skipped**, with the line and message in the reason → name from `name:` or the file's basename, which is what a terminal `claude` falls back to and what the folder's docs refer to either way → `description` required (*"the model would never pick it"*) → the body below the frontmatter, trimmed, is the `prompt`, and is required.

Copied when present and well-typed: `tools` and `disallowedTools` and `skills` (a comma-separated string or a YAML list, each item trimmed, empty dropped), `model` (string), `maxTurns` (positive integer), `effort` (`low` / `medium` / `high` / `xhigh` / `max` or a number), `background` (boolean). The shape is `AgentDefinition` from `sdk.d.ts` at 0.3.266, verbatim.

`CLAUDE_AGENT_FIELDS_DROPPED` names what is never copied — `permissionMode`, `mcpServers`, `memory`, `observer`, `observerMessage`, `criticalSystemReminder_EXPERIMENTAL`, `initialPrompt` — as an exported list so a test can pin that each stays out whatever the file says. `permissionMode` is the one that matters: `bypassPermissions` there would skip `canUseTool` for the whole subagent. The skip-on-issues rule is why `parseFrontmatter` grew its `issues` field: the reader renders a block scalar as the literal `"|"` and an unquoted `#` as a truncated line, and a subagent described to the model as `"|"` is worse than one it is not offered.

### Permission mapping (`claudePermissions.ts`)

- `toClaudePermissionRequest(toolName, input)` → `{action: toolName, resources, savable: []}`. `action` is Claude's own tool name, stored as-is. `savable` is empty because there is no second store to report — the desktop derives the grant from `resources` and writes it beside the folder
- `claudePermissionResources` reads the first present field from a per-tool table (`Bash: command`, `Read`/`Edit`/`Write`: `file_path`, `NotebookEdit: notebook_path`, `WebFetch: url`, `WebSearch: query`, `Glob`/`Grep`: `pattern`, `path`, `Agent`/`Task`: `description`, `prompt`), falling back to a generic list. A tool missing from the table produces an ask the user can only remember as the whole action — deliberately the widest and least attractive option
- `Agent` **and** `Task` are both listed: `Agent` is what `claude` 2.1.266 emits, `Task` is the name in the SDK's types
- `mintAcpRequestId('permission')` (`acpPermissions.ts`) mints `per_acp_<base36>_<n>`; `mintPermissionRequestId()` is unused by the turn path. The `per_` prefix is required because `isEngineRequestId` gates on it and the renderer's read-only replay rule depends on that: a persisted block bearing such an id is not answerable, since the id is a live address that dies with its turn. Minting the prefix is a smaller change than widening the predicate
- The answer is the **response to the blocking `session/request_permission`**: an option id from the agent's own list, chosen by `pickPermissionOption`, which filters `allow_always` out before it searches. An agent that offered nothing usable is answered `cancelled` rather than handed an invented id. What the model receives on a denial is the agent's own wording as the tool result, verbatim — observed — so it is written for the model, not for the transcript
- An expired park **resolves** with `{kind:'rejected'}` rather than rejecting, so it is ordinary control flow with its own branch: deny, and the transcript says *"No answer — the request expired."* rather than *"Denied."*
- A throwing grant store is caught and treated as "ask the user"

### Dispatch and readiness (`src/main/agents/drivers/`)

**Dispatch.** `driverFor(agent)` reads `agents.driver` and nothing else, so no folder is read for an agent whose kind the row already settles. Every folder agent's row says `acp`; which **engine** it runs is `driver_config.launcher`, written by the scanner (`folderIndexLauncher`) and by `agentRepo.setFolderLauncher` when the user picks one in the Runtime card.

**A turn still does not trust the column.** `acpDriver.run` reads the folder through `readFolder` and takes its launcher from `launcherOfFolder(folder.runtime)`. The column is a cache of that same read, and a stale one used to matter a great deal: with a driver per engine, a Claude agent dispatched on an `opencode` row had to be handed across, and while that hand-off was missing it answered "try again in a moment" for ever. With one driver it is a lookup.

**`launcherOfFolder` never answers null**, and that distinction is load-bearing: "the runtime was read and names nothing" is an answer — the default engine — while "the manifest could not be read" is not, and only the scanner's `unresolved` check may say *keep the row's value*. Collapsing the two left a user who had cleared the engine in the Runtime card running on the engine they had cleared.

**Readiness.** The driver answers the folder's own state first, then asks the **launcher the folder names** for its rungs — so an agent just switched to Claude is answered about Claude rather than about the row's older value. The Claude launcher's two rungs:
- a **failed** install (or an unusable Claude Path) → `not_installed`, with `CLAUDE_NOT_INSTALLED` as the reason and main's own sentence as `detail`. `pending` — not fetched yet, or downloading — stays `ok` on purpose: a send joins the install at the top of its turn, and refusing meanwhile would block the one action that fetches it
- a definite `logged_out` → `not_logged_in`

A list-time check answers from the binary service's memoised `peek` and the probe's 30-second cache. A **fresh** check (the composer's *Check again*) retries a failed install and re-asks the binary, so a `claude login` the user has just run counts. `unknown` never blocks, and the OpenCode launcher has no `readiness` at all — its binary is one this app will download, so its absence is not a state a user has to fix. Claude's is downloaded too; it keeps a rung because a *failed* download, and the login, are.

## Renderer Components

The full runtime form and Permissions tab live in agent **Settings**. Chat mode uses `RuntimePanel compact`; its “with subscription” suffix requires `logged_in` plus `authMethod === claude.ai` or a nonempty subscription type. Unknown authentication remains unqualified. The compact model badge derives from complexity; it does not render a manually declared model override.

| Component / helper | Renders / manages |
|---|---|
| `RuntimePanel` | The first select is labelled **`Runs on`** (was `Credential`) and groups `On this machine` with a `Claude Agent` option valued `engine:claude`, and `AI credentials` with the existing list; and a `Codex CLI` group. **Both CLI options are always rendered**; a failed one is marked in its label — `Claude Agent (install failed)`, `(path not usable)` — never in its value, because the file is written from the value. An option that vanished made this select and the Settings picker, which keeps its button and reads *Unavailable*, disagree about whether the runtime exists. `cliFailureCopy()` holds the four wordings of each failure (badge, option, line, tooltip) and branches on whether a path is saved. The pending model placeholder was renamed `Model choice`, because two controls on one surface must not announce the same name |
| `EngineRow` (private) | The third column's row — dot, word, optional button — shared so folder engines render into one fixed `h-[26px]` slot. `dot` and `tone` are passed in, not derived: the engine status and CLI login checks mean different things by the same colours |
| `EngineStatus` (private) | Unchanged, and shown only for OpenCode agents |
| `ClaudeStatus` (private) | `Checking…` while the binary-state query is in flight, `Claude Code <label>` otherwise — the label is `claudeVersionLabel()`'s: `<pin> managed`, `<pin> (your install)`, `<version> unverified` or plain `unverified` — and `Install failed` / `Path not usable` when there is nothing to run. **No Start button** — this app starts nothing there. The `title` carries the resolved path. **The login is deliberately not in this cell's text** — not because it is unknowable, but because the column is fixed at 219 px and does not widen with the window, so it holds the shortest true thing and the status line carries the meaning. Takes `auth={claudeAuth?.state}`, which decides the **dot only**: danger on a failed install or unusable path, `--color-warning` on a definite `logged_out` (the type scale's *"Awaiting auth"*, and warning not danger because the install is fine and one command fixes it), muted for `unknown`, in-flight and `logged_in`. **Never the success colour** — one option away in the same slot a green dot means *the process is running*, so green here would be one indicator in one position meaning two things |
| `planSuffix(subscriptionType)` (private) | `"max"` → `" (Max plan)"`, empty string when the CLI named none. Passed through and capitalised, never mapped: this app does not own the set of plan names, and a lookup table would render an unrecognised plan as blank on the one line meant to say who pays |
| `changeRuntimeTarget(value)` | The one picker's answer, now either an engine or a credential. To Claude: clear the credential and the model, keep the tier, note what was dropped. Away from Claude: clear the engine, keep the tier |
| `commitCredential(value)` | Returns `null` on the Claude path, always. A manifest may legally carry both an engine and a credential, and forwarding the credential from a control that is not on screen handed `validate` the one pair it refuses |
| `commit(..., {engine})` | `engine` **absent means "the engine the manifest already names"**. The panel rewrites the whole `runtime` block, so a save about the model that did not carry the engine would delete the user's engine choice |
| `ClaudeApprovals` (private, `PermissionsCard.tsx`) | Rendered in place of `OpenCodeProfile` when the effective engine is Claude, including the machine default. One paragraph describing **both** settings above the control — a sentence that changed with the select would resize the card on every toggle — then the `Approvals` select (`auto` / `ask`, `value = pending ?? stored ?? DEFAULT_CLAUDE_APPROVAL`), then a `h-[15px]` truncating error slot that is always rendered with the full text in `title`. `pending` holds the pick until `onSettled`: the select is otherwise controlled by the DTO, and main re-scans the folder before answering, so the control snapped back to the old value for the round trip and flipped afterwards. `onError` writes *"Nothing was changed — "* plus the lower-cased reason. The grants footnote's last clause is *on the default setting* here rather than *which is asked again* |
Renderer rules that are decisions, not styling:

- **`declaredEngine` is read through `isAgentEngine`**, so a value a newer tool wrote is carried as "none" rather than written back as itself
- **Three binary states, not two.** `claudeBinary === undefined` — the query in flight — is `Checking…` with the status line silent; collapsing it with "no" is what once showed the full not-installed alarm for half a second on machines that had Claude Code, back when the question was PATH detection
- **The dot moved because the line alone was not glanceable.** The reserved line turned red on a logged-out machine while the row's one indicator stayed neutral grey about a state the app had just gone and found out. That is the whole reason `ClaudeStatus` takes the auth state at all; nothing in the cell's *text* changed
- **Three login states, and `undefined` is a fourth.** The status line's Claude ladder is: binary state unknown → silent; failed → `cliFailureCopy().line` in danger; `claudeAuth === undefined` (the query in flight) → **silent**; `logged_out` → the remedy-first danger sentence; otherwise the note, which says *login* (plus `planSuffix`) on `logged_in` and plain *runs on Claude Code* on `unknown`. Silence while the probe is in flight is not caution for its own sake: filling the slot with the reassuring install sentence meant a logged-out machine read healthy in muted grey and was contradicted in red ~100 ms later (measured at t=891 ms and t=996 ms). Nothing moves either way — the line is reserved — so what the retraction costs is the credibility of the next reassuring sentence. `unknown` is **not** silence: it is an answer, and the plain sentence is the true thing to say about it
- **The logged-out line leads with the remedy** — `Run \`claude\` in a terminal: that Claude Code install is not logged in.` At the 800 px minimum it needs 432 px and has 414 px, so the problem-first wording lost the half naming the action (rule 7). It is deliberately **not** `describeEngineSkip('claude_not_logged_in')`: that sentence is a *turn error* and opens "This agent runs on Claude…", which is narration on a panel that says so two rows above
- **The Claude option is always offered.** It used to depend on PATH detection, with an exemption for a manifest that already named the engine so the select never rendered blank; with a CLI Cinna fetches for itself there is no absent case left to exempt, and the kind-branch ratchet's count for this file dropped by that one read
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
- **Engine selection may be per-agent or inherited from the machine Default runtime.** The approval choice remains per-agent: **Approvals** (`DesktopState.claudeApproval`, `auto` \| `ask` \| null), with `DEFAULT_CLAUDE_APPROVAL = 'auto'` applied at read time in `claudeDeps.approval` and in the card, never written to disk in place of null
- **The turn's own constants live with the driver now** (`ACP_TURN_CEILING_MS`, `ACP_CANCEL_GRACE_MS`, `ACP_IDLE_REAP_MS`), none read from the environment. The runner's `CLAUDE_BACKGROUND_GRACE_MS` and `CLAUDE_TURN_FREE_TASK_TYPES` went with it: the adapter decides when a turn with background work is over. What is left to the desktop is showing that work, keeping the process up while it runs (`ACP_BUSY_REAP_CEILING_MS`, 30 min) and saving the turn Claude starts when it ends
- **`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` is deliberately not set** into the child. It would remove `run_in_background` from the CLI's tool schemas — buying nothing now that the stdin hazard is gone, and taking away a capability the user's own `claude` has
- **`CLAUDE_AGENT_SDK_CLIENT_APP`** is set *into the child*, never read from the parent
- **`DISABLE_AUTOUPDATER=1`** (`AUTOUPDATER_ENV`) is set into every Cinna-spawned `claude` — sessions and the login probe — and set **last** in `buildClaudeEnv`, so nothing inherited can switch it back on. A session may be running on the user's own install, and that install's background updater replaces the binary and retargets `~/.local/bin/claude` from inside whichever process is running
- **`localAgentsClaudePath`** — app setting, default empty. Validated as absolute-or-empty on save; whether it runs is the resolver's answer, reported as state
- **`CINNA_CLAUDE_DOWNLOAD=off`** — turns the managed download into a `download_failed` with a sentence. Set by the E2E fixture on every launch, after a spec's own variables so none can switch it back on
- **The pin** — `RUNTIME_PINS.claude` in `src/shared/runtimePins.ts`; `PINNED_CLAUDE_VERSION` in `src/shared/engine.ts` is the renderer's view of it
- **Packaging** — root/nested `@anthropic-ai/claude-agent-sdk-*` exclusions keep the bundled CLI binaries out; `CLAUDE_CODE_EXECUTABLE` makes that safe. The managed Claude Code is not packaged either: it is downloaded into `userData` on first use. The hooks in `scripts/packaged-dependencies.cjs` unpack the adapter and its installed runtime dependency tree, then reject missing required shipped dependencies. Unpacking only the adapter left its SDK imports unreachable in the Node child. See [Packaged Runtime Dependencies](../../development/distribution/packaged_runtime.md) for peer/optional handling, re-hoisting, manual smoke checks and the measured platform/runtime boundaries.

## Security

- **No credential of any kind is involved on this path.** The desktop stores no token, implements no login and never reads or writes anything under `~/.claude/`
- **The organisation behind the login is never read; the account is.** `claude auth status` answers with the account's email, organisation id and organisation name; `parseClaudeAuthStatus` lifts the **email** out and leaves `orgId` and `orgName` where they are, so neither reaches `ClaudeAuthStatus`, a log line, or the renderer. **The absence of the read is the defence** — a rule saying "do not log the organisation" is one careless edit from being untrue, whereas a field nothing reads cannot leak. The email is read because it is the answer to the panel's own question, *which login pays for this turn*, which a plan tier cannot give on a machine holding more than one Claude login; it is the user's own account shown back to them, and it still never reaches the logger, which carries states, methods and durations only. What crosses is the state, the CLI's own `authMethod` word, and a plan tier
- **The child environment is constructed, and audited on the value handed over.** See `CLAUDE_STRIPPED_ENV` and `auditClaudeEnv`; the audit logs names only, because logging a key's value to explain that it leaked recreates the leak in the log buffer
- **`settingSources: []` plus `strictMcpConfig: true` plus `mcpServers: {}`** is the isolation boundary, and all three are required. The first alone left the user's own MCP connectors — Gmail, Drive, Calendar in the probe — attached to a folder agent, with no Cinna surface saying so. **It applies to isolated sessions only**: kit folders and Cinna's own build session. An adopted bare folder is deliberately not isolated (see [The Claude Engine](claude_engine.md#a-kit-folder-is-sealed-a-bare-folder-runs-on-its-own-setup)), so on that branch the user's connectors, the folder's `.mcp.json` — with no trust step — and the folder's `defaultMode` all reach the session. Watched 2026-09-17 against `claude` 2.1.274 / adapter 0.76.0
- **`runtimeMode` is derived once, in `readAcpFolder`, and never re-derived from `kind`.** The local-development build session presents a synthetic `kind: 'bare'` view over a synced workspace while running `isolated`; a `kind === 'bare'` test inside a launcher would have given Cinna's own build session that workspace's settings files
- **Nothing is pre-approved by the desktop.** No `allowedTools`, so every gated tool reaches the desktop's permission request. Read-only tools are **not** gated by the CLI at all, and pre-approving a name would shadow the request entirely — the SDK says so itself at runtime
- **On *Automatic* the CLI's own reviewer approves before the desktop is asked, and it was not seen to decline.** Seven probes — a force push, a global git config rewrite, a write outside the folder — and not one reached the block. So on that setting the grants and the block are a backstop, and every surface says so
- **The permission mode is two-valued at the desktop's boundary.** `bypassPermissions` and `dontAsk` are unreachable from the select, refused by `setClaudeApproval`, and coerced to null off disk — a hand edit reaching for the SDK's vocabulary reads as *no choice*, never as the more permissive setting
- **The reviewer runs with no environment context.** The user's `autoMode.environment` lives in `~/.claude/settings.json`, which `settingSources: []` withholds and this engine never reads; the session transcript showed `repoVisibility: unknown` and nothing else. Nothing here tries to pass it
- **A folder subagent cannot move a permission decision.** `readFolderAgents` never copies `permissionMode` or `mcpServers` from a `.claude/agents/*.md` frontmatter, so a text file in the folder cannot put a subagent on `bypassPermissions` or reattach a connector `strictMcpConfig` shut off. The asks a subagent raises reach the same permission path and the same grants as the main thread's. With native subagent sessions they are addressed to the child's session id, and they reach the parent turn's handlers only because the connection aliases that session to its parent (`acpClient.ts:aliasSession`). A request for an unaliased, unbound session is refused after the pre-bind window
- **Permission grants are per-folder and per-engine-vocabulary.** `Bash` and `bash` are different actions, so a rule written on one engine never authorises the other
- **A login that is not the install's own is said in the transcript, on every exit.** `authStatus.kind` other than `'account'` means something reached the child that was meant to be stripped, and the person is being billed somewhere they did not pick. **Only the kind and a scrubbed label leave the driver** — the same payload carries the account's email address, unasked and with no way to switch it off short of refusing subscription use, so `scrubbed()` strips anything email-shaped rather than trusting the label to stay a plan name. `auditClaudeEnv` (on the value actually handed over) is the other half of the same guarantee
- Not a sandbox. As on the other engine, a shell command reaches anything the user can

## Tests

| File | What it pins |
|---|---|
| `claudeEnv.test.ts` | `USER` and `HOME` present; the login-shell `PATH` present; the client-app identifier set and `CLAUDE_CODE_ENTRYPOINT` not; keys and `CINNA_ENGINE_KEY_*` stripped **through a deliberately over-wide injected allowlist**; an API key stripped even when it arrives beside a valid login; the audit finding nothing afterwards, and reporting names rather than values; `DISABLE_AUTOUPDATER=1` set whatever the shell said |
| `contracts/claude.contract.test.ts` | one test per entry of `claude.contract.ts`, against the real pinned binary and the real adapter — not part of `npm test`; see [Claude Code Interface Contract](contracts/claude_interface.md) |
| `claudeAuth.test.ts` | the parse (a plan and an account read on a logged-in answer, with the organisation **never** on the returned object; a non-boolean or absent `loggedIn` as `unknown`, not `logged_out`), the probe (**a logged-out answer that exited 1 is still read** — the exit code is not the signal; the path, `auth status` and the given environment actually handed to `execFile`; a callback that never fires resolving `unknown` rather than hanging; an unspawnable binary as `unknown`, not `logged_out`), and the cache (one ask inside the window, a re-ask after it, `refresh` dropping it immediately, one child for two concurrent callers, never rejecting whichever dependency throws, and no spawn at all when there is no install) |
| `local_tools.ipc.test.ts` | that `local-tools:refresh` re-asks the login **against the detection it just refreshed**, and that a failing login probe still lets the channel answer with the detected tools |
| `useClaudeAuth.test.tsx` | that the poll runs while the answer is `logged_out` and stops on every other answer, including `unknown`, and that a `visibilitychange` refetch ignores its own freshness window |
| `acpMessages.test.ts` | the fixtures under `__fixtures__/claude/` folded into parts: the tool-name precedence (`_meta.claudeCode.toolName` over `name` over the first title), tool calls arriving before the first chunk, a mode update, and an unknown update kind ignored |
| `acpLaunchers.test.ts` (Claude half) | the readiness rungs — a `logged_out` install refused **before anything is spawned**, an `unknown` probe running the turn anyway — the declared `elicitation.form` and AIR capabilities, `endsTurnsWithCostedUsage`, the `_meta` options (including `settingSources: []`, `strictMcpConfig` and no `allowedTools`), `CLAUDE_CODE_EXECUTABLE` naming the binary `binary()` returned, a failed install refusing while a pending one does not, and the mode the approval setting maps to |
| `claudeAgents.test.ts` | a folder with no agents directory yielding nothing without throwing; a definition read as the folder wrote it; the file name as the fallback name; YAML lists for `tools` and `skills` and the optional numbers; a file with no description skipped and named; one bad file not taking the others with it; **the boundary** — `permissionMode` and `mcpServers` never carried whatever the file says; and the reader's own limits — a block-scalar description and an unquoted `#` each skipping the file rather than offering a subagent described as `"|"` or a truncated line, with the quoted form of the same description read cleanly |
| `src/main/agents/drivers/index.test.ts` | `driverFor` and the per-turn reconcile, through the real wiring with the whole module graph below `index.ts` mocked. It replaced the old resolver's dispatch test and keeps its scenarios, because the failure it guards is silent and permanent. An agent whose manifest said `engine: "claude"` went to the OpenCode runner, which could not find it in the config (now skipped there deliberately), found no skip reason to explain that, and answered *"This agent is not available in the running engine yet"* every turn, for ever. A row that still says `opencode` is exactly how that failure would come back, so the test pins a folder naming Claude running on Claude **while its row still says OpenCode** |
| `acpDriver.test.ts` | the whole turn against a real fake-agent child process, including the launcher chosen from the folder rather than the row, and the driver contract; follow-up turns, including a Claude one ending on the costed `usage_update` and not on quiet |
| `acpActivity.test.ts`, `acpActivity.driver.test.ts` | the recorded Claude background-shell, subagent and stop fixtures read into activity items, and a subagent turn's saved transcript identical to the one produced before `nativeSubagentSessions` |
| `runtimeService.test.ts`, `validator.test.ts`, `desktopStateService.test.ts`, `engineConfigSource.test.ts`, `RuntimePanel.test.tsx` | the engine field through resolution, validation, the bare agent's state, the config skip and the panel |
| `desktopStateService.test.ts`, `localAgentService.test.ts` (approvals) | the setting round-tripped for either kind of folder, in the folder for a kit and under `userData` for a bare one; null read as null and written as null, not as today's default; `bypassPermissions` on disk read as null; the value in the summary; the setter refusing an unknown value with `/approval setting/` and storing nothing; a kit folder's manifest untouched by the write |
| `PermissionsCard.test.tsx` (Claude) | the OpenCode profile sentence absent and the *approved everything it was shown* sentence present; no choice rendering as `auto`; a stored `ask` rendered; a change holding the picked value through the round trip **over a live query**, the way the page renders it, because a static prop would hide the half where `setQueryData` is what keeps the control on the pick; a refusal beside the control with the select back on the stored value; no select at all on OpenCode |
| `RuntimePanel.test.tsx` (login ladder) | each of the five status-line outcomes as its own test: the login named with its plan, the login named without one when the CLI reported none, the logged-out line **leading with the remedy**, silence while the probe is in flight, and `unknown` getting the plain *runs on Claude Code* sentence rather than silence |

`e2e/specs/claude-engine.spec.ts` drives the built app through the choice itself: the option under its own `optgroup`, the manifest rewritten in **both** directions (to Claude clears `credential`, back clears `engine`, the tier survives either way), the panel reporting the Claude Code that runs (`Claude Code unverified`, the saved path in its `title`) with no model list, and the panel's height measured before and after at both the default width and the 800px minimum, because the page's tab strip sits directly below it.

**It never runs a turn.** Spawning `claude` bills a real person's subscription on every developer's machine and in CI, so everything asserted there is knowable from the picker, the panel and the file; whether that install can actually answer is out of scope. **Its Claude Code is the spec's own, named through the product's override.** The fixture sets `CINNA_CLAUDE_DOWNLOAD=off`, and the sandbox carries the developer's real `PATH` — so without a path a Claude session would resolve to the developer's install on the one machine where that happens to be the pin and fail in words everywhere else. The spec writes a scripted executable that answers `--version` and nothing else and saves it as `localAgentsClaudePath`, which makes the Engine cell one value on every machine and means the spec no longer skips where Claude Code is absent.

`e2e/specs/claude-logged-out.spec.ts` covers the state the unit tests can only fake: an install that is genuinely **not logged in**. It gets there without logging anybody out — every spec already runs under a throwaway `HOME`, and `buildClaudeEnv` passes `HOME` through, so the same binary that answers `loggedIn: true` under the developer's own home answers `false` under the sandbox's. It needs a **real** binary to answer under the sandbox `HOME`, so it uses detection only to *find* one, names it through `localAgentsClaudePath`, and skips on a machine with none. It asserts the remedy-first line **and** that the Engine column still reads `Claude Code unverified`, which is what distinguishes *logged out* from *install failed* — the two rungs that share the danger tone — and it asserts the reassuring install sentence **absent** rather than tolerated, since a spec that accepted either would also pass where the probe had silently degraded to `unknown`. `claude auth status` is the only `claude` invocation it causes; it runs no turn and bills nothing, which is why it is allowed where a turn is not.

`agent-runtime.spec.ts` and `bare-agent.spec.ts` were updated for the renamed `Runs on` label and the required `engine` field, and nothing more.

## Related

- [The Claude Engine](claude_engine.md) — the rules and the reasons
- [The ACP Engine Contract](acp_contract.md) — the live contract with separate per-engine evidence
- [The Claude Engine Contract](claude_contract.md) — what was watched about Claude Code itself, and what is still unverified (§8 is the list of open risks). Sections describing the in-process SDK are marked retired in place
- [The Agent Turn (tech)](agent_turn_tech.md) — the driver all folder engines share, the process pool, and the shared input/result
- [The Local Engine (tech)](engine_tech.md) — runtime resolution, config generation and the "Runs with" panel's other half
- [Local Agent Permissions (tech)](permissions_tech.md) — the grant store all folder engines write to
