# `/run:<name>` — Technical Details

Implementation reference for [`/run:<name>` — running a folder agent's catalog commands](commands.md). The catalog reader, the localisation rules and the `command_result` part kind are **not** restated here — see [Kit Contract & Manifest Layer](kit_contract.md) and [Command Results](../../chat/command_results/command_results.md).

## File Locations

### Main process
- `src/main/services/localAgents/commandService.ts` (net-new) — the whole feature: catalog lookup, localisation call, subprocess execution, turn-lock, and shaping into `RunAgentTurnResult`
  - `MAX_OUTPUT_BYTES` (`:73`, `200_000`) — combined stdout+stderr cap, enforced as chunks arrive (`append`, `:205-215`): past it the pipes are still drained so the child never stalls on a full buffer, but nothing more is kept — the bound is on this process's heap, not only on the DB row
  - `COMMAND_TIMEOUT_MS` (`:83`, 5 min) — per-command ceiling, deliberately shorter than `TURN_CEILING_MS` (20 min, `localAgentTurnRunner.ts`)
  - `killTree(child)` (`:120-146`) — POSIX: `process.kill(-child.pid, 'SIGKILL')` against the process group; win32: `taskkill /pid <pid> /T /F`. Falls back to signalling the child directly if there is no pid or no process group
  - `execute(localCommand, agentDir, env, signal?, timeoutMs?)` (`:149-235`) — spawns under a shell (`shell: true`), `detached: process.platform !== 'win32'` so `killTree` can reach the group, checks `signal?.aborted` *before* spawning (closes the gap between an abort fired while `getShellEnv()` is still pending and the listener being attached)
  - `commandService.matchRunCommand(wireContent)` (`:266-269`) — `RUN_REFERENCE_PATTERN.exec(wireContent.trim())`, anchored to the whole trimmed message
  - `commandService.run(userId, agentId, name, signal?, timeoutMs?)` (`:279-399`) — locates the agent (`localAgentService.locate`), reads the catalog (`readCommandCatalog`), localises the entry (`layout.localizeCommand`), runs it under `turnLock.withLock(agentId, 'command', …)`. Never throws — every failure path returns `{ok: false, error}`, and a cancel returns `{ok: false, aborted: true}` so a direct caller can tell it from a failure
  - `commandService.runForTurn(userId, agentId, name, signal?)` (`:410-425`) — `run()` shaped into `RunAgentTurnResult`: success → one `command_result` `MessagePart`; failure → `{error: {message, raw}}`
  - `resolveCommandRunner(isFolder, wireContent, agentOwnerId, agentId, fallback)` (`:441-454`) — the interception point itself, extracted as a pure function so the dispatch decision is directly testable without spinning up `ipcMain`. Returns `fallback` unchanged unless `isFolder` **and** `matchRunCommand` both hit

### Main process — call site
- `src/main/ipc/agent_a2a.ipc.ts:195-196` — `resolveTurnRunner(agent)` / `isFolderAgent(agent)`, unchanged from Phase 6
- `src/main/ipc/agent_a2a.ipc.ts:242-248` — `messageRoutingService.prepareAgentSend`, which is what produces `wireContent`
- `src/main/ipc/agent_a2a.ipc.ts:257` — `resolveCommandRunner(isFolder, wireContent, agentOwnerId, agentId, runner)`, called after `wireContent` is known and before `streamToAgent`
- `src/main/ipc/agent_a2a.ipc.ts:275-276` — `a2aStreamingService.streamToAgent({runner: effectiveRunner, …})` — the swap that actually matters; see [Testing notes](#testing-notes) for why this line specifically has its own test file

### Main process — reused, unchanged by this slice
- `src/main/kit/validator.ts:687` — `readCommandCatalog(agentDir, relPath)`
- `src/main/kit/layout.ts:329-344` — `LayoutView.localizeCommand(command, context)`, rule-driven from `layout.json`'s `local_command_runner.rules` (`resources/cinna-kit-contract/layout.json:247`)
- `src/main/services/localAgents/turnLock.ts:68` — `acquire(agentId, owner)`; `:98` — `withLock`. `owner` is an unconstrained string — `'command'` is a new value passed in, not a new lock mode
- `src/main/services/agentTurn/runner.ts` — `AgentTurnRunner`, `isFolderAgent()`. Not imported by `commandService.ts`; `resolveCommandRunner` returns an object shaped to the same interface without depending on the module
- `src/main/services/a2aStreamingService.ts` — `RunAgentTurnResult`, `streamToAgent()`. Body unchanged; only the `runner` it is handed differs

### Main process — the composer popup's folder branch
- `src/main/services/agentService.ts:494-509` — `listFolderCliCommands(userId, agentId)`: locates the agent, reads the catalog, maps each entry to the shared `CliCommand` shape (`src/shared/cliCommands.ts`) with `command: '/run:${name}'`. Never throws — a read failure logs a warning and returns `[]`, since this backs a popup, not a page
- `src/main/services/agentService.ts:522-542` — `listCliCommands(userId, agentId)` — the one function `useCliCommands` calls through IPC. `:525` dispatches to `listFolderCliCommands` when `agent.source === 'folder'`, **before** the pre-existing `agent.protocol !== 'a2a'` short-circuit that previously answered `[]` for every folder agent (the same dead-branch-until-a-phase-adds-it shape as `agentStatusService.list`'s remote-only filter)

### Shared
- `src/shared/kit/manifest.ts:147` — `RUN_REFERENCE_PATTERN = /^\/run:([A-Za-z0-9][A-Za-z0-9_-]*)$/`. The same pattern `validator.ts:978` already checked `status_refresh_command` against — this slice does not define a second grammar
- `src/shared/messageParts.ts:41` — `'command_result'` part kind (pre-existing); `:83` — `commandInvocation` field, always set on a `command_result` part

### Renderer
- `src/renderer/src/components/agents/local/ReadOnlyCards.tsx:95-169` — `CommandsCard`. `run(name)` (`:101-124`) calls `useNewChatFlow().startNewChat({message: '/run:<name>', agentIds:[agent.id], mode:null, providerId:null, providers:undefined, allModels:undefined, mcpIds:[]})` after `setActiveView('chat')`. `runningName` state disables every Run button while one is in flight
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx:174-187` — the **Start chat** button, no longer `disabled`. `onClick` is `setActiveView('chat')` + `setPendingAgentId(agent.id)` — the same `pendingAgentId` path `AgentStatusOverlay`'s own "Start chat" already used for a remote agent, seeded into `pendingAgentIds` by `MainArea.tsx`
- `src/renderer/src/components/chat/ChatInput.tsx:502` — `promptSourceAgent = boundAgent ?? selectedAgent ?? null`; `:510` — `useCliCommands(promptSourceAgent?.id)`. Unchanged by this slice; a folder agent reaches the popup only because `listCliCommands` now answers for one
- `src/renderer/src/hooks/useCliCommands.ts` — unchanged. `useCliCommands(agentId)` → `window.api.agents.listCliCommands(agentId)`, deliberately agnostic to what kind of agent `agentId` names
- `src/renderer/src/components/chat/CommandResultBlock.tsx`, `MessageStream.tsx` — reused verbatim; see [Command Results](../../chat/command_results/command_results.md)

## IPC Channels

No new channel. `agent:send-message` (`agent_a2a.ipc.ts:148`) is unchanged in shape — the only new work on that path is the `resolveCommandRunner` call and the runner swap described above. `agent:list-cli-commands` (`src/preload/index.ts:517`, the existing channel `useCliCommands` calls) is unchanged in signature; only `agentService.listCliCommands`'s folder branch behind it is new.

## Services & Key Methods

### `commandService.run` — the guards, in order

1. `localAgentService.locate(userId, agentId)` — folder gone from disk, or the agent otherwise unaddressable (`:286-294`)
2. The catalog lookup as a whole (`:301-334`) is guarded: `getLayoutView(root.path)` throws a `KitError` when the kit contract itself cannot be loaded, and `run()`'s contract is that it never throws — so the guard covers the lookup, not only the one call known to throw today. Inside it: `readCommandCatalog(agentDir, catalogPath)` then `catalog.commands.find(c => c.name === name)` — name not in the catalog (`:308-318`)
3. `layout.localizeCommand(entry.command, {hasPyproject})` (`:319-320`) — no guard of its own, always succeeds; a rule that doesn't match runs the command unchanged
4. `turnLock.withLock(agentId, 'command', …)` (`:336`), wrapped in a `catch` (`:390-398`) because `turnLock.acquire` throws and never queues — same contract `LocalAgentTurnRunner` relies on
5. Inside the lock: `execute()` runs the subprocess and classifies the outcome, in this order — `spawnError` (`:340-350`), `timedOut` (`:355-365`; the message names the ceiling actually applied, `timeoutMs`, not the default), `aborted` (`:366-376`; the caller's signal fired — a timeout is checked first because the ceiling kills through the same path but never fires the signal, so the two stay distinguishable), non-zero `exitCode` (`:377-387`), or success (`:388`)

### `execute()` lifecycle

`shellEnvForChild(await getShellEnv())` (`commandService.ts:337`) supplies the child's environment — the same narrowed login-shell environment a stdio MCP server or the local engine gets; see [Shell Environment Resolution](../../development/shell_environment/shell_environment.md). The abort listener and the timeout ceiling both route through `killTree`, and `finish()` (`:219-230`) is idempotent — the first of `'error'` or `'close'` to fire settles the promise, `clearTimeout` and `removeEventListener` run exactly once.

### `killTree` — why it exists

A plain `child.kill('SIGKILL')` only signals the shell `spawn(..., {shell:true})` itself. The shell dies, but a grandchild it already forked (the real command inside a pipeline or `&&` sequence) is orphaned, keeps running, and — holding the inherited stdout/stderr pipes open — keeps the `'close'` event from firing until *it* finishes. Found by running it, not by reasoning about it: a `sleep 2 && touch marker` killed this way never ran `touch` (the shell that would launch it was dead), but the promise this module returns did not settle, and the turn lock stayed held, until the full sleep finished anyway — silently defeating both the abort and the timeout ceiling. The fix spawns the child as the leader of its own process group (`detached: true` on POSIX) so `process.kill(-pid, 'SIGKILL')` reaches every process in it; Windows has no process groups in this sense, so `taskkill /pid <pid> /T /F` is the tree-kill there.

### `resolveCommandRunner` — why it is a pure, extracted function

Which runner a message actually goes through is exactly the kind of decision a mutation could silently break (e.g. the resolved command runner computed but never wired into the `streamToAgent` call) with no failing test to catch it, and `agent_a2a.ipc.ts`'s handler itself is not unit-testable without spinning up `ipcMain`. Extracting the decision into `resolveCommandRunner` — pure in, pure out — makes both halves independently testable: the decision itself in `commandService.test.ts`, and the fact that the IPC handler actually uses what it returns in `agent_a2a.commandDispatch.test.ts`.

## Data Shapes

### `CommandRunOutcome` (`commandService.ts:237-254`)

`{ok, name, localCommand, output, exitCode, aborted, error?}` — the catalog name as referenced, the command as actually localised and executed, captured output (truncated), the process exit code, whether the caller's signal cancelled it (always `ok: false`, never a failure of the command — `streamToAgent` already suppresses the error surface on abort, but a direct consumer of `run()` needs the flag), and (on failure) a short user-facing reason.

### `RunAgentTurnResult` shaping (`runForTurn`, `:344-359`)

Success: `{text: '```\n<output>\n```', parts: [{kind:'command_result', text, commandInvocation:'/run:<name>'}], notices: []}`. `_(no output)_` stands in for an empty body. Failure: `{text:'', parts:[], notices:[], error:{message, raw}}` — `raw` is the captured output when there is any, falling back to the error message itself when there is none, so the turn-error banner's expand affordance always has something to show.

## Configuration

| Constant | Where | Value | Why |
|---|---|---|---|
| `MAX_OUTPUT_BYTES` | `commandService.ts:73` | 200,000 | Combined stdout+stderr cap, enforced as output arrives; a runaway script must not grow the DB row — or the main process's heap — without bound |
| `COMMAND_TIMEOUT_MS` | `commandService.ts:83` | 5 min | Shorter than `TURN_CEILING_MS` (20 min) on purpose — a catalog command is a script, not an LLM turn, so a tighter ceiling is still generous for a one-click Run button |

## Security

- **A command runs under the same turn lock a model turn does**, owner `'command'`. This is what stops a `/run:<name>` script's writes racing a concurrent model turn (owner `'turn'`), a page editor save (owner `'editor'`), or a second command for the same agent — all three are proven generically for other owner pairs and specifically for `'command'` in `commandService.test.ts`'s "the turn lock" suite
- **The command runs cwd'd to the agent's own folder** (`agentDir`), never anywhere else — `spawn(localCommand, {cwd: agentDir, …})`
- **The environment handed to the subprocess is the narrowed login-shell environment** (`shellEnvForChild`), the same narrowing every other child spawn in this feature uses — see [The Local Engine](engine.md#the-engines-environment-is-narrowed-not-inherited)
- **`turnLock.anyHeld()` is deliberately not consulted.** A command never touches the shared `opencode serve` process, so there is nothing engine-level to serialize against — using the engine-wide predicate here would block a command on an unrelated agent's model turn for no reason
- **Output is never a place secrets are assumed absent** — nothing in this slice redacts a command's stdout/stderr. A catalog command that prints a credential prints it into the transcript exactly as it would on any other host; this is unchanged from what running the same script by hand would do, and out of scope for this slice

## Testing notes

- `src/main/services/localAgents/commandService.test.ts` (372 lines) — runs against the real bundled kit contract, a real temp folder, and (for most cases) a real subprocess rather than a mocked `spawn`, because "does `sh -c` actually run and capture output" is exactly the kind of claim a mock cannot prove. `spawn` and `getLayoutView` are the only things forced to throw, each for the one case a real environment cannot reliably reproduce (a spawn failure; a kit contract that cannot be loaded). Covers: `resolveCommandRunner`'s three branches, `matchRunCommand`'s exact-match grammar, every error path (not in catalog, folder gone, contract unreadable, binary not on `PATH`, non-zero exit, spawn throws, ceiling timeout — asserting the message names the ceiling actually applied — and abort, including an abort fired before the subprocess even starts, both reported with `aborted: true`), success (real localisation observed end to end, output capped at exactly `MAX_OUTPUT_BYTES` plus the marker — that the cap is enforced per chunk rather than once at the end is a heap property a black-box run cannot distinguish, and is checked by reading `append`), the turn-lock suite (held for the subprocess's length, refuses a second command, blocks an editor write), and `runForTurn`'s shaping of both outcomes
- `src/main/ipc/agent_a2a.commandDispatch.test.ts` (166 lines) — added as a review fix-up after a hand-run mutation (reverting `runner: effectiveRunner` back to `runner`) survived the full suite twice, because nothing had exercised the `agent:send-message` handler at all. Everything upstream and downstream of that one line is mocked to a canned happy path with distinguishable sentinel objects; the only assertion that matters is *which* sentinel `streamToAgent` receives — for a folder agent sending `/run:check`, and for a remote agent sending ordinary text. `resolveCommandRunner`'s own correctness is not re-proven here — that's `commandService.test.ts`'s job
- `src/main/services/agentService.listCliCommands.test.ts` — the composer-popup folder branch, against a real temp folder and the real catalog reader. Covers: a folder agent's commands mapped to the `CliCommand` shape, a not-found agent id rejecting, a broken catalog degrading to `[]` rather than throwing, and re-fetch behaviour
- `src/renderer/src/hooks/useCliCommands.test.tsx` — pins `useCliCommands` as agent-id-agnostic: it calls `window.api.agents.listCliCommands(agentId)` and surfaces whatever comes back, with no branch on what kind of agent the id names. Explicitly does **not** cover `ChatInput` calling the hook with a folder agent's id at the right moment — see [What is not verified](commands.md#what-is-not-verified)
- `src/renderer/src/components/agents/local/ReadOnlyCards.test.tsx` — `CommandsCard`'s Run button: switches to the chat view and starts a direct chat sending `/run:<name>`, disables every Run button while one is in flight and re-enables once it settles, and the empty-state copy with no Run button when the catalog is empty
- `src/renderer/src/components/agents/local/LocalAgentPage.test.tsx` — **Start chat**: switches to the chat view and hands the agent id to the pending-agent path, and asserts the button is enabled — explicitly named as pinning the flip from the prior hard-coded `disabled`

## What is not verified

See [commands.md § What is not verified](commands.md#what-is-not-verified) for the argued list. In short, from this slice's side: no live-browser run through `npm run dev`; the `ChatInput` → `useCliCommands` wiring for a folder agent is code-inspection-verified only, not exercised by a mounted-component test (the hook underneath it is tested); and `killTree`'s win32 `taskkill /T /F` path has never executed on real Windows.
