# Artifacts — Technical Details

Behaviour and rules: [Artifacts](artifacts.md). The agent's tool, its approval and the skill: [Agent Publish (tech)](agent_publish_tech.md).

## File Locations

**Shared**
- `src/shared/artifacts.ts` — every type that crosses IPC (`ArtifactView`, `ArtifactViewFile`, `ArtifactsViewOutcome`, `ArtifactPreviewOpenResult`, `ArtifactPreviewTextResult`, `ArtifactsSupport`, `ArtifactInspection`, `PublishArtifactInput`, `ArtifactsPublishOutcome`, `ArtifactDetail`, `ArtifactCardDto`, `ArtifactErrorCode`), channel names, `FALLBACK_ARTIFACT_LIMITS`, the wording helpers (`artifactKindLine`, `artifactAudience`, `formatArtifactBytes`) and `artifactIdFromUrl`.

**Main**
- `src/main/services/artifacts/publishService.ts` — `createArtifactService(deps)`: support, inspect, publish, detail, visibility, links, local reads. Core service: no Electron.
- `src/main/services/artifacts/artifactService.ts` — the production wiring (profile, account, discovery, `cinnaFetch`/`cinnaSend`, folder locate, repo, events) and the `installArtifactsSkillGate` call.
- `src/main/services/artifacts/inspect.ts` — `inspectArtifactPath`, `exclusionFor`, `decideKind`: the walk.
- `src/main/services/artifacts/zip.ts` — `buildZip`, the archive sent.
- `src/main/ipc/artifacts.ipc.ts` — thin handlers (activation gate, delegate).
- `src/main/db/publishedArtifacts.ts` — `publishedArtifactRepo`; `src/main/db/migrations/published-artifacts.ts`; tables in `src/main/db/schema.ts`.
- `src/main/auth/cinna-oauth.ts` — `CinnaEndpoints` gained `instance_name` and `artifacts`.
- `src/main/services/cinna-http.ts` — `cinnaSend` accepts `DELETE` (revoking a link).
- `src/main/services/htmlPreview/artifactPreviewServer.ts` — `createArtifactPreviewServer(deps)`: the token registry and `cinna-preview://art-<token>/…` handler for a published revision, without Electron. Wired in `src/main/host/desktop/htmlPreview.ts` (`artifactPreviewServer`); `handlePreviewRequest` routes a request on the one `cinna-preview` scheme by host (`art-` prefix → this server, else the HTML preview's).
- `src/main/ipc/html_preview.ipc.ts` — `html-preview:open-artifact` and `html-preview:read-artifact-text` beside the HTML preview's channels.
- `src/main/hub/core.ts` — reads support as each profile becomes ready.

**Preload**: `src/preload/index.ts` — `window.api.artifacts`; `window.api.htmlPreview.openArtifact` / `readArtifactText` (`release` ends an artifact preview too).

**Renderer**
- `src/renderer/src/components/artifacts/PublishArtifactDialog.tsx`, `ArtifactCard.tsx` (card, drawer actions, Share popover, `ArtifactLinkCard`, `useArtifactProgress`), `ArtifactPreviewModal.tsx` (the Preview, whose header has the owner-only **Share…** — owner from `useArtifactDetail`, the card element kept as state to portal into; the header's files toggle, `panelChoice` state (null until the user toggles, so `filesPanelOpenByDefault` applies: `entry === null && files.length > 1`; closed and disabled until the view is in), `aria-expanded`/`aria-controls` on the list; Escape and an outside press close the popover first via a `shareOpen` ref the window listeners read; mounted by `ArtifactsHost.tsx`, which is mounted once in `App.tsx`).
- `src/renderer/src/stores/artifactPreview.store.ts` — which artifact is open, the click origin, `openSeq`.
- `src/renderer/src/components/chat/PreviewBody.tsx` — `PreviewBody`, `MarkdownPreview`, `JsonPreview`, `XmlPreview`, `CsvPreview`, shared with `FilePreviewModal` (extracted from it, nothing else changed).
- `src/renderer/src/hooks/useArtifacts.ts` — `useArtifactsSupport`, `useArtifactsSupportLoader`, `useArtifactCards`, `ArtifactCardsSource`, `useArtifactDetail`, `useArtifactEvents`.
- `src/renderer/src/stores/artifactPublish.store.ts` — the dialog's request and the one publish mutation.
- Surfaces changed: `components/chat/MessageContextMenu.tsx` (**Publish…**), `FilePreviewModal.tsx` (header **Publish…**), `fileRefs.tsx` (`MessageIdContext`, link cards), `MessageStream.tsx` (cards after messages), `stores/filePreview.store.ts` (`messageId`).

## Database Schema

Created by `migratePublishedArtifacts` in `src/main/db/migrations/published-artifacts.ts` (registered in `runAllMigrations` after `migrateInboxDismissals`; creation only). See [Migrations](../../development/migrations/migrations_llm.md).

- `published_artifacts` — one row per `(profile_user_id, server_url, artifact_id)` (unique), with `source_path` (the realpath, indexed with profile and server), `agent_id`, the last known `title`, `kind`, `revision`, `visibility`, `url`, `live_link_count`, and `approved_agent_id` (no longer read or written; the column stays to spare a migration). `agent_id` is what the agent policy trusts as "this agent published it". FK → `users` cascade.
- `chat_artifact_cards` — a card anchored after `message_id` of `chat_id`. FK → `users` and `chats` cascade; `message_id` is deliberately not a foreign key.
- The rows are a **cache of core**, kept in sync after every publish, detail read and share action (`repo.sync`); a 404 forgets the row. They are a hint for *Update* and for cards; nothing decides sharing from them; the agent policy reads core fresh for ownership.

## IPC Channels

All `ipcHandle`, all behind `userActivation.requireActivated()`, all returning data (a thrown code does not survive IPC).

- `artifacts:support` → `ArtifactsSupport` — `{supported, instanceName?, limits, linkOrigins?}`.
- `artifacts:support-changed` (main → renderer, `{profileId, support}`; `window.api.artifacts.onSupportChanged`) — `useArtifactsSupportLoader` applies it for the current profile only, and a reply to a `support()` asked before a push is dropped as older. Does not touch a context menu already open.
- `artifacts:inspect` (`{agentId, path, entry?}`) → `ArtifactsInspectOutcome`.
- `artifacts:publish` (`PublishArtifactInput`) → `ArtifactsPublishOutcome`.
- `artifacts:cards` (`chatId`) → `ArtifactCardDto[]`, from memory, no network.
- `artifacts:detail` (`artifactId`) → `ArtifactsDetailOutcome`, core's current state.
- `artifacts:set-visibility`, `artifacts:create-link` (`withCode?`), `artifacts:revoke-link` → outcomes carrying fresh detail.
- `html-preview:open-artifact` (`artifactId`) → `ArtifactPreviewOpenResult` — `{token, baseUrl, entry, files, revision}` or a failure. Reads the profile once, asks `artifactService.view`, registers the capability under that profile. `html-preview:read-artifact-text` (`token`, `path`) → `ArtifactPreviewTextResult`, cut at `MAX_PREVIEW_BYTES`. Both behind the activation gate; `html-preview:release` frees the token.
- `artifacts:local` (`artifactId`) → `PublishedArtifact | null`, memory only.
- Agent publish: `artifacts:approvals`, `artifacts:answer-approval` ([Agent Publish (tech)](agent_publish_tech.md)).
- Events to every window: `artifacts:progress` (`{operationId, phase}`, phases `packing` → `uploading` → `sharing`), `artifacts:changed` (`{artifactId}`; renderer re-reads cards, details and local reads), `artifacts:approvals-changed` (`{chatId}`).

## Services & Key Methods

`publishService.ts` (`createArtifactService`)
- `support()` — `knownSupported` first: a supported answer for the account's current server, this session's else the `artifact_support` row (`supportMemory`, `db/artifactSupport.ts`; migration `artifact-support.ts`, PK profile+server, instance name and the three limits; link origins are derived live, not stored). If there is one it returns at once and `supportFor` revalidates in the background; otherwise it awaits `supportFor`. `computeSupport`: the profile's user row must be `cinna_user` with tokens; `deps.discover` (`discoverCinnaEndpoints`, cached per server per session) must report `artifacts >= 1`; limits from `GET /api/v1/artifacts/capabilities` once per server, else `FALLBACK_ARTIFACT_LIMITS`.
- `supportFor` — one computation per profile at a time. Definite supported: row written if changed. Definite no (`noArtifacts`): row forgotten, retry stopped. Transient (discovery threw): the known supported answer stands, else unsupported, and `scheduleRetry` (active profile only, one timer, `schedule` injectable) asks again after 1 s doubling to `SUPPORT_RETRY_MAX_MS` (30 s); it ends on any definite answer or when the active profile changes. `settle` stores the answer per profile and, when it differs (supported, name, limits, link origins), publishes `artifacts:support-changed`. `supportedNow()` reads the same `knownSupported` synchronously — so the agent tool and the skill gate see a kept answer from startup.
- `inspect(input, options?)` — `confine` then `walk`. `confine` finds the agent folder from the agent id (or the validated session), takes `realpath` of the path (relative paths are resolved against the folder: the agent tool names files that way), requires `isWithin`, and applies `exclusionFor` to every segment of the path itself — so a file inside `credentials/` or a named `.env` is refused (`path_refused`, with the reason) as well as dropped inside a folder.
- `publish(input, options?)` — validates (title 1–200, description ≤ 2000, `visibility` one of `private|instance|link|keep`, `artifactId` a UUID), re-walks, re-checks entry and limits, reads each kept file with `O_NOFOLLOW` and the per-file cap, zips, then `POST /api/v1/artifacts` (new: `source_kind=desktop`, `source_label="<agent> · <path>"`) or `POST /api/v1/artifacts/<id>/revisions`. Then, per the chosen audience: `PATCH` visibility, or `POST …/links` (URL and code returned in the outcome; the URL is also remembered in memory, below). Failures of that follow-up become `warning`, not an error. Records memory (`recordPublish`, `sync`), anchors the card (`addCard`; after `anchor.messageId`, else `latestMessageId(chatId)`), emits `artifacts:changed`.
- `view(artifactId)` — `POST /api/v1/artifacts/<id>/view` for anyone core lets view it; `toView` checks the answer (an absolute `http(s)` content base ending in `/`, relative file paths with no `..`, an entry that is one of the files). Read-only, announces nothing. The result holds the capability (`contentBase`) and is main-side only.
- `createdLinkUrls` (`rememberLink`, keyed by profile, server and link id) — the URLs of links this app created this session, in memory only, because core returns a link's URL once. `readDetail` fills each `ArtifactLinkInfo.url` from core's `url` when it sends one, else from this map, else null (no copy icon). The code is not remembered.
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
- `ArtifactCard` — one bordered button (`data-artifact-card-body`, opens the preview) and, below it, the `data-artifact-card-drawer` row (`out` / `in`): `IconAction` buttons (Open, `CopyIconAction`, Share…) that are out while hovered, focused within, or Share… is open, and `pointer-events-none opacity-0` otherwise (the row keeps its height so nothing shifts). Each button's tooltip is an `aria-hidden` span shown by Tailwind `group-hover/focus-within` at once, not the native `title` delay; `.artifact-card-drawer` and `.artifact-icon-button` in `main.css` carry the fade and hover tint. Marks on the audience line: `data-artifact-warning-mark`, `data-artifact-error-mark` (a `role="alert"`). A deleted artifact disables the body and Share…. Copy link's "Copied" is a status, not a renamed button.
- `ArtifactCard` / `SharePopover` — the owner's card (`canShare`) reads `artifacts:detail` through `useArtifactDetail` (the query Share… and link cards share) and draws its audience line from core's answer, since grants are made on core's page and never reach the local row; until core answers, or if it fails, the row's audience stands. Open, Copy link (via main's clipboard: `navigator.clipboard` refuses once a dialog has focus), Share…; revoke asks inline in the row; a revoked link stays inert in place until the popover closes. Hide-this-note dismisses a one-time warning, read from `artifactPublish.store` (`warnings`) by the popover itself. **Create public link** sits on the Public links heading row (`min-w-[8.75rem]`, so "Copied" moves nothing): it calls `artifacts:create-link`, copies the URL, and marks the new row's icon copied; it is `aria-disabled` while busy or showing Copied. Each live link with `url` has a copy icon (`Copy public link <prefix>`). `SharePopover` is exported and takes `container` (portal target, default the body); the preview modal passes its dialog so the popover counts as inside it. The store no longer holds link URLs (`freshLinks` is gone).
- `ArtifactLinkCard` — any `/artifact/<uuid>` link (`artifactIdFromUrl(href)`, no origin list) when supported: skeleton at the card's height, then `artifacts:detail`; any failure renders the original link. When the href's origin is not already in `support.linkOrigins`, `LoadedArtifactLinkCard` draws the card only if `sameOrigin(detail.url, origin)` — core's own url for the id is the proof; a mismatch stays the link. Unsupported means no read at all. `ShownArtifactsContext` still keeps one card per artifact.
- `MessageStream` — cards are keyed by message id and pushed right after that message; `ArtifactCardsSource` is mounted only while supported, so an unsupported transcript asks nothing.
- The reference menu's items are decided once at open, with `canPublish`; a credential reference never gets **Publish…**.

## Artifact preview server

`artifactPreviewServer.ts`
- `register(artifactId, view, userId)` → `{token, baseUrl}`: token is `art-` + 24 random bytes in hex; `baseUrl` is `cinna-preview://<token>/`. At most `MAX_ARTIFACT_PREVIEW_TOKENS` (16), oldest dropped. `release` deletes.
- `handle(request)`: GET/HEAD only; the entry must exist and belong to `currentUserId()` (else deleted and 404); `artifactRelativePath` rejects empty, `.`, `..`, backslash and NUL segments after decoding; the target is `new URL(rel, view.contentBase)` and must still start with the base. Fetched with `runtimeHost.http.fetch`, no headers but `Range`, `redirect: 'manual'`, so no cookies or tokens of the app go to core's content origin: the capability in the path is the credential. The body streams back with core's type and `ARTIFACT_PREVIEW_CSP` (core's content policy, scoped to this scheme), `nosniff`, `no-store`, `no-referrer`; an HTML page gets `injectPreviewLinkHelper`. With `?cinna-view=text` (`ARTIFACT_PREVIEW_AS_TEXT`) a text type is served as `text/plain`, which a frame displays where `text/csv` would download.
- `freshView`: re-mints (`artifactService.view`) when the capability is within `ARTIFACT_VIEW_REFRESH_MS` (60 s) of `expiresAt`; concurrent requests share one mint.
- `readText(token, path)`: the same checks, then the file's text cut at `MAX_PREVIEW_BYTES` and decoded as UTF-8 (`decodePreviewText`). A directory path, a missing token or a path outside the base are failures as data (`not_found`, `path_refused`, `invalid_input`, `request_failed`).

`ArtifactPreviewModal` asks `htmlPreview.openArtifact` on mount and releases the token on close or when a late answer arrives for a closed modal. `artifactFileView(baseUrl, file)` decides per file: the file preview's kind by name then type → a text kind read via `readArtifactText` and drawn by `PreviewBody`; html, images, and `image|video|audio/*` → the sandboxed frame (`HTML_PREVIEW_SANDBOX`) at `baseUrl + path`; anything else → none. Both kinds render through `FilesView` (list + content; the list is omitted when collapsed, and the content's bottom-left corner rounds then). A site opens its `entry` (its frame is titled as the artifact, other files `title: path`); files open the first listed. The panel choice is component state, gone when the modal closes. With the list collapsed and more than one file, a non-entry file's path follows the revision in the header (`data-artifact-preview-path`). Picking the shown file again bumps a `reload` counter in the frame's key, remounting it. The toggle wears the header buttons' bordered shell so it does not read as a second kind icon.

## Configuration

- No setting. Support and limits are the instance's. The dependency is the discovery document's `artifacts` (integer) and `instance_name`, and `GET /api/v1/artifacts/capabilities`.
- Kit contract 1.12.0, and 1.13.0 for the `artifacts/` role (`protocols/artifacts.schema.json`, `skills/cinna-artifacts/`, `templates/artifact-sqlite-dashboard/`) — see [Kit Contract (tech)](../../agents/local_agents/kit_contract_tech.md).

## Security

- The view capability (`contentBase`) lives only in main (`ArtifactView`, the preview server's entries); IPC returns a token. A token works only for the profile that opened it and for paths under the base; the request carries no app credentials.

- The renderer sends `{agentId, path}` only; main finds the folder, re-realpaths, re-checks containment and exclusions, and re-inspects at publish. A path it cannot trust is `path_refused`.
- Excluded files are never read: the walk drops them before `readKept`, and `O_NOFOLLOW` plus a re-`fstat` size check refuse a file swapped for a link or grown past its cap since the walk.
- The token only goes to the profile's own API through `cinna-http`; the multipart body carries the archive, never credentials.
- A public link's code is never stored. Its URL is held only in main's memory for the session (core's own `url`, when it sends one, is used instead) and is never written to disk.
- Link cards read core only for an origin the profile itself owns or core named, so an `/artifact/<uuid>` link on an arbitrary host cannot make the desktop call it with a token. `MessageStream` provides `ShownArtifactsContext` (ids carded by `chat_artifact_cards` rows and by persisted or live `artifacts_publish` results); `ArtifactLinkCard` leaves a link to one of them as a link.

## Tests

`artifactPreviewServer.test.ts` (token scope, path refusals, re-mint, text mode, `readText`), `ArtifactPreviewModal.test.tsx`, and `publishService.test.ts` (`view`).

`src/main/services/artifacts/{inspect,publishService,zip,artifactsSkill}.test.ts`, `src/main/db/publishedArtifacts.test.ts` and the migration case in `migrations.test.ts`, `src/main/ipc/artifacts.ipc.test.ts`, `src/renderer/src/components/artifacts/*.test.tsx`, `MessageContextMenu.publish.test.tsx`, `MessageStream.artifacts.test.tsx`; the E2E spec `e2e/specs/artifacts.spec.ts` (loopback fake core). Against a real local core, with no fake: `e2e/specs/live-artifacts.spec.ts` (publish by an agent on each engine in `CINNA_E2E_LIVE_ARTIFACT_ENGINES`, Edit… and the Inbox answer, core's web pages, link cards) and `e2e/specs/live-artifacts-access.spec.ts` (per-person grants, link expiry and code lock-out, core's non-site viewers, no model turn). Both are manual; their recipes are in [E2E](../../development/e2e/e2e_llm.md).
