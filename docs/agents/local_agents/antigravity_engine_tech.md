# The Antigravity Engine — Technical Details

## File Locations

### Main process and shared contracts

- `src/shared/runtimePins.ts` — `RUNTIME_PINS.antigravity`: `cli` and one `antigravityAsset(os, file, sha256, size)` row per platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), each with `executable: 'agy_acp_server.par'` and `siblings: ['localharness_external']`. No `versionOutput`, no adapter. See [Runtime Pins](../../development/runtime_pins/runtime_pins_llm.md).
- `src/main/engine/binaryResolver.ts` — `ANTIGRAVITY_SPEC` (`searchPath: false`, `versionless: true`), `ANTIGRAVITY_ASSETS`, `configuredAntigravityPath`, `realAntigravityResolverDeps`, `managedInstallComplete` (binary plus every sibling) and the `versionless` branches in `runInstall` / `resolveFromSources`.
- `src/main/managed/managedAsset.ts` — `extractArchiveWith`: on Linux a `.zip` goes to `unzip`, then `bsdtar`, then `python3 -m zipfile`; everything else stays on `tar`.
- `src/main/engine/engineBinaryService.ts` — `antigravityBinaryService`, the shared service over that resolver; `knownPinned` reports the pin for a managed copy without spawning it.
- `src/main/agents/drivers/acp/antigravityLauncher.ts` — `createAntigravityLauncher`, `antigravityIsolatedHome`, `prepareAntigravityHome`, `installAntigravitySkill`, `antigravityPreamble`, `isAntigravityAuthError`, the tool-name lists (`ANTIGRAVITY_BUILTIN_TOOLS`, `ANTIGRAVITY_FILTER_TOOLS`, `ANTIGRAVITY_ISOLATED_DISABLED_TOOLS`, `ANTIGRAVITY_NATIVE_DISABLED_TOOLS`) and the sentences `ANTIGRAVITY_NOT_LOGGED_IN`, `ANTIGRAVITY_LOGIN_UNCHECKED`, `ANTIGRAVITY_LOGOUT_REFUSED`.
- `src/main/agents/drivers/acp/antigravityEnv.ts` — `buildAntigravityEnv` (user-home child environment), `antigravityHome`, `antigravityServerArgs`, `ANTIGRAVITY_NOT_INSTALLED`.
- `src/main/agents/drivers/acp/antigravityAuth.ts` — `probeAntigravityAuth`, `parseAntigravityAuthType`, `ANTIGRAVITY_KEYCHAIN`, `AntigravityAuthProbe` (`status`, `refresh`, `invalidate`).
- `src/main/agents/drivers/acp/acpLogin.ts` — `acpAuthenticateLogin`: the login as an ACP exchange (`initialize`, then `authenticate {methodId}`).
- `src/main/agents/drivers/acp/engineLogin.ts` — `EngineLoginProtocol` and the `protocol` branch of `EngineLogin` (stdin piped, stdout read for answers, child stopped when the exchange settles); `engineLoginCommand` returns null for Antigravity.
- `src/main/agents/drivers/acp/acpLaunchers.ts` — the plan fields this engine introduced: `firstPromptPreamble`, `sessionCwd`, and the launcher hooks `authError` and `refusePrompt`.
- `src/main/agents/drivers/acp/acpDriver.ts` — `refusePrompt` before anything is sent, `withheldSession` / `primeSession` (late save of a session whose first prompt carries the preamble), `launcherAuthError`, `answerPermissionQuestion` / `askQuestions`, and `isCinnaToolAsk` with the `offers` check.
- `src/main/agents/drivers/acp/acpMessages.ts` — the `antigravity` case of `cinnaTool`, `isAntigravityMcpCall`, `rawInputOf` (replayed `rawInput` strings), and `ANTIGRAVITY_UNEXECUTED`.
- `src/main/agents/drivers/acp/antigravityAutoApproval.ts` — `antigravityAutoApproves(policy, call, fs?)`, the folder policy that settles an ask without the user: `splitCommandLine`, `realPathOf`, the protected-path rule, the per-command option tables and the `find`/`grep`/`rg` tree walk. `AntigravityAutoApprovalPolicy` is `{folder, scriptRoots}`. The filesystem is injectable (`AutoApprovalFs`).
- `src/main/agents/drivers/acp/acpPermissions.ts` — the `antigravity` branch of `toAcpPermissionRequest`.
- `src/main/agents/drivers/acp/acpQuestions.ts` — `permissionAsQuestion`, `permissionQuestionAnswer`.
- `src/main/agents/drivers/acp/conductorToolPolicy.ts` — `ANTIGRAVITY_CONDUCTOR_TOOLS`, the `antigravity` branch of `applyConductorToolPolicy`, `BARE_MCP_TITLE`, `mcpCallOf`, `BareToolEvidence` and `cinnaToolName`'s `bare` / `meta` arguments.
- `src/main/agents/drivers/acp/acpTelemetry.ts` — `antigravity` as a `TelemetryEngine`; prompt answers carry no usage.
- `src/main/agents/drivers/index.ts` — production wiring: `antigravityAuthProbe`, `engineLogins.antigravity`, the launcher's deps (`home`, `tasksSkill`, `settings`), `stableProcessCwd`, `acpLauncherFor` (chat-runtime `sessionCwd`), and the Antigravity branches of `prepareAiFunctionRuntime` and `folderSystemPrompt`.
- `src/main/services/localAgents/promptAssembly.ts` — `NATIVE_INSTRUCTIONS_FILE.antigravity = null`, `NATIVE_RUNTIME_SENTENCE.antigravity`, `antigravityWorkingDirectory`; `resolveDesktopPromptContext` gives Antigravity pointer-style skills.
- `src/main/services/tasksSkillService.ts` — `tasksSkillDeliveryFor('antigravity')` is a pointer; `folderSystemPrompt` upgrades it to a skill for an isolated home, where it is installed.
- `src/main/services/localAgents/runtimeService.ts` — the CLI-engine early return for `antigravity` (no credential; model from `antigravityModelForComplexity`) and the credential refusal.
- `src/main/services/localAgents/desktopStateService.ts`, `localAgentService.ts` in the same directory — `antigravityApproval` and `setAntigravityApproval` (through `setEngineApproval`, shared with Codex).
- `src/main/services/conductorToolCorrelation.ts`, `conductorBridge.ts` in the same directory — correlation of bare-named calls through the session's `offers`.
- `src/main/services/aiFunctionRuntimeService.ts` — the preamble ahead of every utility prompt.
- `src/main/services/chatModeService.ts`, `chatConductorService.ts` — `antigravity` accepted as a chat-mode engine and named on the runtime row.
- `src/main/services/localAgents/desktopAppConnectService.ts` — Antigravity in the exhaustive engine tables; no desktop app stands for it.
- `src/main/kit/validator.ts` — warns on a credential beside `runtime.engine = antigravity`.
- `src/shared/engine.ts` — `AgentEngine`, `EngineLoginId`, `AntigravityAuthStatus`, `PINNED_ANTIGRAVITY_VERSION`, `ANTIGRAVITY_BINARY_CHANNEL`, `ANTIGRAVITY_TIER_MODEL`, `antigravityModelForComplexity`. `src/shared/agentDrivers.ts`, `localAgents.ts`, `sessionTelemetry.ts`, `developmentSession.ts` carry the launcher id, `antigravityApproval`, the telemetry engine and the build-session login tool.
- `src/main/agents/drivers/acp/contracts/` — `antigravity.contract.ts`, `antigravity.contract.test.ts`, `antigravityHarness.ts`, `snapshots/antigravity-1.3.0.json`; `contractDocs.ts:antigravityContractDocInput` renders the [interface contract](contracts/antigravity_interface.md).
- `scripts/install-runtime.mjs`, `scripts/pin-assets.mjs`, `scripts/generate-contract-docs.mjs`, `Makefile` (`ENGINES`, `CONTRACT_OVERRIDE_antigravity`).

### Preload and renderer

- `src/preload/index.ts` — `localTools.antigravityAuth`, `localAgents.setAntigravityApproval`, `engine.antigravityBinary` / `resolveAntigravity` / `onAntigravityState`. The login uses the shared `localTools.engineLogin` with the id `antigravity`.
- `src/renderer/src/hooks/useEngine.ts` — `useAntigravityBinary` (`['antigravity-binary']`, written from pushes), `useResolveAntigravityBinary`. `useLocalTools.ts` — `useAntigravityAuth`. `useLocalAgents.ts` — `useSetAntigravityApproval`.
- `src/renderer/src/components/settings/antigravityStatus.ts` — `antigravityStatusText`, `antigravityVersionLabel`, `antigravityToolCell` over `managedCliStatus.ts:ANTIGRAVITY_CLI` (decimal megabytes, login noun *Google*), plus `antigravityModelName`, `antigravityRunModelLabel`, `antigravityDefaultOptionLabel`.
- `src/renderer/src/components/settings/AntigravitySettingsFields.tsx` — the Antigravity Path over `RuntimePathField.tsx`.
- `src/renderer/src/components/settings/AntigravityTermsTip.tsx` — the (?) with Google's terms link, placed before or beside every Log in.
- `src/renderer/src/components/settings/RuntimeChoiceButtons.tsx` — the always-available Antigravity choice (`managedVersion`, `tool: null`); the picker is a container-query grid so four or five choices stay equal.
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — the Runtime status line. Install, Retry and Log in are the selected card's overlay (`useRuntimeCardSetup`, runtime setup in main); the line carries a login's **Cancel**, and `AntigravityTermsLine` (in `AntigravityTermsTip.tsx`) — the terms sentence with its link, which never truncates — while Antigravity is selected and not ready and nothing more pressing holds the line, otherwise `AntigravityTermsTip` at its end.
- `src/renderer/src/components/settings/DeveloperToolsSettingsSection.tsx` — the Antigravity row (the server Cinna runs).
- `src/renderer/src/components/agents/local/RuntimePanel.tsx` — Runs on option, tier select (`Default (Flash high)`), status line and badge (*Sign-in required*). `PermissionsCard.tsx` — `AntigravityApprovals`.
- `src/renderer/src/components/chat/ComposerReadiness.tsx` — the terms tip before Log in. `DesktopAppsBanner.tsx` — a signed-in, installed Antigravity counts as a working runtime.
- `src/renderer/src/components/settings/ChatModeRuntimeFields.tsx`, `ChatModeCard.tsx` — Antigravity as a chat-mode runtime without an AI credential.
- `src/renderer/src/components/localdev/DevelopmentSettings.tsx`, `DevelopmentRuntimeBadges.tsx`, `RuntimeLoginAction.tsx` — the build-session runtime choice, badge and login.

## Database Schema

- No table or migration. Folder rows stay `agents.driver = acp` with `driver_config.launcher = antigravity` as the scanner's cache.
- `DesktopState.antigravityApproval` — `auto`, `ask` or null; unknown values coerce to null and null reads as `ask`. Independent of `codexApproval` and `claudeApproval`.
- `app_settings.localAgentsAntigravityPath` — absolute path or `''` (default scope, `src/main/db/appSettings.ts`).
- Files, not rows: `<userData>/runtimes/antigravity-<version>/{agy_acp_server.par, localharness_external}`; isolated homes at `<folder>/.cinna/antigravity/` (`antigravity-acp/settings.json`, `.gitignore`, `config/skills/<name>/` with a `.cinna-source` digest stamp, the server's own conversations; on Linux a copied `antigravity-acp/acp_token.json`, 0600); chat-runtime and AI Function homes at `<userData>/chat-conductors/processes/<hash>.agyhome`.

## IPC Channels

| Channel | Signature and behavior |
|---|---|
| `local-tools:antigravity-auth` | `() → Promise<AntigravityAuthStatus>`; `state: logged_in / logged_out / unknown`. Never the token or the account. |
| `local-tools:refresh` | Existing; also starts a fresh Antigravity login read. |
| `local-tools:engine-login`, `-cancel`, `-running` | Existing shared login channels; `antigravity` is an accepted `EngineLoginId`, and `engineLoginRunning` reports it. A failed Antigravity login carries no terminal command. |
| `local-agent:set-antigravity-approval` | `({agentId, approval: ClaudeApproval or null}) → LocalAgentOutcome<LocalAgentDto>`; validated in `localAgentService.setEngineApproval`. |
| `engine:antigravity-binary` | `() → Promise<EngineBinaryState>`; `antigravityBinaryService.peek()`, never downloads. |
| `engine:antigravity-resolve` | `() → Promise<EngineBinaryState>`; `refresh()`, never rejects. |
| `engine:antigravity-binary-state` | main → renderer push on every transition, download progress included. |

`registerEngineHandlers` also registers `appSettingsService.onSaved('localAgentsAntigravityPath', …)`: invalidate the login cache and re-resolve without awaiting. All reads and mutations require activation.

## Services & Key Methods

### Launch plan

- `plan` order: `binary()` (installs when missing; a failure is returned as its sentence) → `auth({fresh: true})` → settings → environment → for an isolated folder, `prepareAntigravityHome` and `installAntigravitySkill`, then `GEMINI_HOME` → instructions.
  - A `logged_out` verdict refuses with `ANTIGRAVITY_NOT_LOGGED_IN`.
  - An `unknown` verdict on darwin/linux refuses with `ANTIGRAVITY_LOGIN_UNCHECKED`, because `session/new` with no token opens a browser by itself, per the server's source.
  - A thrown reader error becomes one generic sentence with only the phase logged.
- `readiness` refuses only a `failed` install (`not_installed`) or a `logged_out` login (`not_logged_in`, `login: 'antigravity'`), on the cached read. A pending install is `ok`.
- The spec runs the server directly: `command` the resolved path, `args` from `antigravityServerArgs` (none on macOS, `--uid=` on Linux), cwd the folder. The key digests binary, args, folder and sorted environment; model, mode and instructions are per session and stay out of it.
- `init` advertises no client capabilities: no `elicitation` (the server never sends `elicitation/create`) and no AIR capabilities. `session.mcpServers` is empty; Cinna's descriptor is added by the driver as for every engine. An isolated folder's `session/new` carries `_meta.agy.disabledTools = ['schedule', 'start_subagent']`; a native folder's carries `['start_subagent']` alone. `start_subagent` goes (with `send_message`, the subagents' only channel) because Cinna cannot show that work over ACP 1.3.0: a child's calls arrive flat on the root session with nothing but an id prefix, nesting is capped at 1, its text and report are never streamed, a resume fails, and a `session/load` on the next turn kills the children. `schedule` stays in a native folder: it is the user's own Antigravity scheduler, its runs happen outside this session, and the sealed folder's reason for removing it (Cinna owns scheduling) does not apply.
- `setup` after **new and load**: `modeId` `yolo` for `auto`, else `default`; `configOptions: [{configId: 'model', value, optional: true}]` when a model resolves. The load re-assertion is required: the contract watched a loaded session come back on the first model offered.
- `firstPromptPreamble = antigravityPreamble(instructions)` when instructions are non-empty. `acpDriver` prepends it to the first `session/prompt` of a fresh session only, holds the new session in `withheldSession`, and saves it through `primeSession` on the first turn-content update or the prompt's answer. `finish` reports no `contextId` for a session still withheld.
- `settings(userId, agentId)`: chat-mode runtimes, AI Function profiles, chat conductors and development sessions return their own model with `approval: 'ask'`. A folder agent returns `runtimeService.resolve(...).modelId` (declared model, else the tier's Flash level, else null) and `antigravityApproval ?? 'ask'`, plus `autoApprove: {scriptRoots}` when that is `ask`. `scriptRoots` is `kitAgentPinnedSkillFolders(path, manifest)` (`agentSkillsPlugin.ts`: the cache folders of the kit agent's deliverable catalog and marketplace skills), empty for a bare folder and on any read error. The launcher copies it into the plan as `autoApprove: {folder: ctx.folder.path, scriptRoots}` (`AcpLaunchPlan.autoApprove`) only under `ask`.
- `home(userId, agentId, folderPath)`: `${folderPath}.agyhome` for a chat-mode or AI Function profile, else `antigravityIsolatedHome`.

### Chat runtimes and AI Functions

- `acpLauncherFor` gives an Antigravity chat conductor a profile-owned process folder (`stableProcessCwd` → `codexProcessCwd(poolKey)`) and sets `plan.sessionCwd` to it, so sessions run in that empty folder and never in a chat folder.
- `conductorBridge` applies `applyConductorToolPolicy`:
  - `enabledTools: ['view_file']` plus `disabledTools` = every `ANTIGRAVITY_FILTER_TOOLS` name but `view_file`. Both halves are needed. Without the denylist naming `ask_question`, the server appends it to the allowlist.
  - The filter takes the server's internal `BuiltinTools` names, not the declared function names. A declared name such as `send_message` is rejected and removes nothing. `start_subagent` removes `define_subagent`, `invoke_subagent`, `manage_subagents` and `send_message`.
  - MCP tools are not governed by this filter.
- `prepareAiFunctionRuntime` treats Antigravity like Codex: a live chat conductor's process may serve the utility session, the process folder is stable, the instruction files are removed from it, the plan's preamble is the function's own `systemPrompt`, and the session cwd is the plan's own. `aiFunctionRuntimeService` prepends the preamble to every utility prompt.
- **The `.agyhome` of a shared process holds every sharing chat's conversations.** `view_file` reads the cwd and the whole home, so a conductor can read them (accepted; see [the product doc](antigravity_engine.md#cinnas-tools-and-the-chat-mode-policy)).

### Login and auth

- `engineLogins.antigravity`:
  - Resolves the server through `antigravityBinaryService.ensure()`.
  - Spawns it with `buildAntigravityEnv` and the developer-tool shims, in the user's home with no isolated `GEMINI_HOME`.
  - `acpAuthenticateLogin` writes `initialize`, then `authenticate {methodId: 'oauth-personal'}`. It reads stdout lines only to match answers and drops them. It answers any server request with "method not found".
  - When the exchange settles the child is stopped. `refresh` invalidates and re-reads `antigravityAuthProbe`, and that probe — never the exchange's answer — is the outcome.
  - The shared 10-minute timeout, Cancel and shutdown apply.
- `probeAntigravityAuth`:
  - Reads `<home>/antigravity-acp/settings.json`. Absent means `logged_out`; unreadable or unparsable means `unknown`; no `auth.type` means `logged_out`.
  - Then the token. On darwin, `security find-generic-password -s gemini -a antigravity-acp` without `-w`: exit 0 is present, 44 is absent, anything else or a timeout is `unknown`, and the output is never read. On linux, a `stat` of `acp_token.json`. Any other platform is `unknown`.
  - Bounded by a 5 s timeout and a 64 KiB buffer.
- `AntigravityAuthProbe` caches every answer for 30 s and shares the in-flight read. `invalidate` bumps a generation so a stale read is neither shared nor kept. `authLost` (from `authError`) invalidates and re-reads.
- `isAntigravityAuthError`: `-32000` with *Authentication required*, or `data.reason` `logged_out` / `onboarding_failed`. The driver asks `launcherAuthError` on a failed `session/new` and a failed prompt, local launches only.
- `refusePrompt` refuses a prompt that is exactly `/logout` before the turn lock, with `ANTIGRAVITY_LOGOUT_REFUSED`.
- `telemetryAuth`: `logged_in` → `{kind: 'subscription', label: 'Google account'}`, `logged_out` → `none`, else `unknown`.

### Messages, permissions and questions

- `cinnaTool` for Antigravity: `_meta.mcp` first (Cinna's only when `server === 'cinna'`); otherwise only a first `tool_call` of kind `other` titled `Running <name>`, which the permission gate and `ConductorToolCorrelation` accept only when `offers(name)` — the names Cinna's MCP server served this session.
- `isAntigravityMcpCall` — `_meta.mcp`, or `Running <name>` of kind `other` where the name is in neither built-in list. A completed MCP call stores no tool result: the server's `rawOutput` is the model's `toolSummary`.
- A `tool_call_update` with `status: failed` and `rawOutput` equal to `ANTIGRAVITY_UNEXECUTED` is dropped (an approved ask whose work ran under `<sessionId>:<n>`, or a cancel).
- Command output is the shared `rawOutput.formatted_output` reader, shared with Codex, whose patched adapter sends the same field.
- Replayed built-in calls carry `rawInput` as a JSON string; `rawInputOf` parses it, Antigravity only.
- `toAcpPermissionRequest`:
  - Action `antigravity:<kind>`.
  - `execute` → one resource `{command, cwd}` from `CommandLine` / `Cwd`.
  - `edit` → every `locations[].path`.
  - Other kinds → the exact `rawInput` JSON, else a request-id resource.
  - `pickPermissionOption` never selects `allow_always`.
- `permissionAsQuestion` recognises an ask whose `toolCallId` starts `interaction_`. Labels are de-duplicated (the first wins) and the question is single choice. `answerPermissionQuestion` answers `selected` with the option id, or `cancelled` when nothing it offered was chosen. `capabilities.ts` reports `question: true`.

#### The folder policy in `answerPermission`

`answerPermission` (`acpDriver.ts`) runs the check after the Cinna-tool allow and before the standing grants: `ctx.launcherId === 'antigravity' && ctx.plan.autoApprove && antigravityAutoApproves(...)` answers `allow` (one-time, never `allow_always`) and logs a debug line with the kind. Nothing is stored and no ask reaches the renderer or Inbox. Only kinds `edit` and `execute` can pass.

- **Edit** — one ask per file, `locations[].path` absolute; every location must resolve inside the real folder and not be protected for writing (any dot-prefixed segment, `AGENTS.md` / `GEMINI.md` / `CLAUDE.md`, `.cinna`, `.agents`, `.git`, `app-data/desktop*`, `credentials/`, secret names).
- **Command** — recorded shape `rawInput {CommandLine, Cwd}` (also `command_line` / `working_dir`), relative command lines, `Cwd` the agent folder. `Cwd` must be absolute, inside the folder and not protected. The line must split into plain words (no operators, substitutions, globs, `~`, `^`, `=cmd`, comments) and not start with `NAME=`. Then either a read-only command (a path argument must be allowed for reading; `credentials/README.md` is the one readable file there; `grep -r`, `rg` and `find` walk the tree, up to a bound, refusing hidden entries where the tool reads them and not following symlinked directories; `find` refuses `-exec`, `-delete`, `-fprint*`, `-follow`) or a script: `[python|python3|node|bash|sh] script`, `uv run [--quiet|-q|--no-project] [python] script`, or a first word containing `/`, resolving to an existing regular file in the folder (not protected for writing) or under a `scriptRoots` folder (no `.git`, no secret names).
- Tests: `antigravityAutoApproval.test.ts` (rule, injected filesystem) and the policy cases in `antigravityLauncher.test.ts`, `acpDriver.test.ts` and `index.test.ts`.

## Renderer Components

- `RUNTIME_CHOICES` marks Antigravity `managedVersion`; its sub-line is `antigravityVersionLabel`. The status line is `antigravityStatusText`, except that a logged-out or logging-in Antigravity shows the login state (`loginPendingText`, `loginFailureLead`) with Log in / Cancel and the terms tip in the action slot.
- `RuntimePanel` builds its Antigravity cell from `useAntigravityBinary` and `useAntigravityAuth`. A failed install shows the shared `cliFailureCopy` wording; a logged-out one shows `LoginLine` with Log in; otherwise *Antigravity uses your Google login, on <model>.* Changing Runs on to Antigravity clears model and credential, keeps the complexity, and names the model it will use.
- `AntigravityApprovals` writes `ask` / `auto`, disabled while pending, with the save error in a fixed-height line. Its copy promises no sandbox and says what Ask settles itself (own scripts, a few read-only commands, edits inside the folder; hidden and credential files still ask).
- `AntigravityTermsTip` is one fixed-size icon placed **before** a Log in whose label widens while signing in, or after a fixed one, so nothing moves ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 1). A refused external open says so in place with the address.

## Configuration

| Setting/input | Effective behavior |
|---|---|
| `runtime.engine` | `antigravity` selects this launcher for kit and bare agents. Never chosen by `resolveDefaultEngine`. |
| `runtime.model` | Explicit model id, set through the session's `model` option. Wins over complexity. Settings marks it `modelDeclared`, so a model the session does not offer earns a chat note ([Runtime model catalogue](engine_tech.md#runtime-model-catalogue)). |
| `runtime.effort` | None: Antigravity has no effort option; the desktop never writes one for it. |
| `runtime.complexity` | `simple → gemini-3.8-flash-low`, `medium → gemini-3.8-flash-medium`, `complex → gemini-3.8-flash-high`; none → no model set (server default). |
| `antigravityApproval` | `ask`/null → mode `default`; `auto` → `yolo`. |
| `localAgentsAntigravityPath` | Absolute path or `''`; must be executable; not version-checked. |
| `GEMINI_HOME` | Kept from the shell when the user set one (their Antigravity home). The launcher overrides it for isolated and chat-runtime sessions only. |
| `CINNA_ANTIGRAVITY_DOWNLOAD=off` | Turns the download into a `download_failed` with a sentence. Set by the E2E fixture on every launch; a spec that drives Antigravity must set `localAgentsAntigravityPath`. |
| `CINNA_CONTRACT_ANTIGRAVITY` | Contract tests: an explicit server (with its sibling) instead of the test cache. |

`buildAntigravityEnv` is `shellEnvForChild` plus the user's `GEMINI_HOME`. No credential is ever copied in, except that `prepareAntigravityHome` copies the Linux token file into an isolated home.

## Security

- No token, account or login output crosses the bridge or is logged. The keychain is asked for attributes only and the token file is only `stat`ed — except the Linux copy into an isolated home, written to staging at 0600 and renamed.
- `/logout` is never sent: it would clear the shared keychain token for every home.
- The contract harness refuses to start a server unless its scratch home says `auth.type: gateway`, so a test cannot run on the developer's Google login.
- Automatic (`yolo`) runs commands and edits with no ask and no sandbox. Ask (`default`) is the only review, and for a folder agent the folder policy is the one hole in it: a file written in the folder can be run unasked, so the policy is not a sandbox and the copy does not call it one. It fails closed (unparseable, unknown, unreadable or outside the real folder means the user is asked), and it is absent from every session but a folder agent on Ask.
- Grants are namespaced `antigravity:` and a command grant includes its working directory.
- A chat-runtime home is shared by every chat on that process and readable through `view_file` (the accepted limit above).

## Verification and Limits

- **Level 1 contract** — `make contract ENGINE=antigravity` installs the pinned zip (checksum-verified) into the test cache and runs `antigravity.contract.test.ts` against the real server. The server runs in its own `gateway` auth mode against a loopback fake Gemini endpoint (`streamGenerateContent`), so no Google login is touched. Observed shapes are compared with `snapshots/antigravity-1.3.0.json`. `contractRegistry.test.ts` holds owners, tests, snapshot and the generated doc in `npm test`.
- **No Level 2 flow.** Every contract entry's `flow` is `none`, and `scripts/runtime-compat.mjs` does not know Antigravity. The folder policy has E2E coverage instead: `e2e/specs/antigravity-engine.spec.ts` (fake engine: an in-folder edit answered without a click while `rm` still parks) and `e2e/specs/live-antigravity.spec.ts` (real server: in-folder edits and `pwd` unasked, a skill script unasked, `date` still asks).
- **macOS only.** Linux's `--uid=`, its token-file login and the zip fallbacks are unit-tested, never run against a real Linux server. Windows has no pin.
- **Unit coverage** — `binaryResolver.test.ts` (versionless install, sibling required, half-published install replaced, configured path executable-only, downloads off); `managedAsset.test.ts` (unpacker order); `antigravityLauncher.test.ts`, `antigravityAutoApproval.test.ts`, `antigravityAuth.test.ts`, `acpLogin.test.ts`, `engineLogin.test.ts`; the Antigravity cases in `acpDriver.test.ts`, `acpMessages.test.ts`, `acpPermissions.test.ts`, `acpQuestions.test.ts`, `acpTelemetry.test.ts`, `promptAssembly.test.ts`, `runtimeService.test.ts`, `runtimePins.test.ts`; the renderer's `AntigravitySettingsFields`, `AntigravityTermsTip`, `antigravityStatus`, `RuntimeChoiceButtons`, `RuntimePanel` and `PermissionsCard` tests.
- **Not established:** a real model turn, a real browser login, whether Automatic is safe on a given machine, and anything about Pro models. The chat-mode policy and the `view_file` reach were verified against the fake gateway only.
