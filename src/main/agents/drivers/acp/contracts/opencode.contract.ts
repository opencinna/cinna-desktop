/**
 * The OpenCode interface contract — every external interface of `opencode acp`
 * that Cinna relies on, one named entry each. OpenCode speaks ACP itself: there
 * is no adapter.
 *
 * Same terms as `codex.contract.ts`, whose entry types it uses: an entry says
 * what the binary must do (`expectation`), which Cinna code breaks when it
 * stops (`owners`), and what the user loses (`feature`). Each has exactly one
 * narrow test in `opencode.contract.test.ts`, run against the **real pinned
 * binary** with a loopback fake OpenAI-compatible provider, the config and
 * environment the production launcher writes (`npm run test:contract`).
 *
 * Cinna drives OpenCode 2 only (the resolver refuses a 1.x binary), so every
 * expectation is the 2.x line's.
 *
 * Data only, on purpose: the ratchet and `scripts/generate-contract-docs.mjs`
 * read it under a type-stripping Node. No imports but types, no enums.
 */
import type { ContractArea, ContractEntry, ContractFlow } from './codex.contract'

/** Area order for the generated doc. */
export const OPENCODE_CONTRACT_AREAS: readonly ContractArea[] = [
  'launch & env', 'session lifecycle', 'tools & MCP', 'permissions & questions', 'provider traffic'
]

const LAUNCHERS = 'src/main/agents/drivers/acp/acpLaunchers.ts'
const DRIVER = 'src/main/agents/drivers/acp/acpDriver.ts'
const CONFIG = 'src/main/engine/configGenerator.ts'
const POLICY = 'src/main/agents/drivers/acp/conductorToolPolicy.ts'
const RESOLVER = 'src/main/engine/binaryResolver.ts'

/** No Level 2 whole flow runs OpenCode: its end-to-end check is the billed live specs. */
const NO_FLOW: ContractFlow = { steps: ['none'], note: 'no Level 2 flow runs OpenCode; the billed live specs (`e2e/specs/live*.spec.ts`) cover it end to end' }

export const OPENCODE_CONTRACT: readonly ContractEntry[] = [
  /* ------------------------------------------------------------ launch & env */
  {
    id: 'opencode.launch.version-output', area: 'launch & env', surface: 'CLI', name: '--version',
    expectation: 'Prints `opencode v<version>` on stdout and exits 0; `opencodeMajorVersion` reads 2 from it, and the pinned binary prints exactly the pin’s `versionOutput`.',
    owners: ['src/shared/engine.ts#opencodeMajorVersion', `${RESOLVER}#acceptsVersion`],
    feature: 'Every managed install is discarded as the wrong version, or a configured 2.x is refused as 1.x.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.launch.personal-skills', area: 'launch & env', surface: 'file', name: 'opencode.json plugins: -opencode.config.compatibility',
    expectation: 'With the launcher’s generated config, a session’s model request lists the kit skill from `skills.paths` and none of `~/.claude/skills`, `~/.agents/skills` or `~/.claude/CLAUDE.md` from the sandbox HOME; the same config with `plugins: []` lists both personal skills, so their absence is the plugin entry’s doing. 2.0.27 sends `~/.claude/CLAUDE.md` in neither session (the snapshot’s `personalWithoutPluginEntry`), so its absence proves nothing about the plugin.',
    owners: [`${LAUNCHERS}#OPENCODE_NO_COMPATIBILITY_PLUGIN`, `${CONFIG}#skillPaths`],
    feature: 'A Cinna agent silently picks up the user’s personal Claude Code skills and instructions, and an agent shared with a team behaves differently on each member’s machine.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.launch.database', area: 'launch & env', surface: 'env var', name: 'OPENCODE_DB',
    expectation: 'The session database (`opencode.db`, with its `-wal`/`-shm`) is created at the absolute `OPENCODE_DB` the launcher sets, and none is created under XDG data (`$XDG_DATA_HOME/opencode/`).',
    owners: [`${LAUNCHERS}#OPENCODE_DB`, `${LAUNCHERS}#opencodeDatabasePath`],
    feature: 'Cinna’s sessions are written into, and migrate, the user’s own OpenCode database.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.launch.database-first-start', area: 'launch & env', surface: 'CLI', name: 'acp (first starts on a missing OPENCODE_DB)',
    expectation: 'Several `acp` planned together by the launcher on an `OPENCODE_DB` that does not exist yet, and started at once, reach `session/new`: the launcher first creates the database with one `acp` stopped once it has answered `initialize`. Without it 2.0.27’s schema bootstrap races and the losers exit with “Standalone server exited before reporting readiness”. No start is lost: concurrent starts still die now and then on `database is locked` at open, and the launcher’s `earlyExitRetry` starts such a process again (up to three spawns, within the start timeout).',
    owners: [`${LAUNCHERS}#ensureOpencodeDatabase`, `${LAUNCHERS}#bootstrapOpencodeAcp`, `${LAUNCHERS}#OPENCODE_EARLY_EXIT_RETRY`],
    feature: 'The first autorun or delegation burst after an upgrade (or on a new install) loses turns at spawn.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.launch.process-tree', area: 'launch & env', surface: 'CLI', name: 'acp (process tree)',
    expectation: 'Signalling the `acp` process alone, with SIGTERM and with SIGKILL, ends it and leaves no descendant alive. It runs one child, `serve --stdio`, in a process group of its own, which the group kill does not reach — it exits because its parent went.',
    owners: ['src/main/agents/drivers/acp/acpConnection.ts#killTree'],
    feature: 'Stop, a pool eviction or quitting the app leaves an engine server running per chat, holding its session database open.',
    flow: NO_FLOW
  },

  /* ------------------------------------------------------- session lifecycle */
  {
    id: 'opencode.session.initialize', area: 'session lifecycle', surface: 'ACP method', name: 'initialize',
    expectation: 'Answers protocol version 1 with `loadSession: true`, `mcpCapabilities.http: true` and `mcpCapabilities.sse: false`, so Cinna’s session server must stay `type: "http"`.',
    owners: [`${LAUNCHERS}#ACP_PROTOCOL_VERSION`, "src/main/services/conductorMcpServer.ts#type: 'http'"],
    feature: 'No OpenCode session starts, a resumed chat loses its conversation, or Cinna’s MCP server is never connected.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.session.config-options', area: 'session lifecycle', surface: 'ACP field', name: 'session/new configOptions',
    expectation: '`session/new` answers `sessionId` and `configOptions` holding the select options `mode`, `model` and `effort` (category `thought_level`).',
    owners: [`${LAUNCHERS}#configOptions`, 'src/main/agents/drivers/acp/acpMessages.ts#selectedModelOf'],
    feature: 'The agent’s definition cannot be selected, and the session runs OpenCode’s stock coding agent in the user’s folder.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.session.set-config-option', area: 'session lifecycle', surface: 'ACP method', name: 'session/set_config_option mode, model',
    expectation: 'Setting `mode` to the agent key `buildEngineConfig` named, then `model` to `<provider>/<model>`, both succeed and answer `configOptions`.',
    owners: [`${LAUNCHERS}#configId: 'mode'`, `${LAUNCHERS}#configId: 'model'`],
    feature: 'The turn is refused at setup, or runs on another agent or model than the folder chose.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.session.system-prompt', area: 'session lifecycle', surface: 'provider request', name: 'agent prompt → system message',
    expectation: 'Once `mode` selects the agent, its `prompt` from the generated config arrives in the provider request’s system messages.',
    owners: [`${CONFIG}#buildEngineConfig`],
    feature: 'A folder agent runs without its instructions.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.session.load-replay', area: 'session lifecycle', surface: 'ACP method', name: 'session/load',
    expectation: 'In a fresh process, `session/load` of a session the previous process created succeeds, replays its history as `session/update`s (user, agent, thought and tool updates), and the next prompt’s request carries the earlier turns.',
    owners: [`${DRIVER}#session/load`],
    feature: 'A chat resumed after an app restart or a process eviction starts from nothing.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.session.load-unknown', area: 'session lifecycle', surface: 'ACP method', name: 'session/load (unknown session)',
    expectation: 'In a process on another database, `session/load` of a session id it has never seen answers a JSON-RPC error, promptly, and replays nothing — the driver then starts a fresh session.',
    owners: [`${DRIVER}#the remembered ACP session was gone`],
    feature: 'A chat whose session lives in another database (the user’s shared one, before Cinna had its own) hangs or errors at its first turn instead of starting fresh.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.session.thought-message-id', area: 'session lifecycle', surface: 'ACP field', name: 'agent_thought_chunk.messageId',
    expectation: 'A streamed reasoning summary arrives as `agent_thought_chunk`; it and the reply’s `agent_message_chunk` both carry the message id (`msg_…`).',
    owners: ['src/main/agents/drivers/acp/acpMessages.ts#agent_thought_chunk'],
    feature: 'Thinking is filed under message keys of its own; the turn’s parts are flattened in arrival order, so a change here shows as split or reordered thinking in the transcript.',
    flow: NO_FLOW
  },

  /* ------------------------------------------------------------ tools & MCP */
  {
    id: 'opencode.mcp.session-tool', area: 'tools & MCP', surface: 'ACP field', name: 'session/new mcpServers (Cinna’s server)',
    expectation: 'Cinna’s server, given as a session `mcpServers` http entry, is reachable. The model sees only Code Mode’s `execute`; its code’s `tools["cinna"].<tool>()` call runs with no ask under the generated profile, and the completed update names it in `rawOutput.metadata.toolCalls`.',
    owners: [`${POLICY}#isCodeModeCall`, `${POLICY}#codeModeCinnaTools`, `${CONFIG}#CINNA_TOOL_PERMISSIONS`],
    feature: 'Delegation, handover and every chat MCP tool are unreachable from an OpenCode agent, or each call asks the user twice.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.mcp.connect-timing', area: 'tools & MCP', surface: 'MCP request', name: 'tools/list after session/new',
    expectation: 'A session’s MCP tools are not usable by a first prompt sent the moment `session/new` and its setup have answered — that prompt’s `execute` gets `Unknown tool \'cinna.probe\'` — and they are once Cinna’s server has answered the session’s `tools/list` and the launcher’s settle time has passed.',
    owners: [`${LAUNCHERS}#OPENCODE_MCP_SETTLE_MS`, `${DRIVER}#awaitCinnaTools`, 'src/main/services/conductorMcpServer.ts#toolsListed'],
    feature: 'The first turn of a chat cannot call Cinna’s tools: a coordinator says it will ask a specialist and never does.',
    flow: NO_FLOW
  },

  /* ------------------------------------------------- permissions & questions */
  {
    id: 'opencode.permission.profile-patterns', area: 'permissions & questions', surface: 'file', name: 'agent permission profile (bash, read)',
    expectation: 'Under the conversation profile a shell `ls` runs without an ask and `cat .env` raises one (the secret-file patterns): the config’s `bash` map governs the `shell` tool. A `read` of `.env` (2.x’s `path` argument) is denied by the `read` map without an ask, and the value never reaches the model, while the same `read` of a file no pattern names completes.',
    owners: [`${CONFIG}#CONVERSATION_PERMISSIONS`, `${CONFIG}#SECRET_FILES`],
    feature: 'A pattern that misses fails open: an agent reads a secret without asking — or every command asks.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.permission.ask-options', area: 'permissions & questions', surface: 'ACP method', name: 'session/request_permission',
    expectation: 'An ask carries `toolCall` with `toolCallId`, `title`, `name`, `kind: "execute"`, `status`, `locations` and `rawInput.command`, and the options `once` (`allow_once`), `always` (`allow_always`) and `reject` (`reject_once`).',
    owners: ['src/main/agents/drivers/acp/acpPermissions.ts#pickPermissionOption', 'src/main/agents/drivers/acp/acpPermissions.ts#OPENCODE_RESOURCE_FIELDS'],
    feature: 'Allow and Deny cannot be answered, or a remembered grant stops matching the command it was given for.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.permission.deny-outcome', area: 'permissions & questions', surface: 'ACP method', name: 'reject_once → session/prompt stopReason',
    expectation: 'After Cinna’s `reject_once` the prompt ends `cancelled`, with no further model request.',
    owners: [`${DRIVER}#DENIAL_CONTINUE_PROMPT`, 'src/main/agents/drivers/acp/acpPermissions.ts#pickPermissionOption'],
    feature: 'One Deny reads as the user stopping the turn unless the driver continues it.',
    flow: NO_FLOW
  },
  {
    id: 'opencode.question.elicitation', area: 'permissions & questions', surface: 'ACP method', name: 'question → elicitation/create (form)',
    expectation: 'The model is offered a `question` tool and, to a client declaring `elicitation.form`, the engine sends `elicitation/create` whose schema has one `q<n>` field per question and a `q<n>_custom` free-text companion; an `accept` with the chosen label reaches the model as the tool’s result.',
    owners: ['src/main/agents/drivers/acp/acpQuestions.ts#OPENCODE_QUESTION_KEY', `${LAUNCHERS}#elicitation: { form: {} }`],
    feature: 'A question either never reaches the user or asks permission to ask first; a renamed field files an answer under the wrong question.',
    flow: NO_FLOW
  },

  /* -------------------------------------------------------- provider traffic */
  {
    id: 'opencode.provider.egress', area: 'provider traffic', surface: 'network', name: 'HTTPS_PROXY (egress trap)',
    expectation: 'Model traffic goes only to the configured loopback `baseURL` (the conversation, and the engine’s own title request, which offers no tools). Every other attempt — all refused by the trap — is to a pinned host: `models.opencode.ai`. A new host fails the run.',
    owners: [`${LAUNCHERS}#OPENCODE_DISABLE_AUTOUPDATE`],
    feature: 'A host appearing here is a new place the engine sends something from the user’s machine; one going away can mean a check (catalog, update) Cinna relies on stopped.',
    flow: NO_FLOW
  }
]
