# Cloud Tiles — Technical Details

Implementation reference for [Cloud Tiles](cloud_tiles.md). Local tiles, the frame host, the bridge and the refresh policy are [Dashboards (tech)](dashboards_tech.md); the panel and the context block are [Dashboard Chat (tech)](dashboard_chat_tech.md).

## File Locations

### Main process (core modules, no Electron, except where noted)

- `src/main/services/dashboards/remote/coreDashboardsClient.ts` — `coreDashboardsClient`: every cinna-core call the cloud tiles make, over `cinnaSend`, with core's wire shapes typed (`CoreTileData`, `CoreComponent`, `CoreFrame`, `CoreBlock`, `CoreDashboard`, `CoreRefResolved`, …). `toOutcome` turns core's refusals into `CoreOutcome` data (see [Error mapping](#error-mapping)). Never logs a frame URL.
- `src/main/services/dashboards/remote/cloudComponent.ts` — `listCloudAgents` / `findCloudAgent` (the profile's synced remote rows whose `remoteTargetType` is `agent`; `owned` = `canDevelopAgent`; `bundleId` from `remoteMetadata.bundle_id`), `profileServerUrl`, `serverHost`, and the mapping of core's component (`component_json` parsed with `validateComponentSpec`, files not looked for) to the `ComponentInfo` the renderer draws, with `cloud: CloudOrigin` set.
- `src/main/services/dashboards/remote/backingDashboards.ts` — `ensure` (make, check, re-make once), the background sync (`renamed`, `deleted`, `tileRemoved`, `titleChanged`, `refreshChanged`), the refresh-override mapping, pending refresh changes (`resendRefresh`, `hasPendingRefresh`, `MAX_REFRESH_RESENDS` 3), `deleteOrphanBlocks`.
- `src/main/services/dashboards/remote/remoteTileSource.ts` — a cloud tile's data behind the refresh service's calls: the mirror (`CLOUD_PARAMS_HASH` `cloud`), `markFor` (core outcome → `CloudTileMarkCode` and sentence), `callRefusal` (what a page receives), the poll, pending wakes, `reconnected`, the socket handlers.
- `src/main/services/dashboards/remote/cloudFrames.ts` — `cloudFrames`: opening a frame for a cloud tile or a cloud preview, and the page state sent to core (`PAGE_STATE_RESEND_MS` 10 min); `reset()` on profile close.
- `src/main/services/dashboards/remote/remoteFrames.ts` — `openRemoteFrame`: the cap held in memory, the `/d/v/` fetch, re-mints (`REMOTE_FRAME_REFRESH_MS` 5 min, `REMOTE_FRAME_REMINT_GAP_MS` 60 s), `REMOTE_FRAME_MESSAGES`.
- `src/main/services/dashboards/remote/coreEvents.ts` — `createCoreEvents(deps)`, the production `coreEvents`: the socket.io connection and its lifecycle, `CLOSE_DEBOUNCE_MS` 5 s, `SERVER_CLOSE_RETRY_MS` 5 s.
- `src/main/services/htmlPreview/frameOwners.ts` — `createFrameOwners(release)`: which renderer (an opaque webContents id) opened each frame token, released all at once when that renderer goes.
- `src/main/host/desktop/dashboardFrameOwners.ts` (Electron) — the production `dashboardFrameOwners`; watches a webContents' full-page navigation, `render-process-gone` and `destroyed` the first time it opens a frame.
- Branches in `dashboardService.ts` (`resolveCloudRow`, `addCloudTile`, `cloudComponents`, `cloudAgent`, async `resolveReference`, `resolveCloudBlock`, `mirrorCloudParams`), `dashboardRefreshService.ts` (every call branches on `tile.cloud`; `cloudTileUpdated`, `cloudTileHighlight`, `cloudConnected`), `panelChat.ts` (`openCloud`), `dashboardContext.ts` (`dashboardContextPayload`), `htmlPreview/dashboardFrameServer.ts` (`registerRemote`).
- `src/main/services/runExecutionService.ts` (`dashboardContextFor`), `agents/drivers/{driver,a2aDriver}.ts`, `services/a2aStreamingService.ts` (`a2aMessageMetadata`) — the context as A2A metadata.
- `src/main/db/dashboards.ts` — `isCloudTileRow` (the one reader of a tile row's `source`), `cloudTileCount`, lookups by core block and by core agent, `latestCoreSessionForAgent`, recording the backing dashboard.
- `src/main/hub/core.ts` — `coreEvents.setHandlers({tileUpdated, tileHighlight, connected})`; on profile close `coreEvents.closeAll()` then `cloudFrames.reset()`; `coreEvents.closeAll()` on quit.

### Shared, preload

- `src/shared/dashboards.ts` — `CloudOrigin` (`remoteAgentId`, `server` host) as optional `cloud` on `ComponentInfo` and `TileDto` (absent = local); `TileView.agentName`; state `wrong_server`; `TileResultDto.cloud: CloudTileStatus` (`mark`, `paramsResolved`, `missingCredentials`) and `CloudTileMarkCode`; error codes `unreachable`, `reauth_required`, `env_unavailable`, `adapter_unsupported`, `not_owner`, `wrong_server`; reference misses `not_owner`, `unreachable`; `CloudComponentsOutcome`; `MAX_CLOUD_TILES_PER_DASHBOARD` 20, `CLOUD_TILE_POLL_MS` 30 s.
- `src/preload/index.ts` — `dashboards.cloudComponents(agentId)`.

### Renderer

- `components/agents/ExternalAgentPage.tsx` — the Dashboards tab for an owned agent (`canDevelopAgent`, the same test as main's `owned`); a requested tab the page lacks falls back to Overview.
- `components/dashboards/AgentDashboardsTab.tsx` — `CloudAgentDashboardsTab`, sharing the folder tab's rows, Preview and Add.
- `components/dashboards/componentParts.tsx` — `agentPlace` ("<agent> in the cloud"), `cloudRefusalSentence`, `CloudRefusal` (`retryOn`, default `unreachable`), `RetryLink`, `openCinnaSignIn`, `useCinnaServerName`; `openAgentTab` opens a cloud agent's own page.
- `Tile.tsx` / `TileBody.tsx` / `views/WebView.tsx` — the mark pill and its actions, the frame failure block and its reopen rule (once per changed result, and `CLOUD_FRAME_REOPEN_GAP_MS` = 10 s from the last open, because every cloud mint wakes the environment), Remove copy per state, disabled controls on a gone tile, `tileParamsShown`. `TileFilters` takes `resolved` (core's values for `current`/`today`). `EditTileDialog` hides on-app-start for a cloud tile. `DashboardChatPanel` keeps a refusal's code.
- `hooks/useDashboards.ts` — `useCloudComponents`, keyed under `['dashboards','placements']` so an add, remove or move re-reads it.

## Database Schema

`migrations/dashboards.ts`, idempotent column adds:

- `dashboards.core_dashboard_id` (the backing dashboard, null before the first cloud tile), `dashboards.core_server` (the profile's server URL when it was made).
- `dashboard_tiles.source` (`local` default, or `remote`), `remote_agent_id` (the core agent), `core_block_id`, `cloud_component_json` (the last `CoreComponent` core described, stored without its `placements`, so a tile draws its view offline and after a restart, and an add elsewhere does not rewrite every cache). `agent_manifest_id` stays NOT NULL and holds `''` for a cloud row (no table rebuild). Index on `remote_agent_id`.
- A cloud tile's data is one `dashboard_tile_results` row under params hash `cloud`, written from core's answer; a failure never clears it. Placements of a folder agent filter on `source = 'local'`.

## IPC Channels

- `dashboards:cloud-components` (remote agent row id) → `CloudComponentsOutcome`: core's list mapped, plus this profile's tiles of them. Refusals `not_owner`, `unreachable`, `reauth_required`, `not_found`.
- `dashboards:components` answers `[]` for a remote agent.
- `dashboards:add-tile`, `:update-tile`, `:remove-tile`, `:rename`, `:delete`, `:tiles`, `:tile-result`, `:ensure-fresh`, `:set-params`, `:call`, `:preview`, `:placements`, `:open-frame`, `:release-frame`, `:highlight-ready` and `:panel-chat` take a cloud tile or a remote agent row unchanged and branch in main. `:resolve-reference` and `:panel-chat` are async.
- `:open-frame` records the opening webContents (`event.sender.id`) on success; `:release-frame` forgets the token first.
- No new push channel: core's events surface as `dashboards:tile-changed` and `dashboards:tile-highlight`.

## Services & Key Methods

### Error mapping

`coreDashboardsClient.toOutcome(status, ok, body)`:

- A component route's `{error: {code, message, retry_after_s?, field?}}` passes its code when it is one of `rate_limited`, `needs_credentials`, `call_failed`, `invalid_input`, `not_found`, `env_unavailable`, `adapter_unsupported`.
- Otherwise by status: 403 → `not_owner`, 404 → `not_found`, 400/422 → `invalid_input`, 409 → `limit_reached`, 429 → `rate_limited`, 502/503/504 → `unreachable`, else `call_failed`; the message is `detail` (string, or `detail.message`).
- A transport failure is `unreachable`; `reauth_required` / `not_cinna_user` / `missing_server_url` are `reauth_required`; a profile change mid-request (`CinnaSessionChanged`) is `unreachable`.

`remoteTileSource.markFor` writes the sentence: `unreachable` and `reauth_required` with the server's host, `not_found` and `not_owner` → `agent_gone`, `env_unavailable`, `adapter_unsupported` (core's sentence), `needs_credentials` (`needsCredentialsMessage`), `rate_limited`. `callRefusal` passes `invalid_input`, `not_found`, `rate_limited`, `needs_credentials`, `call_failed` to a page and turns every other code into `call_failed` with the mark's sentence.

### Tile states

`resolveCloudRow(userId, row, dashboard)`: `wrong_server` when the dashboard's `core_server` differs from the profile's server; `agent_missing` when no synced cloud agent has that core id, the profile does not own it, or core answered `not_found` for it (`goneCloudAgents`); `component_missing` when the stored component is absent or core's list no longer has it; `invalid` when core reports error findings; else `ok`. Only an `ok` tile gets a `CloudTileRef` (core dashboard, block, agent name, server, parsed spec) — the handle main uses to call core, never sent to the renderer. Each agent's component list is re-read in the background from `tiles()`, at most once per `CLOUD_CATALOGUE_TTL_MS` (60 s, `shared/dashboards.ts`), and publishes a tile change when it differs. `tiles()` is the only trigger, so `useDashboardTiles` re-asks every `CLOUD_TILES_POLL_MS` (15 s, a quarter of the TTL) while the open dashboard holds a cloud tile (TanStack pauses it while the window is hidden). Polling at the TTL itself would often be dropped by the throttle, whose last-read stamp other asks (tile pushes, the Dashboards tab, the warm-up) reset at any moment, and would wait two periods; at a quarter, core is still read once a minute at most and a component broken, fixed or retitled elsewhere reaches an open dashboard within about 75 s, without reopening it.

### Adding and syncing

- `addCloudTile`: the owned check, `getComponent` (error findings → `component_invalid`), the 20-tile count, `backing.ensure`, `addBlock` (grid `0,0`, `w/h` from `TILE_SIZE_SPANS`, `config {component, skill, params: {}, refresh}`), then the row. A refused 409 for core's block limit runs `deleteOrphanBlocks` (blocks no local row references) and retries once. A failed row write deletes the block; a failure after `madeHere` deletes both the desktop dashboard and its backing one.
- Server identity: `sameCoreServer` / `onOtherCoreServer` (`remote/cloudComponent.ts`) are the one comparison everywhere (case and trailing slashes ignored); a profile with no server URL (signed out) is never `wrong_server`.
- The stored component (`cloud_component_json`) carries the agent's name as `agent_name` (ours, not core's), so a tile whose agent the sync removed still names it.
- `ensure` refuses `wrong_server` for a dashboard recorded on another server, re-makes a backing dashboard core says is gone once, and turns core's 409 for its 50 desktop dashboards into `limit_reached` with a desktop sentence.
- Core replaces a block's whole `config` on update and re-checks it, which wakes the environment. A refresh change therefore reads the block first and writes its current params back with the new `refresh`; if the stored params changed during that read and write, it writes once more with the newest. `whileOpenEvery: null` (interval off) is sent as `"manual"`, because core's `null` means "the component's". `manual` and `onAppStart` are desktop-only. A refused or unanswered refresh change stays pending per tile and is resent after the next refresh core ran, at most three times; one per tile in flight; removing the tile drops it.

### Refresh

`remoteTileSource` behind `dashboardRefreshService`:

- `visible` → `tileData` (wake false), mirror; when `stale` and not Manual-with-data → `refreshTile(open)` on the tile's first sighting in this run, `reshow` after; `waking` while in flight. A read within `READ_DEDUPE_MS` (2 s), or one already running, is joined; a lease that arrives during a non-waking read (poll, event) sets a pending wake honoured when that read settles.
- `manual` → `refreshTile(manual)`; `interval` → `refreshTile(interval)` (a `skipped: env_asleep` answer is no error); `after_turn` → only when the effective rule (`effectiveRefresh(spec, override)`) says `afterTurn`, and not for Manual-with-data; `launch` and `schedule` → nothing.
- `setParams` → `setTileParams` (whole set) under the desktop's per-target check; success mirrors the owner's values on the row and `params_resolved` in the status. `call` → `callTile`; `preview` with a remote agent → `runComponent(tileKey: 'preview')`.
- The poll: while any cloud tile is leased and `!coreEvents.isLive(userId)`, re-read each every `CLOUD_TILE_POLL_MS`; the tick also notices lapsed leases. A poll answer that succeeds clears an `unreachable` mark. `coreEvents.want(userId, any cloud lease)` follows the leases.
- `reconnected(userId)` (the socket's `connected` handler, through `dashboardRefreshService.cloudConnected`) re-reads every leased cloud tile of that profile without waking, so marks from an outage clear and a failed frame reopens.
- `cloudTileUpdated(userId, blockId)` → re-read data and the block's params (`getDashboard`, `mirrorCloudParams`), publish. `cloudTileHighlight(userId, blockId, ids)` → `tileHighlights` and `dashboards:tile-highlight`, as a local highlight.
- A read or refresh that finishes after the profile closed writes nothing.

### The frame relay

- `cloudFrames.openTile` / `openPreview` → `mintTileFrame` / `mintComponentFrame(tileKey 'preview')`. `frame_url` is `<content origin>/d/v/<cap>/<entry>`; the content base (through `/d/v/<cap>/`) and the entry are split and held in memory only. A tile on another server is refused `wrong_server`; a tile whose component was never read is minted anyway and core refuses a non-page component.
- `dashboardFrameServer.registerRemote(frame, userId)` gives the same host, path token, CSP, sandbox headers and navigation rule as a local frame. Each request's path is checked segment by segment (`isSafeAssetSegment`, no dot segments, no `api/`), `encodeURIComponent`-ed, and must stay under the content base. GET and HEAD only, `redirect: 'manual'` (a 3xx is a 404), Content-Length checked and the body capped at the preview limit, no Authorization (the cap is the credential). Only a cleaned `Content-Type` is taken from core. Core's bridge is already in the entry page (byte-identical to the bundled file, posting with `"*"`), so nothing is injected.
- **Re-mint.** Lazily once the cap is within 5 minutes of `expires_at`, and on a 404 from `/d/v/` (core's answer to an expired cap, the same as a missing file; 401/403 alike): one re-mint per request, then one retry, and the second answer stands. A frame re-mints on a refusal at most once per 60 s; a request refused in that gap retries with a cap another request minted since, else answers 404. A failed expiry mint also waits 60 s, the old cap serving meanwhile. Every mint wakes the environment, which is why a page of missing files must not mint in a loop.
- Relay errors: 503 → "The agent's environment isn't running.", 502 → unreadable, network → "Can't reach the Cinna server."
- **Page state.** A page document id per load; `putPageState({pageDoc, highlightReady, seq})` when the page says it listens, resent every 10 minutes (core forgets readiness after 15); withdrawn with `ifPageDoc` when the page loads again or the frame is released. `seq` = `max(now × 1000, last + 1)` per tile.
- **Owners.** `frameOwners` releases a webContents' tokens on a full-page navigation, a crash or destruction, through the same path as `release-frame` (page state withdrawn, resend stopped, token no longer served). Without it, a reloaded window's frames would never be released: React cleanups do not run then.

### Core's events

`coreEvents` (socket.io-client, path `/ws`, transports websocket then polling, reconnection on, at most 30 s between retries):

- `auth` is asked on every (re)connect and fetches a fresh access token (`getCinnaAccessToken`), because core checks the token only at connect.
- Open while `want(userId, true)`; closed `CLOSE_DEBOUNCE_MS` after the last `want(…, false)`, on `closeAll`, when another profile wants one, and when the profile's Cinna session generation changed (the next reconnect opens a new one).
- A session that needs a sign-in stops it until the session changes.
- Core closing the socket (`io server disconnect`) is retried after 5 s. Core refusing at connect (`connect` returns false → `CONNECT_ERROR`) makes socket.io-client destroy the socket and never reconnect, so `connect_error` with `!socket.active` schedules `connect()` itself: 5 s doubling to 5 minutes, one pending, reset by a successful connect.
- Core emits every event as `event` `{type, model_id, meta}`; `dashboard_tile_updated` and `dashboard_tile_highlight` are routed by `meta.block_id` (and `meta.ids`); matching a block to a tile is the handler's.
- `connected(userId)` fires on every connect. Never logs the server URL or a token.

### References

`resolveReference` (async): `bundle:` — the chat's own agent, a local agent, then an owned cloud agent with that bundle id via `getComponent`. `id:`/slug in a cloud agent's chat — `resolveRefs` with a core session of the profile's chats with that agent (`latestCoreSessionForAgent`): core's match of the chat's agent wins over a local slug; a reference core says names another agent falls through to local agents, then `agent_not_here`; core's `env_asleep` / `adapter_unsupported` and an unanswered call read `unreachable`. A non-owned cloud agent is `not_owner`.

### Panel chat and context

See [Dashboard Chat (tech)](dashboard_chat_tech.md#cloud-agents).

## Configuration

- `socket.io-client` (^4.8) is a main-process dependency, externalised by the build and shipped with production dependencies. `socket.io` is a devDependency, for the E2E fake core.
- Limits: 20 cloud tiles per dashboard (core's block limit), core's 50 desktop dashboards per user, 30 s poll, 10 min page-state resend, 5 min early re-mint, 60 s re-mint gap.

## Security

- **The renderer never sees core ids, a frame cap or a server URL** — only `CloudOrigin` (core agent id, server host).
- **The cap is a credential:** held in main's memory, never logged, never in an error message, never in a URL the renderer sees. Relayed bytes get the desktop's frame policy, never core's headers.
- **Nothing is sent to another server** than the backing dashboard's; logs carry no URLs.
- **Every new handler requires an activated profile**, and results that land after a profile switch are dropped.

## Tests

`remote/coreDashboardsClient.test.ts` (`toOutcome`), `remote/backingDashboards.test.ts`, `remote/remoteTileSource.test.ts`, `remote/remoteFrames.test.ts`, `remote/cloudFrames.test.ts`, `remote/coreEvents.test.ts`, `htmlPreview/frameOwners.test.ts`, `dashboardService.cloud.test.ts`, `db/migrations/dashboards.test.ts`, the cloud cases in `dashboardFrameServer.test.ts`, `dashboards.ipc.test.ts`, `panelChat.test.ts`, `dashboardContext.test.ts`, `a2aDriver.test.ts`, `a2aStreamingService.test.ts`, `run.routing.test.ts`; renderer `Tile.cloud.test.tsx`, `ExternalAgentPage.dashboards.test.tsx`, `hooks/useDashboards.cloud.test.tsx` and cloud cases in `AgentDashboardsTab`, `ComponentCard`, `EditTileDialog` and `dashboardContext` tests. `kindBranches.test.ts` pins the two `source` reads (`db/dashboards.ts`, `componentParts.tsx`). E2E: `dashboard-cloud.spec.ts` (fake core in the spec, `e2e/fixtures/fakeCinnaDashboards.ts`) and the billed `live-dashboard-cloud.spec.ts` against a local cinna-core (see [E2E](../../development/e2e/e2e_llm.md)).
