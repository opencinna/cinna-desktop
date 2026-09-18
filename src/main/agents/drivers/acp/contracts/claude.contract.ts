/**
 * The Claude Code interface contract — every external interface of the Claude
 * Code CLI and its ACP adapter that Cinna relies on, one named entry each.
 *
 * `codex.contract.ts`'s counterpart, on its types and its rules: an entry says
 * what the tool must do (`expectation`), which Cinna code breaks when it stops
 * (`owners`), and what the user loses (`feature`). Each has exactly one narrow
 * test in `claude.contract.test.ts`, run against the **real pinned binary** and
 * the real adapter with a loopback fake Anthropic endpoint
 * (`npm run test:contract`). An entry that cannot be exercised that way carries
 * `live` and the reason; its test is skipped, not faked.
 *
 * Data only: the ratchet and the doc generator read it under a type-stripping
 * Node. A type-only import and nothing else.
 */
import type { ContractArea, ContractEntry } from './codex.contract'

/** Area order for the generated doc. No `restricted chat policy`-only tooling: Claude's policy is one option. */
export const CLAUDE_CONTRACT_AREAS: readonly ContractArea[] = [
  'launch & env', 'auth', 'session lifecycle', 'tools & MCP', 'permissions & questions',
  'cancellation', 'restricted chat policy', 'provider traffic', 'limits'
]

const LAUNCHERS = 'src/main/agents/drivers/acp/acpLaunchers.ts'
const DRIVER = 'src/main/agents/drivers/acp/acpDriver.ts'
const AUTH = 'src/main/agents/drivers/acp/claudeAuth.ts'
const POLICY = 'src/main/agents/drivers/acp/conductorToolPolicy.ts'
const MCP_SERVER = 'src/main/services/conductorMcpServer.ts'

export const CLAUDE_CONTRACT: readonly ContractEntry[] = [
  /* ------------------------------------------------------------ launch & env */
  {
    id: 'claude.launch.version-output', area: 'launch & env', surface: 'CLI', name: '--version',
    expectation: 'Prints exactly `<version> (Claude Code)` on stdout and exits 0.',
    owners: ['src/main/engine/binaryResolver.ts#CLAUDE_SPEC'],
    feature: 'The managed install is discarded as the wrong version, and an up-to-date install of the user’s own is never reused.',
    flow: 'first Claude turn (install)'
  },
  {
    id: 'claude.launch.executable', area: 'launch & env', surface: 'env var', name: 'CLAUDE_CODE_EXECUTABLE',
    expectation: 'The adapter runs the executable this variable names, not the `claude` its own SDK dependency bundles.',
    owners: [`${LAUNCHERS}#CLAUDE_CODE_EXECUTABLE`],
    feature: 'Sessions run on an unpinned Claude Code — or none at all in the packaged app, which excludes the bundled copy.',
    flow: 'plain chat'
  },
  {
    id: 'claude.launch.child-env', area: 'launch & env', surface: 'env var', name: 'PATH / HOME / USER',
    expectation: 'A session starts and completes a turn on the narrowed child environment alone: PATH, USER, LOGNAME, SHELL and HOME, plus what the launcher adds.',
    owners: ['src/main/agents/drivers/acp/claudeEnv.ts#buildClaudeEnv'],
    feature: 'Every Claude turn fails at start, or runs with variables the desktop meant to withhold.',
    flow: 'plain chat'
  },
  {
    id: 'claude.launch.autoupdater-disabled', area: 'launch & env', surface: 'env var', name: 'DISABLE_AUTOUPDATER',
    expectation: 'With `DISABLE_AUTOUPDATER=1` the CLI’s background updater never runs: a Cinna-spawned process does not download a newer Claude Code or retarget `~/.local/bin/claude`.',
    owners: ['src/main/agents/drivers/acp/claudeEnv.ts#buildClaudeEnv', 'src/main/agents/drivers/acp/claudeEnv.ts#AUTOUPDATER_ENV'],
    feature: 'A desktop session silently moves the user’s own `claude` to another version, and a pooled adapter’s next spawn runs a version that never passed the pin gate.',
    flow: 'live flow: a long session on the user’s own install',
    live: 'Nothing differs in a contract run. Probed 2026-09-18 on 2.1.276 behind the egress trap: `claude update` contacts `downloads.claude.ai` with or without the variable (it governs the *background* updater, not the command), and a non-interactive session never checks for an update either way — the updater belongs to the long-lived interactive process, under a real install layout.'
  },
  /* -------------------------------------------------------------------- auth */
  {
    id: 'claude.auth.status-json', area: 'auth', surface: 'CLI', name: 'auth status',
    expectation: 'Prints a JSON object with a boolean `loggedIn` and a string `authMethod`; with no login it reports `loggedIn: false`, `authMethod: "none"`. `orgId`/`orgName`, when present, are extra keys.',
    owners: [`${AUTH}#parseClaudeAuthStatus`, `${AUTH}#probeClaudeAuth`],
    feature: 'Readiness cannot tell a logged-out install from a working one: the panel stops naming the login, and a logged-out agent fails at its first turn instead of being told to log in.',
    flow: 'agent page opens'
  },
  {
    id: 'claude.auth.login-follows-home', area: 'auth', surface: 'file', name: 'HOME (Keychain / ~/.claude)',
    expectation: 'A second Claude Code binary, run with the user’s real HOME and USER, reports the same subscription login as their own install, with no Keychain prompt.',
    owners: ['src/main/agents/drivers/index.ts#claudeAuthProbe', 'src/main/agents/drivers/acp/claudeEnv.ts#buildClaudeEnv'],
    feature: 'The managed CLI is logged out on a machine whose user is logged in: every Claude agent stops until they log in a second time.',
    flow: 'live flow: first turn on the managed binary',
    live: 'Needs the user’s real subscription login and Keychain entry; an isolated HOME has neither. Verified by hand 2026-09-18 (2.1.266 from node_modules reported the 2.1.276 install’s Max login).'
  },
  /* ------------------------------------------------------- session lifecycle */
  {
    id: 'claude.session.initialize', area: 'session lifecycle', surface: 'ACP method', name: 'initialize',
    expectation: 'Answers protocol version 1 as `@agentclientprotocol/claude-agent-acp` at the pinned version, with `loadSession: true`, HTTP MCP capability, and the AIR capabilities `asyncTasks` and `nativeSubagentSessions`.',
    owners: [`${LAUNCHERS}#createClaudeLauncher`],
    feature: 'Sessions cannot be resumed, injected MCP servers are refused, or background work and subagents stop being reported.',
    flow: 'plain chat'
  },
  {
    id: 'claude.session.options-system-prompt', area: 'session lifecycle', surface: '_meta key', name: '_meta.claudeCode.options.systemPrompt',
    expectation: 'A string `systemPrompt` replaces the `claude_code` preset: it reaches the model as the system prompt, and the preset’s coding-assistant text does not.',
    owners: [`${LAUNCHERS}#systemPrompt`],
    feature: 'A folder agent answers as a generic coding assistant instead of as itself; an AI function loses its instructions.',
    flow: 'plain chat'
  },
  {
    id: 'claude.session.options-setting-sources', area: 'session lifecycle', surface: '_meta key', name: '_meta.claudeCode.options.settingSources',
    expectation: '`settingSources: []` keeps a project `CLAUDE.md` out of the session; `["user","project","local"]` brings it in.',
    owners: [`${LAUNCHERS}#settingSources`],
    feature: 'An isolated agent picks up a repository’s instructions, or a native folder loses its own.',
    flow: 'native folder chat'
  },
  {
    id: 'claude.session.options-agents', area: 'session lifecycle', surface: '_meta key', name: '_meta.claudeCode.options.agents',
    expectation: 'Subagent definitions passed as `agents` are offered to the model under their names, with `settingSources: []`.',
    owners: [`${LAUNCHERS}#agents`, 'src/main/agents/drivers/acp/claudeAgents.ts#readFolderAgents'],
    feature: 'A kit folder’s own subagents silently disappear from its sealed session.',
    flow: 'folder agent with subagents'
  },
  {
    id: 'claude.session.set-mode', area: 'session lifecycle', surface: 'ACP method', name: 'session/set_mode',
    expectation: '`default` and `auto` are both accepted modes, and `session/new` reports the session’s `currentModeId`.',
    owners: [`${LAUNCHERS}#modeId`],
    feature: 'The desktop’s approval choice cannot be applied: an agent set to ask runs unasked, or the reverse.',
    flow: 'plain chat'
  },
  {
    id: 'claude.session.permission-mode-meta-inert', area: 'session lifecycle', surface: '_meta key', name: '_meta.claudeCode.options.permissionMode',
    expectation: '`permissionMode` in the session options is **ignored**: a session created with `bypassPermissions` there still starts in `default`. `session/set_mode` is the only mechanism.',
    owners: [`${LAUNCHERS}#session/set_mode`],
    feature: 'Pinned in both directions. If a release starts honouring it, the `set_mode`-after-every-new-and-load rule can be simplified; until then "simplifying" it hands a folder its own permission mode.',
    flow: 'plain chat'
  },
  {
    id: 'claude.session.load-replay', area: 'session lifecycle', surface: 'ACP method', name: 'session/load',
    expectation: 'Loading a session by id succeeds and replays its history as `user_message_chunk`, `agent_message_chunk` and `tool_call` updates; the next prompt continues the same conversation.',
    owners: [`${DRIVER}#session/load`],
    feature: 'A chat loses its context after the agent’s process is reaped or the app restarts.',
    flow: 'continuity (second turn after restart)'
  },
  {
    id: 'claude.session.costed-usage-ends-turn', area: 'session lifecycle', surface: 'ACP field', name: 'usage_update.cost',
    expectation: 'Every turn ends with a `usage_update` that carries `cost`.',
    owners: [`${LAUNCHERS}#endsTurnsWithCostedUsage`, 'src/main/agents/drivers/acp/acpFollowUp.ts#usage_update'],
    feature: 'A follow-up turn the engine starts on its own never ends until the ceiling, leaving the chat "working".',
    flow: 'background task follow-up'
  },
  /* -------------------------------------------------------------- tools & MCP */
  {
    id: 'claude.mcp.session-injection', area: 'tools & MCP', surface: 'ACP field', name: 'session/new.mcpServers (http)',
    expectation: 'An HTTP MCP server passed in `session/new.mcpServers`, with its Authorization header, is connected and its tools are offered to the model — under `strictMcpConfig: true` and `mcpServers: {}` in the options.',
    owners: [`${LAUNCHERS}#strictMcpConfig`, `${LAUNCHERS}#newSessionParams`],
    feature: 'A chat’s specialists and Cinna tools never reach the model: the conductor can talk but not act.',
    flow: 'specialist attached'
  },
  {
    id: 'claude.mcp.tool-naming', area: 'tools & MCP', surface: 'provider request', name: 'mcp__<server>__<tool>',
    expectation: 'A tool `probe` of the server named `cinna` is offered to the model as `mcp__cinna__probe`.',
    owners: [`${POLICY}#mcp__cinna__`, `${POLICY}#cinnaToolName`],
    feature: 'Cinna’s own tool calls are not recognised as such: no specialist card, no correlation, wrong permission scope.',
    flow: 'tool call'
  },
  {
    id: 'claude.mcp.tool-name-meta', area: 'tools & MCP', surface: '_meta key', name: '_meta.claudeCode.toolName',
    expectation: 'Every `tool_call` and `tool_call_update` for a tool carries the model-facing tool name in `_meta.claudeCode.toolName`.',
    owners: ['src/main/services/conductorToolCorrelation.ts#toolName'],
    feature: 'A tool call in the transcript cannot be tied to the Cinna call it caused; handover cards detach from their turn.',
    flow: 'tool call'
  },
  {
    id: 'claude.mcp.tool-use-id', area: 'tools & MCP', surface: 'MCP request', name: '_meta["claudecode/toolUseId"]',
    expectation: 'The MCP `tools/call` request carries the model’s `tool_use` id in `_meta["claudecode/toolUseId"]`, equal to the ACP `toolCallId` of the same call.',
    owners: [`${MCP_SERVER}#claudecode/toolUseId`],
    feature: 'The MCP side and the ACP side of one call get different ids, so a result lands on the wrong card or on none.',
    flow: 'tool call'
  },
  {
    id: 'claude.mcp.list-changed-adopted', area: 'tools & MCP', surface: 'MCP request', name: 'notifications/tools/list_changed',
    expectation: 'A tool added to a connected server mid-session, announced with `tools/list_changed`, is offered to the model on the **next** request of the same session.',
    owners: [`${MCP_SERVER}#refreshTools`, `${LAUNCHERS}#sessionToolsFixed`],
    feature: 'Pinned in both directions — the opposite of Codex. If a release stops adopting it, a specialist attached mid-chat is never callable, and the Claude launcher needs `sessionToolsFixed` too.',
    flow: 'specialist attached mid-chat'
  },
  /* ----------------------------------------------------- permissions & questions */
  {
    id: 'claude.permission.request-shape', area: 'permissions & questions', surface: 'ACP method', name: 'session/request_permission',
    expectation: 'In `default` mode an MCP tool call asks first: `toolCall.toolCallId`/`name`/`rawInput`, and options of kind `allow_once`, `allow_always` and `reject_once`. Answering `allow_once` runs the call once.',
    owners: ['src/main/agents/drivers/acp/acpPermissions.ts#allow_once', 'src/main/agents/drivers/acp/acpPermissions.ts#request_permission'],
    feature: 'Approvals stop appearing, or appear with no way to answer: the agent acts unasked or hangs on every tool.',
    flow: 'tool call'
  },
  {
    id: 'claude.question.elicitation-form', area: 'permissions & questions', surface: 'ACP method', name: 'elicitation/create (form)',
    expectation: 'With `elicitation.form` advertised, `AskUserQuestion` is offered to the model and a call to it arrives as `elicitation/create` in `form` mode, one `question_<n>` property per question with its options as `oneOf`; the accepted answer goes back to the model as the tool result.',
    owners: ['src/main/agents/drivers/acp/acpQuestions.ts#requestedSchema', `${LAUNCHERS}#elicitation`],
    feature: 'An agent can no longer ask the user anything: the tool is withdrawn, or its question never reaches the chat.',
    flow: 'agent asks a question'
  },
  /* ------------------------------------------------------------ cancellation */
  {
    id: 'claude.cancel.reaches-mcp-call', area: 'cancellation', surface: 'ACP method', name: 'session/cancel → notifications/cancelled',
    expectation: '`session/cancel` during an MCP tool call ends the prompt with `stopReason: "cancelled"` within seconds **and** cancels the in-flight MCP request, so the server’s handler sees its signal abort.',
    owners: [`${DRIVER}#session/cancel`, `${MCP_SERVER}#signal`],
    feature: 'Stop ends the chat’s turn but the specialist it called keeps running — and keeps spending — with nothing attached to it.',
    flow: 'stop during a specialist call'
  },
  /* -------------------------------------------------- restricted chat policy */
  {
    id: 'claude.policy.no-native-tools', area: 'restricted chat policy', surface: '_meta key', name: '_meta.claudeCode.options.tools: []',
    expectation: '`tools: []` yields a request with **no native tool at all** — no Bash, Read, Write, Agent or WebFetch — and only the injected MCP tools; without it the full native set is offered.',
    owners: [`${POLICY}#applyConductorToolPolicy`],
    feature: 'A plain chat or an AI function can read and write the user’s files and run commands, in a session the UI presents as unable to.',
    flow: 'plain chat'
  },
  /* -------------------------------------------------------- provider traffic */
  {
    id: 'claude.provider.base-url', area: 'provider traffic', surface: 'env var', name: 'ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY',
    expectation: 'Every Messages request goes to `POST <base>/v1/messages` with the given key as `x-api-key`. **This is what the whole contract stands on**: red here means no other entry was really checked.',
    owners: ['src/main/agents/drivers/acp/contracts/claudeHarness.ts#ANTHROPIC_BASE_URL'],
    feature: 'Nothing in the product — Cinna strips these variables from a real session. The contract run would silently stop being hermetic.',
    flow: 'none (test infrastructure)'
  },
  {
    id: 'claude.provider.auxiliary-request', area: 'provider traffic', surface: 'provider request', name: 'session title',
    expectation: 'The CLI’s only request of its own is a **session title**: system prompt opening "You are naming a coding…", the session’s text inside `<session>…</session>`, no tools, on the conversation’s model. It is sent beside the first prompt — carrying the user’s first message — and again after turns. No compaction or other request appears in a short session.',
    owners: ['src/main/agents/drivers/acp/contracts/claudeHarness.ts#isClaudeTitleRequest'],
    feature: 'Characterised, not depended on: a user’s first message is sent a second time, on their subscription, for a title Cinna does not show. A new kind of request appearing here is a cost and privacy change worth a line in the release notes.',
    flow: 'plain chat'
  },
  {
    id: 'claude.provider.no-real-egress', area: 'provider traffic', surface: 'network', name: 'api.anthropic.com',
    expectation: 'With `ANTHROPIC_BASE_URL` set the CLI **still tries `api.anthropic.com`** on its own. Every attempt the CLI routed through `HTTPS_PROXY` was to `api.anthropic.com:443` and was refused before TLS; the dummy key never left the loopback endpoint. The trap sees proxy-honouring traffic only — it is a record of what the CLI sends through its HTTP stack, not a firewall.',
    owners: ['src/main/agents/drivers/acp/contracts/claudeHarness.ts#startEgressTrap'],
    feature: 'A contract run would make real requests to the vendor. A new host appearing here is a new place the CLI sends something.',
    flow: 'none (test infrastructure)'
  },
  /* ------------------------------------------------------------------ limits */
  {
    id: 'claude.limits.rate-limit-kind', area: 'limits', surface: 'ACP field', name: 'error.data.errorKind',
    expectation: 'A provider 429 (`rate_limit_error`) fails the prompt with a JSON-RPC error whose `data.errorKind` is `"rate_limit"`.',
    owners: [`${DRIVER}#errorKind`, `${DRIVER}#rate_limit`],
    feature: 'A rate-limited conductor is reported as a generic failure and retried at once, instead of pausing until the limit lifts.',
    flow: 'rate-limited turn'
  },
  {
    id: 'claude.limits.subscription-limit', area: 'limits', surface: 'ACP field', name: 'error.data.errorKind (subscription)',
    expectation: 'Reaching a **subscription** usage limit is reported with the same `errorKind: "rate_limit"` as an API 429.',
    owners: [`${DRIVER}#rate_limit`],
    feature: 'A Max or Pro user who runs out of quota sees a raw error and an immediate retry loop.',
    flow: 'live flow: not reproducible on demand',
    live: 'A subscription limit is produced by the vendor’s servers for a logged-in account; a fake endpoint can only return an API-key 429, which `claude.limits.rate-limit-kind` covers.'
  }
]
