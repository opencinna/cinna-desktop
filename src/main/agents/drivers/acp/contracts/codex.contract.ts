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
  /** Which whole-flow (Level 2) step exercises it. Free text until that spec exists. */
  flow: string
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
    flow: 'first Codex turn (install)'
  },
  {
    id: 'codex.launch.codex-path', area: 'launch & env', surface: 'env var', name: 'CODEX_PATH',
    expectation: 'The adapter starts the app-server from the executable this variable names, not from its bundled dependency.',
    owners: [`${LAUNCHER}#createCodexLauncher`, `${POLICY}#prepareCodexConductorPolicy`],
    feature: 'Sessions run on an unpinned CLI (or none: the bundled one is excluded from the packaged app), and the restricted-chat wrapper is bypassed.',
    flow: 'plain chat'
  },
  {
    id: 'codex.launch.codex-config', area: 'launch & env', surface: 'env var', name: 'CODEX_CONFIG',
    expectation: 'Its JSON is applied at thread start: `model`, `model_reasoning_effort` and `developer_instructions` reach the model request.',
    owners: [`${LAUNCHER}#createCodexLauncher`],
    feature: 'A folder agent loses its instructions, its chosen model and its work-complexity effort.',
    flow: 'folder agent turn'
  },
  {
    id: 'codex.launch.initial-agent-mode', area: 'launch & env', surface: 'env var', name: 'INITIAL_AGENT_MODE',
    expectation: 'A new session starts in the mode this variable names (`read-only`).',
    owners: [`${LAUNCHER}#createCodexLauncher`],
    feature: 'A session could begin in a wider approval mode than the agent’s Approvals setting before `session/set_mode` lands.',
    flow: 'folder agent turn'
  },

  /* -------------------------------------------------------------------- auth */
  {
    id: 'codex.auth.login-status', area: 'auth', surface: 'CLI', name: 'login status',
    expectation: 'With no login under `HOME`/`CODEX_HOME` it prints a line `Not logged in` and exits non-zero; the login follows the home directory, not the binary.',
    owners: ['src/main/agents/drivers/acp/codexAuth.ts#parseCodexAuthStatus', 'src/main/agents/drivers/acp/codexEnv.ts#buildCodexEnv'],
    feature: 'Readiness cannot tell a logged-out machine, so a turn fails mid-chat instead of being refused with the `codex login` remedy.',
    flow: 'readiness before a turn'
  },

  /* ------------------------------------------------------- session lifecycle */
  {
    id: 'codex.session.initialize', area: 'session lifecycle', surface: 'ACP method', name: 'initialize',
    expectation: 'Answers protocol version 1 and advertises `agentCapabilities.loadSession: true`.',
    owners: [`${LAUNCHER}#ACP_PROTOCOL_VERSION`, `${DRIVER}#loadSession`],
    feature: 'No Codex session starts, or every turn after the first loses the conversation.',
    flow: 'plain chat'
  },
  {
    id: 'codex.session.modes', area: 'session lifecycle', surface: 'ACP method', name: 'session/set_mode',
    expectation: 'A session offers the mode ids `read-only` and `agent`, and `session/set_mode` to either succeeds.',
    owners: [`${LAUNCHER}#modeId`],
    feature: 'The Approvals setting (Ask for approval / Automatic) cannot be applied; the turn is refused at setup.',
    flow: 'folder agent turn'
  },
  {
    id: 'codex.session.load', area: 'session lifecycle', surface: 'ACP method', name: 'session/load',
    expectation: 'Loading a session in the same process succeeds and **keeps the collaboration mode it was left in**, so setup must be re-applied after every load.',
    owners: [`${POLICY}#collaboration_mode`, `${DRIVER}#session/load`],
    feature: 'A resumed restricted chat would silently run in Plan mode, where `request_user_input` is a usable native tool.',
    flow: 'continuity (second turn)'
  },
  {
    id: 'codex.session.system-prompt-meta', area: 'session lifecycle', surface: 'adapter patch', name: '_meta.cinna.systemPrompt',
    expectation: 'The patched adapter passes it as `developerInstructions` on thread start, so it reaches the model as developer/system text and never as user input.',
    owners: ['scripts/patch-codex-acp.cjs#patchCodexAcp', `${POLICY}#systemPrompt`],
    feature: 'Chat-mode instructions and AI-function prompts are lost, or leak between sessions sharing one warm process.',
    flow: 'plain chat'
  },

  /* ------------------------------------------------------------- tools & MCP */
  {
    id: 'codex.mcp.session-injection', area: 'tools & MCP', surface: 'ACP field', name: 'session/new mcpServers',
    expectation: 'An HTTP descriptor named `cinna` is connected with its headers, and its tools are offered to the model as `mcp__cinna.<tool>`.',
    owners: ['src/main/services/conductorBridge.ts#prepare', 'src/main/services/conductorMcpServer.ts#ConductorMcpServer'],
    feature: 'A Codex chat cannot call attached agents or MCP servers at all.',
    flow: 'specialist attached'
  },
  {
    id: 'codex.mcp.tool-call-naming', area: 'tools & MCP', surface: 'ACP field', name: 'tool_call title / rawInput',
    expectation: 'A Cinna tool call is reported with `title: "mcp.cinna.<tool>"` and `rawInput: { server: "cinna", tool: "<tool>" }`.',
    owners: ['src/main/agents/drivers/acp/conductorToolPolicy.ts#cinnaToolName', 'src/main/services/conductorToolCorrelation.ts#ConductorToolCorrelation'],
    feature: 'Tool calls are not recognised as Cinna’s: no agent sub-thread in the transcript, and the permission gate treats them as native actions.',
    flow: 'tool call'
  },
  {
    id: 'codex.mcp.list-changed-not-adopted', area: 'tools & MCP', surface: 'ACP field', name: 'notifications/tools/list_changed',
    expectation: 'A tool added mid-session is **not** offered to the model on the next turn; the tool list is fixed at session creation.',
    owners: [`${LAUNCHER}#sessionToolsFixed`, 'src/main/services/conductorBridge.ts#sessionToolsFixed'],
    feature: 'If this ever flips, the new-session-on-tool-change workaround is dead weight; while it holds, removing the workaround makes a specialist attached mid-chat never callable.',
    flow: 'specialist attached'
  },
  {
    id: 'codex.mcp.inherited-disable-preserved', area: 'tools & MCP', surface: 'adapter patch', name: 'mcp_servers merge',
    expectation: 'With the patched adapter, a personal MCP server disabled by the policy stays disabled when a session injects `cinna`; its tools are never offered.',
    owners: ['scripts/patch-codex-acp.cjs#patchCodexAcp', `${POLICY}#mcp_servers`, `${POLICY}#DISABLE_MCP_CONFIG_FILTERING`],
    feature: 'A plain chat with "no tools" exposes the user’s personal MCP servers to the model.',
    flow: 'plain chat'
  },

  /* ------------------------------------------------- permissions & questions */
  {
    id: 'codex.permission.mcp-call-asks', area: 'permissions & questions', surface: 'ACP method', name: 'session/request_permission',
    expectation: 'Every Cinna MCP call raises a permission request with `toolCall.kind: "execute"`, an `allow_once` option, and the `toolCallId` of the `tool_call` update that named the tool — the request itself carries no title or `rawInput`.',
    owners: ['src/main/agents/drivers/acp/acpPermissions.ts#toAcpPermissionRequest', 'src/main/agents/drivers/acp/acpPermissions.ts#pickPermissionOption'],
    feature: 'Either tool calls stall with no ask to answer, or (if the ask disappears) the recorded `codex:<kind>` grants stop matching anything.',
    flow: 'tool call'
  },
  {
    id: 'codex.question.unavailable-in-default-mode', area: 'permissions & questions', surface: 'ACP field', name: 'request_user_input',
    expectation: 'In Default collaboration mode a `request_user_input` call is answered "unavailable in Default mode" and no client request is made.',
    owners: [`${POLICY}#default_mode_request_user_input`, 'src/main/agents/drivers/acp/acpQuestions.ts#toInputQuestions'],
    feature: 'A no-tools chat or AI function could block on a question nobody is shown.',
    flow: 'plain chat'
  },

  /* ------------------------------------------------------------ cancellation */
  {
    id: 'codex.cancel.session-cancel', area: 'cancellation', surface: 'ACP method', name: 'session/cancel',
    expectation: 'A cancel notification during a model request ends `session/prompt` with `stopReason: "cancelled"` within seconds.',
    owners: [`${DRIVER}#session/cancel`],
    feature: 'Stop leaves the turn running until the eighty-minute ceiling, holding the agent’s turn lock.',
    flow: 'stop mid-turn'
  },

  /* --------------------------------------------------------- models & config */
  {
    id: 'codex.config.app-server-read', area: 'models & config', surface: 'app-server RPC', name: 'initialize + config/read',
    expectation: '`config/read` with `includeLayers: false` returns `config.model` and `config.mcp_servers` without starting a thread.',
    owners: [`${POLICY}#discover`],
    feature: 'Restricted chats refuse: the policy cannot learn the effective model or which personal MCP servers to disable.',
    flow: 'plain chat (policy preparation)'
  },
  {
    id: 'codex.config.model-list-default', area: 'models & config', surface: 'app-server RPC', name: 'model/list',
    expectation: '`model/list` with `includeHidden: true` returns `data[]` with string `id`s and exactly one `isDefault: true`.',
    owners: [`${POLICY}#discover`],
    feature: 'A chat mode that names no model cannot resolve one and refuses.',
    flow: 'plain chat (policy preparation)'
  },
  {
    id: 'codex.config.model-option', area: 'models & config', surface: 'ACP method', name: 'session/set_config_option model',
    expectation: 'Setting the `model` config option changes the model of the next request.',
    owners: ['src/main/services/runtimeModelCatalog.ts#recordRuntimeModelCatalog'],
    feature: 'Switching a chat’s model has no effect until the process is replaced.',
    flow: 'model switch'
  },

  /* -------------------------------------------------- restricted chat policy */
  {
    id: 'codex.policy.feature-flags', area: 'restricted chat policy', surface: 'CLI', name: 'features list',
    expectation: 'Every feature flag the policy disables is a flag this CLI recognises.',
    owners: [`${POLICY}#FEATURES_DISABLED`],
    feature: 'A renamed flag is silently ignored and its native tool (shell, patch, browser, sub-agents) comes back into "no tools" chats.',
    flow: 'plain chat'
  },
  {
    id: 'codex.policy.catalog-fields', area: 'restricted chat policy', surface: 'CLI', name: 'debug models --bundled',
    expectation: 'Prints `{ models: [...] }`; every model has string `slug`, `display_name` and `shell_type`, and every field the policy overwrites is still a field of the catalog.',
    owners: [`${POLICY}#CATALOG_POLICY`],
    feature: 'Restricted chats refuse ("catalog malformed"), or a new tool-selecting field is left at its native value.',
    flow: 'plain chat (policy preparation)'
  },
  {
    id: 'codex.policy.no-native-tools', area: 'restricted chat policy', surface: 'CLI', name: '-c overrides + model_catalog_json',
    expectation: 'Under the production policy the model is offered Cinna tools, MCP resource readers and `request_user_input` only — no shell, patch, image or delegation tool.',
    owners: [`${POLICY}#prepareCodexConductorPolicy`, 'src/main/agents/drivers/acp/conductorToolPolicy.ts#applyConductorToolPolicy'],
    feature: 'A plain chat can run commands and edit files on the user’s machine.',
    flow: 'plain chat'
  },
  {
    id: 'codex.policy.collaboration-mode', area: 'restricted chat policy', surface: 'ACP method', name: 'session/set_config_option collaboration_mode',
    expectation: 'Sessions expose a `collaboration_mode` config option and accept the value `default`.',
    owners: [`${POLICY}#collaboration_mode`],
    feature: 'Restricted sessions cannot be pinned to Default mode and are refused at setup.',
    flow: 'plain chat'
  },

  /* -------------------------------------------------------- provider traffic */
  {
    id: 'codex.provider.auxiliary-request', area: 'provider traffic', surface: 'provider request', name: 'POST /v1/responses (thread title, compaction)',
    expectation: 'Beyond the conversation the CLI sends exactly two kinds of request of its own. **Thread title**: once per session beside its first turn (folder, restricted chat and utility sessions alike, never again), on `gpt-5.6-luna` whatever model the session uses, strict `json_schema` output `{ title }`, carrying the user’s first message verbatim but not Cinna’s session instructions, offered no tool a restricted session is not allowed; a thread still untitled after `session/load` (the provider answered with something other than `{ title }`) is asked for again on its next turn. **Compaction**: once after a model change, on the *previous* model, with no tools, carrying the conversation so far and not the new turn’s prompt. No other request is made.',
    owners: [`${POLICY}#prepareCodexConductorPolicy`],
    feature: 'Extra provider calls on the user’s login that Cinna never asked for: the first message of every session — AI-function inputs included — also goes to a second model, and a model switch costs a full-context call on the old one. If either starts carrying native tools, the "no tools" guarantee of a restricted chat is broken through a request nobody scripted.',
    flow: 'plain chat (first turn); model switch'
  },

  /* ------------------------------------------------------------------ limits */
  {
    id: 'codex.limits.rate-limit-kind', area: 'limits', surface: '_meta key', name: '_meta.codex.threadStatus',
    expectation: 'A provider 429 ends `session/prompt` normally (`end_turn`, no error, no `errorKind`, no AIR session failure); it shows only as `_meta.codex.threadStatus.type: "systemError"` and as assistant text naming the 429.',
    owners: [`${DRIVER}#errorKind`],
    feature: 'KNOWN GAP: the driver pauses a rate-limited chat on `error.data.errorKind === "rate_limit"`, the Claude adapter’s shape, which Codex never sends — so on Codex a rate limit reads as an ordinary finished turn whose "answer" is the retry error. This entry pins what Codex does send, for whoever closes the gap.',
    flow: 'rate limit'
  }
]
