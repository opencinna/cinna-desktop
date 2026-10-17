# Artifacts — Technical Details

Behaviour and rules: [Artifacts](artifacts.md). The agent's tool, its approval and the skill: [Agent Publish (tech)](agent_publish_tech.md).

## File Locations

**Shared**
- `src/shared/artifacts.ts` — every type that crosses IPC (`ArtifactsSupport`, `ArtifactInspection`, `PublishArtifactInput`, `ArtifactsPublishOutcome`, `ArtifactDetail`, `ArtifactCardDto`, `ArtifactErrorCode`), channel names, `FALLBACK_ARTIFACT_LIMITS`, the wording helpers (`artifactKindLine`, `artifactAudience`, `formatArtifactBytes`) and `artifactIdFromUrl`.

**Main**
- `src/main/services/artifacts/publishService.ts` — `createArtifactService(deps)`: support, inspect, publish, detail, visibility, links, local reads. Core service: no Electron.
- `src/main/services/artifacts/artifactService.ts` — the production wiring (profile, account, discovery, `cinnaFetch`/`cinnaSend`, folder locate, repo, events) and the `installArtifactsSkillGate` call.
- `src/main/services/artifacts/inspect.ts` — `inspectArtifactPath`, `exclusionFor`, `decideKind`: the walk.
- `src/main/services/artifacts/zip.ts` — `buildZip`, the archive sent.
- `src/main/ipc/artifacts.ipc.ts` — thin handlers (activation gate, delegate).
- `src/main/db/publishedArtifacts.ts` — `publishedArtifactRepo`; `src/main/db/migrations/published-artifacts.ts`; tables in `src/main/db/schema.ts`.
- `src/main/auth/cinna-oauth.ts` — `CinnaEndpoints` gained `instance_name` and `artifacts`.
- `src/main/services/cinna-http.ts` — `cinnaSend` accepts `DELETE` (revoking a link).
- `src/main/hub/core.ts` — reads support as each profile becomes ready.

**Preload**: `src/preload/index.ts` — `window.api.artifacts`.

**Renderer**
- `src/renderer/src/components/artifacts/PublishArtifactDialog.tsx`, `ArtifactCard.tsx` (card, Share popover, `ArtifactLinkCard`, `useArtifactProgress`), `ArtifactsHost.tsx` (mounted once in `App.tsx`).
- `src/renderer/src/hooks/useArtifacts.ts` — `useArtifactsSupport`, `useArtifactsSupportLoader`, `useArtifactCards`, `ArtifactCardsSource`, `useArtifactDetail`, `useArtifactEvents`.
- `src/renderer/src/stores/artifactPublish.store.ts` — the dialog's request and the one publish mutation.
- Surfaces changed: `components/chat/MessageContextMenu.tsx` (**Publish…**), `FilePreviewModal.tsx` (header **Publish…**), `fileRefs.tsx` (`MessageIdContext`, link cards), `MessageStream.tsx` (cards after messages), `stores/filePreview.store.ts` (`messageId`).

## Database Schema

Created by `migratePublishedArtifacts` in `src/main/db/migrations/published-artifacts.ts` (registered in `runAllMigrations` after `migrateInboxDismissals`; creation only). See [Migrations](../../development/migrations/migrations_llm.md).

- `published_artifacts` — one row per `(profile_user_id, server_url, artifact_id)` (unique), with `source_path` (the realpath, indexed with profile and server), `agent_id`, the last known `title`, `kind`, `revision`, `visibility`, `url`, `live_link_count`, and `approved_agent_id` (the agent a person approved to publish it; used only by the agent skip rule). FK → `users` cascade.
- `chat_artifact_cards` — a card anchored after `message_id` of `chat_id`. FK → `users` and `chats` cascade; `message_id` is deliberately not a foreign key.
- The rows are a **cache of core**, kept in sync after every publish, detail read and share action (`repo.sync`); a 404 forgets the row. They are a hint for *Update* and for cards; nothing decides sharing from them except as a starting point the agent skip rule refuses to trust.

## IPC Channels

All `ipcHandle`, all behind `userActivation.requireActivated()`, all returning data (a thrown code does not survive IPC).

- `artifacts:support` → `ArtifactsSupport` — `{supported, instanceName?, limits, linkOrigins?}`.
- `artifacts:inspect` (`{agentId, path, entry?}`) → `ArtifactsInspectOutcome`.
- `artifacts:publish` (`PublishArtifactInput`) → `ArtifactsPublishOutcome`.
- `artifacts:cards` (`chatId`) → `ArtifactCardDto[]`, from memory, no network.
- `artifacts:detail` (`artifactId`) → `ArtifactsDetailOutcome`, core's current state.
- `artifacts:set-visibility`, `artifacts:create-link` (`withCode?`), `artifacts:revoke-link` → outcomes carrying fresh detail.
- `artifacts:local` (`artifactId`) → `PublishedArtifact | null`, memory only.
- Agent publish: `artifacts:approvals`, `artifacts:answer-approval` ([Agent Publish (tech)](agent_publish_tech.md)).
- Events to every window: `artifacts:progress` (`{operationId, phase}`, phases `packing` → `uploading` → `sharing`), `artifacts:changed` (`{artifactId}`; renderer re-reads cards, details and local reads), `artifacts:approvals-changed` (`{chatId}`).

## Services & Key Methods

`publishService.ts` (`createArtifactService`)
- `support()` — `computeSupport`: the profile's user row must be `cinna_user` with tokens; `deps.discover` (`discoverCinnaEndpoints`, cached per server per session, so a server that gains `artifacts` needs a restart) must report `artifacts >= 1`; limits from `GET /api/v1/artifacts/capabilities` once per server, else `FALLBACK_ARTIFACT_LIMITS`. The last answer per profile is kept for `supportedNow()`, the synchronous read the agent tool and the skill gate use.
- `inspect(input, options?)` — `confine` then `walk`. `confine` finds the agent folder from the agent id (or the validated session), takes `realpath` of the path (relative paths are resolved against the folder: the agent tool names files that way), requires `isWithin`, and applies `exclusionFor` to every segment of the path itself — so a file inside `credentials/` or a named `.env` is refused (`path_refused`, with the reason) as well as dropped inside a folder.
- `publish(input, options?)` — validates (title 1–200, description ≤ 2000, `visibility` one of `private|instance|link|keep`, `artifactId` a UUID), re-walks, re-checks entry and limits, reads each kept file with `O_NOFOLLOW` and the per-file cap, zips, then `POST /api/v1/artifacts` (new: `source_kind=desktop`, `source_label="<agent> · <path>"`) or `POST /api/v1/artifacts/<id>/revisions`. Then, per the chosen audience: `PATCH` visibility, or `POST …/links` (URL and code returned once). Failures of that follow-up become `warning`, not an error. Records memory (`recordPublish`, `sync`), anchors the card (`addCard`; after `anchor.messageId`, else `latestMessageId(chatId)`), emits `artifacts:changed`.
- `detail`, `setVisibility`, `createLink`, `revokeLink` — each reads back `GET /api/v1/artifacts/<id>` (`readDetail`), which syncs the row only when `is_owner`, and learns the page URL's origin.
- `linkOrigins(profile, server)` — the server origin, plus origins in remembered rows (`repo.urls`), plus origins learned this session; what `artifactIdFromUrl` is checked against to skip the origin comparison above; it no longer gates the read.
- `local`, `cards`, `serverOf`, `supportedNow` — memory/no-network reads.
- `guarded` maps `CinnaReauthRequired` → `reauth_required`, `CinnaApiError` 404 → `gone`, `not_cinna_user` → `not_supported`, others → `request_failed`.

`inspect.ts`
- `inspectArtifactPath(root, limits, chosenEntry)` — lstat-only walk, sorted entries; a symlink or non-file is listed in `excluded`, never followed; a folder matching an exclusion at any depth is one `…/` row, never walked; the walk returns once `files > maxRevisionFiles` or `size > maxRevisionBytes`; files over `maxFileBytes` are named (first five).
- `exclusionFor(name, isDirectory)` — `.git`, `.env*`, `*.pem`, `*.key` (any), `.DS_Store`; as directories also `credentials`, `app-data`, `.claude`, `node_modules`; then any other dot-named entry as `hidden file`. Mirrors core's ingest rule plus its agent route's dot-name refusal (`_refuse_excluded_path`). `confine` applies it to every segment of the requested path, so a path under an excluded or hidden folder is refused, not published.
- `decideKind` — mirrors core's decision: a root `index.html` or a lone HTML file is a site; otherwise a chosen entry among the HTML candidates; otherwise files.

`artifactMultipart` builds the body; `overLimitsMessage` is the one sentence for the dialog, the refusal and the agent.

## Renderer Components

- `PublishArtifactDialog` — one global instance driven by `useArtifactPublishStore`. Fixed layout (every row present from the first frame, a refusal rendered last under the buttons). Edit… of an agent request starts from `request.approval`. Inspection runs on open; a result for a stale open is dropped.
- `artifactPublish.store.ts` — the publish call lives in the store so a result lands even if the dialog unmounted (a mutate-level callback would be dropped). Closes on success only.
- `ArtifactCard` / `SharePopover` — the owner's card (`canShare`) reads `artifacts:detail` through `useArtifactDetail` (the query Share… and link cards share) and draws its audience line from core's answer, since grants are made on core's page and never reach the local row; until core answers, or if it fails, the row's audience stands. Open, Copy link (via main's clipboard: `navigator.clipboard` refuses once a dialog has focus), Share…; revoke asks inline in the row; a revoked link stays inert in place until the popover closes. Hide-this-note dismisses a one-time warning.
- `ArtifactLinkCard` — any `/artifact/<uuid>` link (`artifactIdFromUrl(href)`, no origin list) when supported: skeleton at the card's height, then `artifacts:detail`; any failure renders the original link. When the href's origin is not already in `support.linkOrigins`, `LoadedArtifactLinkCard` draws the card only if `sameOrigin(detail.url, origin)` — core's own url for the id is the proof; a mismatch stays the link. Unsupported means no read at all. `ShownArtifactsContext` still keeps one card per artifact.
- `MessageStream` — cards are keyed by message id and pushed right after that message; `ArtifactCardsSource` is mounted only while supported, so an unsupported transcript asks nothing.
- The reference menu's items are decided once at open, with `canPublish`; a credential reference never gets **Publish…**.

## Configuration

- No setting. Support and limits are the instance's. The dependency is the discovery document's `artifacts` (integer) and `instance_name`, and `GET /api/v1/artifacts/capabilities`.
- Kit contract 1.12.0, and 1.13.0 for the `artifacts/` role (`protocols/artifacts.schema.json`, `skills/cinna-artifacts/`, `templates/artifact-sqlite-dashboard/`) — see [Kit Contract (tech)](../../agents/local_agents/kit_contract_tech.md).

## Security

- The renderer sends `{agentId, path}` only; main finds the folder, re-realpaths, re-checks containment and exclusions, and re-inspects at publish. A path it cannot trust is `path_refused`.
- Excluded files are never read: the walk drops them before `readKept`, and `O_NOFOLLOW` plus a re-`fstat` size check refuse a file swapped for a link or grown past its cap since the walk.
- The token only goes to the profile's own API through `cinna-http`; the multipart body carries the archive, never credentials.
- A public link's URL and code are returned once and never stored by the desktop.
- Link cards read core only for an origin the profile itself owns or core named, so an `/artifact/<uuid>` link on an arbitrary host cannot make the desktop call it with a token. `MessageStream` provides `ShownArtifactsContext` (ids carded by `chat_artifact_cards` rows and by persisted or live `artifacts_publish` results); `ArtifactLinkCard` leaves a link to one of them as a link.

## Tests

`src/main/services/artifacts/{inspect,publishService,zip,artifactsSkill}.test.ts`, `src/main/db/publishedArtifacts.test.ts` and the migration case in `migrations.test.ts`, `src/main/ipc/artifacts.ipc.test.ts`, `src/renderer/src/components/artifacts/*.test.tsx`, `MessageContextMenu.publish.test.tsx`, `MessageStream.artifacts.test.tsx`; the E2E spec `e2e/specs/artifacts.spec.ts`.
