# The Claude Engine Contract — what is verified, how, and under what conditions

**Status:** verified against the real binary on **9 September 2026**, `claude` **2.1.266**
(Claude Code), `@anthropic-ai/claude-agent-sdk` **0.3.266**, `darwin-arm64`, on a **native-installer**
install authenticated with a claude.ai login.

This document exists for the reason [the OpenCode contract](opencode_contract.md) exists: **the
engine contract is the one part of Local Agents our tests cannot check.** The Claude path has a
sharper version of the problem — the whole feature rests on a subprocess resolving credentials this
app never sees, and a fake at the SDK boundary is faithful only to what we believed when we wrote
it. Six of the rules the feature was planned around turned out to be wrong, and two of
them would have shipped as defects: an environment that cannot authenticate, and an isolation
boundary that leaves the user's Gmail attached.

**Governing rule, inherited unchanged: an assumption about the engine is unverified until someone
has watched the binary do it.** Rows marked *unverified* are untested, not weakly tested.

---

## 1. Conditions — what was run

Reproduce with these exact conditions or the results do not transfer.

| | |
|---|---|
| CLI version | `2.1.266` (`claude --version`), reported as `claude_code_version` on the init message |
| SDK version | `@anthropic-ai/claude-agent-sdk@0.3.266` |
| Platform | `darwin-arm64` |
| Binary | `/Users/evgenyl/.local/bin/claude` — **native installer**. Not Homebrew, not the npm shim |
| Credential | a claude.ai login, held in the **login Keychain** (`Claude Code-credentials`). A `~/.claude/.credentials.json` also exists and is a **stale decoy** — see the correction below |
| Auth as reported | `apiKeySource: 'none'` on every successful init |
| Model as served | `claude-opus-5[1m]`, chosen by the CLI with no `model` option passed |
| Probe | `scratchpad/probe/*.mjs` — throwaway, not in the repo. §8 is the runbook to rebuild it |

> **Correction, 9 September 2026 — which store this machine actually uses.** The row above
> originally read *"`~/.claude/.credentials.json` exists on disk; the Keychain path was not
> exercised"*, and inferred the second half from the first. The file's own `expiresAt` is
> **2026-08-09** and its mtime **2026-08-08**; the Keychain item's `mdat` is **2026-09-09**, the day
> of these probes. The file's token had been expired for a month while every probe here succeeded,
> so **the credential in play was the Keychain one and always had been.** Everything in this
> document was therefore observed against a *Keychain-backed* credential, not a file-backed one —
> which changes what §8's first item is still asking. Corrected there.

Every turn below was a real turn against the user's own plan. The cost line the SDK reports
(`total_cost_usd`) ranged 0.06–0.16 USD per single-tool probe turn — see §6 on why that number is
not a cost.

---

## 2. Verified — watched, not inferred

### The child environment

| Behaviour | Evidence |
|---|---|
| `Options.env` **replaces**, never merges | `sdk.mjs` builds the child env from `this.options.env` with a `{...process.env}` default; nothing merges the two |
| `PATH` + `HOME` alone is **not enough to authenticate** | with exactly `{PATH, HOME}` the CLI exits 1 with `Not logged in · Please run /login`, on a machine whose interactive `claude` is logged in |
| **`USER` is required** | adding `USER` alone to `{PATH, HOME}` restores authentication (exit 0). `LOGNAME`, `SHELL` and `TMPDIR` each individually do **not** |
| The SDK sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` itself | `if(!c.CLAUDE_CODE_ENTRYPOINT)c.CLAUDE_CODE_ENTRYPOINT="sdk-ts"` — we neither need nor should set it |
| The SDK deletes `NODE_OPTIONS` from the child | `delete c.NODE_OPTIONS`, unconditionally |
| **`shellEnvForChild` already passes `USER`** | `DEFAULT_INHERITED_ENV_VARS` from the MCP SDK is `["HOME","LOGNAME","PATH","SHELL","TERM","USER"]`, and `CHILD_ENV_ALLOWLIST` starts from it |

That last row is the good news attached to the bad. The corrected environment is
not a special case bolted on: **build it from `shellEnvForChild` and `USER` and
`HOME` arrive for free**, because the app's own allowlist already carries them.
The construction rule is therefore *narrow with the existing helper, then strip
the auth-redirecting names, then add `CLAUDE_AGENT_SDK_CLIENT_APP`* — not a
hand-assembled dictionary that has to remember `USER` on its own. A
hand-assembled one is exactly what the plan specified, and exactly what omitted
it.

**`USER` is the single most important finding in this document.** The plan's environment table
omitted it, and the failure it produces is not a crash: the CLI reports *"Not logged in"*, which the
plan's own readiness ladder renders as **"log in with `claude` in a terminal"** — sending every user
to re-authenticate a CLI that was already authenticated, with no way to discover that the desktop
was the cause. The env table in §7 is the corrected one.

### What the isolation options actually isolate

Run with `settingSources: []`, a project `CLAUDE.md`, a project `.claude/settings.json` and a
project `.claude/skills/probeskill/`:

| Source | `settingSources: []` | `['user','project','local']` |
|---|---|---|
| Project `CLAUDE.md` | **suppressed** — the model did not know the rule it states | loaded — the model quoted the rule verbatim |
| Project skill (`probeskill`) | **suppressed** | listed in `skills` |
| Project plugin (`clangd-lsp`) | **suppressed** | listed in `plugins` |
| Tool count | 26 | 27 |
| **The CLI's built-in skills** | **18, still loaded** | 19 |
| **Slash commands** | **52, still loaded** | 53 |
| **The user's MCP servers** | **3, still loaded** | 3 |

Two of those rows disprove the plan. `settingSources: []` governs *filesystem settings files,
`CLAUDE.md`, and project-level skills and plugins*. It does **not** govern MCP servers, and it does
not govern the CLI's own built-in skills.

**The MCP row is a boundary defect, not a cosmetic one.** The three servers that survived isolation
were `claude.ai Google Drive`, `claude.ai Google Calendar` and `claude.ai Gmail` — the user's own
connectors. A folder agent run under the plan as written would have been handed tools that reach
the user's mail, and nothing in the Cinna UI would have said so.

| Suppression that works | Effect |
|---|---|
| `strictMcpConfig: true` **with** `mcpServers: {}` | `mcp_servers: []`. This is the fix |
| `skills: []` | **no effect** — still 18. The `skills` option is a context filter over what the Skill tool will accept; `init.skills` reports what was *discovered* |

The built-in skills are part of the unmodified CLI the user installed, and reaching them requires
the `Skill` tool, which the desktop's profile controls. They are left alone deliberately. The MCP
servers are user configuration and are shut off.

### `apiKeySource`

- The plan's reading is **correct**: `'none'` is what a claude.ai login reports. Observed on every
  successful init.
- The 0.3.266 type is **wider than the wire**: `'user' | 'project' | 'org' | 'temporary' | 'oauth'`
  are in the union, and `sdk.d.ts` documents them as *"legacy members that current CLIs never
  emit"*. A translator must handle them as unknown rather than treat `'oauth'` as the subscription
  case — the subscription case is `'none'`.

### The message sequence for one tool-calling turn

With `includePartialMessages: true`, `allowedTools: ['Read']`, one Read, `maxTurns: 4`:

```
system/init
system/status                     ← not in the plan
rate_limit_event                  ← not in the plan
stream_event  message_start
stream_event  content_block_start
stream_event  content_block_delta:text_delta   ×3
assistant     [text]              ← after that block's deltas, before its stop
stream_event  content_block_stop
stream_event  content_block_start
stream_event  content_block_delta:input_json_delta  ×26
assistant     [tool_use(Read)]
stream_event  content_block_stop
stream_event  message_delta
stream_event  message_stop
user          [tool_result]
system/status
stream_event  message_start … text_delta ×4
assistant     [text]
stream_event  content_block_stop / message_delta / message_stop
rate_limit_event
result/success
```

Three things the translator has to be built around:

- **`assistant` is emitted per content block, not per message.** Each carries only the block that
  just completed. Summing text across `assistant` messages is correct; summing it *and* the
  `text_delta` stream double-counts.
- **Deltas are true deltas** (`text_delta` carries the increment). The plan predicted this and the
  plan is right — which matters, because `StreamPartsAccumulator` expects cumulative text and the
  OpenCode path already carries the adapter for that mismatch.
- **The union is far wider than the six kinds the plan names.** `SDKMessage` in 0.3.266 has 37
  members, and two undocumented-by-the-plan kinds (`system/status`, `rate_limit_event`) appeared in
  the very first probe turn. The translator must ignore unknown kinds silently and by default.

`result/success` ended the turn, with `stop_reason: 'end_turn'`, `num_turns: 2`, and `usage` /
`total_cost_usd` populated.

### Subagents — how a `Task`/`Agent` call comes down the same iterator

Probed with a prompt that forces a subagent, `forwardSubagentText` **unset** (the
default, and what the runner uses):

```
STREAM message_start  msg=TPh9nF  parent=null
STREAM block_start    idx=0 type=text        parent=null
ASSISTANT msg=TPh9nF  blocks=text            parent=null
STREAM block_start    idx=1 type=tool_use    parent=null
ASSISTANT msg=TPh9nF  blocks=tool_use(Agent) parent=null
USER      msg=—       blocks=text            parent=toolu_01LSE6…   ← the subagent's prompt
ASSISTANT msg=Tkr2dA  blocks=tool_use(Read)  parent=toolu_01LSE6…
USER      msg=—       blocks=tool_result     parent=toolu_01LSE6…
USER      msg=—       blocks=tool_result     parent=null            ← the Agent call's own result
STREAM message_start  msg=2ZSda7  parent=null
RESULT success turns=2
```

| Question | Answer |
|---|---|
| Do subagent frames arrive as `stream_event`? | **No — zero, in the whole turn.** They come only as `assistant` / `user` messages |
| Do they carry `parent_tool_use_id`? | Yes, on all three |
| Does a subagent's `assistant` carry its own `message.id`? | Yes (`Tkr2dA`), distinct from the main thread's |
| Does its `user` tool_result carry a message id? | **No** — only `tool_use_id`, exactly as on the main thread |
| What is the tool called? | **`Agent`**, not `Task`. `Task` is the name in `sdk.d.ts` and the docs |

The first row is the load-bearing one. A translator tracking a single "current
message id" off `message_start` is **correct today** — nothing interleaves — but
only because `forwardSubagentText` is off. That is a property of an option, not
of the protocol, and the failure if it changed would be silent: a subagent's
`message_start` would capture the slot and the main agent's next delta would be
filed into the subagent's message. The runner therefore keys by
`parent_tool_use_id ?? 'main'` rather than relying on the option staying unset.

The last row matters for the permission ask: a tool name the desktop's table
misses renders as itself, and *"The agent is asking to Agent"* is not a sentence.

### Permissions — `canUseTool`

The signature and resolution shapes are exactly as the plan quotes them. Observed:

| Behaviour | Evidence |
|---|---|
| Called with `(toolName, input, {signal, suggestions})` | `Write` → `keys: ['file_path','content']`, `hasSignal: true` |
| `suggestions` shape | `[{type:'setMode', mode:'acceptEdits', destination:'session'}]` — a *mode* suggestion, not a permission rule |
| `{behavior:'allow', updatedInput}` | tool ran |
| `{behavior:'deny', message}` | **the message is what the model receives as the `tool_result`**, verbatim. The model reported the refusal and did not route around it |
| A denial is not a turn failure | `result/success`, `is_error: false`, and the denial recorded in `result.permission_denials[]` with `tool_name`, `tool_use_id`, `tool_input` |

Two findings that change Phase 4:

- **A bare tool name in `allowedTools` bypasses `canUseTool` entirely.** With
  `allowedTools: ['Read']` the callback was never invoked. The SDK emits a runtime warning saying
  so: `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` — *"Bare allowedTools entries auto-approve the whole tool
  before the callback is consulted… Allow rules from settings files can also shadow the callback but
  are not visible here."* The plan specifies `allowedTools` derived from the profile **and**
  `canUseTool` wired to the grant registry; as written those two mechanisms cancel each other.
- **Read-only tools never reach `canUseTool` at all.** With no `allowedTools` and
  `permissionMode: 'default'`, a `Read` ran with no ask. Only tools that would prompt in the CLI
  reach the callback. The desktop's grant registry therefore governs the mutating surface, not the
  whole tool surface; gating everything would need a `PreToolUse` hook.

The settings-file half of the warning is already closed by `settingSources: []`.

### Sessions

| Behaviour | Evidence |
|---|---|
| A session id is reported on every message (`session_id`) | observed |
| `resume` carries conversation state | turn 1 stored `4711`; turn 2 with `resume` answered `4711` |
| **The id is stable across a resume** | turn 2's `session_id` equalled turn 1's. `saveSession` rewrites the same value, it does not rotate |
| A forgotten id fails | `resume` of a synthetic UUID → `No conversation found with session ID: …` |

### Cancellation

`Options.abortController` aborted mid-turn **throws** out of the async iterator:
`Error("Claude Code process aborted by user")`. It does not complete the iterator and does not
yield a `result`.

**`error.name` is `'Error'`, not `'AbortError'`.** Cancellation must be detected from
`input.signal.aborted`, never from the error.

---

## 3. Disproven — believed by the plan, and false

| The plan says | What happens |
|---|---|
| The child env needs `PATH`, `HOME` and `CLAUDE_AGENT_SDK_CLIENT_APP` | it also needs **`USER`**, or the CLI reports *Not logged in* on a logged-in machine (§2) |
| `settingSources: []` is the desktop's boundary | it does not suppress **MCP servers**. The user's Gmail/Drive/Calendar connectors load. `strictMcpConfig: true` + `mcpServers: {}` is required (§2) |
| `allowedTools` **and** `canUseTool` together express the profile | a bare name in `allowedTools` **shadows** `canUseTool` for that tool; the SDK warns about it by name (§2) |
| `'none'` means claude.ai OAuth, and `ApiKeySource` is a four-member union | `'none'` is right, the union is nine members; five are legacy and never emitted (§2) |
| The `SDKMessage` kinds a translator meets are the six named | 37 in the union; `system/status` and `rate_limit_event` arrive in the first turn (§2) |
| A failed turn arrives as a message to translate | **error results are thrown**, not yielded (§4) |
| *"`total_cost_usd` … on a subscription is a shadow price"* | correct, and understated — see §6 |

## 4. Errors arrive as exceptions, not as messages

This is the single structural fact the runner is built around, and the plan does not mention it.

Both failures observed — *Not logged in* and *No conversation found* — came out of the async
iterator as a **thrown** `Error`, never as a `result` message:

```
Error: Claude Code returned an error result: Not logged in · Please run /login
  errorClass: 'error_result'
```

The SDK constructs this in `readMessages`: when the stream carries an error result it replaces the
process-exit error with `Claude Code returned an error result: ${text}`. So:

- `runTurn` must wrap the whole iteration, not just its body. The `never throws` contract is
  otherwise violated on the two most likely first-run failures.
- **The only discriminator between failure kinds is the message text.** `errorClass` is
  `'error_result'` for both. "Not logged in" and "the session is gone" are told apart by substring
  or not at all — which is why readiness (§5) is answered *before* a turn rather than parsed out of
  one.
- The stale-session rule the plan wants — retry once without `resume`, silently — is a `catch`
  around the first iteration, not a branch on a result.

## 5. Not installed, not logged in — and the third state

- **Not installed** is answerable without spawning: `toolDetectionService` already reports it.
- **Not logged in** is *not* answerable without spawning, but it is answerable without a turn.
  `claude auth status` (2.1.266; *"Show authentication status"*, `--json` by default, `--text`
  optional) logs nothing in or out, runs no turn, and reports `loggedIn` with an `authMethod`.
  **The JSON field is the signal — and the exit code is not, but not for the reason first
  recorded.** This section originally said *"exit code 0 in all three"*. Re-measured 9 September
  2026, three runs per row, against the same `claude` 2.1.266:

  | Environment | exit | `loggedIn` | `authMethod` | `subscriptionType` |
  |---|---|---|---|---|
  | the full shell | **0** | `true` | `claude.ai` | the plan |
  | `env -i PATH HOME USER` | **0** | `true` | `claude.ai` | the plan |
  | `env -i PATH HOME` | **1** | **`false`** | `none` | *absent* |
  | `env -i PATH HOME USER`, `HOME` an empty directory | **1** | **`false`** | `none` | *absent* |

  A logged-out install exits **1**, with valid JSON on stdout and an **empty stderr**. The last row
  is there because it reaches the logged-out state a second, independent way, and rules out the
  exit code being about the withheld `USER` rather than about the login.

  **So a caller must parse stdout regardless of the exit code.** Treating non-zero as "the probe
  failed" collapses the one state this command exists to detect into *unknown*, and readiness
  silently goes back to being answered by a billed turn. `claudeAuth.ts` is built on that rule and
  a mutation check holds it.

  The response also carries `apiProvider` and `subscriptionType`, which the original table did not
  record; `subscriptionType` is present only when logged in.

  That last row reproduces §2's `USER` finding for free, and the probe is the cheap bisect §9 step 1
  used to need a billed turn for. The output also carries the account's email and organisation id;
  a caller that logs it logs those. **Wired in, 9 September 2026.** `claudeAuth.ts` runs it
  under the same constructed child environment the turn will use — the same rule §2's `USER` row
  exists for — and `claudeAgentTurnRunner` refuses a turn on a definite `logged_out`. `unknown`
  never blocks: the thrown-error fallback in §4 stays as the second line. Verified on the native
  installer against a **Keychain-backed** credential; the Homebrew wrapper and the npm shim are
  still untested (§8). The billed probe still
  works as described — `claude --print --output-format json 'say OK'` exits **1** with
  `is_error: true` and `result: "Not logged in · Please run /login"`, and **0** otherwise — it is
  just no longer the cheapest.
- **`SDKAuthStatusMessage` was never emitted** in any probe, including the not-logged-in run. The
  plan's readiness design leans on it. It exists in the type union; nothing observed produces it.
  Treat it as a signal that may arrive, never as the mechanism.

## 5a. The SDK ships a 190 MB `claude` of its own

Measured, not inferred. `@anthropic-ai/claude-agent-sdk@0.3.266` is 4.8 MB, but
it declares eight **optional** dependencies — one per platform — and the one
that installs on this machine, `@anthropic-ai/claude-agent-sdk-darwin-arm64`,
is a single **199,422,144-byte `claude` executable**. A plain `npm install` of
the SDK therefore adds ~190 MB to `node_modules`.

The plan already forbids using it (*"the bundled copy would … put a second
Claude Code inside the installer, and would run a version the user never
chose"*). What was not known is that **not using it is not the same as not
shipping it**: the file arrives on disk from the dependency alone, and
electron-builder packages `node_modules` unless told otherwise. So the rule
needs a second half with teeth:

- `pathToClaudeCodeExecutable` points at `toolDetectionService`'s find — the
  behavioural half, which the plan has.
- **The optional platform packages must be excluded from the packaged app**, or
  every installer grows by ~190 MB and ships a Claude Code the user did not
  install and cannot update.

### The SDK also drags the Anthropic API SDK forward

`@anthropic-ai/claude-agent-sdk@0.3.266` declares a **peer dependency on
`@anthropic-ai/sdk >= 0.93.0`**, and this app pinned `^0.89.0`. `npm install`
refuses the combination outright (`ERESOLVE`), so adding the Agent SDK is not an
additive change: it forces a bump of the SDK behind the **Anthropic chat
adapter**, which has nothing to do with this feature.

The blast radius is one file — `src/main/llm/anthropic.ts` is the only consumer
— and the bump taken was the smallest that satisfies the peer (`^0.93.0`, not
the current `0.124.0`). **Verified — by a different method from the rest of this
document.** `src/main/llm/anthropic.test.ts` runs the 0.93 client itself, not a
mock of it, against a stubbed `fetch` answering with Messages-API SSE frames and
error envelopes, so a renamed streaming event, a tool input no longer parsed from
partial JSON, a moved error status or a dropped abort fails there where `tsc`
passes. What it does not do is watch the live API: the wire is what the API is
documented to send. Writing it found two defects, both older than the bump: a
credential, endpoint and headers the client took from the process environment
over the stored key — the same class of fault §7 of this document exists for —
and one in the adapter's error mapping; 0.89.0's `core/error.js` and
`core/streaming.js` were fetched with `npm pack` and are identical on the second,
and the first is an SDK default that predates 0.89. What is covered, and both
defects, are in [LLM Adapters — Technical
Details](../../llm/adapters/adapters_tech.md#sdk-versions-and-one-that-moved-for-a-reason-outside-this-domain).

**Verified twice over.** First, removing the bundled package breaks nothing:
with `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64` deleted
outright, the SDK still imported and ran a full turn against the user's own
binary (`cli 2.1.266`, `apiKeySource: none`) — `pathToClaudeCodeExecutable` is
always supplied, so the bundled-binary resolution path is never reached.

Second, the exclusion works. A `--dir` build on `darwin-arm64` with
`'!node_modules/@anthropic-ai/claude-agent-sdk-*/**'` in the `files` list
produced an app containing **no platform package and no file over 50 MB other
than the asar and the Electron framework**, while the SDK itself (`sdk.mjs`,
`bridge.mjs`, `manifest.json`) is packed inside the asar as it must be. *Still
unverified on the other targets* — only `darwin-arm64` was built.

## 6. `total_cost_usd` on a subscription — worse than the plan says

Observed: 0.135713, 0.163215, 0.057161 USD for single-turn probes on a claude.ai login where the
marginal cost to the user was **zero**. The plan proposes putting it in a notice worded as what it
is. Three probe turns at ~0.12 USD average would render as roughly a third of a dollar spent on a
plan that charged nothing, and no wording available in a notice line makes that number informative.
**Recommendation: drop it from the Claude path entirely when `apiKeySource === 'none'`.** Token
counts from `usage` are real and can stay.

## 7. The corrected environment table

Supersedes the table the feature was planned around; the rule as it now stands is in
[The Claude Engine](claude_engine.md#the-child-environment-is-constructed-never-inherited).

| Included | Why |
|---|---|
| `PATH` (login-shell resolved) | the agent's own tools must resolve |
| `HOME` | the CLI's credentials live under it |
| **`USER`** | **without it the CLI cannot authenticate** (§2). The plan omitted this |
| `CLAUDE_AGENT_SDK_CLIENT_APP` | `cinna-desktop/<version>`; identifies this app in the User-Agent |
| the rest of `shellEnvForChild` | unchanged from the engine's rule |

| Excluded | Status |
|---|---|
| `ANTHROPIC_API_KEY` | **unverified that it shadows an OAuth login** — see below. Stripped regardless |
| `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | stripped, unverified |
| `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / `_ANTHROPIC_AWS` | stripped, unverified |
| every `CINNA_ENGINE_KEY_*` | stripped |
| `CLAUDE_CODE_ENTRYPOINT`, `NODE_OPTIONS` | the SDK sets and deletes these itself; do not fight it |

Set alongside the env, not in it: `strictMcpConfig: true`, `mcpServers: {}` (§2).

## 8. Still unverified — and one of these can still kill the feature

1. **The Keychain — largely closed, 9 September 2026, and it was the wrong question.** This item
   used to say the path had never been exercised. It had: §1's correction shows the probe machine's
   file credential expired on 2026-08-09 while every probe since succeeded, so the Keychain item was
   the live one throughout.

   The remaining half — whether a **signed, hardened-runtime** parent can spawn a child that reads
   it — was then measured directly. A copy of `node` was signed with a Developer ID Application
   certificate, `--options runtime`, and **this app's own `build/entitlements.mac.plist`**, which
   grants `allow-jit`, `allow-unsigned-executable-memory`, `allow-dyld-environment-variables` and
   `apple-events` and **nothing Keychain-related** (`codesign -d` confirms `flags=0x10000(runtime)`
   and exactly those four keys). From it, `claude auth status` was spawned under the constructed
   child environment, twice:

   | Parent | `~/.claude/.credentials.json` | exit | `loggedIn` | consent prompt |
   |---|---|---|---|---|
   | signed, hardened runtime, no Keychain entitlement | present (stale) | 0 | `true` | none |
   | signed, hardened runtime, no Keychain entitlement | **moved aside** — the Keychain is the only store left | 0 | `true` | none |

   The file was restored and verified byte-identical by SHA-256. **A hardened-runtime, Developer
   ID-signed parent with no Keychain entitlement does not gate its child's Keychain read, and no
   consent prompt appeared.**

   What that does **not** cover, and none of it should be read as covered:
   - the parent is a signed `node`, **not the packaged `.app`** — no bundle identity, no
     `entitlementsInherit` chain across Electron's helper processes;
   - not **notarized**, not quarantined, not launched from `/Applications` past Gatekeeper, where
     first-launch TCC state can differ;
   - the accessing binary is the **native installer's** `claude`. A Homebrew wrapper and an npm shim
     are different binaries and therefore different ACL evaluations against the same item;
   - "no prompt appeared" is on a machine where `claude` has been run interactively many times. A
     prompt on genuinely first use by a new accessing binary is not ruled out.
2. **`ANTHROPIC_API_KEY` shadowing an OAuth login.** Not proven. The probe designed for it could not
   run: with a bogus key the turn fails for reasons indistinguishable from the key being ignored,
   and a *valid* API key was not available. The stripping rule stands on the SDK documenting the two
   as distinct `ApiKeySource` values, which is strong but is not observation.
3. **Install shapes.** Only the native installer was tested. The SDK branches on the path's
   extension — a path ending `.js`/`.mjs`/`.ts` is run **through node**, anything else is spawned
   **directly** — so an npm shim and a native binary take different code paths, and the Homebrew
   wrapper is a third shape. Untested.
4. **`claude auth status` on the other install shapes.** Verified against a Keychain-backed
   credential on the native installer (§5, and item 1 above). Whether it answers `loggedIn` on a
   **Homebrew or npm** install, and whether it does so without a consent prompt there, is untested —
   the same gap as item 1's last bullet, reached from the other side.
4a. **The exclusion on targets other than `darwin-arm64`** (§5a). Verified on
   that one; `linux-*`, `win32-*` and `darwin-x64` are not built here.
5. **`SDKAuthStatusMessage`** — what emits it (§5).
6. **Windows.** Unconsidered, as the plan says.

## 9. Runbook — how to re-verify

```bash
mkdir -p /tmp/claude-probe && cd /tmp/claude-probe && npm init -y
npm i @anthropic-ai/claude-agent-sdk@0.3.266

# 1. The environment bisect — the finding that matters most. Free, no turn:
#      env -i PATH=$PATH HOME=$HOME            claude auth status  → loggedIn: false
#      env -i PATH=$PATH HOME=$HOME USER=$USER claude auth status  → loggedIn: true
#    Exit code is 0 either way; read the JSON. Do not paste the output into a
#    doc — it carries the account's email and organisation id.
#    The billed form, if you want to see the turn itself fail:
#    spawn `claude --print --output-format json 'say OK'` with, in turn:
#      {PATH,HOME}                     → expect exit 1, "Not logged in"
#      {PATH,HOME,USER}                → expect exit 0
#    Any future CLI that changes this invalidates §7.

# 2. Isolation. query() with settingSources: [] against a cwd holding a CLAUDE.md,
#    a .claude/settings.json and a .claude/skills/*/SKILL.md; read the init message.
#    Assert: CLAUDE.md not honoured, project skill absent, mcp_servers EMPTY
#    (the last only with strictMcpConfig: true + mcpServers: {}).

# 3. Sequence. includePartialMessages: true, one Read, log every message's
#    {type, subtype}. Assert `assistant` arrives per content block.

# 4. Permissions. A Write with no allowedTools → canUseTool fires.
#    The same with allowedTools:['Write'] → it does not, and node prints
#    CLAUDE_SDK_CAN_USE_TOOL_SHADOWED.

# 5. Errors. resume a synthetic UUID → expect a THROW, not a result.
#    abort() mid-turn → expect a THROW whose .name is 'Error'.
```

Pin whatever version you observe. The values in §1 are `2.1.266` / `0.3.266`; nothing here should be
assumed to survive a CLI minor bump, and §2's `USER` row least of all.
