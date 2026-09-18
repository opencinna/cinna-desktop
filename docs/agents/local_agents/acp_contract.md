# The ACP Engine Contract — what is verified, how, and under what conditions

Every local CLI agent runs over the **Agent Client Protocol**: a child process, ndjson over its
stdio, one driver ([The Agent Turn](agent_turn.md)) and one launcher per engine ([The Local
Engine](engine.md)). This document records what was actually *watched* on that wire and against
those binaries, what is only assumed, and what was believed and proved false.

It is the **live** contract, and it supersedes the transport halves of two earlier documents: the
OpenCode engine contract (an HTTP server with an SSE bus) and the Claude engine contract (the Agent
SDK in this process). What each of those still owns — measurements about the *engine* rather than the
transport, cited from the source by section number — is listed at the end, and every section of
theirs that the move retired is marked as retired in place.

**The honesty convention:** a claim here is either *watched* (a recording, a log line, a probe's
output) or explicitly marked as assumed. If you cannot say which, it is assumed.

## 1. Conditions — what was run

These are the original OpenCode/Claude probe conditions. Their live-model measurements do not transfer to Codex; the separate Codex adapter evidence and native-CLI limits are recorded below.

| | |
|---|---|
| Protocol | ACP **v1** (`protocolVersion: 1`), `@agentclientprotocol/sdk` 1.4.0. v2 is a draft that removes client-side `fs/*` and `terminal/*`; this client declares neither and is forward-compatible |
| OpenCode | `1.18.27` — the version pinned in `src/shared/engine.ts` — launched as `opencode acp` (stdio). Same binary, same SHA-256 and same archive layout as the pinned download the desktop verifies |
| Claude | `@agentclientprotocol/claude-agent-acp` **0.76.0**, running on this build's Node (`ELECTRON_RUN_AS_NODE=1`), driving the user's own `claude` **2.1.267** through `CLAUDE_CODE_EXECUTABLE` |
| Platform | `darwin-arm64` |
| Credential | OpenCode: a real key, reaching the process only as the `CINNA_ENGINE_KEY_…` variable its config names. Claude: the user's own claude.ai login, held in the login Keychain, with **no API key anywhere in the environment** |
| Recordings | ndjson transcripts of every probe, taken in a throwaway spike repository that is **not part of this one**. What survives in-tree is `src/main/agents/drivers/acp/__fixtures__/{opencode,claude,codex}/*.json`, distilled from them and used by the translator's tests. The between-turn and activity probes have [their own conditions](#between-turn-traffic) |

The spike answered seven questions and went **go** on all of the ones that gated the phase. Two came
back partly negative and both are recorded below in full: OpenCode has no question path over ACP, and
its agent entry's own `model` is ignored.

## 2. Verified — shared behavior measured on OpenCode and Claude

### Packaged dependency resolution — Claude and Codex

The adapters run as Node children from `app.asar.unpacked`; their dependencies must
also resolve there. Claude failed before `initialize` while `@agentclientprotocol/sdk`
remained inside the adjacent archive. The installed peer tree also differed from
what electron-builder shipped: the Claude SDK's `@modelcontextprotocol/sdk` peer
needed an explicit production dependency. Both adapters' dependency trees are now
discovered before packing and the shipped required manifest tree is checked after
packing, including cross-builds. The user's Claude/Codex executables remain external.

Verified on the signed macOS arm64 package: both adapters completed ACP v1 `initialize` using
the packaged Electron executable and isolated copies outside the checkout. Codex's
app-server was the integration-test fixture; Claude did not start a turn. Separate
arm64 checks also passed for both adapters with the check runner's Node executable
in a path containing spaces. These checks use temporary homes and no inherited credentials
or Node loader overrides; they establish no live model or login behavior.

The separate packaged main-process check loaded 21 external imports and exercised
SQLite queries, libsodium initialization/hashing, native Canvas drawing, and RTF/PDF
extraction including the dynamic PDF.js worker against the signed macOS arm64 package.

The signed macOS x64 package also passed both ACP initializations and
all named main-process checks, including native Canvas drawing, under Rosetta on an
arm64 host with x64 Electron 41.2.1. ACP initialization allows 60 seconds for cold
Rosetta startup. This establishes x64 runtime behavior under Rosetta, not a separate
Intel-hardware result. The main check uses project Electron by default, or an
explicit matching target runtime, against copied packaged files with sanitized
environment and temporary userData; it does not boot the production app.
Windows/Linux runtime and OCR remain unverified.

See [Packaged Runtime Dependencies](../../development/distribution/packaged_runtime.md)
for the commands, dependency/optional rules, isolation and evidence limits. The
automatic build guard and `npm run test:packaging` are distinct from the manually
invoked `test:packaged:acp` and `test:packaged:main` runtime checks.

### Traffic arrives before a turn can bind, and it is not rare

Messages are *read* in order and *processed* concurrently: the SDK's connection dispatches each
incoming message without awaiting the previous one, so a response and the notifications written
behind it race through the client.

Watched, not reasoned about: in the Claude recording of `session/new` with an MCP server, the
`available_commands_update` for the session follows the `session/new` **response** with nothing in
between; the same happens after `session/set_config_option` on OpenCode. A turn that bound its
handlers on the response would have dropped the opening of its own turn some fraction of the time.

The client therefore keeps an unbound session's traffic in a bounded pen and drains it in order on
bind. **This is the finding a fake would never have produced**, because a fake answers a request and
then emits — in that order, always.

### `session/load` replays the whole conversation before it answers

Verified on OpenCode: loading a session emits the entire prior conversation as `session/update`
notifications and only then resolves. There is no cursor and no "since" parameter.

Two consequences the driver is built on: the replay must be **dropped** rather than ingested (it
would append the whole history to the new turn's message), and the gate that drops it must close
**before** the handlers are bound, because binding flushes the pre-bind pen synchronously.

### The session-update union is closed, and validation here means loss

`zSessionUpdate` in the SDK is a closed union of the `sessionUpdate` literals that version knows, and
`ClientApp`'s constructor installs a session-update router as a **static** handler that parses every
one of them ahead of anything we register. A kind the schema has not heard of throws there and the
update is dropped with a `console.error`.

Measured rather than assumed: the connection **survives** it — the SDK catches a throwing
notification handler — so the cost is one lost update per unknown kind rather than a dead turn.
Which is worse, being invisible. Nothing in the recordings is outside the 1.4.0 schema today, and one
`opencode` or adapter bump is all it would take.

### `fs/*` and `terminal/*` are called even though the client declares neither

Per ACP, an agent must not call a capability the client did not declare. **OpenCode 1.18.27 calls
`fs/write_text_file` regardless** — three times in the permission recording. On the `-32601` it
writes the file itself and the turn continues to `tool_call_update: completed`.

So "method not found" is the *working* answer. Answering for real would hand the agent a second,
unaudited write path; crashing would break turns that work today.

### A permission ask is a blocking request, and the shape differs by engine

`session/request_permission` blocks the agent until it is answered — there is no out-of-band reply
and no id for the agent to correlate, which is why the desktop's park **is** the unresolved response.

What the ask carries is not the same on both engines, and the difference is what
`acpPermissions.ts` exists for:

| | OpenCode | Claude adapter |
|---|---|---|
| Tool name in the ask | **Absent.** `title` is the *file path* on an edit ask | Present, twice: a non-standard `toolCall.name` and `_meta.claudeCode.toolName` |
| Where the name comes from | The `tool_call` notification that arrived moments earlier with the same `toolCallId` | The ask itself |
| Action vocabulary | `toolCall.kind` → `edit` / `execute` / `fetch` / `read`, mapped to the coarse `edit` / `bash` / `webfetch` / `read` its HTTP payload used | The tool names themselves (`Bash`, `Edit`, `WebFetch`), unchanged from the in-process runner |
| Resource field | `rawInput.command` / `filepath` / `filePath` / `path` / `url` / `pattern` / `query`, first match wins | The tool's own input shape |

Two spellings, one call: the **ask** writes `filepath` while the `tool_call_update` for the same call
writes `filePath`. Both are read, because an ask with no resources is remembered as the *whole
action* — the widest grant this app can write — from a mis-read field name.

**The vocabularies are never merged.** A grant written under OpenCode's `bash` must not authorise
Claude's `Bash`: the grants already on disk were written under the old runners' words, and a
migration of user-approved rules is not something a transport change gets to do.

### Cancellation is a notification, and an agent may not act on it

`session/cancel` is a notification; the pending `session/prompt` is supposed to come back
`cancelled`. OpenCode answers within milliseconds. But an agent that is *inside* a
`session/request_permission` cannot read it at all — it is blocked, waiting for us — which is why the
desktop answers its parked asks **before** it cancels, and why the wait is bounded (3 s) and a grace
that expires retires the process.

## 3. OpenCode over `opencode acp`

### What a config selected by `OPENCODE_CONFIG` applies, and what it does not

A config file applies **in full** over ACP — provider entry, agent entry with its inlined prompt, the
permission profile, and credentials named in `provider.<id>.env` and read from the process
environment. `session/set_config_option` with `mode` selects the agent definition.

**The agent entry's own `model` is ignored.** Selecting a mode never moved the session's model, and
an agent entry pointing at a non-existent model still ran on the session default — silently. So the
desktop states the model twice: as the config's top-level `model`, and again on the session.

**The model option can be refused for a model the session has already selected.** OpenCode populates
its model catalogue asynchronously after start, so a `model` set issued milliseconds after
`session/new` answers *"Invalid params: model not found"* — while `session/new` itself reports that
same model as `configOptions.model.currentValue`. Hence exactly one optional setup call in the whole
turn path.

### There is no question path over ACP

`opencode acp` sets `OPENCODE_CLIENT=acp` itself, and the `question` tool is registered only for
`app` / `cli` / `desktop` clients or behind `OPENCODE_ENABLE_QUESTION_TOOL`. Its ACP layer bridges no
`question.asked` to `elicitation/create`.

Watched: with the tool forced on, the probe's question **hung for 150 s and had to be cancelled**.
So the desktop sets neither variable and claims no question capability for this launcher. A model
that asks in prose is a degradation; a tool that hangs the turn is a defect.

### What an idle process costs, and what a cold start costs

| | OpenCode | Claude adapter |
|---|---|---|
| Idle, holding one session | **311 MB physical footprint** (499 MB RSS, 144 MB of it the mapped binary) | ~100 MB, ~400 MB once its `claude` child is up |
| Spawn → `initialize` | 631–695 ms | 181–284 ms |
| → `session/new` | ~300 ms further | ~300 ms further |

These two numbers are the whole argument for the process model: nothing starts at boot, and an idle
process is reaped after two minutes — unless the agent still has background work running, in which
case the reap waits, for up to 30 quiet minutes ([Session Activity](../session_activity/session_activity.md#the-process-is-not-reaped-while-its-work-runs)).

## 4. Claude Code over `@agentclientprotocol/claude-agent-acp`

The same binary, the same login and the same isolation as the in-process runner — moved into its own
process. Everything in this section that predates the move was taken through the SDK directly and is
marked where the transport changed how it is expressed.

### The move out of process fixed the stdin bug

The in-process runner had to hold its prompt iterable open past the model's first `result`, because a
string prompt closes the CLI's stdin there and a **background subagent outlives it** — its permission
asks then reached the desktop as "Stream closed" denials.

Re-run over ACP: a background subagent's permission ask arrived after the parent's reply, was
allowed, and the subagent completed. **No "Stream closed" anywhere.** The adapter owns the CLI's
stdin in its own process, for its own lifetime, so the class of bug is gone rather than worked
around.

### `elicitation.form` is what gains the engine a question path

The adapter puts `AskUserQuestion` in `disallowedTools` **unless** the client advertises
`clientCapabilities.elicitation.form`. Declared, the tool is enabled and each of its questions is
rendered as a form field of an `elicitation/create` request.

So the capability the in-process runner never had is gained by declaring a capability, and the
desktop's `capabilities().input.question` is true for this launcher and false for OpenCode. The
schema the adapter builds is read rather than guessed: `question_<n>` (a `oneOf` of `{const, title,
description?}` for single-select, an `array`/`anyOf` for multi-select, where the `const` **is** the
option's label because that is what the tool records as the answer), plus a `question_<n>_custom`
free-text companion marked with `_meta._askUserQuestionCustomAnswer` — dropped rather than rendered,
because the desktop's widget supplies its own Other answer and the companion would otherwise appear as a second question. Codex companions use a different marker, described below.

**The request names the call it came from, and that call answers twice.** `handleAskUserQuestion`
passes the SDK's `toolUseID` to `askUserQuestionsToCreateRequest`, which sends it as the
elicitation's `toolCallId`. This is the same id the adapter's `AskUserQuestion` `tool_call`
notification carries. Once answered, that call completes with the CLI's own result restating the
answer ("Your questions have been answered: …"). The desktop therefore files the question beside the
call and folds that result into the question block, instead of printing the answer a second time.
The id and the wording were read from the adapter's source and the CLI binary (2.1.270), not from a
recording.

### `permissionMode` in `_meta` is inert; `session/set_mode` is the whole mechanism

The adapter reads `_meta.claudeCode.options` as SDK options, so the setting sources, the MCP policy,
the system prompt, the model alias and (on the isolated branch) the folder's own subagents all travel
there.

**`permissionMode` does not survive, and this is watched rather than inferred.** *2026-09-17, `claude`
2.1.274, adapter 0.76.0:* `permissionMode: 'default'` was sent in the session options and the session
came back reporting `acceptEdits`, taken from the project's `.claude/settings.local.json`. The adapter
reads `defaultMode` from the user's own `~/.claude/settings.json` and from the folder's
`.claude/settings*.json` **under `settingSources: []` as well as under
`['user','project','local']`** — the same folder reported `acceptEdits` on both branches — so a
session can start in any mode, `bypassPermissions` included.

`session/set_mode` after every `session/new` *and* every `session/load`, before the first prompt, is
the only thing that makes the desktop's approval setting true. In the same probe, `set_mode default`
was answered `{}`, a `config_option_update` reported `currentValue: "default"`, and the next file
write raised a `session/request_permission` that `allow_once` answered. This is why a failed setup
call refuses the turn instead of warning, and why "simplifying" the call into the session options
would be a silent regression rather than a tidy-up.

### The adapter runs its own `claude` unless told otherwise

Left unset, `CLAUDE_CODE_EXECUTABLE` makes the adapter run a `claude` it ships itself — 2.1.257 in
the probe, against the user's 2.1.267. That is a second Claude Code the user never chose and cannot
update. The launcher always names the user's binary, and `electron-builder.yml` excludes the
adapter's nested platform packages so the shipped copy carries no second CLI; the two together are
what make the exclusion safe.
### What the Claude launcher inherits, unchanged, from the in-process runner

Four rules were established against the SDK and are unchanged by the transport. Each is stated here
because the launcher depends on it; the measurement behind each is in [The Claude Engine
Contract](claude_contract.md), section by section.

- **The child environment is constructed, not inherited, and `USER` is load-bearing.** Narrowed to
  the shared child allowlist, then stripped by name of every API key, auth token, base URL,
  third-party-provider switch and `CINNA_ENGINE_KEY_*`, then audited on the value actually handed
  over — because a turn billed to the wrong account looks exactly like a turn billed to the right
  one. Without `USER` the CLI reports *"Not logged in"* on a logged-in machine
  ([§2](claude_contract.md#2-verified--watched-not-inferred), [§7](claude_contract.md#7-the-corrected-environment-table))
- **Isolation takes three options, not one — and it now applies to *isolated* sessions only.**
  `settingSources: []` alone left the user's own MCP connectors attached — the probe found
  `claude.ai Gmail`, Drive and Calendar registered beside ours. `settingSources: []` **plus**
  `strictMcpConfig: true` **plus** `mcpServers: {}` is what leaves only what we injected
  ([§2](claude_contract.md#2-verified--watched-not-inferred)). Kit folders and Cinna's own build
  session take that triple; an adopted bare folder takes the native options below instead
- **`settingSources: []` also hides the folder's own subagents**, so on the isolated branch they are
  passed explicitly as `options.agents` — omitted rather than passed empty, so a folder without any
  hands the adapter exactly what it was handed before the option existed. A native session is not
  handed them at all; it loads them from the settings it keeps enabled

### A bare folder's session is the folder's own, and that was watched

*2026-09-17, `claude` 2.1.274, adapter 0.76.0, wire log in both directions.* A session created with
`settingSources: ['user','project','local']`, `systemPrompt: {type:'preset', preset:'claude_code',
append}`, **no** `strictMcpConfig`, **no** `mcpServers` and **no** `agents`:

| What the folder held | Reached the session? |
|---|---|
| `CLAUDE.md` | **yes** — quoted in the first answer, no tool call |
| `AGENTS.md` / `AGENT.md` | **no** — not memory to this CLI; the model ran `ls`/`cat`/`grep` to find the fact. So the desktop still pastes those two in for Claude |
| `.claude/settings.json` hooks (`SessionStart`, `PreToolUse` matcher `Bash`) | **yes**, both fired. Neither fired on the isolated control run in the same folder |
| `.claude/agents/probe-agent.md` | **yes** — listed as a `subagent_type`, with no `agents` option sent |
| `.mcp.json` stdio server | **yes**, and **with no trust step**: the interactive CLI asks before enabling a project MCP server, the SDK path does not |
| the user's own claude.ai connectors | **yes** — expected on this branch, and the reason the isolated branch exists |
| `.claude/settings.local.json` `defaultMode` | **yes**, and it beat `permissionMode` in the options (above) |

Two things the wire does **not** say, worth knowing before writing a test against it: `session/new`'s
result carries only `sessionId`, `modes` and `configOptions` — no MCP list, no subagent list, on
either branch — and the only observable difference in the frames was the `available_commands_update`
count (57 native against 49 isolated, the delta being the user's own plugin skills).

**Codex and OpenCode were not probed**: neither CLI is installed on the machine the probe ran on.
Codex reading a project `AGENTS.md` natively, and therefore taking the desktop context alone as its
`developer_instructions`, is **decided but unwatched**. OpenCode's `OPENCODE_CONFIG` merge-versus-replace
question is likewise still open, and a bare OpenCode agent keeps the whole assembled prompt until it
is answered
- **Readiness costs nothing.** `claude auth status` says whether that install is logged in without
  running a turn, and only a definite `logged_out` refuses: a probe that could not answer is
  `unknown`, which never blocks ([§5](claude_contract.md#5-not-installed-not-logged-in--and-the-third-state))

### On *Automatic*, the CLI's own reviewer answers first — and it declined nothing

The desktop's **Approvals** setting picks the session mode: `auto` puts Claude Code's own classifier
in front of the desktop's permission request, `default` brings every mutating call to the desktop.

Watched over seven probes on `auto`, including a force push and a global git config rewrite: the
classifier **never referred one to the client**. So on Automatic the desktop's permission block is a
backstop rather than a gate, and every surface says so. A model with no classifier (`haiku`) runs
`default` regardless, and the transcript carries a notice saying so. The full probe table, including
what each one actually did to the machine, is [§10](claude_contract.md#10-auto-mode--the-classifier-in-front-of-canusetool-and-what-it-approved).

**With `claude` 2.1.273 the set call itself fails on `haiku`.** Watched on 16 September 2026:
`session/set_mode {modeId: 'auto'}` answered `-32603` *"Cannot set permission mode to auto: auto mode
unavailable for this model"*. So the probes in [Between-turn traffic](#between-turn-traffic) all ran in
`default`. The driver treats a failed setup call as a refusal ([The Agent
Turn](agent_turn.md#the-setup-is-a-refusal-not-a-warning)). From the code, not from a run in the app: a
`haiku` agent on Automatic under that CLI should therefore fail its turn with *"This agent could not be
set up for the turn."* instead of falling back with a notice.

`bypassPermissions` and `dontAsk` are deliberately unreachable: both remove the desktop's request
from the decision, and with it the grants and the transcript's record.

## Codex over `@agentclientprotocol/codex-acp`

The pinned adapter is **1.11.0**, with an upstream Codex dependency range **^0.153.4**. It bridges ACP to the user's installed `codex app-server`, selected explicitly by `CODEX_PATH`; Cinna excludes the dependency's bundled CLI from its packaged app. This range is compatibility evidence from the package, not a version gate enforced by Cinna.

**Watched through the actual adapter, with a scripted app-server peer:** `src/main/agents/drivers/acp/codexAdapter.test.ts` runs an isolated copy over real stdio and observes text streaming, native approval and question round trips, cancellation, thread creation and resume. `CODEX_CONFIG` reaches both thread paths with the assembled developer instructions, optional model and reasoning effort. The test observes turn arguments for `on-request`, reviewer `user`, workspace-write and network disabled. The built-Electron `e2e/specs/codex-engine.spec.ts` also covers this production launcher path, persistent settings and resume after restart. Neither test calls a real model.

**Read from the pinned adapter source:** `read-only` means Ask for approval with a workspace-write sandbox, not read-only files. `agent` selects `auto_review` in the same sandbox. Both retain temporary-directory allowances; `agent-full-access` is never selected by Cinna. The mode is set after every new/load before prompting. Normal Codex user/project settings, skills and MCP configuration remain active; this is not the Claude launcher's settings-isolated contract.

**Permission scope differs again:** actions are namespaced `codex:<kind>`. Execute scope is the complete `rawInput`, `title`, `content` and `locations` as one exact resource. SOCKS host/protocol lives outside raw input in the adapter, so raw-input-only grants could authorize a different network destination; regression tests pin that boundary. Edit scope includes all locations. A scope-less request is unique to its request ID. The shared one-time answer rule still applies to remembered grants.

**Questions:** the declared `elicitation.form` capability bridges native `requestUserInput`. Companion fields marked `_meta.codex.isOtherAnswer` are excluded from the visible questions; the original field ID receives either a chosen label or custom text. URL elicitation is not advertised. Of the AIR capabilities, Codex is sent `asyncTasks` only, never `nativeSubagentSessions`, and its subagents are read off the root session's tool calls ([why](#session-activity-over-the-air-extension)).

The [Codex technical reference](codex_engine_tech.md) owns the exact configuration, diagnostics and test inventory. Native CLI sandbox behavior, real reviewer decisions, login/provider variants and version compatibility remain separate live validation work; the original OpenCode/Claude measurements above are not claims about Codex.

## The steering extension

**Read from the pinned adapter sources, not watched against a live CLI.**

- **Claude Code (`@agentclientprotocol/claude-agent-acp` 0.76.0)** advertises `_meta.steering.supported: true` at the top level of its `initialize` answer and implements `_session/steering`, which injects a follow-up into the running turn instead of queueing a separate `session/prompt`. It validates `_meta.steering.idleBehavior` and accepts only `promptRequired`, and it answers `promptRequired` to a steer that finds no registered turn. Its `prompt()` can publish updates before it queues the turn: a `plan` of the tasks an earlier turn left open, and, once per session, the Auto-mode fallback warning as an `agent_message_chunk`.
  - **It steers at `priority: "now"`,** pushing the message into the SDK's streaming input. It uses `later` only while a permission or elicitation is waiting on the user (`pendingUserInputCount > 0`), and the request has no field for the client to choose. The adapter's own comment says what `now` means: pre-empting is aborting. The CLI ends the running cycle, together with the tool it is executing, and the steered message runs as a second cycle. That was a real defect here. A message sent while a `Bash` command ran interrupted the command, whose result then ended `[Command was aborted before completion]` (the marker the adapter adds when the CLI reports a command `interrupted`), and the agent answered the message instead of finishing.
  - **The adapter was not patched to a gentler priority.** Its steered-turn settlement waits for the steered message's replayed echo (`Turn.steeredEchoes`), and whether a `next`-priority message taken mid-cycle is ever echoed could not be confirmed. A message that is not echoed would park the turn. The driver withholds steering while a tool call runs instead — see [The Agent Turn](agent_turn.md#a-message-sent-mid-turn-is-taken-only-while-the-prompt-is-in-flight-and-no-tool-is-running).
- **Codex (`@agentclientprotocol/codex-acp` 1.11.0)** advertises the same flag and serialises steering requests per session. It does not read `idleBehavior`: with no live turn, it **starts a new turn from the steering prompt** and answers `startedNewTurn`. That includes a steer that arrives before it has registered the turn it was just prompted with: `startNewTurnFromSteering` first waits for the prompt in flight to drain, so the answer comes only once that whole turn is over. The driver cancels the new turn and the message is queued instead; the steering window opening at the first turn content, not at the prompt, is what keeps the second case from arising — see [The Agent Turn](agent_turn.md#a-message-sent-mid-turn-is-taken-only-while-the-prompt-is-in-flight-and-no-tool-is-running).
- **OpenCode** has not been checked for the extension. The driver steers only an agent that advertises it, so an engine that does not is queued, never guessed at.

The driver's side — the window, its opening at the first turn content, its withdrawal while a tool call runs, `late`, the orphan-turn cancel and retire — runs only against the fake agent's `steer` handler and `awaitSteer` step.

## Between-turn traffic

**Watched, 16 September 2026.** Every frame was logged with millisecond timestamps. The raw recordings contain the account's email (`_auth/status_update`) and are not in this repository. The fixtures distilled from them are: `claude/{async_task_background_shell,followup_turn,subagent_background,subagent_sync,async_task_stop}.json` and `codex/{async_task_background_terminal,subagent,subagent_nocaps,async_task_stop}.json`. Each fixture's `promptReturnedAtIndex` marks the first notification that arrived after `session/prompt` answered.

| | |
|---|---|
| Claude | `claude-agent-acp` **0.76.0** on Node 22.23.2, driving `claude` **2.1.273**, model `haiku`, `settingSources: []`, `strictMcpConfig` |
| Codex | `codex-acp` **1.11.0**, with `CODEX_PATH` set to the ChatGPT app's bundled `codex-cli` **0.154.0-alpha.6.2**, on a ChatGPT login, with the default model, effort `low` and `INITIAL_AGENT_MODE=agent`. No `codex` was on `PATH`, so the app's own detection would have called Codex not installed on that machine |
| Init | `elicitation.form` plus both AIR capabilities, except in the control runs |

**The session keeps talking after `session/prompt` returns, on both engines.** This traffic has no bound turn. Before the desktop listened between turns, it was penned for ten seconds and dropped.

- **Claude runs whole turns of its own.** A background shell ended 24 s after the prompt returned. Within a second the agent started a turn nobody prompted: a cost-less `usage_update`, a `Read` tool call, the text *"Output: `probe-done`"*, then a `usage_update` carrying `cost` and `_meta["_claude/origin"] = {kind: "task-notification"}`. Nothing followed for the next 65 s
- **It happens with or without the AIR capabilities.** In the control run, which advertised neither, the same unprompted turn arrived 30–32 s in and ended the same way. Advertising the capabilities adds activity frames and nothing else
- **Codex was never seen to start a turn of its own.** After its prompt returned it sent only transcript-shaped frames for the turn already over, and bookkeeping:
  - `tool_call_update`s for that turn's exec: a `terminal_output_delta`, then `status: completed` with `rawOutput`
  - `async_task_state_update`
  - `session_info_update`: the generated title after the prompt, and `_meta.codex.threadStatus: {type: "idle"}`

  No `usage_update` came between turns
- **The background task ends after the prompt returns** (Claude +24 s, Codex +22 s). The exception is a Claude background **subagent**: `session/prompt` waited for it, *and* for the turn its completion triggered. A prompted turn can therefore carry two cost-bearing `usage_update`s: origin `human`, then `task-notification`
- **The end of a turn is the `usage_update` that carries `cost`.** Cost-less `usage_update`s (`used`/`size`, sometimes `_claude/rateLimit`) arrive two to four times inside every turn, including at the start of the unprompted one. So "a `usage_update`" is not an end marker. A costed one ends an *unprompted* turn only when no prompt is in flight
- **Codex's background terminal depends on the model.** A plainly worded "run it in the background" became `nohup … &`: an ordinary exec that ends at once, with no async task and nothing after the turn. A background terminal appeared only when the model left an `exec_command` running (`yield_time_ms` 1000)
- **No `session/request_permission` arrived in any of these runs**, on either engine. A permission ask between turns has not been watched

What the desktop does with this — the observer, which traffic opens a follow-up turn, and how that turn ends — is [The Agent Turn](agent_turn.md#a-session-is-listened-to-between-turns).

## Session activity over the AIR extension

**The client opts in at `initialize`:** `clientCapabilities._meta.jetbrains.air = {version: 1, capabilities: [...]}`, with `asyncTasks` and `nativeSubagentSessions` as the two names this client knows. *From the adapters' code:* each checks `version >= 1` and looks for each capability by name. Watched under the conditions above unless marked.

### Background tasks (`asyncTasks`)

| Update | What was watched |
|---|---|
| `async_task_spawned` | `{asyncTaskId, name, taskType: "shell", description?, showInTranscript: false, canStop: true, toolCallId?, outputFilePath?}`. **Claude** sends no `toolCallId` and no `outputFilePath`, and repeats the name as the description. **Codex** has `asyncTaskId === toolCallId` and no description or output path, and sends it *before* the prompt returns, when the exec is backgrounded |
| `async_task_progress` | Claude: `{asyncTaskId, toolCallId}`, then `{asyncTaskId, outputFilePath, toolCallId}`, within 10 ms of the spawn |
| `async_task_state_update` | `{asyncTaskId, state, outputFilePath?, toolCallId?}`. **Claude sent `stopped` and, 1 ms later, `completed` for the same task.** *From the adapter's code:* the `stopped` comes from a list-level liveness check, and a later authoritative event may override it once. So a later terminal state must be allowed to replace an earlier one |
| `tool_call_update` of the backgrounded call | `_meta.jetbrains.air.asyncTasks.backgrounded: true`. Claude's also carries `toolResponse.backgroundTaskId` equal to the task id, with or without the capability |

**Stop is `_session/async_task/stop {sessionId, asyncTaskId}`**, with both params validated as non-empty strings. Both engines answer `{stopped: true}`, and both send the task's `stopped` state update *before* the answer.

- **Claude**, in the same millisecond: two `stopped` updates, then a root `agent_message_chunk` *"**Task stopped by user:** sleep 120."* with **no `messageId`** and no `usage_update` after it. It is synthetic transcript text, not a model turn. No model turn followed in the 40 s watched
- **Codex**, after the answer: the exec's `tool_call_update` with `status: failed` and exit code −1
- *From the adapters' code, not watched:* an unknown session or task answers `{stopped: false}`

### Subagents (`nativeSubagentSessions`)

`subagent_spawned {subagentSessionId, name, task, capabilities: {}}` and `subagent_state_update {subagentSessionId, state}` arrive on the parent session.

- **Subagent states.** Claude's, *from its code*: `completed | failed | disconnected | cancelled`. Codex was watched sending `completed`
- **Codex's `task` is a placeholder** (*"Delegated task for Echo probe"*), not the prompt

**Claude: the child can be linked to its call.** The child's own frames arrive under `sessionId = subagentSessionId`. The two sides are linked in two independent ways:

- Every child frame watched (`tool_call`, `tool_call_update`, `agent_message_chunk`) carries `_meta.claudeCode.parentToolUseId`, the parent's call id
- The parent's `tool_call_update` for that call carries `_meta.claudeCode.toolResponse.agentId`, which equals `subagentSessionId`

**But with the capability on, the parent never receives the `Agent` `tool_call`.** *From the adapter's code:* its native-subagent router swallows the Agent/Task control frames. What the parent does get is a `tool_call_update` for a call id it was never told about, with `toolName: "Agent"`, no title, input or status, and a `toolResponse`:

- **Background subagent:** the update comes right after `subagent_spawned`, with `{status: "async_launched", agentId, outputFile, isAsync: true}`
- **Synchronous subagent:** it comes after the child's frames and the `subagent_state_update`, with `status: "completed"` and the report

The launch text a terminal shows for a background subagent is the CLI's own and is not on the wire. Left alone, all of this would change the saved transcript of every subagent turn. So the desktop:

- routes the child session to whoever hears the parent (`aliasSession`)
- writes the missing `Agent` call back into the stream ([Session Activity (tech)](../session_activity/session_activity_tech.md#the-synthesized-agent-call-subagentframes))

**Codex: nothing links the child to the call, so it is not sent the capability.**

- With the capability, the spawn call is never sent to the parent. *From the adapter's code,* it is a "represented spawn"
- The child's frames carry only terminal metadata, with no parent link
- The parent's `wait` collaboration call listed no receivers

**Codex without any capability** (control recording, `codex/subagent_nocaps.json`):

- no `subagent_spawned`, and no child-session frames
- instead, the root session gets tool calls titled *"Start subagent <name>"* and *"Complete subagent <name>"*, each with `_meta.codex.subagent {threadId, path, activity}`
- a `wait` call whose `receiverThreadIds` and `agentsStates` were empty

That is what the desktop reads. The `_meta.codex.collaboration` shape — a `spawnAgent` call naming its receivers, and `rawInput.agentsStates` with per-thread status — is **derived from `codex-acp` 1.11.0's code** (`createCollabAgentToolCallUpdate`), not watched. Its fixture, `codex/subagent_collab.json`, says so.

**Does the prompt wait for a subagent?** On Claude, yes, for background and synchronous subagents alike. On Codex it did in the one run, because the model called `wait`. Codex has no background-spawn flag, so a non-waiting spawn was not tested.

### What each launcher advertises

| Launcher | Capabilities | Why |
|---|---|---|
| Claude | `asyncTasks`, `nativeSubagentSessions` | Both can be routed back to the chat |
| Codex | `asyncTasks` | Native subagent sessions would lose the spawn call with nothing to link the child |
| Command-line (custom) | `asyncTasks` | Only the Claude adapter's shape of native subagent sessions is routed back |
| OpenCode | none | `clientCapabilities: {}`, unchanged |

## 5. Corrections, and what a fake could not have caught

Worth stating plainly, because it generalises past this feature.

Most of what is in §2–§4 is a case where **the fake was correct and the fake was not the binary.** A
capability an agent must not call is documented as such, and OpenCode calls it. A schema union is
closed, and the SDK drops what falls outside it rather than saying so. A response and the
notifications behind it are written in order and arrive in a race. A fake built from the
specification implements none of that, every test passes, and the turn loses the opening of its own
answer some fraction of the time.

The related trap, one level down, is a test that only exercises the *easy* input. The
cumulative-versus-delta convention is the sharpest instance, and it survived the rewrite because the
translator still has to obey it: handing the accumulator the raw delta instead of the running total
once **passed 19 of 19 tests**, because for a plain sequential stream
both conventions produce byte-identical output. Two ordinary inputs separate them — a chunk identical
to its predecessor (an LLM emitting `**`, `the `, a double space), where the wrong convention makes
the accumulator skip it as a no-op and the answer is silently one chunk short; and an end-of-block update carrying the cumulative text after more than one delta, where the whole text is appended twice.

**The rule for anyone adding to `agents/drivers/acp/`:** if a behaviour is only in the schema, it is
unverified. Mark it, and prefer a design that degrades visibly when the assumption is wrong.

Three corrections from this phase, all found by the real binaries after the fake agent was green:

- **The `model` config option can be refused for a model already selected.** The fake answers every
  option call; only OpenCode's asynchronous catalogue produces the race
- **`launcherOfFolder` must never answer null.** "The runtime was read and names nothing" is an
  answer — the default engine — and only the scanner's *unresolved* check may say "keep the row's
  value". Conflating the two left a user who cleared the engine in the Runtime card running on the
  engine they had cleared
- **The pool's `shutdown` had no caller at all.** Every test passed; quitting mid-turn left a
  detached `opencode acp`, or the Claude adapter and the ~260 MB `claude` under it, running in its
  own process group with nothing left that knew it existed

## 6. Still unverified

- **Gemini CLI (`gemini --acp`).** No launcher exists and no question capability is claimed.
- **Codex native execution.** The implemented pinned adapter is tested against a scripted native app server. A real paid-model turn, live account login, automatic-review decisions, native sandbox enforcement and a CLI-version/platform matrix are not established by those tests
- **Whether OpenCode will bridge a question to `elicitation/create`** in a later version. Today it
  does not, and the desktop's capability answer says so
- **Remote ACP transports** (Streamable HTTP, WebSocket) are an active RFD upstream, not shipped.
  `opencode acp --port` exists but is OpenCode-specific
- **MCP servers passed in `session/new.mcpServers`.** The folder launchers send an empty list today, so
  nothing here has exercised Cinna per-session MCP injection. Codex may still load MCP servers from its own configuration
- **Codex on a bare folder's native runtime.** That Codex reads a project `AGENTS.md` itself — and therefore that the desktop should hand it only its own context as `developer_instructions` — is decided from the CLI's documented behaviour, not watched. No Codex install was available for the 2026-09-17 probe
- **OpenCode's `OPENCODE_CONFIG`: merge or replace.** Unanswered, and the reason a bare OpenCode agent still runs on the whole assembled prompt. No OpenCode install was available either
- **The Claude adapter's own `session/load`** is covered by a fixture rather than by a live run
- **How each engine behaves on a session id it has forgotten** has been watched on OpenCode only
- **An ask between turns.** No probe produced a `session/request_permission` or an elicitation after the prompt returned, on either engine. A follow-up turn's asks run only against the fake agent
- **A Codex turn started on its own.** Never seen. The ten-second quiet rule that ends a follow-up on an engine with no end marker has not met a real one
- **The Codex collaboration shape** (`spawnAgent` receivers, `agentsStates`) is read from the adapter's code. The installed CLI sent `subAgentActivity` tool calls instead
- **Subagent states other than `completed`**, and a Claude background task of a type other than `shell`, are read from code
- **Background work that runs past 30 minutes** without a state change: the reaper's ceiling is not exercised against a real process
- **Steering against a real CLI.** Both adapters' support, and the Claude adapter's `now` priority, are read from source. The aborted command was a real turn in the app, not a recorded probe. No wire log of a live steer exists. Still unwatched: where a real engine places an injected message relative to the output the desktop recorded before it; how either engine behaves when a steer races the end of a turn; and whether a steer that arrives after the model has begun a tool call, but before the adapter reports that call, still aborts it

## 7. Runbook — how to re-verify

**Shared, free:** spawn the engine's ACP command with a throwaway `HOME`, send `initialize` with
`protocolVersion: 1` and `clientCapabilities: {}`, then `session/new` with a `cwd` you own. Log every
frame in both directions as ndjson — that log is the only evidence that outlives the probe.

**OpenCode.** Point `OPENCODE_CONFIG` **and** `OPENCODE_CONFIG_DIR` at a directory holding a config
with one provider (`env: ["NAME"]`, never `options.apiKey`) and one agent entry, spawn
`opencode acp` with `cwd` = an unrelated folder, and assert: `session/new` reports your top-level
`model` as `configOptions.model.currentValue`; `set_config_option {mode}` selects your agent; a
prompt that writes a file raises `session/request_permission` with `toolCall.kind: 'edit'` and a
`rawInput.filepath`; and answering `allow_once` leaves the engine's own saved-grant store empty. To
see the defect in §3's permission section, answer `allow_always` once and then prompt a **new session
in the same process** — it will not ask again.

**Claude.** The environment bisect first, because it is free and it is the finding that matters most:
`env -i PATH=$PATH HOME=$HOME claude auth status` → `loggedIn: false`; add `USER=$USER` → `true`. Then
spawn the adapter with `CLAUDE_CODE_EXECUTABLE` set to your own `claude`, declare
`clientCapabilities: {elicitation: {form: {}}}`, and prompt something that asks a question: an
`elicitation/create` with `question_0` proves the capability. For the mode override, put
a `defaultMode` other than `default` in a throwaway project's `.claude/settings.local.json` (the
project scope is enough — no need to touch the real `~/.claude/`), pass
`_meta.claudeCode.options.permissionMode = 'default'`, and read the mode the session reports — it
will be the file's. Then send `session/set_mode` and read it again.

**For the native branch**, run two sessions over one throwaway project holding a `CLAUDE.md`, a
`.mcp.json`, a `.claude/agents/*.md` and a hooks block, with the user's **real** `HOME` (the login
lives there) and a `cwd` under `os.tmpdir()`: one with `settingSources: ['user','project','local']`
and the `claude_code` preset, one with the isolated triple. The prompts that separate them are "what
is the project codename" (the `CLAUDE.md` fact), "list your MCP servers and your subagent types", and
one that writes a file after `set_mode`. Read the hooks' own log file between the two runs rather
than asking the model whether its hooks ran. Note that read-only shell commands (`ls`, `cat`, `echo`)
are auto-approved in **every** mode, so a probe that wants to see a `session/request_permission` must
use a command that writes.

**Between-turn traffic and activity.** Declare `clientCapabilities: {elicitation: {form: {}}, _meta:
{jetbrains: {air: {version: 1, capabilities: ['asyncTasks', 'nativeSubagentSessions']}}}}` (only
`asyncTasks` for Codex), keep reading after `session/prompt` answers, and log every frame with a
millisecond timestamp. Prompt a shell that sleeps ~25 s in the background. Assert that `async_task_spawned`
arrives, that the prompt returns before `async_task_state_update`, and — on Claude — that an unprompted
turn follows and ends with a `usage_update` carrying `cost` and `_claude/origin`. For Codex, ask for an
`exec_command` left running, since "in the background" alone may become `nohup`. Then send
`_session/async_task/stop` for a fresh task and assert that the `stopped` update comes before
`{stopped: true}`. Repeat once with no AIR capabilities: the unprompted turn must still arrive, with no
`async_task_*` frames.

Two billed turns per Claude probe. Budget ~0.1–0.25 USD reported per probe, and read §4 on why that
number is not a cost.

## Where the rest of the evidence lives

This document is the contract the driver is built on. The per-engine findings that predate ACP — with
their original measurements, tables and section numbers, which the source cites by number — stay
where they were taken:

- [The OpenCode Engine Contract](opencode_contract.md): the two config readers and the variable each
  honours (§9.5.3), that the v2 reader substitutes nothing (§9.5.4), why a custom entry's models need
  declared limits (§9.5.9), the three transports the engine can build (§9.5.10), Gemini over Google's
  OpenAI-shaped endpoint (§9.5.11), and **the permission scoping defect (§4)** that is the whole
  reason the desktop holds its own grants
- [The Claude Engine Contract](claude_contract.md): the environment bisect and the corrected table
  (§2, §7), what the isolation options actually isolate (§2), the login states (§5), the ~190 MB
  `claude` that arrives with the SDK (§5a), what `total_cost_usd` is not (§6), and the auto-mode
  probes (§10)

Everything in those two documents that the ACP move retired is **marked as retired in place**, with
what replaced it. Nothing unmarked there is stale.

## Configured commands and startup cancellation

The [custom launcher](../custom_agents/custom_agents.md) uses this same ACP connection for a user-selected local or SSH command. A standalone Test exchanges initialize and disposes the child without authentication, session creation or a prompt. Local spawn argv and cwd stay separate from the remote session cwd; stdout remains protocol-only. Turn Stop and the ceiling also cancel silent initialize/new/load/setup, retire startup processes and prevent a later prompt. User Stop now returns an explicit canceled result, including the existing folder driver; the former shared ACP abort-result exception is removed. A remote command that ignores prompt cancellation is disposed after the grace with a visible unconfirmed-remote-stop notice.
