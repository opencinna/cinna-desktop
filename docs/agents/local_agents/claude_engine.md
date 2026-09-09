# The Claude Engine — a folder agent on the user's own Claude Code

> **What the SDK and the binary actually do is recorded in [The Claude Engine Contract](claude_contract.md).** That document is what was watched against `claude` 2.1.266 and `@anthropic-ai/claude-agent-sdk` 0.3.266 — what is verified, what is only assumed, and what was believed and proved false. This document does not restate it. Five of its findings shape rules below and none of them is visible in the SDK's types: `USER` must be in the child environment or the CLI reports *"Not logged in"* on a logged-in machine; `settingSources: []` does **not** detach the user's MCP connectors, so `strictMcpConfig` and an empty `mcpServers` travel with it; a bare tool name in `allowedTools` shadows `canUseTool` entirely, so none is passed; SDK failures arrive as **thrown exceptions**, not as messages; and read-only tools never reach the permission callback at all. Where this document and the contract disagree, the contract is right — it was watched, and this was written.

## Purpose

Let a folder agent run on the **Claude Agent SDK**, driving the `claude` binary already installed on this machine under that install's own login, instead of on the desktop-managed `opencode serve`.

What it buys the user: the Claude Code harness — its tools, subagents and context management — for agents whose work OpenCode's loop does poorly, and inference paid for by their own Claude plan rather than by an API key this app holds.

## A note on paths

Same convention as [The Local Engine](engine.md) and [The Agent Turn Runner](agent_turn.md), with one row added:

| Written as | Means |
|---|---|
| `src/...`, `docs/...` | A file in **this repository** |
| `Local/<slug>/...`, `cinna-agent.json`, `app-data/desktop.json` | Inside an **agent folder** |
| `~/.claude/...` | The user's **own** Claude Code installation |

The third row is a rule, not a formatting habit: **the desktop reads nothing and writes nothing under `~/.claude/`.** Everything it wants from the user's Claude Code it gets by spawning the binary and reading what that process reports.

## The governing principle

**The desktop is an orchestrator. It never becomes an authentication provider.**

Cinna spawns the `claude` the user installed, unmodified, in an environment where that binary resolves the credentials it already has. It implements no login, stores no token, brokers no session and resells no capacity. That is the whole basis on which the feature is permitted, and it is one environment variable away from being false **in either direction**:

- put an auth variable in, and the turn silently bills the user's **API account** while the panel says it ran on their Claude plan — no error, no failed turn, a bill at the end of the month; or
- leave the wrong one out, and the CLI reports *"Not logged in"* on a machine whose `claude` is perfectly logged in, sending the user to re-authenticate a tool that was already fine with nothing pointing at this app as the cause.

Both were live hazards and the second is the one that actually bit. The child environment is therefore **constructed** — see [The child environment is constructed, never inherited](#the-child-environment-is-constructed-never-inherited).

## Core Concepts

- **Engine** — what actually runs an agent's turn. Two of them: `opencode` (the desktop-managed server, still the default and what every agent that names no engine gets) and `claude` (the Agent SDK, in-process, spawning the user's own binary). Previously implicit; now a field on the runtime
- **Engine axis** — the second dimension runner dispatch gains. It is `source` **then** `engine`: a folder agent on Claude and a folder agent on OpenCode are the same `source`
- **Native auth** — the credential the spawned `claude` resolves for itself. The desktop never sees it, never names it and never stores it
- **`apiKeySource`** — what the CLI *reports* it authenticated with, on its init message. `'none'` is the subscription case. This is a fact read off the running process, not a belief derived from the config we generated
- **Engine credential** — for `engine: 'claude'` there is not one. The runtime carries an engine and a tier, and no credential row and no API key at all
- **Model alias** — `haiku` / `sonnet` / `opus`, which is how a plan is addressed. Not a catalogue id, because on this path there is no credential and therefore no catalogue to hold one
- **Translator** — the fold from the SDK's message stream into the A2A-shaped message every consumer downstream of the runner already reads. The only substantial new code in the feature

## User Stories / Flows

### Putting an agent on Claude
1. On the agent page, the **Runs with** panel's first control is now **Runs on** rather than *Credential*: it offers this machine's Claude Code above a separator, and the AI credentials below it
2. The Claude option is offered **only where a `claude` was actually detected** — an absent install means an absent option, never an option that fails after the click. An agent whose manifest already names the engine keeps its option regardless, or the select would render blank over a file that plainly says what it runs on
3. Choosing it writes `runtime.engine: "claude"` and **clears the credential**, because that path spends none. A concrete model is dropped too, and the status line says which model went and why: an id from a provider's catalogue means nothing to a plan addressed by alias
4. The **work complexity** survives the move in both directions. `medium` means the same thing on either engine, so a change of runtime must not silently discard the user's answer to "how hard is this work"
5. The **Advanced** raw-model picker is not shown on this engine — there is no catalogue to list. It is removed from inside a fixed-height row rather than disabled, so the panel keeps its footprint and the page's tab strip does not move out from under the pointer that just used the select
6. The third column stops reporting the OpenCode engine and reports the detected install instead — `Claude Code 2.1.266`, or `Not installed` — **with no Start button**, because this app starts nothing there

### Chatting with an agent on Claude
1. The user sends a message in a chat bound to the agent. Everything up to the runner is the shared path: same composer, same persistence, same transcript, same cancel button
2. Dispatch reads the agent's own engine and sends the turn to the Claude runner
3. Readiness is answered **before** the turn, on both rungs and for free: no `claude` on this machine, and a `claude` that is not logged in, are each a sentence naming the remedy rather than a turn that fails with the CLI's own words
4. The per-agent turn lock is taken, so "this agent is busy in another chat" behaves exactly as it does on the other engine
5. The SDK is asked for a turn in the agent's folder, with the folder's assembled system prompt, and the answer streams into the transcript token by token — text, thinking, tool calls and their results, as the same part kinds every other agent produces
6. The session id the CLI reports is remembered for this (chat, agent), so tomorrow's message continues the same conversation

### Being asked for permission
1. Mid-turn the agent wants to write a file, run a command, fetch a URL or start a subagent, and the SDK asks this app whether it may
2. If a standing grant for this agent already covers it, it is allowed **silently** — nothing is written to the transcript, exactly as on the other engine. A block that appeared and answered itself milliseconds later is a widget the user cannot act on
3. Otherwise a permission block appears inside the streaming answer, naming the action as a phrase — "Permission needed to run a command: …" — and the turn blocks on the answer
4. The decision is recorded beside the ask: *Allowed once*, *Allowed, and remembered for this agent*, *Denied*, or *No answer — the request expired*
5. **Read-only tools never ask.** With no `allowedTools` and the default permission mode, a `Read` runs with no ask at all. The grants govern the mutating surface, not the whole tool surface, and this is a limit of the mechanism rather than a policy

### Claude Code is there but not logged in
1. Detection finds the binary, so the option is offered. Whether that install is *logged in* is asked separately, and **for free**: `claude auth status` runs no turn and bills nothing
2. The panel's status line says so before anything is spent — *"Run `claude` in a terminal: that Claude Code install is not logged in."* The remedy leads, because that line is measured to clip at the 800 px minimum window and the half that survives has to be the half naming the action
3. A turn asked for anyway is **refused before the SDK is called**: *"This agent runs on Claude, and that Claude Code install is not logged in. Run `claude` in a terminal."* Nothing is spawned and nothing is billed
   - The second half is **word for word the panel's**, because a user meets this condition on two surfaces and two paraphrases of one instruction read as two instructions. The panel's wording is what the skip reason moved to match, not the other way round — that line is measured to the pixel and cannot afford *installation*. The opening clause stays only because a turn error in a transcript has nothing around it naming the engine, while the panel says so two rows up
4. The remedy is named and nothing offers to perform it. Logging in is something only the user can do, in their own terminal, against their own account
5. The user goes and does it — which is the reason the panel keeps asking while the answer is *logged out*. Coming back to a red alarm about a machine that is now fine is the failure that rule exists to prevent

## Business Rules

### The engine is a field on the runtime, never a synthetic credential

A runtime is now `{engine, credential, model}`. The tempting alternative — a fake credential row labelled "Claude Agent", so the picker and every consumer stay uniform — is rejected, and the reason is that `isCredentialUsable`, `findCredentialByReference`, the enabled/disabled ladder and every skip reason are written about a row that has a key, an `enabled` flag and a catalogue behind it. A synthetic row satisfies none of those and would lie to each of them differently. It lies worst at *"the user switched this credential off"*, which has no meaning at all for an engine that bills nobody's key.

*Which* engine and *where the choice came from* also stay separate questions: the engine is a new field, and the existing runtime **source** (`manifest` / `default` / `none`) is untouched.

### The Claude path resolves nothing about credentials, because it has none

Runtime resolution returns early for this engine instead of threading a null credential through a ladder written about credential rows. Run it through them and a perfectly healthy agent is explained with *"your default chat mode uses a credential that is switched off"* — a sentence about a key it was never going to spend, and one the user would act on by changing something that cannot help.

The early return sits **above** the Default-runtime lookup, and that order is load-bearing rather than tidy: that lookup reads the user's default chat mode and this machine's credential override, and a throw in either store used to turn a Claude agent into an OpenCode one at the dispatch point, silently — after which the agent answered *"this agent is not available in the running engine yet"* for ever.

### A tier resolves to an alias, not through the model classifier

Work complexity becomes `haiku` / `sonnet` / `opus` by a small table, deliberately **not** through the family classifier the other engine uses. That module classifies a live catalogue against a credential's own model list, and here there is no credential and no catalogue: a plan serves what the plan serves, addressed by alias. Resolving a tier through a classifier with nothing to classify would produce nothing for every agent.

The **Medium floor** still applies in spirit — an agent that names no tier runs on `sonnet`. A model the manifest names explicitly still wins over a tier, matching the other path's precedence, so the two cannot disagree about which of the pair the user meant.

### An agent on another engine has no entry in the OpenCode config

Config generation skips it. Without that it still gets an entry, the generator skips it as *credential unavailable* — because a Claude runtime resolves to no credential — and the Runs-with panel explains a healthy agent with a sentence about a key it does not spend.

It is not merely cosmetic either: the generated config names a model as `<credential>/<model>`, and a Claude runtime's model is an alias no OpenCode provider lists.

### The child environment is constructed, never inherited

The SDK's own documentation is explicit that the environment option **replaces** the child's environment entirely rather than merging it. Neither of its defaults is correct here, and inheriting is the dangerous one, because it fails by reporting success: `ANTHROPIC_API_KEY` lives in exactly the shell profile [this app deliberately sources](../../development/shell_environment/shell_environment.md), so the obvious implementation authenticates against the user's API account with nothing anywhere looking wrong.

So the environment is built by **narrowing with the helper the app already has, then stripping, then adding one variable**:

| Included | Why |
|---|---|
| the login-shell `PATH` | the agent's own tools — `git`, `make`, `uv` — must resolve, exactly as they must for the other engine |
| `HOME` | the CLI's credentials live under it. The one deliberate widening of the narrowing rule, and it is safe because the alternative is not "narrower", it is "authenticates as nobody" |
| `USER` | without it the CLI reports *"Not logged in"* on a logged-in machine. It comes for free from starting at the shared allowlist; the hand-assembled dictionary that preceded it is what left it out |
| a client-app identifier | `cinna-desktop/<version>`, so the CLI's User-Agent says who asked. An orchestrator should say who it is |

| Excluded, by name | Why |
|---|---|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | each re-authenticates or redirects the turn away from the user's own plan |
| `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / `_ANTHROPIC_AWS` | each routes the turn to a provider the user did not choose in this panel |
| every `CINNA_ENGINE_KEY_*` | the local engine's credential map. There is no credential on this path, and its presence would be a second way to pay |

Most of the excluded names would not survive the narrowing anyway. They are stripped **by name regardless**, because the list is the statement of intent: a future widening of the shared allowlist must not quietly restore the billing trap.

The built environment is then **audited before it is handed over**, and a leak is logged loudly by name — never by value, since logging the value of a key to explain that it leaked recreates the leak in the log. It is checked on the value actually being passed rather than trusted to the function that produced it, because the environment is the one input here whose corruption is invisible in the result: a turn billed to the wrong account looks exactly like a turn billed to the right one.

### Readiness is answered before the turn, and the login is free to ask

Two facts decide whether this engine can run an agent, and **both are knowable without spending anything**:

- **Is there a `claude` on this machine** — `toolDetectionService`, which spawns nothing at all
- **Is that install logged in** — `claude auth status`, which spawns the binary but runs no turn and bills nothing

The second used to cost a turn. The runner learned *Not logged in* from a **thrown turn error** and told it apart from other failures by matching the CLI's own words. That works, and it is the wrong shape: the user asks a question, waits a turn's worth of latency, and gets back an error about authentication.

The two are asked **in that order**, and both **before the per-agent turn lock** — there is nothing to ask about a login when there is no binary, `claude_not_installed` outranks the login everywhere it is read, and "there is no Claude Code here" must not queue behind another chat's turn.

**Only a definite `logged_out` refuses a turn.** `unknown` is a first-class answer and never blocks: a probe that timed out, could not spawn, or met an output shape it did not recognise is not evidence of a logged-out install, and the thrown-error fallback is still there as the second line. A readiness check that can refuse a working engine on its own uncertainty is worse than no readiness check.

**The probe runs in the same constructed child environment the turn will.** This is not tidiness — it is the `USER` finding applied to the check itself. The binary answers differently depending on its child environment, so a probe run under the full login-shell environment would cheerfully report a login for a child that then cannot authenticate, and readiness would be answering about a different process than the one the turn spawns.

**Settings → Local Agents → Developer Tools → Refresh re-asks the login too, and nothing on that screen says so.** That table has two columns, Tool and Version, so the one control in the app that deliberately re-checks the login sits on a screen that never displays it. It is recorded here as a decision rather than left to be found as a bug: the button means *"go and look at this machine again"*, and after it a stale login answer beside fresh detection would be the inconsistency — most of all on the machine the button exists for, where Claude Code has just been installed and is about to be logged into. A **login column is deliberately not added** to that table. It would be a second surface for a fact the agent page already carries, and it is not needed as a recovery path: the panel's own poll clears a stale alarm within about ten seconds, without the user going to Settings at all.

The answer is **cached for a short window, not for the app's lifetime** the way detection is. Whether a binary exists barely changes while the app is open; whether it is logged in changes precisely *because* the app has just told the user to go and log in. A permanently cached "no" would leave them staring at the alarm they had already fixed. One probe is shared by the turn path and the panel, so a render and a turn starting together spawn one child rather than two.

### The account behind that login is never read

`claude auth status` answers with the account's **email**, **organisation id** and organisation name alongside the login state. The two organisation fields are not lifted out of the CLI's JSON — not into the returned shape, not into a log line, not across IPC to the renderer.

**That is the defence, and it is deliberately not a rule about logging.** A field that is never read cannot leak from a debug line somebody adds six months from now; a rule saying "do not log the account" is one careless edit from being untrue. What survives is who *pays* rather than who they are: the authentication method as the CLI words it, and the plan tier when it names one. Same reasoning as the engine config's Invariant 4, applied to somebody else's login.

### The desktop's boundary must not be redefined by files it did not write

`settingSources: []` keeps the user's own settings files, `CLAUDE.md`, project skills and plugins from redefining what a Cinna agent may do — a stray `CLAUDE.md` two directories up rewriting an agent's behaviour is invisible in every surface the user reads.

**That option is not the whole boundary**, and believing it was would have shipped as a defect. It does not detach the user's own MCP connectors: a probe run with it still had the user's Gmail, Drive and Calendar attached, so a folder agent would have been handed tools reaching the user's mail with no Cinna surface saying so. `strictMcpConfig` with an empty server map is the actual fix and travels with it.

This has a cost worth stating rather than discovering: the user's own skills, `CLAUDE.md`, commands and plugins **do not load**. "Use my whole local setup" and "the desktop decides what this agent is" are in genuine tension, and this resolves it toward the second, because a folder agent's system prompt is assembled from the folder's own files. If a per-agent opt-in is wanted later it is a manifest flag, not a default.

The system prompt is that assembled prompt as a plain string, never the SDK's coding-assistant preset — the preset would talk over the folder, which already says what this agent is.

### No tool is pre-approved, because pre-approving one bypasses the asking

A bare tool name in `allowedTools` auto-approves that tool *before* the permission callback is consulted — the SDK says so itself at runtime — so the two mechanisms cancel rather than compose. **No `allowedTools` is passed at all.** This is the half that has to be true before the desktop's grants mean anything.

### *Always allow* stays the desktop's, on both engines

The SDK offers a way to persist an allow into Claude Code's **own** rules. It is never used. Such a rule would be user-global, shared with the user's personal Claude Code, and would authorise agents this app has nothing to do with — the same reason the other engine's `always` is never forwarded to it. A remembered decision is a row in that agent's desktop state, and what the CLI is told is a plain allow; the transcript records which of the two actually happened.

### Claude's tool vocabulary stays Claude's

A grant is stored under the action **the engine that raised it actually named** — `Bash`, not `bash` — so a rule written on one engine never silently authorises the other. What the two share is only the sentence the user reads: one describer knows both vocabularies, because "The agent is asking to Bash" is not English, and because the block on screen must not be able to disagree with the block the transcript replays.

The grant key gains no engine segment. A grant is already scoped to a folder, and an agent does not change engines between one ask and the next often enough to justify a migration.

### The manifest gains a key, additively — read tolerantly, written strictly

`runtime.engine` is contract **1.2.0**, exactly as `runtime.complexity` was 1.1.0. See [Kit Contract & Manifest Layer](kit_contract.md).

- **An unrecognised engine value reads as no engine**, and the agent falls to the host default. It does not fail validation and does not brick the folder, because a folder written by a newer tool must keep running. The schema deliberately does not close the value set with an enum: engines are expected to grow
- **`engine: "claude"` with a `credential` is refused on write** and, on read, is a warning with the credential ignored. They are not meaningful together: a manifest naming one would make the panel report a key that pays for nothing
- The validator **warns rather than errors** on both cases, because an error there marks the folder invalid and drops it from the engine entirely — which is the exact brick the additive promise exists to prevent

The tolerant read is applied again at the last place it could be forgotten: dispatch. An engine value this build does not know sends the turn to the default runner.

### An unreadable folder falls back to the default engine

Dispatch reads the agent's manifest on the turn path, so it is guarded rather than trusted — the row may be gone, its folder may have moved, and a manifest is briefly unparseable every time an assistant saves it. **Falling back to the default engine is the safe direction**: the OpenCode runner already renders every one of those states as a readable turn error, whereas dispatching to the Claude runner on a folder that could not be read would replace all of them with *"no Claude Code was found"*.

### The turn never throws, and that is harder here

A failed turn is a result carrying an error, never an exception, for the same reason as everywhere else: an exception crossing IPC loses its code. It is harder on this path because **the SDK reports failure by throwing out of its async iterator** rather than by yielding a result — observed for both "Not logged in" and a stale resume, the two most likely first-run failures. So the whole iteration is wrapped, and the only discriminator between failure kinds is the message text.

**Cancellation is also a throw**, and its name is not `AbortError`. A stop is told apart from a real failure by the turn's own signal and by nothing else. A cancelled turn is not an error anywhere: it keeps whatever streamed and reports no failure, and the abort check comes before the failure branch so that a stop landing mid-turn is never reported to the user as an error for something they did on purpose.

A stop that lands **before** the turn starts is checked for explicitly, because a listener added to an already-aborted signal never fires and everything before it can await — detection walks the `PATH` and the shell environment may source a profile. A cancellation in that window used to be dropped entirely: the child ran the whole turn, the user's plan paid for a turn they had cancelled, and the result was still reported, correctly, as not an error.

### A remembered session is verified by use, not by a probe

There is no endpoint to ask whether a session still exists. A resume against a session the CLI has forgotten throws, and the right response is to start a fresh one and carry on without explaining — the user asked a question, not to be told about our bookkeeping.

Three guards keep that retry from becoming a second billed turn:

- only for **the observed wording** of a forgotten session. Matching any error that merely mentions a session id let a rate-limit or state error re-run a whole turn for a failure that had nothing to do with continuity
- **never once the turn has already streamed something.** The retry reuses this turn's accumulator, so a second pass arrives under fresh message ids and is *appended* rather than replacing — the user reads the answer twice, for two billed turns. A turn that streamed had no forgotten session to blame anyway
- never after a cancel, and never when there was no remembered session to blame in the first place

### A turn that did not run on the install's own login says so, where the user is

`apiKeySource` is the **observed** fact — what the CLI reports it authenticated with, off its own init message — and the subscription case is `'none'`. Anything else means something reached the child that the environment construction intended to strip, and the person is being billed on an account they did not pick in the Runs-with panel.

**That failure otherwise looks exactly like success**, which is why a log line is not a surface: nobody reads the log until they already suspect something, and here there is nothing to suspect. So a completed turn that reports anything but `'none'` also carries a **notice** — *"This turn did not run on your Claude Code login — the CLI reported …. It may be billed to that account instead."*

A notice and not a panel line, because notices are the existing channel for agent-side system messages and land in the transcript **beside the turn they describe**. A panel would say it once, about whichever turn ran last, on a screen the user may not be looking at.

**On every exit, not only the successful one.** The observation is made at the init message, so the exit path a turn happens to take cannot decide whether the user is told: a turn that reported the wrong account and then failed, or was cancelled, or ran to the twenty-minute ceiling has been billed to that account regardless — and the ceiling is the most expensive way to get it wrong.

**Silent when the value is `'none'` or absent.** This app never *asserts* a subscription — asserting one because a variable was stripped would be a claim about an environment it does not fully control — it only reports when the CLI says otherwise. A turn that failed before the CLI said anything has no observation to report, and inventing one is the exact assertion this rule exists against. The turn itself still succeeds: this is a warning about billing, not a failure, and blanking a good answer would help nobody.

### What the panel says, and what it still will not claim

The panel now reports the login, because the login became free to ask. The reserved status line names it in one of three shapes: *runs on your own Claude Code login*, with the plan in brackets when the CLI reported one; the weaker *runs on your own Claude Code install* when the probe answered `unknown`; and the logged-out remedy, which **leads with the action** — *"Run `claude` in a terminal: …"* — because at the 800 px minimum window this line is measured to clip, and the surviving half has to be the half the user can act on.

What is still never asserted is a **subscription the CLI did not name**. The plan is passed through, capitalised and no further; a lookup table here would blank out a plan this app had not heard of on the one line meant to say who pays, and inferring one because an environment variable was stripped would be a claim about an environment this app does not fully control.

Two states are silence rather than reassurance, and they are different states:

- **Detection has not answered.** The full red not-installed alarm appeared for half a second on machines that *do* have Claude Code — the default first visit for every agent on this engine — naming a remedy the user would satisfy by installing what they already had
- **The login probe has not answered.** Filling the slot with the reassuring install sentence meant a logged-out machine read healthy in muted grey and was contradicted in red about a tenth of a second later (measured at t=891 ms and t=996 ms). Nothing moves either way — the line is reserved — so what a retraction costs is that the *next* reassuring sentence here is worth less. An answer of `unknown` is not this case: it is an answer, and the install sentence is the true thing to say about it

The **Engine column still names the install and never the login** — it is fixed at 219 px and does not widen with the window, so it holds the shortest true thing and the line that can grow carries the meaning. Its **dot** does move, once: `--color-warning` for a definite `logged_out`, which is the type scale's *"Awaiting auth"* case, and warning rather than danger because the install is fine and one command fixes it. The reserved line below was turning red while the one glanceable indicator in the row stayed neutral about a state the app had just gone and found out.

Everything else about that dot is unchanged, and one rule in particular: it is **never the success colour**. One option away in that exact slot a green dot means *the process is running*, so a green here would be one indicator, in one position, meaning two things — and the weaker claim read as the stronger. `unknown`, in-flight and `logged_in` all stay muted; only "no install at all" is danger.

The panel says nothing about which account paid for a turn either, and **that is a choice of channel rather than silence** — the observation goes into the transcript instead. See below.

## What this deliberately does not do

- **It shares no transport with the OpenCode runner.** No event bus, no SSE parsing, no durable cursor, no hole-and-heal recovery, no engine manager — the SDK is an async generator in this process. There is no socket to drop, no stream to fan out to a second agent, and no shared server whose restart could end somebody else's turn. Inventing a common transport abstraction across the two would manufacture a shape only one of them has; the shared shape is the runner seam, one level up
- **It does not gate an engine restart.** The per-agent lock is still taken, so busy-in-another-chat is unchanged, but a Claude turn neither defers a config change nor is ended by one. That is a genuine simplification and worth naming as one
- **It reports no cost and no token counts, and both omissions are deliberate.** Cost on a subscription is a shadow price — three probe turns reported dollar figures against a plan that charged nothing — and no wording available in a notice line makes that informative, so it is dropped outright. Token counts are a different argument and land in the same place: the contract says they *may* stay, which is permission rather than instruction, and a token figure in every transcript is noise for a number nobody asked for. The SDK's final message carries both and the translator folds them; nothing reads them, on purpose. The one thing a turn does report about itself is the account that paid for it, and only when that is not the expected one
- **It never writes into `~/.claude/`** — no settings, no rules, no credentials, no `apiKeyHelper`
- **It ships no Claude Code of its own.** The SDK pulls a bundled ~190 MB binary per platform; every installer excludes it. Not executing it is not the same as not shipping it, and shipping it would put a second Claude Code in the app that the user never chose, cannot see and cannot update
- **It makes no claim about Windows.** Detection, `PATH` resolution and credential storage all differ there and none of it was considered
- **The engine axis is two-valued on purpose.** Nothing here is built to accommodate a third engine and it should not be until there is one — the abstraction that fits two is not reliably the one that fits three

## Known gaps, carried honestly

These are open:

- **The Keychain question is largely closed, and it was the wrong question.** This entry used to say the path had never been exercised. It had been all along: the probe machine's credentials *file* had been expired for a month while every probe succeeded, so the live credential was the Keychain item throughout — see [the contract, §1](claude_contract.md). The remaining half was then measured directly: a Developer ID-signed `node` under `--options runtime` carrying **this app's own entitlements**, none of them Keychain-related, spawned `claude auth status` with the credentials file moved aside and got a logged-in answer with **no consent prompt**. What that does not cover is written out in [§8 item 1](claude_contract.md#8-still-unverified--and-one-of-these-can-still-kill-the-feature) and must not be read as covered: the parent was a signed `node`, not the packaged `.app` with its `entitlementsInherit` chain; nothing was notarized, quarantined or launched past Gatekeeper; only the native installer's `claude` was the accessing binary; and "no prompt" is on a machine where `claude` has been run interactively many times
- **A real spawn against a genuinely logged-out install is still untested.** The readiness probe is verified against a logged-out *environment* rather than a logged-out *machine* (`USER` withheld, and an empty `HOME`), and the thrown-error fallback below it is still driven by matching the CLI's error text
- **Whether an API key in the environment actually shadows an OAuth login is not proven.** The stripping rule rests on the SDK documenting the two as distinct credential sources, which is strong but is not observation
- **Only one install shape was tested** — the native installer. The SDK branches on the executable path's extension, so an npm shim and a Homebrew wrapper take different code paths — and they are also *different binaries* to the Keychain, so the item's ACL is evaluated afresh for each and the no-prompt result above does not carry over
- **The installer exclusion is verified on `darwin-arm64` only.** The other seven platform packages are not built here
- **The Anthropic API SDK moved 0.89 → 0.93** to satisfy the Agent SDK's peer requirement, and the bump lands on the ordinary Anthropic chat adapter, `src/main/llm/anthropic.ts`, not on anything here. That adapter is covered — `src/main/llm/anthropic.test.ts` runs the SDK's real client against a stubbed wire — but nothing in this feature exercises it, so a further bump forced from here is verified there, not here; see [LLM Adapters — Technical Details](../../llm/adapters/adapters_tech.md#sdk-versions-and-one-that-moved-for-a-reason-outside-this-domain)
- **Out-of-plan usage has no good surface.** It arrives mid-turn as an error from the CLI and its message is passed through, which is honest but not helpful. We do not know the user's limits and inventing a sentence about them would be worse than the CLI's own
- **No automated test ever runs a turn on it.** The E2E scenarios drive the *choice* — the option, the manifest rewritten in both directions, the panel's geometry — and the readiness ladder, which is reachable there because the probe is free and the sandbox `HOME` makes a real install read as logged out. They stop there, because spawning a `claude` **turn** bills a real person's subscription on every developer's machine and in CI. Everything past the picker is covered by unit tests against an injected SDK

## Architecture Overview

```
Agent page → "Runs with" panel
   │  Runs on: [ On this machine: Claude Agent | AI credentials: … ]
   │  tier picker, status line, detected-install column
   ▼
local-agent:update-field  (kit, stamped)  /  local-agent:set-runtime  (bare)
   │  runtime.engine written to cinna-agent.json or to Desktop State
   ▼
runtimeService.resolve ──► ResolvedRuntime { engine, credential?, model }
   │                        engine = claude → no credential, model = alias
   ▼
resolveTurnRunner(agent)             dispatch: source → engine
   ├── source ≠ folder ────────────────────────► A2A runner
   ├── engine = opencode ──────────────────────► local (OpenCode) runner
   └── engine = claude ────────────────────────► Claude runner
                                                     │
   readiness — before the lock, before any turn:     │
     toolDetectionService → no `claude`  ──► refused │  nothing spawned
     claudeAuthProbe      → `logged_out` ──► refused │  nothing billed
       `claude auth status`, cached, in the same     │  `unknown` never blocks
       constructed environment the turn will use     │
     the panel asks the same probe:                  │
       useClaudeAuth → local-tools:claude-auth       │
                                                     │
              ┌──────────────────────────────────────┤
              ▼                                      ▼
   query({ prompt, options })              canUseTool ──► standing grants
     cwd            = the agent folder          │          └ covered → allow, silently
     systemPrompt   = the folder's own          │
     pathToClaude…  = the user's binary         └────────► parked request
     settingSources = []                                    └ transcript block → answered
     strictMcpConfig + no MCP servers
     env            = constructed (see rules)
     resume         = the remembered session
     abortController= the turn's own signal
              │
              ▼
   SDK message stream ──► translator
     stream_event → text and thinking deltas     assistant → tool calls
     user         → tool results                 result    → the turn ends
     system/init  → apiKeySource, model, version
              │
              ▼
   RunAgentTurnResult { text, parts, notices, contextId }
              │
              ▼
   parts accumulator → message repository → renderer   (all unchanged)
```

## Integration Points

- [The Claude Engine Contract](claude_contract.md) — what was watched against the real binary and the SDK, and the authority for every "why does the code do this" question here
- [The Agent Turn Runner](agent_turn.md) — the seam this is the third implementation of, and every rule about never throwing, the lock and the ceiling
- [The Local Engine, Runtimes & Prompt Assembly](engine.md) — the runtime resolution this extends, the prompt assembly it reuses verbatim, and the environment narrowing rule it widens by exactly one variable
- [Local Agent Permissions](permissions.md) — the standing grants the permission callback consults, and why *Always* is never written into a tool's own store
- [Kit Contract & Manifest Layer](kit_contract.md) — `runtime.engine` as an additive 1.2.0 field, and the tolerant-read rule that keeps a newer folder running
- [Agents Tab & Agent Page](agents_tab.md) — the "Runs with" panel and its one reserved status line
- [Open in… (Local Agent Tools)](open_in_tools.md) — the tool detection that already found `claude` for a menu item and is now load-bearing for whether an agent can run at all. The login probe is its sibling and rides the same `local-tools:*` surface (`local-tools:claude-auth`), so pressing **Refresh** in Settings → Local Agents re-asks both
- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — the login-shell environment and the child allowlist the constructed environment starts from
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — rule 1 in particular, for a picker that changes which controls exist beneath it
- Technical details: [The Claude Engine (tech)](claude_engine_tech.md)
