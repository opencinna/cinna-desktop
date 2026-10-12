/**
 * The Codex interface contract — every external interface of the Codex CLI and
 * its ACP adapter that Cinna relies on, one named entry each.
 *
 * An entry says what the tool must do (`expectation`), which Cinna code breaks
 * when it stops (`owners`), and what the user loses (`feature`). Each has
 * exactly one narrow test in `codex.contract.test.ts`, run against the **real
 * pinned binary** and the real patched adapter with a loopback fake provider
 * (`npm run test:contract`). When a new Codex release turns an entry red, the
 * entry names where to look.
 *
 * Data only, on purpose: the ratchet in `contractRegistry.test.ts` reads it to
 * check that every id has a test and every owner still exists, and
 * `scripts/generate-contract-docs.mjs` reads it under a type-stripping Node to
 * generate `docs/agents/local_agents/contracts/codex_interface.md`. No imports,
 * no enums.
 */

export type ContractArea =
  | 'launch & env'
  | 'auth'
  | 'session lifecycle'
  | 'tools & MCP'
  | 'permissions & questions'
  | 'cancellation'
  | 'models & config'
  | 'restricted chat policy'
  | 'provider traffic'
  | 'limits'

export type ContractSurface = 'CLI' | 'provider request' | 'env var' | 'app-server RPC' | 'ACP method' | 'ACP field' | '_meta key' | 'file' | 'adapter patch' | 'MCP request' | 'network'

/**
 * The steps of the Level 2 whole flow, the same in its two variants: the
 * no-billing `e2e/specs/runtime-flow.spec.ts` and the billed
 * `scripts/live/runtime-flow.mjs` (`make live-flow`). `none` says no step
 * exercises the entry, and then the note says why. A plain object rather than
 * an enum: this file is read under a type-stripping Node.
 */
export const FLOW_STEPS = {
  A: 'plain chat on the Default runtime, then its title (the engine’s own on Codex, Cinna’s AI title elsewhere)',
  B: 'a specialist @-added mid-chat, called through Cinna’s MCP server',
  C: 'continuity: a later turn remembers the first',
  D: 'a specialist attached before the first turn',
  none: 'not covered by the whole flow'
} as const

export type FlowStep = keyof typeof FLOW_STEPS

export interface ContractFlow {
  /** One or more of A–D, or `none` alone. The ratchet rejects anything else. */
  steps: readonly FlowStep[]
  /** What about the step exercises it, or why none does. Required with `none`. */
  note?: string
}

export interface ContractEntry {
  /** `codex.<area>.<what>` — stable, and quoted verbatim in its test's title. */
  id: string
  area: ContractArea
  surface: ContractSurface
  /** The exact flag, variable, method or field. */
  name: string
  /** What the tool must do. One sentence a release can be checked against. */
  expectation: string
  /** Repo-relative `file#symbol` in Cinna that depends on it. */
  owners: string[]
  /** What the user loses when it breaks. */
  feature: string
  /** Which whole-flow (Level 2) step(s) exercise it — see {@link FLOW_STEPS}. */
  flow: ContractFlow
  /**
   * Set when the entry **cannot be exercised against a fake provider** — it
   * needs a real login, a paid model or the vendor's own servers — and says
   * why. Its contract test is `it.skip`, never a faked pass; the ratchet holds
   * both directions, and the generated doc marks it. It is checked by the live
   * flow (Level 2) instead.
   */
  live?: string
}

/** Area order for the generated doc. */
export const CODEX_CONTRACT_AREAS: readonly ContractArea[] = [
  'launch & env', 'auth', 'session lifecycle', 'tools & MCP', 'permissions & questions',
  'cancellation', 'models & config', 'restricted chat policy', 'provider traffic', 'limits'
]

const LAUNCHER = 'src/main/agents/drivers/acp/codexLauncher.ts'
const POLICY = 'src/main/agents/drivers/acp/codexConductorPolicy.ts'
const DRIVER = 'src/main/agents/drivers/acp/acpDriver.ts'

export const CODEX_CONTRACT: readonly ContractEntry[] = [
  /* ------------------------------------------------------------ launch & env */
  {
    id: 'codex.launch.version-output', area: 'launch & env', surface: 'CLI', name: '--version',
    expectation: 'Prints exactly `codex-cli <version>` on stdout and exits 0.',
    owners: ['src/main/engine/binaryResolver.ts#CODEX_SPEC', `${POLICY}#SUPPORTED_VERSION`],
    feature: 'The managed install is discarded as the wrong version, and restricted chats refuse to start.',
    flow: { steps: ['A'], note: 'the live flow asserts the resolved binary reports the pinned version; the restricted-chat policy checks it before the first turn' }
  },
  {
    id: 'codex.launch.codex-path', area: 'launch & env', surface: 'env var', name: 'CODEX_PATH',
    expectation: 'The adapter starts the app-server from the executable this variable names, not from its bundled dependency.',
    owners: [`${LAUNCHER}#createCodexLauncher`, `${POLICY}#prepareCodexConductorPolicy`],
    feature: 'Sessions run on an unpinned CLI (or none: the bundled one is excluded from the packaged app), and the restricted-chat wrapper is bypassed.',
    flow: { steps: ['A'] }
  },
  {
    id: 'codex.launch.codex-config', area: 'launch & env', surface: 'env var', name: 'CODEX_CONFIG',
    expectation: 'Its JSON is applied at thread start: `model`, `model_reasoning_effort` and `developer_instructions` reach the model request.',
    owners: [`${LAUNCHER}#createCodexLauncher`],
    feature: 'A folder agent loses its instructions, its chosen model and its work-complexity effort.',
    flow: { steps: ['B', 'D'], note: 'the specialist’s folder-agent turn; model and effort are not asserted' }
  },
  {
    id: 'codex.launch.initial-agent-mode', area: 'launch & env', surface: 'env var', name: 'INITIAL_AGENT_MODE',
    expectation: 'A new session starts in the mode this variable names (`workspace-write`).',
    owners: [`${LAUNCHER}#createCodexLauncher`],
    feature: 'A session could begin in a wider approval mode than the agent’s Approvals setting before `session/set_mode` lands.',
    flow: { steps: ['B', 'D'], note: 'the specialist’s folder-agent turn starts under it; the mode itself is not asserted' }
  },

  {
    id: 'codex.sandbox.write-outside-workspace', area: 'permissions & questions', surface: 'ACP method', name: 'sibling write / session/request_permission',
    expectation: 'In `workspace-write` and `agent` mode alike, an exec_command writing inside the workspace runs without an ACP ask, and one writing a sibling directory outside the workspace and system temp roots is denied without an ask. Explicit require_escalated in workspace-write raises an execute permission and allow_once writes; the isolated fake-provider automatic reviewer refuses invalid reviewer output in agent mode.',
    owners: ['src/main/agents/drivers/acp/codexLauncher.ts#modeId', 'src/main/agents/drivers/acp/codexLauncher.ts#workspace-write'],
    feature: 'Ask for approval stops meaning "ask before writing outside the folder" (were it mapped to `read-only`, a folder agent could not edit its own folder). The file-handover requester cannot assume it can write another adopted folder unattended; tasks_create with an assignee supplies the main-owned alternative.',
    flow: { steps: ['none'], note: 'the whole flow does not write another adopted folder' }
  },
  {
    id: 'codex.sandbox.read-outside-workspace', area: 'permissions & questions', surface: 'ACP method', name: 'sibling read / session/request_permission',
    expectation: 'A shell read (`cat`) of a file outside the workspace and outside the system temp roots runs without an ACP ask and returns the file’s content, in workspace-write and in agent mode alike: the sandbox confines writes, not reads. Measured 6 Oct 2026, and again 11 Oct 2026 on 0.162.1 with codex-acp 2.2.2, against a fake provider.',
    owners: ['src/main/agents/drivers/acp/codexLauncher.ts#modeId'],
    feature: 'A Codex folder agent is told to read the `cinna-tasks` SKILL.md under the app’s resources before its first tasks_* call; if that read is refused or waits on an approval, it works the task verbs without the skill.',
    flow: { steps: ['none'], note: 'no step reads a file outside the working folder' }
  },
  {
    id: 'codex.tool.command-output', area: 'tools & MCP', surface: 'ACP field', name: '_meta.terminal_output_delta / terminal_exit',
    expectation: 'With the launcher’s client capabilities (`_meta.jetbrains.air` declared), a shell command’s output arrives only as `_meta.terminal_output_delta: { data, terminal_id }` fragments: streamed on in-progress updates while a command shown as a terminal runs, and whole on the completing update of a read/search/list command. With the patched adapter the completing update of every command also carries `rawOutput: { exit_code, formatted_output }`, the whole output (a terminal command’s exit is in `_meta.terminal_exit` too); no `content` text. The opening `tool_call` carries `name: "exec_command"` beside the human `title`. The desktop stores `formatted_output` as the call’s tool_result, the fragments only when there is none, and names the call by its title.',
    owners: ['src/main/agents/drivers/acp/acpMessages.ts#terminal_output_delta', 'src/main/agents/drivers/acp/acpMessages.ts#formatted_output', 'src/main/agents/drivers/acp/acpMessages.ts#resolveToolName', 'scripts/patch-codex-acp.cjs#airClientOff', 'scripts/patch-codex-acp.cjs#commandEndWhole'],
    feature: 'Every Codex command runs with no output in the chat: the transcript keeps the call and never what it printed. Codex-acp sends AIR’s client no fragments at all, so this is also the first place the AIR shapes would show if the patch stopped applying.',
    flow: { steps: ['none'], note: 'the whole flow’s turns call Cinna tools, not shell commands' }
  },
  {
    id: 'codex.tool.command-output-whole', area: 'tools & MCP', surface: 'adapter patch', name: 'rawOutput.formatted_output (whole output)',
    expectation: 'A command that prints, pauses two seconds and prints again keeps its first lines: with the patched adapter its completing `tool_call_update` carries the whole output as `rawOutput.formatted_output`, though 0.162.1 streams no `terminal_output_delta` for what a command prints before its first output poll and the adapter resends nothing once a fragment streamed. The desktop stores that whole output once.',
    owners: ['scripts/patch-codex-acp.cjs#commandEndWhole', 'src/main/agents/drivers/acp/acpMessages.ts#streamedCommandText'],
    feature: 'A build or a test run is stored without its first lines: the transcript shows only what came after the CLI’s first poll.',
    flow: { steps: ['none'], note: 'the whole flow runs no shell command' }
  },
  {
    id: 'codex.tool.update-merge', area: 'tools & MCP', surface: 'ACP field', name: 'tool_call / tool_call_update fields',
    expectation: 'A terminal command’s opening `tool_call` carries `name`, `kind: "execute"`, `title`, `status: "in_progress"`, `content: [{ type: "terminal" }]` and `rawInput: { command, cwd }`; every later `tool_call_update` carries only what changed — never `title`, `kind` or `rawInput` again — and the completing one its `status` and no `content`.',
    owners: ['src/main/agents/drivers/acp/acpMessages.ts#recordEvidence', 'scripts/patch-codex-acp.cjs#airClientOff'],
    feature: 'A Codex call’s card keeps the name, input and narration of its opening update; a reader that replaced a call with each update would blank it. The AIR-UI shapes reshape these fields, so a change here is also where they would show.',
    flow: { steps: ['none'], note: 'the whole flow runs no shell command' }
  },
  {
    id: 'codex.tool.mcp-output', area: 'tools & MCP', surface: 'ACP field', name: 'tool_call_update rawOutput.result / error',
    expectation: 'An MCP call’s completing `tool_call_update` carries `rawOutput: { result: { content, structuredContent, _meta }, error }` and no `content`. A tool answering `isError` arrives as `status: "failed"` with its message in `result.content` and `error: null`. The desktop stores the content’s text as the call’s tool_result.',
    owners: ['src/main/agents/drivers/acp/acpMessages.ts#mcpOutputText'],
    feature: 'A Codex agent’s MCP calls — Cinna’s own tools included — show no result in the chat, and a failed call shows no reason.',
    flow: { steps: ['none'], note: 'the whole flow does not assert stored tool results' }
  },
  {
    id: 'codex.mcp.folder-session-load', area: 'tools & MCP', surface: 'ACP field', name: 'native folder session/new and session/load mcpServers',
    expectation: 'With native tools still enabled, two sessions on one adapter connect different cinna bearer descriptors and call their own provider; session/load with the first descriptor calls that provider again. Descriptor data stays in per-session RPC, outside process configuration.',
    owners: ['src/main/agents/drivers/acp/acpDriver.ts#session/load'],
    feature: 'Ordinary folder agents lose handover tools, or a pooled session delegates under another chat identity.',
    flow: { steps: ['none'], note: 'the whole flow exercises restricted conductor sessions, not ordinary folder MCP injection' }
  },
  /* -------------------------------------------------------------------- auth */
  {
    id: 'codex.auth.login-status', area: 'auth', surface: 'CLI', name: 'login status',
    expectation: 'With no login under `HOME`/`CODEX_HOME` it prints a line `Not logged in` and exits non-zero; the login follows the home directory, not the binary.',
    owners: ['src/main/agents/drivers/acp/codexAuth.ts#parseCodexAuthStatus', 'src/main/agents/drivers/acp/codexEnv.ts#buildCodexEnv'],
    feature: 'Readiness cannot tell a logged-out machine, so a turn fails mid-chat instead of being refused with the `codex login` remedy.',
    flow: { steps: ['A'], note: 'the login probe before the first turn' }
  },

  /* ------------------------------------------------------- session lifecycle */
  {
    id: 'codex.session.initialize', area: 'session lifecycle', surface: 'ACP method', name: 'initialize',
    expectation: 'Answers protocol version 1 and advertises `agentCapabilities.loadSession: true`.',
    owners: [`${LAUNCHER}#ACP_PROTOCOL_VERSION`, `${DRIVER}#loadSession`],
    feature: 'No Codex session starts, or every turn after the first loses the conversation.',
    flow: { steps: ['A'] }
  },
  {
    id: 'codex.session.modes', area: 'session lifecycle', surface: 'ACP method', name: 'session/set_mode',
    expectation: 'A session offers the mode ids `read-only`, `workspace-write`, `agent` and `agent-full-access`, and `session/set_mode` to `workspace-write` or `agent` succeeds. `workspace-write` (edit the workspace, ask before writing outside it) is what `read-only` was before codex-acp 2.0; `read-only` is now a read-only sandbox, which Cinna does not use.',
    owners: [`${LAUNCHER}#modeId`],
    feature: 'The Approvals setting (Ask for approval / Automatic) cannot be applied; the turn is refused at setup.',
    flow: { steps: ['A', 'B', 'D'], note: 'applied at session setup; the mode is not asserted' }
  },
  {
    id: 'codex.session.load', area: 'session lifecycle', surface: 'ACP method', name: 'session/load',
    expectation: 'Loading a session in the same process succeeds and **keeps the collaboration mode it was left in**, so setup must be re-applied after every load.',
    owners: [`${POLICY}#collaboration_mode`, `${DRIVER}#session/load`],
    feature: 'A resumed restricted chat would silently run in Plan mode, where `request_user_input` is a usable native tool.',
    flow: { steps: ['none'], note: 'no step restarts the app or reaps the process between turns, so nothing is loaded' }
  },
  {
    id: 'codex.session.system-prompt-meta', area: 'session lifecycle', surface: 'adapter patch', name: '_meta.cinna.systemPrompt',
    expectation: 'The patched adapter passes it as `developerInstructions` on thread start, so it reaches the model as developer/system text and never as user input.',
    owners: ['scripts/patch-codex-acp.cjs#patchCodexAcp', `${POLICY}#systemPrompt`],
    feature: 'Chat-mode instructions and AI-function prompts are lost, or leak between sessions sharing one warm process.',
    flow: { steps: ['A'] }
  },
  {
    id: 'codex.session.prompt-usage', area: 'session lifecycle', surface: 'ACP field', name: 'usage / _meta.quota.token_count',
    expectation: 'Every prompt response carries the **whole prompt’s** usage — every model request of the turn summed — as `usage` (ACP names) and as `_meta.quota.token_count` (codex names, cache writes as `cacheWriteInputTokens`) with one `model_usage` row for the session’s model; never the thread’s running total, a session `session/load`ed into a fresh adapter process included.',
    owners: ['src/main/agents/drivers/acp/acpTelemetry.ts#parsePromptTelemetry', 'src/main/agents/drivers/acp/acpTelemetry.ts#cacheWriteInputTokens'],
    feature: 'A Codex turn’s tokens and estimated cost in the mode badge and the message popup: read as a turn, a last request would undercount every turn that called a tool, and a running total would charge the whole history to each turn.',
    flow: { steps: ['A', 'C'], note: 'every turn passes through it; no step asserts the tokens' }
  },
  {
    id: 'codex.session.air-async-tasks', area: 'session lifecycle', surface: '_meta key', name: '_meta.jetbrains.air capabilities (asyncTasks)',
    expectation: 'With the launcher’s `airClientMeta([\'asyncTasks\'])` and the patched adapter answering `isAirClient` false, a command left running when its turn ends is still reported as a background task: `async_task_spawned` (`taskType: "shell"`, `toolCallId` the command’s), and its completion arrives after the prompt returned. `initialize` answers with no `_meta.jetbrains`.',
    owners: [`${LAUNCHER}#airClientMeta`, 'src/main/agents/drivers/acp/acpActivity.ts#async_task_spawned', 'scripts/patch-codex-acp.cjs#airClientOff'],
    feature: 'Background commands disappear from the activity row beside the composer and cannot be stopped there. A `jetbrains` key in `initialize` means the adapter treats Cinna as the AIR UI again.',
    flow: { steps: ['none'], note: 'the whole flow runs no shell command' }
  },
  {
    id: 'codex.activity.subagent-shape', area: 'session lifecycle', surface: 'ACP field', name: 'tool_call rawInput {agentThreadId, agentPath, activityKind}',
    expectation: 'With the launcher’s capabilities (no `nativeSubagentSessions`), a `spawn_agent` call sends neither `subagent_spawned` nor `subagent_state_update`: the root session gets a `tool_call` titled `Start subagent <name>` whose `rawInput` is `{agentThreadId, agentPath: "/root/<name>", activityKind: "started"}`, later one with the same thread and `activityKind: "completed"`, and collaboration calls (`wait`) whose `rawInput` carries `senderThreadId`, `receiverThreadIds` and `agentsStates`. None of them carries `_meta`.',
    owners: ['src/main/agents/drivers/acp/acpActivity.ts#codexSubagentActivity', 'src/main/agents/drivers/acp/acpActivity.ts#isCodexCollaboration', `${LAUNCHER}#airClientMeta`, 'scripts/patch-codex-acp.cjs#airClientOff'],
    feature: 'Codex subagents vanish from the activity row beside the composer: 2.x dropped the `_meta.codex.subagent` / `collaboration` keys 1.11.0 read from, and the `rawInput` is all that is left. A `subagent_spawned` here means the adapter treats Cinna as a native-subagent client, and the spawn call leaves the transcript.',
    flow: { steps: ['none'], note: 'no step has the model spawn a subagent' }
  },
  {
    id: 'codex.session.silent-updates', area: 'session lifecycle', surface: 'ACP field', name: 'notice / compaction_update',
    expectation: 'A turn that compacts (a model change) sends neither `notice` nor `compaction_update` — the adapter sends them only to a client declaring `session.notices` / `session.compaction`, which the launcher does not. As under 1.11.0, the compaction arrives as a `tool_call` `kind: "think"`, title `Compact conversation`, completed within the turn, and the CLI’s warning as agent text `Warning: …` ahead of the answer.',
    owners: ['src/main/agents/drivers/acp/acpMessages.ts#compaction_'],
    feature: 'A Codex model switch shows a "Compact conversation" step and the CLI’s long-thread warning in the reply, as before the bump. Were `notice` or `compaction_update` sent unasked, the desktop would drop them silently (its default for an unknown update), and the step or the warning would vanish.',
    flow: { steps: ['none'], note: 'no step changes the model' }
  },
  {
    id: 'codex.session.info-title', area: 'session lifecycle', surface: 'ACP field', name: 'session_info_update.title',
    expectation: 'After a thread’s first prompt the session reports `session_info_update` with a `title` twice: first the prompt text verbatim (a placeholder), then the title the CLI’s own title request produced.',
    owners: ['src/main/agents/drivers/acp/acpSessionTitle.ts#isPromptPlaceholder', 'src/main/agents/drivers/acp/acpSessionTitle.ts#sessionInfoTitle', 'src/main/services/chatTitleService.ts#applyEngineTitle'],
    feature: 'A chat whose root runs on Codex keeps the title derived from its first message — Cinna runs no AI title of its own for it — or, if the placeholder stopped being first or verbatim, is named after the prompt itself.',
    flow: { steps: ['A'], note: 'the chat’s title is the fake provider’s answer to the CLI’s title request' }
  },

  /* ------------------------------------------------------------- tools & MCP */
  {
    id: 'codex.mcp.session-injection', area: 'tools & MCP', surface: 'ACP field', name: 'session/new mcpServers',
    expectation: 'An HTTP descriptor named `cinna` is connected with its headers, and its tools are offered to the model as `mcp__cinna.<tool>`.',
    owners: ['src/main/services/conductorBridge.ts#prepare', 'src/main/services/conductorMcpServer.ts#ConductorMcpServer'],
    feature: 'A Codex chat cannot call attached agents or MCP servers at all.',
    flow: { steps: ['B', 'D'] }
  },
  {
    id: 'codex.mcp.tool-call-naming', area: 'tools & MCP', surface: 'ACP field', name: 'tool_call title / rawInput',
    expectation: 'A Cinna tool call is reported with `title: "mcp.cinna.<tool>"` and `rawInput: { server: "cinna", tool: "<tool>" }`.',
    owners: ['src/main/agents/drivers/acp/conductorToolPolicy.ts#cinnaToolName', 'src/main/services/conductorToolCorrelation.ts#ConductorToolCorrelation'],
    feature: 'Tool calls are not recognised as Cinna’s: no agent sub-thread in the transcript, and the permission gate treats them as native actions.',
    flow: { steps: ['B', 'D'] }
  },
  {
    id: 'codex.mcp.list-changed-not-adopted', area: 'tools & MCP', surface: 'ACP field', name: 'notifications/tools/list_changed',
    expectation: 'A tool added mid-session is **not** offered to the model on the next turn; the tool list is fixed at session creation.',
    owners: [`${LAUNCHER}#sessionToolsFixed`, 'src/main/services/conductorBridge.ts#sessionToolsFixed'],
    feature: 'If this ever flips, the new-session-on-tool-change workaround is dead weight; while it holds, removing the workaround makes a specialist attached mid-chat never callable.',
    flow: { steps: ['B'], note: 'the specialist attached mid-chat is callable only because the conductor gets a new session' }
  },
  {
    id: 'codex.mcp.inherited-disable-preserved', area: 'tools & MCP', surface: 'adapter patch', name: 'mcp_servers merge',
    expectation: 'With the patched adapter, a personal MCP server disabled by the policy stays disabled when a session injects `cinna`; its tools are never offered.',
    owners: ['scripts/patch-codex-acp.cjs#patchCodexAcp', `${POLICY}#mcp_servers`, `${POLICY}#DISABLE_MCP_CONFIG_FILTERING`],
    feature: 'A plain chat with "no tools" exposes the user’s personal MCP servers to the model.',
    flow: { steps: ['none'], note: 'needs a personal MCP server in the Codex config; no step sets one up' }
  },

  /* ------------------------------------------------- permissions & questions */
  {
    id: 'codex.permission.mcp-call-asks', area: 'permissions & questions', surface: 'ACP method', name: 'session/request_permission',
    expectation: 'Every Cinna MCP call raises a permission request with `toolCall.kind: "execute"`, an `allow_once` option, and the `toolCallId` of the `tool_call` update that named the tool — the request itself carries no title or `rawInput`.',
    owners: ['src/main/agents/drivers/acp/acpPermissions.ts#toAcpPermissionRequest', 'src/main/agents/drivers/acp/acpPermissions.ts#pickPermissionOption', 'src/main/agents/drivers/acp/acpMessages.ts#cinnaTool', 'src/main/agents/drivers/acp/acpDriver.ts#offersCinnaTool'],
    feature: 'A conducting session allows these asks silently when the `tool_call` with the same id carried `rawInput.server: "cinna"` and a `rawInput.tool` Cinna’s server listed for that session; if the id stops matching, every Cinna call in a chat surfaces an opaque ask again, and a folder agent’s recorded `codex:<kind>` grants stop matching anything.',
    flow: { steps: ['B', 'D'] }
  },
  {
    id: 'codex.question.unavailable-in-default-mode', area: 'permissions & questions', surface: 'ACP field', name: 'request_user_input',
    expectation: 'In Default collaboration mode a `request_user_input` call is answered "unavailable in Default mode" and no client request is made.',
    owners: [`${POLICY}#default_mode_request_user_input`, 'src/main/agents/drivers/acp/acpQuestions.ts#toInputQuestions'],
    feature: 'A no-tools chat or AI function could block on a question nobody is shown.',
    flow: { steps: ['none'], note: 'no step has the model ask a question' }
  },

  /* ------------------------------------------------------------ cancellation */
  {
    id: 'codex.cancel.session-cancel', area: 'cancellation', surface: 'ACP method', name: 'session/cancel',
    expectation: 'A cancel notification during a model request ends `session/prompt` with `stopReason: "cancelled"` within seconds.',
    owners: [`${DRIVER}#session/cancel`],
    feature: 'Stop leaves the turn running until the eighty-minute ceiling, holding the agent’s turn lock.',
    flow: { steps: ['none'], note: 'no step stops a turn' }
  },

  /* --------------------------------------------------------- models & config */
  {
    id: 'codex.config.app-server-read', area: 'models & config', surface: 'app-server RPC', name: 'initialize + config/read',
    expectation: '`config/read` with `includeLayers: false` returns `config.model` and `config.mcp_servers` without starting a thread.',
    owners: [`${POLICY}#discover`],
    feature: 'Restricted chats refuse: the policy cannot learn the effective model or which personal MCP servers to disable.',
    flow: { steps: ['A'], note: 'policy preparation before the first turn' }
  },
  {
    id: 'codex.config.model-list-default', area: 'models & config', surface: 'app-server RPC', name: 'model/list',
    expectation: '`model/list` with `includeHidden: true` returns `data[]` with string `id`s and exactly one `isDefault: true`.',
    owners: [`${POLICY}#discover`],
    feature: 'A chat mode that names no model cannot resolve one and refuses.',
    flow: { steps: ['A'], note: 'policy preparation, and only when the Codex config names no model' }
  },
  {
    id: 'codex.config.model-option', area: 'models & config', surface: 'ACP method', name: 'session/set_config_option model',
    expectation: 'Setting the `model` config option changes the model of the next request.',
    owners: ['src/main/services/runtimeModelCatalog.ts#recordRuntimeModelCatalog'],
    feature: 'Switching a chat’s model has no effect until the process is replaced.',
    flow: { steps: ['none'], note: 'no step switches the model' }
  },

  /* -------------------------------------------------- restricted chat policy */
  {
    id: 'codex.policy.feature-flags', area: 'restricted chat policy', surface: 'CLI', name: 'features list',
    expectation: 'Every feature flag the policy disables is a flag this CLI recognises.',
    owners: [`${POLICY}#FEATURES_DISABLED`],
    feature: 'A renamed flag is silently ignored and its native tool (shell, patch, browser, sub-agents) comes back into "no tools" chats.',
    flow: { steps: ['A'] }
  },
  {
    id: 'codex.policy.catalog-fields', area: 'restricted chat policy', surface: 'CLI', name: 'debug models --bundled',
    expectation: 'Prints `{ models: [...] }`; every model has string `slug`, `display_name` and `shell_type`, and every field the policy overwrites is still a field of the catalog.',
    owners: [`${POLICY}#CATALOG_POLICY`],
    feature: 'Restricted chats refuse ("catalog malformed"), or a new tool-selecting field is left at its native value.',
    flow: { steps: ['A'], note: 'policy preparation before the first turn' }
  },
  {
    id: 'codex.policy.no-native-tools', area: 'restricted chat policy', surface: 'CLI', name: '-c overrides + model_catalog_json',
    expectation: 'Under the production policy the model is offered Cinna tools, MCP resource readers and `request_user_input` only — no shell, patch, image or delegation tool.',
    owners: [`${POLICY}#prepareCodexConductorPolicy`, 'src/main/agents/drivers/acp/conductorToolPolicy.ts#applyConductorToolPolicy'],
    feature: 'A plain chat can run commands and edit files on the user’s machine.',
    flow: { steps: ['A'] }
  },
  {
    id: 'codex.policy.collaboration-mode', area: 'restricted chat policy', surface: 'ACP method', name: 'session/set_config_option collaboration_mode',
    expectation: 'Sessions expose a `collaboration_mode` config option and accept the value `default`.',
    owners: [`${POLICY}#collaboration_mode`],
    feature: 'Restricted sessions cannot be pinned to Default mode and are refused at setup.',
    flow: { steps: ['A'] }
  },

  /* -------------------------------------------------------- provider traffic */
  {
    id: 'codex.provider.auxiliary-request', area: 'provider traffic', surface: 'provider request', name: 'POST /v1/responses (thread title, compaction)',
    expectation: 'Beyond the conversation the CLI sends exactly two kinds of request of its own. **Thread title**: once per session beside its first turn (folder, restricted chat and utility sessions alike, never again), on `gpt-5.6-luna` whatever model the session uses, strict `json_schema` output `{ title }`, carrying the user’s first message verbatim but not Cinna’s session instructions, offered no tool a restricted session is not allowed; a thread still untitled after `session/load` (the provider answered with something other than `{ title }`) is asked for again on its next turn. **Compaction**: once after a model change, on the *previous* model, with no tools, carrying the conversation so far and not the new turn’s prompt. No other request is made.',
    owners: [`${POLICY}#prepareCodexConductorPolicy`],
    feature: 'Extra provider calls on the user’s login that Cinna never asked for: the first message of every session — AI-function inputs included — also goes to a second model, and a model switch costs a full-context call on the old one. If either starts carrying native tools, the "no tools" guarantee of a restricted chat is broken through a request nobody scripted.',
    flow: { steps: ['A'], note: 'the thread-title request beside the first turn; compaction is not reached' }
  },

  /* ------------------------------------------------------------------ limits */
  {
    id: 'codex.limits.rate-limit-kind', area: 'limits', surface: '_meta key', name: '_meta.codex.threadStatus',
    expectation: 'A provider 429 ends `session/prompt` normally (`end_turn`, no error, no `errorKind`, no AIR session failure); it shows only as `_meta.codex.threadStatus.type: "systemError"` and as assistant text naming the 429.',
    owners: [`${DRIVER}#errorKind`],
    feature: 'KNOWN GAP: the driver pauses a rate-limited chat on `error.data.errorKind === "rate_limit"`, the Claude adapter’s shape, which Codex never sends — so on Codex a rate limit reads as an ordinary finished turn whose "answer" is the retry error. This entry pins what Codex does send, for whoever closes the gap.',
    flow: { steps: ['none'], note: 'no step produces a 429' }
  }
]
