# Account Build Sessions — Technical Reference

Implementation companion to [Account Build Sessions](build_sessions.md). Tool installation/reconciliation stays in [Local Development tech](local_dev_tech.md).

## File Locations

### Shared and main process

- `src/shared/developmentSession.ts` — `DevelopmentContext`, `DEFAULT_DEVELOPMENT_COMPLEXITY`, `DEVELOPMENT_RUNTIME_NAMES`, `isDevelopmentAgent`.
- `src/shared/appSettings.ts`, `src/main/db/appSettings.ts`, `src/main/services/appSettingsService.ts` — typed keys, defaults and write validation.
- `src/main/localdev/developmentSessionService.ts` — context/documents, prerequisites, restoration, builder creation/reuse and binding validation.
- `src/main/localdev/localDevService.ts` — active-profile reconciliation and `executionContext` with managed-tool PATH.
- `src/main/services/localAgents/runtimeService.ts`, `src/main/services/localAgents/defaultEngineService.ts`, `src/shared/engine.ts`, `src/shared/modelFamilies.ts` — existing engine/credential/model and tier resolution.
- `src/main/engine/engineConfigSource.ts` — process-local model catalogue, `getCachedEngineModels`, `collectEngineConfigInput`.
- `src/main/agents/drivers/index.ts` — builder runtime projection, selected launchers, development prompt/config, PATH/pool-key composition and `developmentRuntimeBlocker`.
- `src/main/agents/drivers/acp/acpDriver.ts` — async runtime reads and cancel-safe preflight; `src/main/agents/drivers/acp/claudeAuth.ts` — auth-probe timeout cleanup.
- `src/main/services/agentService.ts` — active-profile builder filtering, public `development` discriminator and validated saved `developmentEngine`.
- `src/main/services/customAgentService.ts`, `src/main/services/localAgents/desktopStateService.ts`, `src/main/db/agents.ts`, `src/main/db/schema.ts` — owned builder row and reused external session/grant state.
- `src/main/ipc/localdev.ipc.ts` — activation gate and input boundary.

### Preload

- `src/preload/index.ts` — `window.api.localDev.sessionContext`, `prepareSession`, and optional `AgentData.development` / `AgentData.developmentEngine`.

### Renderer

- `src/renderer/src/components/localdev/LocalDevStatusButton.tsx`, `src/renderer/src/components/layout/MainArea.tsx`, `src/renderer/src/stores/ui.store.ts` — footer → `local-development` view.
- `src/renderer/src/components/localdev/LocalDevelopmentPage.tsx`, `src/renderer/src/hooks/useDevelopmentWorkspace.ts` — presentation/composer separated from context queries and guarded actions.
- `src/renderer/src/components/localdev/BuildGuideModal.tsx`, `src/renderer/src/components/localdev/DevelopmentRuntimeBadges.tsx` — guide and compact runtime summary.
- `src/renderer/src/components/localdev/DevelopmentSettings.tsx`, `src/renderer/src/components/localdev/RuntimeInstallAction.tsx` — build settings and prerequisite installation.
- `src/renderer/src/components/settings/RuntimeChoiceButtons.tsx`, `src/renderer/src/components/settings/InstallRuntimeDialog.tsx`, `src/renderer/src/components/settings/SettingsLayout.tsx` — shared cards, install flow, help/selector rows and dialog behavior.
- `src/renderer/src/stores/localDev.store.ts`, `src/renderer/src/hooks/useAppSettings.ts` — per-profile in-memory drafts/page mode and settings invalidation.
- `src/renderer/src/hooks/useNewChatFlow.ts`, `src/renderer/src/hooks/useChat.ts` — guarded creation, delayed selection and same-account cleanup.
- `src/renderer/src/components/agents/ExternalAgentPage.tsx` — builder Settings routing and generic-editor exclusion.
- `src/renderer/src/components/chat/ComposerWarning.tsx`, `src/renderer/src/components/chat/ComposerReadiness.tsx`, `src/renderer/src/components/chat/ChatInput.tsx` — shared warning above the input. CLI transcript files are mapped in [Conversation UI tech](../../chat/conversation_ui/conversation_ui_tech.md#cinna-cli-calls).

## Database Schema

No new table or migration. Existing definitions in `src/main/db/schema.ts` and repositories in `src/main/db/agents.ts` provide:

| Storage | Build-session use |
|---|---|
| `app_settings` | Installation-global engine, credential and complexity keys; defaults are in `src/main/db/appSettings.ts` |
| `agents` | Default/settings-scope runtime row from `agentRepo.createRuntime`; `source = local`, `driver = acp`, name `Build · <account>` |
| `agents.driver_config` | `launcher = custom`, placeholder command `cinna-development-session`, `cwd`, `developmentProfileId`, `developmentEngine` |
| `chats` | Profile-owned normal chat, bound directly to the builder through the existing creation/update flow |
| `a2a_sessions` | Existing `(chat, agent)` context-ID mirror; session IDs still come from ACP |

`customAgentService.runtime` reuses `desktopStateService.readExternal/patchExternal` for binding-scoped sessions and permission grants. The binding digest covers active profile, owner, row ID and configuration identity. The private file is written before the SQLite session mirror; an old mirror without the matching private session refuses reuse. No `AGENT.md`, manifest or desktop-state file is written into the CLI account workspace by builder preparation. See [external storage](../custom_agents/custom_agents_tech.md#database-schema).

`isDevelopmentAgent` requires a local ACP row with a string `developmentProfileId`. `agentService.toDto` exposes `development: true` as the presentation discriminator and an optional saved `developmentEngine` only when `isAgentEngine` validates it, while `listMerged` excludes builder rows for other profiles. The internal driver configuration is not a renderer-editable command.

## IPC Channels

| Channel / preload method | Signature | Boundary |
|---|---|---|
| `localdev:session-context` / `localDev.sessionContext` | `() → DevelopmentContext` | Activated session; main resolves the active account and probes its effective runtime |
| `localdev:prepare-session` / `localDev.prepareSession` | expected `profileId`, `workspacePath`, `serverUrl`, `runtime`, `complexity` → `{ agentId }` | Activated session; basic input shape then exact current-context comparisons in the service |

`DevelopmentContext` carries profile/server/account identity, workspace path, CLI version, `ResolvedRuntime`, complexity, public documents, assembled instructions, nullable blocker and optional `setupTarget`/`installTool`. It carries no account token or credential secret. Expected renderer values are freshness assertions, not authorization to choose an account, read a path or launch a command. These command failures reject and are unwrapped beside the composer; setup/state verbs retain their state-as-data contract.

## Services & Key Methods

### Context and prerequisite checks

- `readDevelopmentDocuments(root)` reads only `CLAUDE.md`, `context/README.md`, `context/platform/README.md`. It canonicalizes the root, requires each resolved path to equal its exact expected path and remain within the root, requires a regular file, and omits files over 128,000 bytes or unreadable files. Redirecting a guide symlink even to a secret inside the same workspace is refused.
- `developmentContext()` requires a connected profile and ready workspace, resolves the build engine/complexity/credential using shared runtime resolution and the cached catalogue, and assembles the same documents into runtime instructions. Legacy workspace protocol blocks building with `setupTarget = local-dev`; ordinary runtime remedies use `runtime`.
- `loadDevelopmentContext()` warms OpenCode through `collectEngineConfigInput(..., { refreshModels: false })`, then rereads context. It rejects changed profile/workspace/engine/credential/complexity across the await. Model changes during this warmup are permitted: resolving a previously empty cache is its purpose.
- `getDevelopmentSessionContext(probe)` owns the context load, prerequisite probe and final recheck as one service operation. `developmentRuntimeBlocker` asks the selected launcher's readiness with `fresh: true`; OpenCode separately calls `engineBinaryService.ensure`. After the probe, changed model IDs also reject. An existing context blocker takes priority over a probe result.
- `prepareDevelopmentSession(expected)` compares the displayed account/workspace/URL, engine/credential/model and complexity, refuses a blocker, awaits `localDevService.executionContext`, and rechecks before touching storage. It reuses an enabled same-profile/workspace/engine builder or creates one with `agentRepo.createRuntime`. It creates no chat or remote agent itself.

### Saved sessions and launch plans

- `contextForDevelopmentAgent(row)` rejects a changed profile, workspace or engine and any current blocker. Credential/model/complexity are re-resolved, not pinned in the row.
- `restoreDevelopmentContext(row)` joins `localDevService.reconcile(profileId)` only in idle/installing states for the owning profile, warms the catalogue, then validates the saved binding. A startup probe previously cached **Finish local development setup…** before restoration finished; a manual Check again hid the symptom. Waiting fixes that race without automatically retrying settled attention states.
- `readAcpRuntime` in the driver registry is asynchronous. A builder projects to an `AcpFolderView` rooted at the account workspace, with the selected engine, while retaining the external runtime's session/grant methods. Its validation composes external ownership/chat checks and development binding checks. The placeholder custom command is never the builder's launch plan.
- `folderSystemPrompt` supplies the assembled build instructions. Claude receives the selected model alias; Codex receives CLI-default model, mapped reasoning effort and `approval: ask`. OpenCode config collection adds compatible active-profile builders with their resolved credential/model and prompt, skipping rows whose current binding is invalid.
- The launcher wrapper obtains the managed execution context, builds the ordinary engine plan, validates again, then adds the managed PATH while retaining the launcher's credential environment and setup. `developmentPlanKey` hashes the original plan key with PATH, so a changed toolchain cannot reuse a process launched with the previous PATH. The normal process pool, sessions and permission handling remain authoritative.
- `customAgentService` rejects builder configuration/Test/Save through `assertCustom`; only its internal runtime-storage entry permits development rows. `ExternalAgentPage` follows the public discriminator to Local Development Settings, even if another agent left the shared page mode on settings.

### Canceling before the prompt starts

`acpDriver.beforeStart(signal, operation)` races runtime restoration and launch planning against cancellation, observes both eventual outcomes and removes its abort listener in `finally`. Stop returns a canceled outcome promptly without canceling shared restoration. After cancellation, late success cannot validate/plan/acquire the runtime, and late rejection cannot become an unhandled failure or a new transcript event. Failures that occur before cancellation retain their normal error behavior.

`probeClaudeAuth` similarly clears the fallback timeout in `finally` after its Promise race settles. A successful logged-in or logged-out answer previously left a timer that logged a false timeout five seconds later. Genuine missing callbacks still return unknown after the fallback ceiling; unknown authentication never becomes a fabricated logged-out verdict. See [Claude auth probing](../local_agents/claude_engine_tech.md#claudeauthts--the-free-login-probe).

## Renderer Components

- `LocalDevelopmentPage` keys its workspace by account ID. `useDevelopmentWorkspace` queries only when `LocalDevState.phase = ready`, with a 30-second stale time and retries disabled. The query key includes profile, state, inherited engine/credential and all three build settings. `useSetAppSetting` invalidates development context after settlement.
- `src/renderer/src/components/chat/AgentConnectionDetails.tsx` branches on `development` before generic ACP configuration. It displays the saved engine through `DEVELOPMENT_RUNTIME_NAMES` (Claude Code/Codex/OpenCode, otherwise Not recorded), protocol/location and Local Development ownership directly from public metadata. No custom configuration request, private driver configuration or current-default lookup is needed; see [connection detail lookup](../../chat/chat_routing/chat_routing_tech.md#connection-detail-lookup).
- `DevelopmentComposer` alone subscribes to the profile draft. Its textarea auto-sizes to at most 180 px and uses `resize-none`. Settings hides rather than discards the composer; readiness and visibility control autofocus. `AmbientGrid` receives that active/ready state and textarea ref; CSS propagates normal/focused border tint, and secondary actions opt into the Shell scheduler. The submit row contains only Start building; Enter/Shift+Enter/composition behavior remains in the textarea handler. See [Appearance](../../ui/appearance/appearance_tech.md). The guide mounts only on demand and memoizes the selected document, keeping Markdown parsing and runtime probes off the keystroke path.
- `BuildGuideModal` uses `useDialogChrome` for focus trapping, Escape and focus restoration, portals to the document body, and resets document scroll when the contents selection changes. `react-markdown` uses GFM, `remarkStripHtml` and `documentMarkdownComponents`. Session instructions show the briefing prefix; document bodies appear as separate contents entries.
- `DevelopmentSettings` uses the shared cards with an optional Default Runtime choice and smaller 8rem minimum widths. It saves build keys only; work complexity uses `SettingsLabel` and `settingsDropdownRowClass`. `InstallRuntimeDialog.selectionDescription` names the build-specific effect rather than promising to change all folder agents. `RuntimeInstallAction` rechecks after installation.
- `DevelopmentRuntimeBadges` reads the shared cached `useClaudeAuth` only for Claude. Subscription wording requires a logged-in result with `authMethod = claude.ai` or a subscription type; OpenCode names the credential where available and Codex shows CLI default plus effort.
- `ComposerWarning` is shared by build setup/action errors and `ComposerReadinessWarning` in ordinary chats. It wraps the full reason, places recovery controls below it, and renders nothing for healthy readiness. Warning/danger severity remains defined by the readiness state; catalogue `/run:` refusal exemptions are unchanged.

### First-chat lifecycle

`useDevelopmentWorkspace.send` prevents duplicate submission, calls prepareSession, checks mount/profile identity, refreshes agents, checks again and invokes `useNewChatFlow.startNewChat` with one builder, no mode/provider/MCP and an `isCurrent` guard. It clears the profile draft and navigates only after success; errors retain it.

For guarded flows, the `useCreateChat` mutation with `{ select: false }` creates without selecting. `useNewChatFlow` captures the originating account independently of the page guard and checks across chat creation, on-demand bindings, chat configuration, MCP bindings and attachment/note ingestion. Selection and the first send happen only after preparation remains current. Ordinary unguarded callers retain their existing immediate-selection behavior.

If a guarded preparation becomes stale, it does not select or send the late chat or publish an error onto another page/account. Best-effort `chat.delete` runs only for the originating account; this is soft deletion. On a successful response while still on that account, both `['chats']` and `['trash']` invalidate, since creation may already have refreshed the sidebar with the empty row. Failed deletion or an account switch skips that refresh. A canceled cross-account creation can leave an empty row in the originating account; no cross-account cleanup authority is added.

## Configuration

| App-setting key | Default | Resolution |
|---|---|---|
| `localDevelopmentEngine` | empty string | Inherit `defaultEngineService.current()`; otherwise validated `claude`, `codex` or `opencode` |
| `localDevelopmentCredentialId` | empty string | Optional reference used only with explicit OpenCode. Unavailable explicit selection blocks rather than accepting a fallback |
| `localDevelopmentComplexity` | `complex` | Validated `simple`, `medium`, `complex`; invalid read falls back to `DEFAULT_DEVELOPMENT_COMPLEXITY` |

All three use installation-global app settings. They do not write local-agent manifests or per-agent desktop runtime choices. Inherited defaults retain the shared credential-resolution chain; build complexity is always supplied explicitly. No new environment variable or account token store is introduced. Managed PATH comes from the existing Local Development execution context.

## Security

- Main owns account selection, filesystem guide reads, effective runtime resolution and launch plans. Renderer-supplied snapshot fields only detect staleness.
- Public guide exposure is a fixed bounded allowlist with exact-path/symlink checks. Account config, `.env`, tokens and arbitrary paths are not read through this API. Instructions explicitly forbid printing secrets; that instruction is not a filesystem sandbox.
- Active-profile list filtering is presentation isolation, supplemented by runtime binding, owned-row and chat validation before sessions/grants/turns. Generic custom-command APIs cannot rewrite a builder.
- Runtime authentication isolation is unchanged. Only PATH is added to the selected launcher's environment; provider secrets remain under the existing main-process credential and generated-config policy.
- This entry flow supplies context and approval handling, not independent proof of server permissions, tool safety or remote build completion. CLI/server authorization and each runtime's approval model still apply.

## Validation

- `src/main/localdev/developmentSessionService.test.ts` — fixed docs and secret/symlink exclusion, inherited/explicit runtime, complexity, stale checks, reuse, startup wait, settled failure and OpenCode warmup.
- `src/main/agents/drivers/index.test.ts`, `src/main/agents/drivers/acp/acpDriver.test.ts`, `src/main/agents/drivers/acp/claudeAuth.test.ts` — production launcher selection/effort, cancellation before runtime/plan settlement and real-vs-false timeout behavior.
- `src/main/services/agentService.readiness.test.ts`, `src/main/services/customAgentService.test.ts`, `src/main/services/appSettingsService.test.ts` — discriminator/profile visibility, all three saved runtime DTO values, omission of unknown/missing values without exposing driverConfig, command-editor protection and setting validation. `src/renderer/src/components/chat/RouterBadge.test.tsx` covers builder hover/focus without configuration requests and saved-runtime labels.
- `src/renderer/src/components/localdev/LocalDevelopmentPage.test.tsx`, `src/renderer/src/components/localdev/DevelopmentSettings.test.tsx`, `src/renderer/src/components/agents/ExternalAgentPage.development.test.tsx` — entry/focus/draft/guide/setup, save rollback and builder settings routing.
- `src/renderer/src/hooks/useNewChatFlow.test.tsx`, `src/renderer/src/components/chat/ChatInput.readiness.test.tsx`, `src/renderer/src/components/chat/ChatInput.routing.test.tsx` — delayed selection, navigation/account cancellation, real query-cache cleanup and universal warning behavior.
- `e2e/specs/local-dev.spec.ts` covers the local-only profile surface; `e2e/specs/cinna-integration.spec.ts` includes optional real-server build entry, guide and settings assertions after setup. These changes were checked with focused tests, typechecks and a production build, without running the full E2E suite or claiming a live remote build.
