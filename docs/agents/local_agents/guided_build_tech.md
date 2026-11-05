# Guided First Build — Technical Details

## File Locations

Shared
- `src/shared/buildBrief.ts` — tool and provider names, capability ids, states, labels and hints, effort-to-complexity map, limits, the input schema, `parseBuildBrief` (total, one-sentence errors), `composeBuildMessage` (the building chat's first message)
- `src/shared/localAgents.ts` — `LocalAgentDto.unbuilt`
- `src/shared/appSettings.ts` — `guidedFirstBuild`

Main
- `src/main/services/localAgents/guidedBuild.ts` — `isUnbuiltKitAgent`, `decideGuidedChat`, `guidedBuildSection`, `SCAFFOLD_SCRIPT_FILES`, `SCAFFOLD_SKILL_FILES`. Pure, no Electron
- `src/main/services/localAgents/buildBriefToolProvider.ts` — `BuildBriefToolProvider`
- `src/main/services/localAgents/scannerService.ts` — fills `unbuilt` in the kit scan (`entryNames`); the unreadable-agent and bare scans set false
- `src/main/services/localAgents/desktopStateService.ts` — `guidedBuildDone`, `markGuidedBuildDone`, `guidedBuildMarkerPath`
- `src/main/services/localAgents/localAgentService.ts` — `markGuidedBuildDone`, `guidedBuildOpen`
- `src/main/services/chatService.ts` — `update` (request stripped, `decideGuidedChat` called), `guidedAgentFor`
- `src/main/services/runExecutionService.ts` — `guidedBuildOf` (open section, `'closed'` or null) read once per turn; `turnHeaderFor` gets the section, `bindTurn` gets `RunInput.guidedBuild`
- `src/main/agents/drivers/driver.ts` — `RunInput.guidedBuild` (true while guided, false once that chat's agent is built, absent otherwise)
- `src/main/agents/drivers/acp/acpDriver.ts` — hands it to the launcher plan as `AcpLaunchContext.guidedBuild`; `answerPermission` with `isCodexPlanReview` declines the plan review
- `src/main/agents/drivers/acp/acpLaunchers.ts`, `codexLauncher.ts` — `AcpLaunchContext.guidedBuild`; the Codex plan's `setup.configOptions` `collaboration_mode`
- `src/main/engine/engineConfigSource.ts` (`workshopKit`), `src/main/engine/configGenerator.ts` (`EngineAgentInput.workshopKitPath`, `IDENTITY_FILES`) — the OpenCode read allow for the workshop kit
- `src/main/services/threadContextService.ts` — `buildTurnHeader` appends the section
- `src/main/services/conductorBridge.ts` — `providers` adds the tool provider
- `src/main/db/migrations/chat-guided-build.ts`, `src/main/db/schema.ts`, `src/main/db/chats.ts` — column and `chatRepo.setGuidedBuild`
- `src/main/db/appSettings.ts` — default true
- `src/main/ipc/chat.ipc.ts`, `src/main/ipc/local_agent.ipc.ts` — channels below

Renderer
- `src/renderer/src/components/chat/GuidedBuildNotice.tsx` — `GUIDED_BUILD_HEADING`, `GUIDED_BUILD_NOTICE_TEXT`, `guidedBuildPlaceholder`, `useGuidedBuildNotice(agentId)` (the accent row, `panelLabel` `Guidance`, Skip guidance through `useMarkGuidedBuildDone`, reading the mutation's own state)
- `src/renderer/src/components/chat/BuildBriefCard.tsx` — the card, `useStartBuilding`
- `src/renderer/src/components/chat/MessageStream.tsx` — matches the tool by name and provider, `activeBriefKey`
- `src/renderer/src/components/layout/ChatWorkspace.tsx` — `guidedInvite`, the empty `guided-build-slot` and the `new-chat-above-composer` half with the `noticeReach` reserve, the guided request on send
- `src/renderer/src/components/chat/ChatInput.tsx` — `placeholder`, `guidedBuildAgentId` and `onNoticePanelHeight` props, the anchored notice panel (`composer-notice-anchor`), `data-chat-composer` attribute
- `src/renderer/src/components/chat/ComposerReadiness.tsx` — `openAgentCredentials`
- `src/renderer/src/stores/ui.store.ts` — `agentPageTabRequest` (one-shot; `LocalAgentPage` takes it at first paint)
- `src/renderer/src/hooks/useNewChatFlow.ts`, `useChat.ts`, `useLocalAgents.ts` (`useMarkGuidedBuildDone`)
- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — the toggle
- `src/preload/index.ts` — `chat.update` option, `localAgents.markGuidedBuildDone`

## Database Schema

- `chats.guided_build` — integer, not null, default 0, added by `migrateChatGuidedBuild` (registered after `migrateChatOrigin` in `src/main/db/migrations/index.ts`). Never set at insert (`chatRepo.create` writes false); `setGuidedBuild` leaves `updatedAt` alone.
- No table for the marker.

## IPC Channels

- `chat:update` (chatId, updates) — `updates.guidedBuild` is a request. `chatService.update` removes it from the metadata update whatever it holds and writes the column only through `decideGuidedChat`.
- `local-agent:mark-guided-build-done` ({ agentId }) -> `LocalAgentOutcome<LocalAgentDto>`; needs user activation. Refuses non-kit agents with `invalid_input`; marks the root dirty because the marker is outside the folder and the watcher cannot see it.

## Services & Key Methods

- `decideGuidedChat` — the single gate: requested, setting on, not already guided, no content, direct router, one agent, no attached agents, agent unbuilt.
- `guidedBuildOpen(userId, agentId)` — fresh `get`, true only when `unbuilt`; false on any error. Read by both the turn header and the tool provider each turn.
- `turnHeaderFor` — adds the section only when the chat main is guided, the turn is for its root agent and `guidedBuildOpen` holds.
- `guidedBuildOf` — null for a chat that was never guided, a driver without a folder (`capabilities.cwd`) or any read error; the section's facts while the agent is unbuilt; `'closed'` for a guided chat whose agent is built. `RunInput.guidedBuild` is `true` / `false` / absent for those three, so the session of a formerly guided chat is taken out of the guided setup.
- `codexLauncher` plan — `setup` is the mode id plus, only when `ctx.guidedBuild` is defined, `configOptions` `collaboration_mode` = `plan` (true) or `default` (false). Never in the pool `key`: the process is shared by the agent's chats, so the mode is session-level, applied after new and loaded sessions alike (a loaded session keeps its last mode, `codex.session.load`).
- `isCodexPlanReview(launcherId, params)` / `answerPermission` — a Codex permission request offering `implement_plan` while `input.guidedBuild === true` is answered `reject` (the `revise_plan` option) before any card; logged as "a guided chat declined Codex's plan review".
- `workshopKit(agent)` — `<agent folder>/../../.cinna-kit` when its `kit.json` exists, nothing for a bare folder. `buildEngineConfig` merges it into the `external_directory` allows beside `skillReadPaths`; `IDENTITY_FILES` carries `'*.cinna-kit/*': 'ask'`, which the edit and write maps use, so file-tool edits there ask.
- `conductorBridge.providers` — adds `BuildBriefToolProvider` only for the folder agent's own session (`entry.binding?.artifacts`, the same gate as the artifacts tool), in a guided chat, while `guidedBuildOpen`. Provider is budget-exempt; its tool is listed under provider name "Cinna guided build".
- `BuildBriefToolProvider.callTool` — `parseBuildBrief`; valid returns `BUILD_BRIEF_RESULT`, invalid an error result.

## Renderer Components

- `ChatWorkspace` offers the guidance (heading, empty prompt slot, `guidedBuildAgentId` to the composer) when `appSettings.guidedFirstBuild` is true, the router is direct, one agent is picked and `useComposerFolder` reports it unbuilt. It sends `guidedBuild: true` through `NewChatOptions`, only when `rootAgentId` exists. The example prompts and their readiness refusal are the else branch.
- `BuildBriefCard` renders read-only unless `active`; the latest brief (`LatestBrief`) additionally requires the agent query to report `unbuilt`. Apply writes `runtime.complexity` through `useSetLocalAgentRuntime` (with `KEEP_ENGINE`), and is hidden when the manifest names a concrete model. Start building runs `useStartBuilding`, a hook-level mutation because the card unmounts when the new chat becomes active; a failed marker after the chat started is a toast.
- `MessageStream` shows a refused call (`toolError`, or a streaming error) as the plain tool row.

## Configuration

- `guidedFirstBuild` in app settings, default true; Settings → Features → AI Functions, row id `feature-guided-first-build`.

## Security

- The renderer cannot set the column: the request is stripped and re-decided against the live folder and settings.
- Credential values never enter the brief: the schema carries names only, and the guidance forbids asking for secrets.
- The marker file is under `userData` and holds `done` and a timestamp.

## Tests

`e2e/specs/live-guided-build.spec.ts` is the billed spec, `@live`, on `CINNA_E2E_LIVE_ENGINE=opencode|claude|codex` (passed on all three). Four tests: a daily-check job interviewed into a brief and built through Start building (the folder gains a script, skill or schedule beyond the scaffold); a task instead of a job, not attempted, folder unchanged; two area starts interviewed into a role. It asserts outcomes (persisted tool rows, the card, the folder), not wording, and writes a transcript to the test's output folder. Cost and what it proves are in its header; about $0.10–0.30 on gpt-5.6-luna.

Unit: `guidedBuild.test.ts`, `buildBriefToolProvider.test.ts`, `chatService.guidedBuild.test.ts`, `src/shared/buildBrief.test.ts`, `BuildBriefCard.test.tsx`, `GuidedBuildNotice.test.tsx`, `MessageStream.buildBrief.test.tsx`, `ChatWorkspace.guided.test.tsx`, `ChatInput.guidedBuild.test.tsx`, plus `codexLauncher.test.ts`, `acpDriver.test.ts` and `configGenerator.test.ts` for the delta above.
