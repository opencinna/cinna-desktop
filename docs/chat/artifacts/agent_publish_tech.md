# Agent Publish — Technical Details

Behaviour and rules: [Agent Publish](agent_publish.md). The publish itself, the repo and the dialog: [Artifacts (tech)](artifacts_tech.md).

## File Locations

- `src/main/services/artifacts/artifactToolProvider.ts` — `ARTIFACTS_TOOL_SCHEMAS`, `ArtifactToolProvider`, `agentArtifactPolicy`.
- `src/main/services/artifacts/artifactAgentTools.ts` — `artifactToolProviderFor(session)`: null while the session's profile has no artifacts support, else the provider with `validateSession`, the service, the repo and the approvals registry.
- `src/main/services/artifacts/artifactApprovals.ts` — `createArtifactApprovals`, `approvalInboxHook`.
- `src/main/services/artifacts/artifactsSkill.ts` — skill location, gate, prompt section, Claude plugin.
- `src/main/services/conductorBridge.ts` — `Binding.artifacts`, set for a non-nested folder agent session beside `handovers`; `providers()` appends `artifactToolProviderFor` when it returns one.
- `src/main/kit/artifactsProtocol.ts` — the schema's kit path and `ARTIFACTS_PROTOCOL_VERSION`.
- `src/main/engine/engineConfigSource.ts` (`collectSkillPaths`), `engine/configGenerator.ts` (`CONVERSATION_PERMISSIONS.skill`), `agents/drivers/acp/acpLaunchers.ts` (`artifactsSkillPlugin`), `agents/drivers/acp/antigravityLauncher.ts` (`artifactsSkill`, `removeAntigravitySkill`), `agents/drivers/index.ts`, `services/localAgents/promptAssembly.ts` (`artifactsSkill`, `cinnaArtifactsSection`), `kit/skills.ts` (`PLATFORM_SKILL_NAMES`).
- Renderer: `components/artifacts/ArtifactPublishTool.tsx` (`ArtifactPublishToolBlock`, `ArtifactApprovalCard`), `hooks/useArtifacts.ts` (`useArtifactApprovals`, `useLocalArtifact`), `MessageStream.tsx` (the two branches below).

## IPC Channels

- `artifacts:approvals` (`chatId`) → the active profile's pending `ArtifactApprovalSummary[]` for that chat.
- `artifacts:answer-approval` (`{requestId, decision: 'publish'|'deny', edits?}`) → `ArtifactApprovalAnswer`. Only the active profile's requests; `editsOf` reads Edit…'s fields one by one and the publish validates them again.
- `artifacts:approvals-changed` (`{chatId}`) on open and on settle.

## Services & Key Methods

- `ArtifactToolProvider.callTool` → `publishCall`: unknown arguments are refused first (the sentence names `path, title, description, entry, artifact_id`); then `validate` (a thrown sentence becomes a refusal), support and server from the session's own profile, `inspect` with `{agentDir, profileUserId}`, the entry/empty/over-limit checks, target lookup (`repo.get` for an `artifact_id`, else `findBySource`), the policy, then either `publish()` or the approval. A gone target is cleared so `publish()` goes out as a new private artifact.
- `agentArtifactPolicy({row, agentId, readNow})` — the single place that decides ask or publish. No row → publish. `row.agentId` differs → ask. Otherwise `readNow()` (a `detail` read, which may answer `'gone'`): `'gone'` → publish, `isOwner` → publish, anything else (a throw, null, not owner) → ask. Visibility, links and grants are not consulted. `ArtifactToolDeps.repo` no longer has `setApprovedAgent` (removed from `publishedArtifactRepo`); `approvedAgentId` is not read or written.
- Approval: `onEvent({type: 'needs_input', requestId: 'art_<toolCallId>', resume: 'reply', request: question 'Publish artifact' [Publish, Deny]})`, then `approvals.open(...)`, then `input_resolved` with the answer (`rejected` for timeout/cancel). `eventSink` publishes to the root turn so the Inbox records it.
- `createArtifactApprovals`
  - `open(request, signal)` — resolves once, never rejects; a duplicate id or an already-aborted signal is `cancelled`. Settles on answer, `REQUEST_PARK_TIMEOUT_MS` (an hour) or abort.
  - `answer(profile, requestId, decision, edits?)` — `not_found`, `forbidden` (another profile), `invalid_input` (busy); `deny` settles at once; `publish` runs the provider's `publish(edits)` and settles only on success. A failed publish leaves the request pending and returns the reason.
  - A stop or timeout while `busy` is held in `deferred`; a grace timer (`UPLOAD_GRACE_MS`, 2 minutes) settles it if the upload never answers (`cinnaSend` takes no signal); a failed publish settles `deferred` immediately.
- `approvalInboxHook` — installed as `installTaskRunnerHooks(hook, 'artifacts')`, so `inboxService.answer` / `answerFromTranscript` reach it through `taskRunnerBridge.answer`. It claims only `art_` ids, validates the answer is `Publish` or `Deny`, and maps `not_found` → `no_longer_waiting`, `forbidden` → `not_owned`, busy → `answer_in_progress`, anything else → `unavailable`. The settling `input_resolved` event closes the Inbox row.
- Results: `toolResult` returns exactly the schema's result object; `excluded` merges what the desktop left out with what core dropped. A republish that skipped the card also carries a notice part `Updated rev N`, shown as "Updated without asking"; a new artifact publishes with no notice. A refusal is `isError` with a `notice` part `artifact-refusal:<code>[:<reason>]` (`artifactRefusalNote`) that the transcript turns into "Not published — …" (`artifactRefusalLine`).

## Renderer Components

- `MessageStream` renders the tool by `toolName === 'artifacts_publish' && toolProvider === 'Cinna artifacts'`: a persisted row through `ArtifactPublishToolBlock` (result card, the "Updated without asking" line, or the refusal line), a live block through the same component, which shows the pending `ArtifactApprovalCard` from `useArtifactApprovals(chatId)`.
- `ArtifactApprovalCard` — the same summary rows as the Publish dialog (files, struck-through exclusions, size, audience); **Edit…** opens the dialog with `approval` set; an answer's failure is said in the card.

## Skill delivery (code)

- `artifactsSkillInfo()` is `available` only when the installed gate (`artifactService.supportedNow().supported`) is open and `skills/cinna-artifacts/SKILL.md` is a file; with no gate it is closed. It never throws.
- `artifactsSkillDeliveryFor(engine)` → `skill` for Claude/OpenCode, `pointer` (absolute `SKILL.md`) for Codex and Antigravity; the isolated Antigravity case is rewritten to `skill` in `folderSystemPrompt`.
- `ensureArtifactsSkillPlugin` — `<userData>/cinna-plugins/cinna-artifacts/` (`.claude-plugin/plugin.json`, the skill, `.cinna-skill-hash`), swapped in whole when `contractTreeHash` changes, like the tasks plugin; `null` on any failure (no skill rather than no turn). The launcher lists it between the tasks plugin and the agent's own skills.
- OpenCode: `collectSkillPaths` returns the tasks skill's folder and the artifacts skill's folder (each only if available); each is a root `SKILL.md`, named after its folder. The conversation permission `skill` allows `cinna-artifacts`.
- Antigravity isolated home: `installAntigravitySkill` for the available skill, `removeAntigravitySkill` otherwise.

## Configuration

- No setting. The tool's presence follows the support main last read for the session's profile.

## Security

- The policy never trusts the local row for ownership: core is read for each republish. Sharing is never an input: the tool cannot set it and a republish keeps it.
- The agent's `path` is confined as any reference is (see [Artifacts (tech)](artifacts_tech.md#security)); unknown arguments (a visibility, a share) are refused rather than ignored.
- The approval is addressed per profile; another profile's request cannot be answered from the active one.

## Tests

`src/main/services/artifacts/artifactToolProvider.test.ts`, `artifactsSkill.test.ts`, `src/main/services/artifactsProtocolParity.test.ts` (the registered tool equals `artifacts.schema.json`; skipped when the bundle lacks it), `src/main/engine/engineConfigSource.test.ts`, `configGenerator.test.ts`, `acpLaunchers.test.ts`, `antigravityLauncher.test.ts`, `kit/skills.test.ts`, `components/artifacts/ArtifactPublishTool.test.tsx`, `e2e/specs/artifacts.spec.ts` (fake core), and against the real core `e2e/specs/live-artifacts.spec.ts` (an agent publishing on Claude, OpenCode, Codex and Antigravity; the no-card publish and republish).
