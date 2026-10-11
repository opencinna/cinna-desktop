/**
 * The Antigravity interface contract — every external interface of Google
 * Antigravity's ACP server (`agy_acp_server.par`) that Cinna relies on, one
 * named entry each.
 *
 * `codex.contract.ts`'s counterpart, on its types and its rules: an entry says
 * what the server must do (`expectation`), which Cinna code breaks when it
 * stops (`owners`), and what the user loses (`feature`). Each has exactly one
 * narrow test in `antigravity.contract.test.ts`, run against the **real pinned
 * server** with a loopback fake Gemini endpoint — the server's own `gateway`
 * auth mode, so no Google login is touched (`npm run test:contract`).
 * Antigravity has no adapter: the server speaks ACP itself.
 *
 * No Level 2 whole flow runs Antigravity yet, so every entry's `flow` is
 * `none` with that reason.
 *
 * Data only: the ratchet and the doc generator read it under a type-stripping
 * Node. A type-only import and nothing else.
 */
import type { ContractArea, ContractEntry, ContractFlow } from './codex.contract'

/** Area order for the generated doc. */
export const ANTIGRAVITY_CONTRACT_AREAS: readonly ContractArea[] = [
  'launch & env', 'auth', 'session lifecycle', 'tools & MCP', 'permissions & questions',
  'cancellation', 'models & config', 'restricted chat policy', 'provider traffic'
]

const LAUNCHER = 'src/main/agents/drivers/acp/antigravityLauncher.ts'
const ENV = 'src/main/agents/drivers/acp/antigravityEnv.ts'
const DRIVER = 'src/main/agents/drivers/acp/acpDriver.ts'
const MESSAGES = 'src/main/agents/drivers/acp/acpMessages.ts'
const POLICY = 'src/main/agents/drivers/acp/conductorToolPolicy.ts'

const NO_FLOW: ContractFlow = { steps: ['none'], note: 'no Level 2 whole flow runs Antigravity yet' }

export const ANTIGRAVITY_CONTRACT: readonly ContractEntry[] = [
  /* ------------------------------------------------------------ launch & env */
  {
    id: 'antigravity.launch.version-flag', area: 'launch & env', surface: 'CLI', name: '--version',
    expectation: 'Exits 0 and prints the binary’s build information, one line of which is `Build label: <version>`. Cinna never runs it: the resolver treats the server as versionless and the pinned sha256 is the only proof of version.',
    owners: ['src/main/engine/binaryResolver.ts#ANTIGRAVITY_SPEC', 'src/main/engine/binaryResolver.ts#versionless'],
    feature: 'Nothing today. If the flag became fatal, a resolver that started probing it would discard every install; if the label stopped matching the pin, the managed copy is not the version the contract describes.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.launch.server-args', area: 'launch & env', surface: 'CLI', name: '--uid=',
    expectation: 'On macOS the server starts with no arguments, and `--uid=` is fatal: `Unknown command line flag \'uid\'`, non-zero exit. (Linux takes `--uid=` per the ACP registry; the contract has only run on macOS.)',
    owners: [`${ENV}#antigravityServerArgs`],
    feature: 'Every Antigravity session fails to start on the platform whose arguments are wrong.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.launch.gemini-home', area: 'launch & env', surface: 'env var', name: 'GEMINI_HOME',
    expectation: 'The server reads `antigravity-acp/settings.json` from, and keeps its conversations and MCP tool schemas under, the home this variable names; unset, the home is `$HOME/.gemini`.',
    owners: [`${LAUNCHER}#antigravityIsolatedHome`, `${LAUNCHER}#prepareAntigravityHome`, `${ENV}#antigravityHome`],
    feature: 'A sealed folder would run on the user’s own `~/.gemini` — its skills and MCP servers — or lose its conversations between processes, so a chat could not be resumed.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.launch.command-cwd', area: 'launch & env', surface: 'file', name: 'Command Working Directory',
    expectation: 'The system instruction names the session’s cwd as its `Command Working Directory` when `GEMINI_HOME` is nested inside that cwd; with the home outside it (a native folder on `~/.gemini`), it names `<home>/antigravity-cli/skills` instead.',
    owners: [`${LAUNCHER}#antigravityIsolatedHome`],
    feature: 'A sealed folder’s commands and relative paths would run in the engine’s skills directory; a native folder depends on the prompt naming the folder as long as the second half holds.',
    flow: NO_FLOW
  },

  /* -------------------------------------------------------------------- auth */
  {
    id: 'antigravity.auth.methods', area: 'auth', surface: 'ACP method', name: 'initialize authMethods',
    expectation: '`initialize` advertises an auth method with id `oauth-personal` (Log in with Google) and `agentCapabilities.auth.logout`.',
    owners: ['src/main/agents/drivers/index.ts#oauth-personal', 'src/main/agents/drivers/acp/acpLogin.ts#authenticate'],
    feature: 'Log in cannot start: the `authenticate` Cinna sends names a method the server no longer offers.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.auth.required-error', area: 'auth', surface: 'ACP method', name: 'session/new -32000',
    expectation: 'In a home whose settings name no `auth.type`, `session/new` fails with `-32000` `Authentication required` (and does not open a browser).',
    owners: [`${LAUNCHER}#isAntigravityAuthError`, 'src/main/agents/drivers/acp/antigravityAuth.ts#parseAntigravityAuthType'],
    feature: 'A signed-out user gets a generic start failure instead of the Log in remedy.',
    flow: NO_FLOW
  },

  /* ------------------------------------------------------- session lifecycle */
  {
    id: 'antigravity.session.initialize', area: 'session lifecycle', surface: 'ACP method', name: 'initialize',
    expectation: 'Answers protocol version 1, advertises `agentCapabilities.loadSession: true`, and names itself `antigravity-acp` in `agentInfo`.',
    owners: [`${LAUNCHER}#ACP_PROTOCOL_VERSION`, `${DRIVER}#loadSession`],
    feature: 'No Antigravity session starts, or every turn after a restart loses the conversation.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.session.modes', area: 'session lifecycle', surface: 'ACP method', name: 'session/set_mode',
    expectation: 'A session offers the modes `default`, `auto_edit` and `yolo`, starts in `default`, and `session/set_mode` to `default` or `yolo` succeeds.',
    owners: [`${LAUNCHER}#yolo`],
    feature: 'The Approvals setting (Ask for approval / Automatic) cannot be applied; the turn is refused at setup.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.session.load', area: 'session lifecycle', surface: 'ACP method', name: 'session/load',
    expectation: 'In a new process with the same home and cwd, `session/load` replays the history and keeps the mode, but the `model` option comes back as the first model offered, so setup must re-assert it after every load. A re-asserted model reaches the next request.',
    owners: [`${LAUNCHER}#setup`, `${DRIVER}#session/load`],
    feature: 'A resumed chat silently runs on the default model instead of the one chosen for the agent.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.session.replay-raw-input', area: 'session lifecycle', surface: 'ACP field', name: 'replayed tool_call rawInput',
    expectation: 'A built-in tool call replayed by `session/load` carries `rawInput` as a JSON **string** of the call’s arguments (an MCP call’s stays an object).',
    owners: [`${MESSAGES}#rawInputOf`],
    feature: 'A resumed chat’s tool calls lose their inputs, and evidence read from them is wrong.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.session.first-prompt-instructions', area: 'session lifecycle', surface: 'ACP method', name: 'session/prompt (first)',
    expectation: 'There is no system-prompt channel: text blocks of the first `session/prompt` reach the model inside `<USER_REQUEST>` and never in the system instruction; after `session/load` they are still in the history the next request carries.',
    owners: [`${LAUNCHER}#antigravityPreamble`, `${DRIVER}#firstPromptPreamble`],
    feature: 'A folder agent loses its instructions, or a resumed chat loses them after a restart.',
    flow: NO_FLOW
  },

  /* ------------------------------------------------------------- tools & MCP */
  {
    id: 'antigravity.tool.command-output', area: 'tools & MCP', surface: 'ACP field', name: 'tool_call_update rawOutput.formatted_output',
    expectation: 'A command’s completing `tool_call_update` carries `rawOutput: { commandLine, workingDir, exitCode, exit_code, combinedOutput, formatted_output }`; the desktop stores `formatted_output` as the call’s tool_result.',
    owners: [`${MESSAGES}#formatted_output`],
    feature: 'Every Antigravity command runs with no output in the chat.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.mcp.session-injection', area: 'tools & MCP', surface: 'ACP field', name: 'session/new mcpServers',
    expectation: 'An HTTP descriptor named `cinna` is connected with its headers; its tools are not declared to the model one by one but reached through the meta-tools `call_mcp_tool`, `list_resources` and `read_resource` (declared only when an MCP server is attached), and a call reaches Cinna’s server.',
    owners: ['src/main/services/conductorMcpServer.ts#ConductorMcpServer'],
    feature: 'An Antigravity agent cannot call attached agents or Cinna’s own tools.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.mcp.tool-call-naming', area: 'tools & MCP', surface: 'ACP field', name: 'tool_call title / _meta.mcp',
    expectation: 'An MCP call is reported in one of two shapes. When it raises an ask (mode `default`): titled `<server>_<tool>`, `kind: "other"`, `rawInput: { arguments }`, `_meta: { mcp: { server, tool }, is_mcp_tool_call: true }`, and the permission request carries that same `toolCall`. When it does not (mode `yolo`): titled `Running <tool>` with the bare name, `kind: "other"`, `rawInput: {}`, no `_meta` — no server anywhere.',
    owners: [`${POLICY}#BARE_MCP_TITLE`, `${POLICY}#mcpCallOf`, `${POLICY}#cinnaToolName`, `${MESSAGES}#cinnaTool`, `${DRIVER}#isCinnaToolAsk`],
    feature: 'Cinna’s tool calls are not recognised as Cinna’s: no agent sub-thread, and the permission gate treats them as native actions — under Ask approval a conducting session’s every Cinna call surfaces an ask.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.mcp.result-not-delivered', area: 'tools & MCP', surface: 'ACP field', name: 'MCP tool_call_update rawOutput',
    expectation: 'An MCP tool’s result never reaches the client: the completing update’s `rawOutput` (and `content` text, when present) is the model’s own `toolSummary`. The result goes to the model only, so the desktop shows a completed MCP call with no output.',
    owners: [`${MESSAGES}#isAntigravityMcpCall`],
    feature: 'The chat would show the model’s one-line summary as a Cinna tool call’s result, as if the tool had returned it.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.mcp.list-changed', area: 'tools & MCP', surface: 'MCP request', name: 'tool added mid-session',
    expectation: 'A tool Cinna’s server lists only after the session started is callable through `call_mcp_tool` on the next turn; the session’s tool list is not fixed at creation.',
    owners: ['src/main/agents/drivers/acp/acpLaunchers.ts#sessionToolsFixed'],
    feature: 'If this flips, a specialist attached mid-chat is never callable on Antigravity until its launcher sets `sessionToolsFixed`.',
    flow: NO_FLOW
  },

  /* ------------------------------------------------- permissions & questions */
  {
    id: 'antigravity.permission.execute-ask', area: 'permissions & questions', surface: 'ACP method', name: 'session/request_permission (execute)',
    expectation: 'In mode `default` a command raises an ask with `toolCall.kind: "execute"`, the command line as title, `rawInput: { CommandLine, Cwd, WaitMsBeforeAsync }`, and options `allow_always` (kind `allow_always`, with `_meta["agy.security.warning"]`), `allow` (`allow_once`) and `deny` (`reject_once`). Selecting `allow` runs it under the same id.',
    owners: ['src/main/agents/drivers/acp/acpPermissions.ts#CommandLine', 'src/main/agents/drivers/acp/acpPermissions.ts#pickPermissionOption'],
    feature: 'A command ask cannot be answered, or a grant for one command in one folder stops matching.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.permission.edit-ask', area: 'permissions & questions', surface: 'ACP method', name: 'session/request_permission (edit)',
    expectation: 'Creating a file raises an ask with `kind: "edit"`, title `Run create_file?`, a `diff` content block and `locations`, and only the options `allow` / `deny`. Once allowed, the write runs under **another** id (`<sessionId>:<n>`, `Running edit_file`) and the ask’s own id later ends `failed` with `rawOutput: "Tool call was approved but never executed."`.',
    owners: [`${MESSAGES}#ANTIGRAVITY_UNEXECUTED`, 'src/main/agents/drivers/acp/acpPermissions.ts#locations'],
    feature: 'Every approved edit leaves a failed card in the chat beside the one that succeeded.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.question.permission-shaped', area: 'permissions & questions', surface: 'ACP method', name: 'ask_question / session/request_permission',
    expectation: 'The built-in `ask_question` raises no `elicitation/create`: it arrives as a permission request whose `toolCallId` is `interaction_<hex>`, whose title is the question and whose options are the answers (`optionId` "1", "2"…, all `allow_once`); the selected option reaches the model as its answer.',
    owners: ['src/main/agents/drivers/acp/acpQuestions.ts#permissionAsQuestion', 'src/main/agents/drivers/acp/acpQuestions.ts#permissionQuestionAnswer', `${DRIVER}#answerPermissionQuestion`],
    feature: 'A question shows as an Allow/Deny ask whose buttons say nothing, and the model gets no answer.',
    flow: NO_FLOW
  },

  /* ------------------------------------------------------------ cancellation */
  {
    id: 'antigravity.cancel.model-request', area: 'cancellation', surface: 'ACP method', name: 'session/cancel',
    expectation: 'A cancel during a model request ends `session/prompt` with `stopReason: "cancelled"` within seconds, after an agent message `The request was cancelled by the client.`',
    owners: [`${DRIVER}#session/cancel`],
    feature: 'Stop leaves the turn running until the ceiling, holding the agent’s turn lock.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.cancel.running-command', area: 'cancellation', surface: 'ACP method', name: 'session/cancel (command running)',
    expectation: 'A cancel while a command runs ends `session/prompt` with `cancelled` within seconds, ends the call `failed`, and the command is stopped: its effect never happens.',
    owners: [`${DRIVER}#session/cancel`],
    feature: 'Stop would wait for a long command to finish, and a stopped turn would keep changing the folder behind the user’s back.',
    flow: NO_FLOW
  },

  /* --------------------------------------------------------- models & config */
  {
    id: 'antigravity.config.model-option', area: 'models & config', surface: 'ACP method', name: 'session/set_config_option model',
    expectation: 'The `model` config option offers the session’s models (in gateway mode exactly `AGY_LLM_GATEWAY_MODELS`, first one current), and setting it moves the next request to that model — the thinking level stripped from the id in the request path.',
    owners: [`${LAUNCHER}#configOptions`],
    feature: 'The model chosen for an agent has no effect.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.telemetry.usage-update', area: 'models & config', surface: 'ACP field', name: 'usage_update',
    expectation: 'Each model call is followed by `usage_update { used, size }` (no `cost`), and a prompt answers with its `stopReason` alone — no `usage`, no `_meta`.',
    owners: ['src/main/agents/drivers/acp/acpTelemetry.ts#parsePromptTelemetry', `${MESSAGES}#usageFrame`],
    feature: 'The context meter stays empty for Antigravity chats.',
    flow: NO_FLOW
  },

  /* -------------------------------------------------- restricted chat policy */
  {
    id: 'antigravity.policy.builtin-tools', area: 'restricted chat policy', surface: 'provider request', name: 'functionDeclarations',
    expectation: 'With no filter and no MCP server, the functions declared to the model are exactly `ANTIGRAVITY_BUILTIN_TOOLS`.',
    owners: [`${LAUNCHER}#ANTIGRAVITY_BUILTIN_TOOLS`],
    feature: 'A built-in a later server adds is invisible to the list the policy and the docs are written from.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.policy.filter-names', area: 'restricted chat policy', surface: '_meta key', name: '_meta.agy.disabledTools',
    expectation: 'The filter names are the server’s `BuiltinTools` values (`ANTIGRAVITY_FILTER_TOOLS`), not the declared function names: `start_subagent` removes `define_subagent`, `invoke_subagent`, `manage_subagents` and `send_message`; `create_file` + `edit_file` remove `write_to_file` and `replace_file_content`; a declared name such as `send_message` is rejected (logged) and removes nothing; all of `ANTIGRAVITY_FILTER_TOOLS` together leave no built-in declared. The launcher’s sealed-folder denylist (`schedule`, `start_subagent`) removes exactly `schedule` and the subagent and messaging functions.',
    owners: [`${LAUNCHER}#ANTIGRAVITY_FILTER_TOOLS`, `${LAUNCHER}#ANTIGRAVITY_ISOLATED_DISABLED_TOOLS`, `${POLICY}#applyConductorToolPolicy`],
    feature: 'A sealed folder keeps the engine’s own scheduler, subagents and messaging beside Cinna’s, or a plain chat’s denylist names tools the server ignores.',
    flow: NO_FLOW
  },
  {
    id: 'antigravity.policy.conductor-tools', area: 'restricted chat policy', surface: '_meta key', name: '_meta.agy.enabledTools',
    expectation: 'Under the chat policy (`enabledTools: ["view_file"]`) the model is offered exactly `view_file`, `call_mcp_tool`, `list_resources` and `read_resource`; `view_file` reads a Cinna tool’s schema file in the home and is denied a file outside the workspace; Cinna’s tool calls still go through.',
    owners: [`${POLICY}#applyConductorToolPolicy`, `${POLICY}#ANTIGRAVITY_CONDUCTOR_TOOLS`],
    feature: 'A plain chat on Antigravity can run commands and edit files on the user’s machine, or calls Cinna’s tools blind.',
    flow: NO_FLOW
  },

  /* -------------------------------------------------------- provider traffic */
  {
    id: 'antigravity.provider.requests', area: 'provider traffic', surface: 'provider request', name: 'POST /v1beta/models/<model>:streamGenerateContent',
    expectation: 'Every model request is `POST /v1beta/models/<model>:streamGenerateContent?alt=sse` for the conversation itself: the server sends no request of its own (no title, no summary, no token count).',
    owners: [`${POLICY}#applyConductorToolPolicy`],
    feature: 'Extra model calls on the user’s Google login that Cinna never asked for; one carrying native tools would break a plain chat’s “no tools” guarantee.',
    flow: NO_FLOW
  }
]
