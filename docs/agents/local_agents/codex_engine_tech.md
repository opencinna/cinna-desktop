# The Codex Engine — Technical Details

## File Locations

### Main process and shared contracts

- `src/main/agents/drivers/acp/codexLauncher.ts` — `createCodexLauncher`, readiness, launch plan and invalidation key.
- `src/main/agents/drivers/acp/codexAuth.ts` — `CodexAuthProbe`, `probeCodexAuth`, `parseCodexAuthStatus`.
- `src/main/agents/drivers/acp/codexEnv.ts` — `buildCodexEnv`, the CLI profile exception to the shared child allowlist.
- `src/main/agents/drivers/index.ts` — production dependencies, `codexAuthProbe`, adapter entry resolution, folder prompt and runtime-setting readers.
- `src/main/agents/drivers/acp/acpDriver.ts`, `acpConnection.ts`, `acpProcessPool.ts` in the same directory — shared turn, stdio transport, process ownership and lifecycle.
- `src/main/agents/drivers/acp/acpPermissions.ts` and `acpQuestions.ts` in the same directory — Codex permission scope and elicitation conversion.
- `src/main/agents/drivers/capabilities.ts` and `src/shared/agentDrivers.ts` — launcher identity and advertised capabilities.
- `src/shared/engine.ts` — `AgentEngine`, `CodexAuthStatus`, `effectiveEngine`, `resolveDefaultEngine`, `codexEffortForComplexity`; `src/shared/localAgents.ts` and `src/shared/localAgentRequests.ts` carry desktop summary and permission contracts.
- `src/main/services/localAgents/runtimeService.ts`, `defaultEngineService.ts`, `desktopStateService.ts`, `localAgentService.ts` in the same directory — runtime validation/resolution, machine default, persisted approval choice and owned mutation.
- `src/main/kit/validator.ts` and `resources/cinna-kit-contract/schema/cinna-agent.schema.json` — tolerant manifest reads with warnings for a Codex credential.
- `src/main/ipc/local_tools.ipc.ts` and `local_agent.ipc.ts` in the same directory — activated auth/readiness refresh and approval mutations.

### Preload and renderer

- `src/preload/index.ts` — `localTools.codexAuth` and `localAgents.setCodexApproval`; no CLI output or credentials cross the bridge.
- `src/renderer/src/hooks/useLocalTools.ts` — `useCodexAuth`, tool refresh and installation cache invalidation.
- `src/renderer/src/hooks/useLocalAgents.ts` — `useSetCodexApproval`, updating the agent query from the returned DTO.
- `src/renderer/src/components/agents/local/RuntimePanel.tsx` — full Runs on/complexity controls, CLI readiness and compact model/effort badge.
- `src/renderer/src/components/agents/local/PermissionsCard.tsx` — `CodexApprovals` and the shared standing-grant list.
- `src/renderer/src/components/settings/RuntimeChoiceButtons.tsx` and `LocalAgentsSettingsSection.tsx` in the same directory — selectable Codex machine default and existing install flow.
- `package.json`, `package-lock.json`, `electron-builder.yml` — adapter pin and distribution rules.

## Database Schema

- No new table or migration. Folder rows remain `agents.driver = acp`; `driver_config.launcher = codex` is the scanner's cache, and dispatch re-reads the folder runtime.
- `agentSessionRepo` in `src/main/db/agents.ts` retains each chat/agent session in the existing `a2a_sessions.context_id`; the physical table name does not choose the transport.
- `desktopStateService` also stores sessions and standing grants in kit `app-data/desktop.json`, or a path-keyed record under `<userData>/external-agents/` for a bare folder. These are runtime paths, not repository files.
- `DesktopState.codexApproval` and its DTO summary are optional/null-compatible, with `auto`, `ask` or null as valid stored values. Unknown values coerce to null; the reader applies the Codex default `ask`. `claudeApproval` remains independent.
- Kit runtime settings are stamped writes to the manifest; bare runtime settings are unstamped writes to desktop state. The machine default is `app_settings.localAgentsDefaultEngine` in the default settings scope; `src/shared/appSettings.ts` defines it.

## IPC Channels

| Channel | Signature and behavior |
|---|---|
| `local-tools:codex-auth` | `() → Promise<CodexAuthStatus>`; returns only `state: logged_in / logged_out / unknown`. |
| `local-tools:refresh` | `() → Promise<DetectedTool[]>`; refreshes tool detection and starts a fresh Codex login probe alongside Claude's. |
| `local-agent:set-codex-approval` | `({agentId, approval: ClaudeApproval or null}) → LocalAgentOutcome<LocalAgentDto>`; the shared type name is retained, but storage/defaults are independent. Missing input is not converted into null. |
| `local-agent:update-field` | Existing stamped runtime update for kit agents; `LocalAgentRuntimeInput.engine` now accepts `codex`. |
| `local-agent:set-runtime` | Existing bare-agent runtime mutation, with the same shared validation. |
| `agent:check-readiness` | Existing explicit fresh agent check; refreshes the Codex login verdict and retries detection when the executable is missing. |

These reads/mutations require activation. `localAgentService.setCodexApproval` locates the agent in the settings owner's roots before validating and patching; the editor turn lock refuses overlapping work. It marks the root dirty and re-scans because neither desktop-state location is watched for this change. Chat start/watch/cancel and permission/question delivery use the existing [driver channels](../drivers/drivers_tech.md#ipc-channels), without a Codex-specific send path.

## Services & Key Methods

### Planning and dispatch

- `runtimeService.resolve` returns early for Codex before the desktop credential/default-chat-mode ladder: no credential, declared model or null, and readiness delegated to the launcher. `validate` refuses a desktop credential with either CLI engine.
- `defaultEngineService.lockIfUnset` persists a first-launch result and preserves a selection made while detection was in flight. Existing folder agents retain OpenCode when no prior machine choice exists. `current` uses the cached detection snapshot; `resolved` awaits detection. `effectiveEngine` preserves a declared credential/model on OpenCode when no supported engine is explicit.
- `createCodexLauncher` requires a local folder. Production wiring reads the assembled kit/bare prompt and current runtime model/complexity plus `codexApproval` before each turn.
- `plan.spec` runs `electronNodeRuntime()` with the adapter entry, cwd equal to the agent folder, and a fully constructed environment. A SHA-256 digest over command, arguments, adapter path, cwd and sorted environment provides the pool key; prompt, model, effort, approvals, CLI path and environment changes replace the process on the next turn. The key contains no plaintext configuration.
- The plan advertises ACP v1, `elicitation.form` and `_meta: airClientMeta(['asyncTasks'])`, sends `mcpServers: []`, and requires `session/set_mode` after both new and loaded sessions. A rejected setup cannot reach `session/prompt`.
- **No `nativeSubagentSessions`.** With it, `codex-acp` 1.11.0 suppresses the spawn call on the parent, and child frames carry no parent link. Subagents are derived in `acpActivity.ts:translateActivity` from root-session tool calls instead:
  - `_meta.codex.subagent {threadId, path, activity}` — recorded in `__fixtures__/codex/subagent_nocaps.json`
  - `_meta.codex.collaboration` (`spawnAgent` receivers, `rawInput.agentsStates`) — synthesized from the adapter's code in `subagent_collab.json`

  A subagent that runs again after ending becomes a new item, `<thread>#2`.
- The launcher does not set `endsTurnsWithCostedUsage`. A follow-up turn on Codex would also end on `ACP_FOLLOW_UP_QUIET_MS` of quiet. No Codex follow-up has been observed: its between-turn `tool_call_update`s are for calls of the saved turn, and the gate drops them.
- Shared ACP startup, replay gating, saved-session fallback, two-minute idle reaping (deferred while background work runs), process-tree shutdown, twenty-minute turn ceiling and bounded cancellation remain in the [Agent Turn](agent_turn_tech.md). Cinna's transcript does not restore missing CLI history.

### Authentication and diagnostics

- `probeCodexAuth` executes the detected path with `login status`, the same narrowed environment as turns, a five-second process timeout, SIGKILL and a 64 KiB output cap. A separate 500 ms completion allowance bounds a missing callback.
- `parseCodexAuthStatus` recognizes explicit Logged in using/with and Not logged in lines from stdout/stderr, including a logged-out nonzero exit. Killed/unrecognized probes become `unknown`; only a definite `logged_out` blocks readiness.
- `CodexAuthProbe.status` shares in-flight work and caches for 30 seconds; `refresh` invalidates cached state and joins any current probe. `useCodexAuth` refetches on window focus and every ten seconds while logged out.
- `codex-auth` logs verdict, reason and duration; `codex-launcher` logs preparation phase/agent ID or missing-adapter state. Raw probe output, thrown preparation errors, instructions, environment values and login secrets are not logged by these helpers.
- Missing CLI and logged-out states give installation/login remedies. Missing adapter asks to reinstall Cinna. Other preparation failures give a generic folder/installation remedy with phase diagnostics. Shared ACP startup/turn errors remain visible in the chat; readiness is not a CLI-version compatibility test.

## Renderer Components

- Runtime choices offer Codex without a Soon badge. Installed state and selected state are separate; installing a CLI does not silently select it outside the explicit install-and-select flow.
- `RuntimePanel` uses the actual machine default to label the Default runtime option even while this agent is pinned elsewhere. Codex avoids provider-model loading gates and the Advanced catalogue; its status and compact badge show the declared model or CLI default plus reasoning effort.
- `CodexApprovals` writes `ask` or `auto`, disables its select while pending, and displays a failed save beside the control. It describes sandbox escalation rather than promising approval before every workspace edit.
- Shared question UI accepts choices/custom text. `toInputQuestions` excludes the adapter's companion fields marked `_meta.codex.isOtherAnswer`; `toElicitationContent` returns the value under the original question ID.

## Configuration

| Setting/input | Effective behavior |
|---|---|
| `runtime.engine` | `codex` selects this launcher for kit and bare agents. |
| `runtime.model` | Optional explicit CLI model; omitted from adapter configuration when blank. |
| `runtime.complexity` | `simple → low`, `medium/default → medium`, `complex → high` reasoning effort. |
| `codexApproval` | `ask/default → read-only`; `auto → agent` in this adapter's mode vocabulary. |
| `CODEX_HOME` | Preserved from the resolved shell, then process fallback; selects the user's Codex profile. Cinna does not read/copy that profile's credentials. |
| `CODEX_PATH` | Always overwritten with the executable found by Cinna's tool detector. |
| `CODEX_CONFIG` | JSON carrying `developer_instructions`, optional `model`, and `model_reasoning_effort`. Supplied at both app-server thread creation and resume by the adapter. |
| `INITIAL_AGENT_MODE` | Set by the launcher in addition to mandatory per-session setup. |
| `ELECTRON_RUN_AS_NODE` | `1`, supplied by the shared Electron runtime; no separately installed Node is needed to run the adapter. |

`buildCodexEnv` starts with `shellEnvForChild`; shell `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, `CODEX_CONFIG`, `CODEX_PATH` and `INITIAL_AGENT_MODE` are excluded before launcher-owned values are added. Normal Codex user/project settings, model-provider routing, skills and MCP configuration remain active. Changes inside those configuration files are not hashed by Cinna; Codex owns when it reads them.

### Adapter compatibility and packaging

- The exact dependency is `@agentclientprotocol/codex-acp@1.11.0`. Its package declares `@openai/codex ^0.153.4`, and the lockfile resolves `0.153.4`. This is upstream compatibility evidence, not a Cinna-enforced minimum or a tested matrix of CLI versions.
- The maintained adapter bridges ACP to `codex app-server`. See the pinned [adapter source](https://github.com/agentclientprotocol/codex-acp/tree/v1.11.0), especially `src/AgentMode.ts`, `src/CodexAcpClient.ts` and `src/index.ts` within that upstream repository. <!-- nocheck -->
- Development resolves the adapter entry through `createRequire`. Packaged builds use `<resources>/app.asar.unpacked/node_modules/@agentclientprotocol/codex-acp/dist/index.js`; `electron-builder.yml` registers `scripts/packaged-dependencies.cjs` to unpack the adapter and its installed runtime dependency tree at every depth, then validate required manifests in the shipped tree. See [Packaged Runtime Dependencies](../../development/distribution/packaged_runtime.md) for collection, re-hoisting and optional/peer rules.
- Packaging excludes root and nested `@openai/codex*` dependencies, including platform copies. This is safe only while `CODEX_PATH` always names the user's detected CLI; omitting it would activate an excluded dependency fallback.

## Security

- Approval/auth mutation inputs cross typed preload but are validated again in main. The renderer receives an auth verdict, not account details, login output or credentials.
- The pinned adapter's `read-only` ID is **workspace-write**, `approvalPolicy: on-request`, `approvalsReviewer: user`, network disabled. `agent` retains the same sandbox and uses `auto_review`. Both keep normal temporary-directory allowances (`excludeTmpdirEnvVar` and `excludeSlashTmp` false). Cinna never selects `agent-full-access`; this is not a claim that only one directory is writable or that every filesystem access requires approval.
- `runtime.permissions` belongs to OpenCode's generated profile and is not translated into Codex policy. Folder instructions express intent; the Codex sandbox and approval policy enforce access. Saved Codex configuration/auth can still be used by the CLI.
- `toAcpPermissionRequest` stores Codex actions as `codex:<kind>`. Execute requests with raw input have one indivisible exact resource containing `rawInput`, `title`, `content` and `locations`: splitting fields would combine unrelated grants into wider rights, and omitting presentation fields lost SOCKS host/protocol scope from the actual adapter.
- Edit requests retain all locations, and every path must match a grant. Other raw input is exact JSON; a request with no usable scope gets an exact request-ID resource, never an action-wide grant.
- Shared `pickPermissionOption` excludes `allow_always`; a stored grant answers with `allow_once`. Cinna's grant store is authoritative for decisions made in this UI and does not modify Codex's own persistent rules. Requests handled entirely inside Codex do not pass through that store.

## Verification and Limits

- `src/main/agents/drivers/acp/codexLauncher.test.ts` covers launch/env/config, auth cache/parsing/time bounds, readiness refusal, spec invalidation and redacted diagnostics.
- `src/main/agents/drivers/acp/codexPermissions.test.ts` covers cross-engine grant separation, all-path patches, indivisible command rights, SOCKS host/protocol separation, scope-less requests and choice/custom-answer conversion.
- `codexLauncher.test.ts` also pins the advertised capabilities (`asyncTasks` only). `acpActivity.test.ts` reads the recorded Codex background-terminal, stop and no-capability subagent fixtures, and the synthesized collaboration fixture.
- `src/main/agents/drivers/acp/codexAdapter.test.ts` copies the actual pinned adapter outside `node_modules` and drives real stdio against `src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs`. It verifies selected executable use without a bundled CLI, streaming, new/resumed configuration, sandbox/mode arguments, native permission/question round trips and cancellation.
- `src/shared/engine.test.ts`, `src/main/services/localAgents/runtimeService.test.ts`, `desktopStateService.test.ts` in that directory, and `src/renderer/src/components/agents/local/RuntimePanel.test.tsx` cover selection, credential-free resolution, independent approvals and renderer state.
- `e2e/specs/codex-engine.spec.ts` is the targeted built-Electron regression: persistent runtime/approvals and production detection/auth/launcher/adapter/chat/permission/question/Stop/restart-resume. Its disposable shell PATH and executable assertion prevent use of the developer's real CLI. Only the CLI/app-server peer is scripted.
- Run focused Vitest files or `npm test`, plus `npm run typecheck` and `npm run build`. The full E2E suite is a separate manual validation.
- `npm run test:packaging` covers dependency/build-hook and isolated-environment regressions separately from Vitest. The manual [packaged runtime checks](../../development/distribution/packaged_runtime.md#commands-and-coverage) use actual shipped files; macOS arm64 initialization passed with the fake app-server, including a check-runner Node path containing spaces. No Windows/Linux runtime result is implied by the build guard or Windows fixture launcher.
- No real paid Codex model turn, live account login flow, actual automatic-review decision or native sandbox enforcement is established by these tests. The adapter behavior and generated native arguments are exercised; real CLI version/platform compatibility, forgotten-session error shapes, and provider/configuration variations remain external validation limits.
