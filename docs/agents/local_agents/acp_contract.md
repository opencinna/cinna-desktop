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
| Recordings | ndjson transcripts of every probe, taken in a throwaway spike repository that is **not part of this one**. What survives in-tree is `src/main/agents/drivers/acp/__fixtures__/{opencode,claude}/*.json`, distilled from them and used by the translator's tests |

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
process is reaped after two minutes.

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

### `permissionMode` in `_meta` is overridden by the user's own settings

The adapter reads `_meta.claudeCode.options` as SDK options, so `settingSources: []`,
`strictMcpConfig`, the assembled system prompt, the model alias and the folder's own subagents all
travel there.

**`permissionMode` does not survive.** The adapter reads `defaultMode` from the user's own
`~/.claude/settings.json` and from the folder's `.claude/settings*.json` **even under
`settingSources: []`**, so a session can start in any mode — `bypassPermissions` included.
`session/set_mode` after every `session/new` *and* every `session/load`, before the first prompt, is
the only thing that makes the desktop's approval setting true. This is why a failed setup call
refuses the turn instead of warning.

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
- **Isolation takes three options, not one.** `settingSources: []` alone left the user's own MCP
  connectors attached — the probe found `claude.ai Gmail`, Drive and Calendar registered beside ours.
  `settingSources: []` **plus** `strictMcpConfig: true` **plus** `mcpServers: {}` is what leaves only
  what we injected ([§2](claude_contract.md#2-verified--watched-not-inferred))
- **`settingSources: []` also hides the folder's own subagents**, so they are passed explicitly as
  `options.agents` — omitted rather than passed empty, so a folder without any hands the adapter
  exactly what it was handed before the option existed
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

`bypassPermissions` and `dontAsk` are deliberately unreachable: both remove the desktop's request
from the decision, and with it the grants and the transcript's record.

## Codex over `@agentclientprotocol/codex-acp`

The pinned adapter is **1.11.0**, with an upstream Codex dependency range **^0.153.4**. It bridges ACP to the user's installed `codex app-server`, selected explicitly by `CODEX_PATH`; Cinna excludes the dependency's bundled CLI from its packaged app. This range is compatibility evidence from the package, not a version gate enforced by Cinna.

**Watched through the actual adapter, with a scripted app-server peer:** `src/main/agents/drivers/acp/codexAdapter.test.ts` runs an isolated copy over real stdio and observes text streaming, native approval and question round trips, cancellation, thread creation and resume. `CODEX_CONFIG` reaches both thread paths with the assembled developer instructions, optional model and reasoning effort. The test observes turn arguments for `on-request`, reviewer `user`, workspace-write and network disabled. The built-Electron `e2e/specs/codex-engine.spec.ts` also covers this production launcher path, persistent settings and resume after restart. Neither test calls a real model.

**Read from the pinned adapter source:** `read-only` means Ask for approval with a workspace-write sandbox, not read-only files. `agent` selects `auto_review` in the same sandbox. Both retain temporary-directory allowances; `agent-full-access` is never selected by Cinna. The mode is set after every new/load before prompting. Normal Codex user/project settings, skills and MCP configuration remain active; this is not the Claude launcher's settings-isolated contract.

**Permission scope differs again:** actions are namespaced `codex:<kind>`. Execute scope is the complete `rawInput`, `title`, `content` and `locations` as one exact resource. SOCKS host/protocol lives outside raw input in the adapter, so raw-input-only grants could authorize a different network destination; regression tests pin that boundary. Edit scope includes all locations. A scope-less request is unique to its request ID. The shared one-time answer rule still applies to remembered grants.

**Questions:** the declared `elicitation.form` capability bridges native `requestUserInput`. Companion fields marked `_meta.codex.isOtherAnswer` are excluded from the visible questions; the original field ID receives either a chosen label or custom text. URL elicitation and native child-session UI are not advertised. Shared tool-call translation is the fallback for child-agent activity; native child-session presentation is not tested.

The [Codex technical reference](codex_engine_tech.md) owns the exact configuration, diagnostics and test inventory. Native CLI sandbox behavior, real reviewer decisions, login/provider variants and version compatibility remain separate live validation work; the original OpenCode/Claude measurements above are not claims about Codex.

## The steering extension

**Read from the pinned adapter sources, not watched against a live CLI.**

- **Claude Code (`@agentclientprotocol/claude-agent-acp` 0.76.0)** advertises `_meta.steering.supported: true` at the top level of its `initialize` answer and implements `_session/steering`, which injects a follow-up into the running turn instead of queueing a separate `session/prompt`. It validates `_meta.steering.idleBehavior` and accepts only `promptRequired`, and it answers `promptRequired` to a steer that finds no registered turn. Its `prompt()` can publish updates before it queues the turn: a `plan` of the tasks an earlier turn left open, and, once per session, the Auto-mode fallback warning as an `agent_message_chunk`.
  - **It steers at `priority: "now"`,** pushing the message into the SDK's streaming input. It uses `later` only while a permission or elicitation is waiting on the user (`pendingUserInputCount > 0`), and the request has no field for the client to choose. The adapter's own comment says what `now` means: pre-empting is aborting. The CLI ends the running cycle, together with the tool it is executing, and the steered message runs as a second cycle. That was a real defect here. A message sent while a `Bash` command ran interrupted the command, whose result then ended `[Command was aborted before completion]` (the marker the adapter adds when the CLI reports a command `interrupted`), and the agent answered the message instead of finishing.
  - **The adapter was not patched to a gentler priority.** Its steered-turn settlement waits for the steered message's replayed echo (`Turn.steeredEchoes`), and whether a `next`-priority message taken mid-cycle is ever echoed could not be confirmed. A message that is not echoed would park the turn. The driver withholds steering while a tool call runs instead — see [The Agent Turn](agent_turn.md#a-message-sent-mid-turn-is-taken-only-while-the-prompt-is-in-flight-and-no-tool-is-running).
- **Codex (`@agentclientprotocol/codex-acp` 1.11.0)** advertises the same flag and serialises steering requests per session. It does not read `idleBehavior`: with no live turn, it **starts a new turn from the steering prompt** and answers `startedNewTurn`. That includes a steer that arrives before it has registered the turn it was just prompted with: `startNewTurnFromSteering` first waits for the prompt in flight to drain, so the answer comes only once that whole turn is over. The driver cancels the new turn and the message is queued instead; the steering window opening at the first turn content, not at the prompt, is what keeps the second case from arising — see [The Agent Turn](agent_turn.md#a-message-sent-mid-turn-is-taken-only-while-the-prompt-is-in-flight-and-no-tool-is-running).
- **OpenCode** has not been checked for the extension. The driver steers only an agent that advertises it, so an engine that does not is queued, never guessed at.

The driver's side — the window, its opening at the first turn content, its withdrawal while a tool call runs, `late`, the orphan-turn cancel and retire — runs only against the fake agent's `steer` handler and `awaitSteer` step.

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
- **The Claude adapter's own `session/load`** is covered by a fixture rather than by a live run
- **How each engine behaves on a session id it has forgotten** has been watched on OpenCode only
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
`{"defaultMode": "bypassPermissions"}` in `~/.claude/settings.json`, pass
`_meta.claudeCode.options.permissionMode = 'default'`, and read the mode the session reports — it
will be the file's. Then send `session/set_mode` and read it again.

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
