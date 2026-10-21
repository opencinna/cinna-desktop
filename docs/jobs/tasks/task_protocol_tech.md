# The Cinna Task Protocol — Technical Details

Behaviour and reasons: [The Cinna Task Protocol](task_protocol.md). The tools' own rules: [Agent Task Tools (tech)](agent_task_tools_tech.md).

## File Locations

| Layer | Files and responsibility |
|---|---|
| Contract (bundle, never edited here) | `resources/cinna-agent-kit/protocols/tasks.schema.json` — the eight tools' input schemas, `$defs` (`ref`, `priority`, `category`, `custom_fields`, `artifact`), the `aliases` record, `result_packet.text_prefix`, `context_block.lines`; `resources/cinna-agent-kit/skills/cinna-tasks/SKILL.md` and `references/file-protocol.md`; `kit.json` names both (`protocols.tasks`, `platform_skills.cinna-tasks`) |
| Protocol constants | `src/main/kit/tasksProtocol.ts` — `TASKS_SCHEMA_KIT_PATH`, `TASKS_SCHEMA_REPO_PATH`, `TASKS_PROTOCOL_VERSION` (1). Nothing at runtime opens the schema |
| Tool schemas | `src/main/services/delegationToolProvider.ts` — `TASKS_TOOL_SCHEMAS`, the schema's tools with every `$ref` written out; `UNCHANGED_NOTICE` |
| Targets | `src/shared/taskTargets.ts` — `encodeTaskTarget`, `decodeTaskTarget`, `taskTargetKind` (`bare` → `folder`, `kit` → `kit`, `cloud` → `cinna`) |
| Categories | `src/shared/taskStatus.ts` — `TaskProtocolCategory`, `TASK_PROTOCOL_CATEGORIES`, `toProtocolCategory` / `fromProtocolCategory` (`done` ↔ the app's `closed`) |
| Report parsing | `src/main/tasks/taskReport.ts` — `parseTaskReport(input, defaultAudience)`, shared by the bus and the own-task path |
| Skill | `src/main/services/tasksSkillService.ts` — `tasksSkillDir`, `tasksSkillInfo`, `readSkillVersion`, `tasksSkillLabel`, `tasksSkillPluginDir`, `ensureTasksSkillPlugin`, `tasksSkillDeliveryFor`; `TASKS_SKILL_NAME`, `TASKS_SKILL_DIR_ENV` |
| Prompt stub | `src/shared/handovers.ts` — `cinnaTasksSection(agentId, delivery)`, `CinnaTasksSkillDelivery`; `src/main/services/localAgents/promptAssembly.ts` — `DesktopPromptContext.tasksSkill`, `resolveDesktopPromptContext(engine?)`, `handoverSections` |
| Context block | `src/main/services/threadContextService.ts` — `TURN_HEADER_TITLE`, `buildTurnHeader`; `src/main/services/runExecutionService.ts` — `turnHeaderFor` |
| Result packet | `src/shared/handovers.ts` — `taskResultHead`, `buildHandoverReturnPacket`, `buildHandoverGroupPacket`; `src/main/services/delegationLifecycle.ts` — `returnPacket`, `executorName`; `src/main/services/handoverWake.ts` — `HandoverWakeDeps.executorName` |
| Engine delivery | `src/main/agents/drivers/acp/acpLaunchers.ts` — `ClaudeLauncherDeps.tasksSkillPlugin`; `src/main/agents/drivers/index.ts` — wires `ensureTasksSkillPlugin` and passes the engine to `resolveDesktopPromptContext`; `src/main/engine/configGenerator.ts` — `EngineConfigInput.skillPaths`, `profileWithSkillReads`, the `skill` entry of `CONVERSATION_PERMISSIONS`; `src/main/engine/engineConfigSource.ts` — `collectSkillPaths` |
| Contract entries | `src/main/agents/drivers/acp/contracts/claude.contract.ts` — `claude.session.options-plugins`; `codex.contract.ts` — `codex.sandbox.read-outside-workspace` |
| Tests | `src/main/services/tasksProtocolParity.test.ts`, `tasksSkillService.test.ts`, `src/shared/taskTargets.test.ts`, `src/shared/handovers.test.ts` (the stub is at most ten lines; packet and group first lines), `threadContextService.test.ts`, `promptAssembly.test.ts` (+ snapshot), `configGenerator.test.ts`, `engineConfigSource.test.ts`, `acpLaunchers.test.ts`; the e2e fixture `e2e/fixtures/turnHeader.ts` and the specs that delegate through `tasks_create` |

## Database Schema

None of its own. The protocol reads and writes the existing `tasks`, `delegations`, `handovers` and `task_comments` rows; see [Agent Task Tools (tech)](agent_task_tools_tech.md#database-schema) and [Handover Bus (tech)](handover_bus_tech.md#database-schema).

## IPC Channels

None. The tools are session tools on the loopback MCP; the skill and the context block never cross to the renderer.

## Services & Key Methods

### Parity

- `tasksProtocolParity.test.ts` reads the schema from `TASKS_SCHEMA_REPO_PATH`, or from `CINNA_TASKS_SCHEMA` (absolute or repository-relative) to try a draft or cinna-core's own copy. It asserts `protocol_version === TASKS_PROTOCOL_VERSION`, `server === 'cinna'`, that `DelegationToolProvider.getTools()` names exactly the schema's tools, and that each tool's `inputSchema` equals the schema's with `#/$defs/<name>` inlined (a local key beside a `$ref`, such as a `description`, wins). It compares input schemas, not descriptions. `describe.skipIf` skips the whole block when no schema file exists.
- The `aliases` block is not read anywhere; no old name is registered or mapped.
- Contract 1.16.0 changed two descriptions and one enum in the schema: `tasks_create.category` is `["backlog", "ready", "active", "draft"]`, and the `tasks_create.category` and `tasks_report.ref` descriptions say what `active` and an attaching report do. `TASKS_TOOL_SCHEMAS` carries the same text, and the parity test (which compares input schemas, not descriptions) holds the enum. The skill's verb table gained a line for "say this conversation is working on a task" and its Lifecycle section a sentence on binding; `references/file-protocol.md` says a file task's `id` is a valid `ref`. What each does in the desktop: [Agent Task Tools (tech)](agent_task_tools_tech.md#services--key-methods).

### Targets

- `encodeTaskTarget` URI-encodes every part, so a `:` inside an id cannot be read as a separator. `decodeTaskTarget` accepts only the canonical encoding (a part that re-encodes differently is refused), strings of at most 256 characters, exactly two parts for `folder:` / `kit:` and three for `cinna:`; anything else is null, which `taskToolService` turns into "Choose a target from tasks_targets and pass its target string verbatim as assignee."
- `delegationService.targets` returns `{ protocol_version, targets }`; each entry carries `target`, `name`, `kind`, `location`, `folder`, `acceptsDelegations`, `capabilities`, `protocol_version` and `requires_approval` (`!auto`, after the git check for a bare target). `targetEntries` keeps the service's own `{ kind, agentId, adapter }` shape, which `create` matches a request against.
- Local capabilities are constants (`LOCAL_CAPABILITIES`): a bare target has `structured_report`, `reply`, `priority` and `custom_fields`; a kit target `structured_report` and `reply` (its executor calls `tasks_report`, and a brief has nowhere for priority or custom fields). A cloud target's come from `adapter.delegationSupport` (`structured_report`, `reply`) and `capabilities().writeArtifactKinds` (`attachments`).

### The skill

- `tasksSkillDir` is `<bundle>/skills/cinna-tasks`, the bundle being `process.resourcesPath/cinna-agent-kit` packaged and `<appPath>/resources/cinna-agent-kit` in development (the `contractStore` rule). `CINNA_TASKS_SKILL_DIR` overrides it in an unpackaged build only.
- `tasksSkillInfo` never throws: `available` is whether `SKILL.md` is a file, and `version` is the frontmatter's `version:` with quotes stripped. `tasksSkillLabel` gives `cinna-tasks v<version>` (or the bare name), null when unavailable.
- `ensureTasksSkillPlugin` materialises `<userData>/cinna-plugins/cinna-tasks/`: `.claude-plugin/plugin.json` (`name: cinna-tasks`, `version: '1'`), the skill copied to `skills/cinna-tasks/`, and `.cinna-skill-hash` holding the skill's `contractTreeHash`. The copy is rebuilt only when that hash differs, in a sibling `…tmp-<pid>-<time>` folder swapped in with `swapInto`, so a failed refresh keeps the previous plugin and a session never reads half of either. It is a copy rather than a pointer into the bundle because a plugin needs its own `.claude-plugin/plugin.json` and the packaged bundle is read-only. Any failure is logged (`tasks-skill`) and answered with null.
- `tasksSkillDeliveryFor(engine)` returns `{ kind: 'skill' }` for `claude` and `opencode`, `{ kind: 'pointer', path: <SKILL.md> }` for `codex`, null without a skill. `resolveDesktopPromptContext(engine)` stores it as `tasksSkill`; called without an engine it adds nothing.

### Delivery per engine

- **Claude** — the launcher calls `deps.tasksSkillPlugin()` through `safely` and, for a non-null path, puts `{ type: 'local', path }` first in the `plugins` of `_meta.claudeCode.options`, on the native branch (beside `settingSources: ['user', 'project', 'local']`) and the isolated one (beside `settingSources: []`). On the isolated branch a kit agent's own skills plugin follows it in the same array. Default `argv` delivery is used: the SDK's `pluginDelivery: 'initialize'` exists from SDK 0.3.261 (adapter 0.89.1 runs SDK 0.3.293) and is not passed.
- **OpenCode** — `collectEngineConfigInput` adds `skillPaths` with the skill's own folder (`tasksSkillInfo().dir`, the bundle's `skills/cinna-tasks`) when the skill is available — and, since the [artifacts skill](../../chat/artifacts/agent_publish.md#skill-delivery) joined it, that one's folder too while the profile's instance keeps artifacts; never the `skills/` root — and the OpenCode launcher forwards it into its one-agent `buildEngineConfig` call (it once did not, and no OpenCode ACP session had `skills.paths`). `buildEngineConfig` then writes `skills: { paths }`, the platform skills' folders first and any kit agent's own links folder after it ([Agent Skills — Technical Details](../../agents/local_agents/skills_tech.md)), and gives every agent whose permissions merge onto the profile `profileWithSkillReads(paths)`: `external_directory` becomes `{ '*': 'ask', '<skill folder>/*': 'allow' }`. That works because the 1.18.27 binary asks `external_directory` with the pattern `<parent dir>/*`, its wildcard `*` crosses `/` (covering `references/`), and the last matching rule wins. A manifest's own `external_directory` still replaces the entry whole, and a `replace`-mode permission set gets neither. `CONVERSATION_PERMISSIONS.skill` is `{ '*': 'ask', 'cinna-tasks': 'allow', 'cinna-artifacts': 'allow' }`, so other skills still ask.
- **Codex** — only the prompt stub's pointer line (`Read \`<path>\` before your first \`tasks_*\` call.`). The path is stable per build, so it does not split the process pool.

### The stub and the block

- `cinnaTasksSection` writes `## Cinna tasks`, one line on the `cinna` server, the two numbered rules, `Your Cinna agent id is \`<id>\` — the \`origin.agent\` of any task or brief you create.` and, when there is a delivery, `Open the \`cinna-tasks\` skill before your first \`tasks_*\` call.` or the pointer. `handoverSections` adds it only when the context has an `agentId`; kit and bare prompts put it after the desktop context block (`assembleBareNativePrompt` through its trailing-sections loop).
- `buildTurnHeader` writes `Cinna task context (not part of the conversation):`, `- here: Cinna Desktop, folder agent \`<agentId>\` · chat \`<chatId>\``, `- current task: \`<ref>\` "<title>" (report required: yes|no)` (the title through `JSON.stringify`) or `- current task: none`, then one `- ` line of the nonzero parts `chain depth: N`, `open delegations: T` with ` (W waiting on the user)` only when W > 0, `ready tasks: N` joined by ` · `, then `- tasks skill: <label>` when there is one.
- `turnHeaderFor` sets `reportRequired` from `row.dispatchAgentId`, a delegation row for the task, or `row.jobRunId`; a session-owned task has none of them, so it reads `report required: no`, which is what contract 1.16.0 says. A failure reading the task or counts is logged and leaves those parts out; a failure reading the skill only drops its line. Built only when the driver's capabilities include `cwd`.

### The result packet

- `taskResultHead(agent, ref, status, summary)` is the one place the first line is written. The file packet uses the executor's name (`assigneeName` of the handover's task through `executorName`, else the agent id, else the folder path) and the task id, else the handover id; it continues with ``Handover `<id>` <verb>.``. The kit/cloud packet (`returnPacket`) uses the delegated task's assignee name, else the target agent id, and the task id, else the requester key; its next line is `Delegation: <requester key>`, and a question's line is `Reply with tasks_reply using ref "<task id>" and your answer as message.` The group packet's head is `Task result from <agents> on group \`<id>\`: finished — <n> task(s):`, each member line naming its agent.

## Renderer Components

None. A packet reaches the transcript as an ordinary system row (`SystemTurnBlock`, header `Cinna Desktop · <first line>`).

## Configuration

- `CINNA_TASKS_SKILL_DIR` — development-only skill folder override; ignored when packaged.
- `CINNA_TASKS_SCHEMA` — test-only schema path for the parity test.
- The bundle's skill and schema change only through `make kit-sync`; see [Kit Contract (tech)](../../agents/local_agents/kit_contract_tech.md#updating-the-bundle).

## Security

- The plugin folder is the desktop's own, under `userData`; a folder agent's files cannot add to it. It is the one plugin an isolated Claude session loads, and loading it does not widen `settingSources`.
- OpenCode's outside-the-folder allow is scoped to each platform skill's own folder in the bundle: the skill can be read, and nothing else outside the agent's folder is opened.
- A target string is decoded by main and matched against `targetEntries`; an agent cannot name a target the session could not list.
