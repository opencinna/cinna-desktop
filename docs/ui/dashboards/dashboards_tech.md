# Dashboards — Technical Details

Implementation reference for [Dashboards](dashboards.md). The panel and the context block are [Dashboard Chat (tech)](dashboard_chat_tech.md).

## File Locations

### Main process (core modules, no Electron)

- `src/main/services/dashboards/componentScanner.ts` — `scanComponents(agent)`, `readComponent(agent, name, skill)`: reads `dashboards/<name>/component.json` and each skill's `<skill>/dashboards/<name>/`, validates by core's rules, returns `ScannedComponent` (`info` for the renderer, `spec` for main — null when invalid, `dir`, `shownDir`). `dashboardsFolderRole()` reads the layout's `dashboards` role. Caps: `MAX_COMPONENTS_PER_AGENT` 100, a `component.json` over 256 KB refused unread, content scans of page files skip files over 2 MB and stop at 300 files.
- `src/main/services/dashboards/dashboardService.ts` — dashboards and tiles: CRUD, limits, `resolveTile`, `resolveComponent`, `placements`, `resolveReference`, `credentialSlotReady`, `agentBundleId`, `agentSkillFolders`.
- `src/main/services/dashboards/dashboardRefreshService.ts` — the freshness policy: `ensureFresh`, `tileResult`, `preview`, `renewLease`, `dropLease`, `afterTurn`, `cancelAll`.
- `src/main/services/dashboards/endpointRunner.ts` — `createEndpointRunner(deps)`; the production `endpointRunner`.
- `src/main/services/dashboards/panelChat.ts`, `dashboardContext.ts` — see [Dashboard Chat (tech)](dashboard_chat_tech.md).
- `src/main/services/dashboards/dashboardsSkill.ts` — `cinna-dashboards` skill location, per-engine delivery, the Claude plugin, the prompt section, `skillDashboardComponentCount`.
- `src/main/db/dashboards.ts` — `dashboardRepo`; `src/main/db/migrations/dashboards.ts` — `migrateDashboards`.
- `src/main/ipc/dashboards.ipc.ts` — `registerDashboardHandlers` (registered from `ipc/index.ts`).
- `src/main/kit/dashboardsProtocol.ts` — the protocol's constants (name and script patterns, timeouts, limits, the schema's and bridge's bundle paths); `dashboardsProtocolParity.test.ts` holds each equal to the bundled schema.
- `src/main/services/htmlPreview/dashboardFrameServer.ts` — `createDashboardFrameServer(deps)`, `dashboardFrameCsp()`; `dashboardHelper.ts` — `dashboardHelperScript()`, `injectDashboardHelper()`.
- `src/main/host/desktop/htmlPreview.ts` — the production `dashboardFrameServer` and the three-way host routing in `handlePreviewRequest`; `htmlPreviewGuards.ts` — `dashboardFramePrefix()` and the tile-prefix rule in `previewFrameNavigation`.
- `src/main/services/localAgents/turnLock.ts` — `tryAcquireSharedYielding`; `commandService.ts` — `ExecuteOptions`, `executeLocalCommand`, `agentCommandEnv`, `YieldingAdmission`.
- `src/main/shell/cinnaNode.ts` — `withCinnaNode(env)`, the `CINNA_NODE` shim.
- `src/main/hub/core.ts` — the profile-closing hook, the `onRunClosed` → `afterTurn` bridge, `cancelAll()` in `shutdownHubCore`.

### Shared

- `src/shared/dashboards.ts` — every DTO and outcome type, `TILE_SIZE_SPANS`, `DASHBOARD_LEASE_RENEW_MS` (20 s), `DASHBOARD_LEASE_TTL_MS` (30 s), limits, `parseDuration`, `resolveParamWords`, `DASHBOARD_BRIDGE_PROTOCOL`.
- `src/shared/componentReference.ts` — `parseComponentReference`, `formatComponentReference`, `ownReferencePrefix`, `componentReferenceKey`; pure, used by the resolver and the markdown plugin.
- `src/shared/htmlPreview.ts` — `DASHBOARD_FRAME_SANDBOX`, `DASHBOARD_FRAME_HOST_PREFIX`.

### Preload

- `src/preload/index.ts` — `window.api.dashboards.*`.

### Renderer

- `src/renderer/src/components/dashboards/` — `DashboardsList` (the tab), `DashboardView` (header, grid, lease, focus), `Tile`, `TileBody`, `views/nativeViews.tsx`, `views/WebView.tsx`, `componentBridge.ts`, `AddToDashboardDialog`, `EditTileDialog`, `DashboardDialog`, `AgentDashboardsTab`, `ComponentCard`, `ComponentPreview`, `componentParts.tsx`, `componentReferences.ts` (remark plugin), `dashboardContext.ts`, `DashboardChatPanel`.
- `src/renderer/src/hooks/useDashboards.ts` — queries, mutations and `useDashboardsWatch`.
- `src/renderer/src/components/chat/chatMarkdown.tsx` — the chat's one markdown configuration (plugins, components, `urlTransform`), component references included; `DashboardOriginPill.tsx`.
- `src/renderer/src/components/layout/SidebarTabs.tsx`, `Sidebar.tsx`, `MainArea.tsx` (`case 'dashboard'`), `TopBar.tsx` (the pill); `agents/local/LocalAgentPage.tsx` (the Dashboards tab).
- `src/renderer/src/stores/ui.store.ts` — `sidebarTab: 'dashboards'`, `activeView: 'dashboard'`, `activeDashboardId`, `dashboardPanelOpen`, `dashboardPanelWidth`, `dashboardChatsStash`, `catalogItemRequest`, `AgentPageTab` `'dashboards'`.

## Database Schema

`src/main/db/migrations/dashboards.ts` (after `users`, creation only plus one idempotent column add); Drizzle in `src/main/db/schema.ts`:

- `dashboards` — `id`, `profile_user_id` (→ `users`, cascade), `name`, `sort_order`, timestamps.
- `dashboard_tiles` — `dashboard_id` (→ `dashboards`, cascade), `agent_manifest_id` (the agent's manifest id, not its folder), `component` (folder name), `skill` (null for the agent's own; added by `hasColumn` check), `title` (null = the component's), `size`, `position`, `params_json`, `refresh_override_json` (`{maxAge?, manual?}`), timestamps.
- `dashboard_tile_results` — primary key (`tile_id`, `params_hash`): `result_json`, `fetched_at`, `error`, `duration_ms`, `too_large`, `updated_at`. At most three param sets are kept per tile. A failure writes `error` and never clears `result_json`.
- `chats.origin_dashboard_id`, `chats.initial_title` — `migrations/chats.ts`. Deleting a dashboard nulls `origin_dashboard_id` on its chats (`dashboardRepo.delete`), and deletes results and tiles explicitly as well as by cascade, because a handle may have foreign keys off.

Dashboards are per profile; the agents whose components they show are folder agents, which live in the default scope.

## IPC Channels

All validated again in the service; every answer, refusals included, is data (`DashboardsOutcome`), because a thrown `code` never reaches the renderer. All require an activated profile.

- `dashboards:list`, `:create` (name), `:rename` ({dashboardId, name}), `:delete`, `:reorder` (ordered ids), `:tiles` (dashboard id → dashboard + `TileView[]`).
- `dashboards:add-tile` (`AddTileInput`: an existing `dashboardId` or a `newDashboardName`), `:update-tile`, `:move-tile` ({tileId, toIndex}), `:remove-tile`.
- `dashboards:components` (one agent's or every kit agent's), `:placements` (agent id).
- `dashboards:tile-result` (cached, runs nothing), `:ensure-fresh` ({tileId, reason}) — **`visible` and `manual` only; `after_turn` is main's own and is refused here** — `:preview` ({agentId, component, skill}) runs once and never caches.
- `dashboards:lease` (tile ids), `:drop-lease` (ids, or none for all).
- `dashboards:open-frame` (`{tileId}` or `{agentId, component, skill}` → `{token, url}`; refused unless the component is valid and its view is `html`), `:release-frame` (token).
- `dashboards:resolve-reference` ({reference, chatAgentId}) → `ComponentReferenceResolution`.
- `dashboards:panel-chat` — [Dashboard Chat (tech)](dashboard_chat_tech.md).
- Push: `dashboards:tile-changed` `{tileId}` via `host/events` (`publishEvent`), on every start and end of a run; the renderer invalidates that tile's result query.

## Services & Key Methods

### Scanning and findings

`componentScanner.ts` applies, by hand, the rules in the bundle's `protocols/dashboards.schema.json` and reports its `x-check-codes` (`script_missing`, `network_reference`, `root_relative_path`, `fetch_endpoint`, `sandbox_unsupported`, …) with agent-relative paths and severities. `conformance.test.ts` runs the validator over the kit's `conformance/dashboards/` cases; `dashboardsProtocolParity.test.ts` holds the constants in `dashboardsProtocol.ts` equal to the schema. The schema is core's: a disagreement is settled there and the desktop follows — never the reverse. The scanner's `missingCredentials` come from the agent's credential slots as `localAgentService` reports them (`componentAgentFrom`), judged by `credentialSlotReady`.

A tile's state is `ok`, `agent_missing` (no agent with that manifest id, or two), `component_missing`, or `invalid`.

### The endpoint runner

`endpointRunner.run(call)`: the shell, the process-group kill on timeout or abort, the managed uv and the credential environment are `commandService`'s `execute`; the runner adds stdin (the params JSON, closed at once — an EPIPE from a script that never reads it is swallowed), a 5 MB stdout cap (`too_large`), and a 2,000-character stderr tail (a rolling tail: the reason a script died is at its end).

- **Runtime by extension.** `.py` → `python <script>`, localized as `/run:` commands are (`uv run` beside a `pyproject.toml`; a missing uv is reported by `uvUnavailableReason`). `.js`/`.mjs`/`.cjs` → the user's `node` when one resolves on the child's `PATH`, else Cinna's own runtime as Node (`runtimeHost.nodeRuntime()`, the executable single-quoted because runs go through a shell and the app path has spaces, with `ELECTRON_RUN_AS_NODE=1` set on that one child). The fallback runs pure JS; a native addon fails with "This endpoint needs a native Node module; install Node to run it."
- **Script path.** The agent's own: agent-relative `dashboards/<name>/api/<file>`, quoted. A skill's: absolute, inside the skill's folder (possibly a read-only cache outside the agent). Working directory and credentials stay the agent's.
- **Timeout** from the endpoint's `timeout_s`, default 60, max 300.
- **At most three processes** across every dashboard; the rest queue. A call whose signal aborts leaves the queue.
- **Supersede.** One in-flight call per key (tile and endpoint): a newer call aborts the older, queued or running (`superseded`).
- **Outcomes.** `busy`, `superseded`, `cancelled`, `interrupted`, `timeout`, `failed`, `too_large`, `not_json`. The refresh service stores an error for `timeout`, `failed`, `too_large` and `not_json`; `busy`, `superseded`, `cancelled` and `interrupted` keep the data and write nothing (a preview shows no error for `superseded` either).
- **Output is data.** stdout is parsed, then string values are redacted (`redactCredentialValues`) — redacting the raw text first could corrupt the JSON.

### The turn lock

Dashboard runs take the agent's lock **shared**, with owner `'dashboard'`, through `turnLock.tryAcquireSharedYielding(agentId, owner, onPreempt)`:

- **Refused, never thrown (`null`), while an exclusive holder exists or an exclusive acquisition is queued** for the agent. The reason: with reader preference a steady stream of tile refreshes would keep an editor save or a credential write out for as long as a dashboard stayed open. Turns and `/run:` commands keep `withSharedLock`.
- **Taken only once a runner slot is free**, so a queued run never holds a save out while it waits.
- **Preemptible.** `onPreempt` makes the hold evictable: an exclusive acquisition that finds only preemptible holders (`preemptAll`) removes them, calls each `onPreempt` — which aborts the run and kills its process group — and proceeds instead of refusing. A holder with no `onPreempt` still blocks. The run comes back `interrupted` and the tile keeps its data; the next refresh runs it again. A preempted run is a re-runnable read whose result is discarded, so a process killed a moment after a write starts cannot leave the folder half-written by the desktop.
- A file source's `refresh.command` runs through `commandService.run(…, { yieldingOwner: 'dashboard' })`, which admits through the same yielding path (`busy` → `turn_in_progress`, preempted → aborted).

`queuedExclusive` counts `withQueuedLock` waiters per agent and is cleared by `releaseAll()` with the rest of the lock state.

### Refresh service

`dashboardRefreshService` is created with injected dependencies (`createDashboardRefreshService`) so the policy is testable without a shell. State: `inFlight` per `${tileId}|${paramsHash}`, `controllers`, `pending` (runs and previews, for quit to wait on), `uncached` (results over `MAX_CACHED_RESULT_BYTES` = 1,000,000, memory only), `leases` (tile → {userId, expiresAt}), an `epoch` bumped by `cancelAll` so a run that finishes after a profile close writes nothing.

- `paramsHash` — sha-256 of the sorted params, first 32 hex characters. `resolveParamWords` turns `current` (a month) and `today` (a date) into values in local time **at run time**, so an endpoint never sees the words and the tile keeps them, so "current" follows the calendar.
- `wantsRun(reason, tile, scanned)` is the whole policy: `manual` always; `after_turn` as in the business doc; `visible` when there is no row, or no data and no error yet, or — unless Manual with data — the last attempt (`updated_at`) is older than the max age.
- A file source is read after realpath inside the agent folder, never a credential file, up to 5 MB: `.json` as is, `.csv` as `{csv}`, `.md` as `{markdown}`; a missing file says "<path> is not there yet."
- `renewLease` dedupes and caps at `MAX_LEASED_TILES` (100) and re-checks each tile with `visible`. `afterTurn` only asks tiles with a live lease.
- `cancelAll` aborts every controller, drops leases and in-memory results, and resolves when every run and preview has ended; `shutdownHubCore` awaits it with the other process groups.
- Missing credentials short-circuit before any run: the answer is the cached result with a sentence in `error` (`missingCredentialsMessage`), stored nowhere.
- `after_turn` source: `runExecutionState.onRunClosed(listener(chatId, agentId))`, wired in `hub/core.ts` to `afterTurn(getProfileScopeUserId(), agentId)`. `runClosed` now carries the agent id (null when the turn ended before one was resolved).

### The frame host

URL: `cinna-preview://dash-<H>/<tile>/<entry>` on the existing `cinna-preview` scheme. `handlePreviewRequest` routes by host: `dash-` → `dashboardFrameServer`, `art-` → the artifact preview, anything else → the HTML preview.

- **One host per profile** (`H` a 16-byte random token minted on first use, dropped when another profile is active) and **one path token per mounted frame**, released on unmount (`dashboards:release-frame`). Tiles share the host because each host is its own site to Chromium and costs a renderer process. At most 64 frames at once (`MAX_DASHBOARD_FRAMES`); the oldest is dropped.
- **The component is found again on every request** (`resolve`), so an edit to the page shows on reload and a deleted component 404s.
- **GET and HEAD only.** The file comes from the path alone: safe segments only (`isSafeAssetSegment`), never a first segment `api` (endpoints run through the bridge), realpath inside the component folder, never a credential file (`isCredentialFilePath`) or a layout `secret_files` match (judged by the agent-relative path, `shownDir`, when a skill's folder is outside the agent; an unreadable contract serves nothing a secret rule could name). Larger than the preview limit → 413. The URL and query are never logged or stored.
- **CSP, scoped to the tile's own path**: `default-src 'none'`; `connect-src`, `script-src` (plus `'unsafe-inline'`), `style-src` (plus inline), `img-src` (plus `data:` `blob:`), `font-src`, `media-src` limited to `cinna-preview://<host>/<tile>/`; `form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`, `worker-src 'none'`. Never `'self'` (every tile on the host would match it) and never the scheme source (it would load other tokens and the HTML preview's files). `frame-src 'none'` because the navigation guard lets a frame nested in a HTML preview load the web.
- **CORS** `Access-Control-Allow-Origin: *`: the frame's opaque origin makes every request cross-origin. `Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer`.
- **Sandbox** `DASHBOARD_FRAME_SANDBOX` = `allow-scripts allow-forms allow-modals` — the HTML preview's flags without `allow-top-navigation-by-user-activation`. No `allow-same-origin`: the page cannot reach `window.parent`'s DOM or `window.api`, and keeps no storage.
- **Navigation guard.** `previewFrameNavigation` keeps a subframe inside its own `…/<tile>/` prefix (parsed, so `..` and encodings are normalised first): a page cannot load another tile's or another preview's URL.
- **The bridge is injected byte for byte.** `injectDashboardHelper` puts `<script>` + the bundled `protocols/dashboards-bridge.js` right after `<head …>`, else `<html …>`, else after a doctype, else first. The page's own bytes are untouched either side (latin1 maps one byte to one character, so the offset is a byte offset); a UTF-16 page is returned unchanged since the helper would corrupt it. The file is read from this build's bundle, never a workshop kit's, because the host side of its wire (`componentBridge.ts`) ships with the build; `getBundledContractDir()` missing throws `contract_missing`. The desktop keeps no fork of it.
- `src/renderer/index.html`'s app CSP already allows `frame-src cinna-preview:`.

### The host side of the bridge

`componentBridge.ts` (`createBridgeSession`, MCP Apps JSON-RPC over postMessage) follows the schema's `host_contract`:

- **Whose message:** `event.source` is this tile's frame window and `origin` is `"null"`; anything else is ignored.
- **The nonce** is issued in the `ui/initialize` result (`_meta.cinna.nonce`) and **rotated on every `ui/initialize`**, which is accepted at any time because a reloaded or navigated document starts over. It is not reset on the iframe's `load` event: a new document's handshake arrives before that event. Every other message must carry the current nonce, where the bridge puts it (`params._meta`, `result._meta`, `error.data._meta`).
- **Data only after `initialized`** from the document holding the nonce: `ui/notifications/tool-result` carries the result and `{stale, fetchedAt}`; `ui/notifications/host-context-changed` carries the theme and the CSS variables, re-sent after the theme class lands.
- **Methods:** `ui/initialize`, `ui/notifications/initialized`, `ui/update-model-context` (answered `{}`; its `{summary, selection}` goes to the tile's context, summary capped at 16,000 and selection at 200 ids). `cinna/params-changed` is dropped. Any other request — `tools/call`, `ui/message`, `ui/open-link` — gets a JSON-RPC error (`-32601`), so `cinna.call` rejects with `{message}`; other notifications are dropped.
- A result is sent once per computation (`fetchedAt`).

### Delivering the skill

`dashboardsSkill.ts` — the skill is core's (`resources/cinna-agent-kit/skills/cinna-dashboards/`, with `scripts/check_component.py`), listed in `PLATFORM_SKILL_NAMES` so no workspace or catalog skill may take the name. Delivered as `cinna-artifacts` is, with **no profile gate**, and only to **kit folder agents** (`isKitFolderAgent` in `drivers/index.ts`: not a conductor, AI function, synthetic chat or build session, and `localAgentService` says `kit`):

- **Claude** — a desktop-owned local plugin under `<userData>/cinna-plugins/cinna-dashboards/`, rebuilt only when the skill's tree hash changes and swapped in whole; the launcher's `dashboardsSkillPlugin(userId, agentId)` dep adds it after the artifacts plugin.
- **OpenCode** — `collectSkillPaths` (`engineConfigSource.ts`) adds the skill's own folder to `skills.paths` whenever the bundle has it; the config is one for every agent, so a bare folder's agent sees it listed too, though only a kit agent's prompt names it. `CONVERSATION_PERMISSIONS.skill` allows `cinna-dashboards` by name so opening it never stops a turn on an ask.
- **Codex** — a pointer in the prompt: "Read `<absolute SKILL.md>` before you build…". Codex has no skill loader.
- **Antigravity** — a pointer on the native branch; an **isolated** home gets a copy through the launcher's `dashboardsSkill` dep (`{name, dir}` installs, `{name, dir: null}` removes an earlier copy), and the system-prompt builder in `drivers/index.ts` rewrites the pointer to `skill` there.
- **The prompt section** (`cinnaDashboardsSection`, appended by `assembleAgentPrompt` for a kit agent): open or read the skill; check each component from the agent's folder with `uv run python <absolute check_component.py> dashboards/<name>` — the **desktop's own copy**, by absolute path, because the workshop's `.cinna-kit/` may be a downloaded one a version behind; the agent's reference prefix (`agentReferencePrefix`: the bundle form `cinna://component/bundle:<bundle id>/` when the manifest's `bundle.bundle_id` — else `app-data/desktop.json` `shared_remote.bundle_id` — is known, else `id:<manifest id>/`; the manifest wins). A manifest with neither id gets no section.
- **`CINNA_NODE`.** `check_component.py --run` runs a Node endpoint as `[CINNA_NODE, script]` and never probes it. `withCinnaNode(env)` (`shell/cinnaNode.ts`) sets it on **session** environments only (the Claude, Codex, Antigravity and OpenCode launchers' child envs in `drivers/index.ts` — not a probe or a login): the user's own `node` when one resolves on the `PATH` the engine gets, else a small shim the desktop writes under `<userData>/bin/cinna-node` (a `.cmd` on Windows) around the host's Node runtime. The shim exists because the raw app binary opens a second copy of the app unless `ELECTRON_RUN_AS_NODE=1`, and that variable must never be set in an engine's own environment — so it lives inside the shim, for the one process it starts. It is rewritten only when its content differs, so its path (part of the engine env that feeds a launch key) is stable across turns.
- **Add-on picker.** A skill entry carries `dashboardComponents` (`shared/addons/directory.ts`), counted in main by `skillDashboardComponents` from the copy cached on this machine (marketplace or catalog; `catalogSkillCache` and `marketplaceSkillCache` resolve it by digest, the catalog's revision read from its download path). Zero or no copy says nothing.

## Renderer Components

- `DashboardsList` — the tab: one row per dashboard, **+** and right-click rename/delete; opens the first dashboard itself when none (or a gone one) is open.
- `DashboardView` — the header (Edit layout, Chat, Refresh, ⋯), the 12/6/3-column grid (110 px rows, 12 px gap; `ResizeObserver` picks the columns), `useTileLease` (an `IntersectionObserver` per tile feeds visibility; a first sighting leases at once, batched to one call per tick, and asks `ensureFresh('visible')`), `useTileDrag` (pointer-event reorder: the order shown while dragging, one `moveTile` on release), `useDashboardChat`.
- `Tile` — one fixed-size box; the top strip is reserved so content never sits under the hover bar. `TileBody` picks the view; `nativeViews.tsx` draws markdown, table (reusing `PreviewBody`'s `DataTable`), list and metrics, with row selection; `WebView` mints and releases a frame and runs `useComponentBridge`.
- `AddToDashboardDialog`, `EditTileDialog` — max-age select and the Manual switch (`RefreshFields`).
- `AgentDashboardsTab` — the agent's **Dashboards** Settings tab, kit agents only (`LocalAgentPage`; hidden for a bare agent), built like the tabs beside it.
- `ComponentCard` / `componentReferences.ts` / `chatMarkdown.tsx` — a remark plugin turns reference lines into a `cinna-component-refs` element; `chatUrlTransform` keeps `cinna://component/` hrefs, which react-markdown would otherwise empty; `ComponentRefScopeContext` carries the chat id (for **Ask to fix**) and the message's agent.

## Configuration

- No settings, no environment variables for the user. Limits are constants: 20 dashboards, 24 tiles, 80-character names, 120-character titles, 3 concurrent processes, 5 MB stdout, 1 MB cached result, 64 frames, 100 components per agent, lease 20 s/30 s.
- Contract: dashboards need kit contract **1.19.x** (see [Kit Contract (tech)](../../agents/local_agents/kit_contract_tech.md)). The folder role falls back to `dashboards` under an older workshop contract.

## Security

- **The renderer never names a path.** It names dashboards, tiles, agents and components; main resolves each against the folders it scanned.
- **A component is untrusted code and untrusted text.** Its page is sandboxed with an opaque origin, a path-scoped CSP, no network of its own, no top navigation and a tile-confined navigation guard; its endpoints run only through the runner, with the agent's own credentials, caps and process-group kill, and never from the renderer's request.
- **Nothing runs from text.** A reference in a chat is only named and resolved; Preview, Add, a visible tile and Refresh run a source.
- **Credentials.** The frame server never serves a credential or `secret_files` path; endpoint output is redacted before it is cached or shown; missing credentials stop a run before it spawns.
- **Profiles.** A dash host belongs to the profile that minted it: a request under another active profile 404s and drops the host.

## Tests

`componentScanner.test.ts`, `conformance.test.ts`, `dashboardService.test.ts`, `dashboardRefreshService.test.ts`, `endpointRunner.test.ts`, `dashboardsSkill.test.ts`, `dashboardFrameServer.test.ts`, `htmlPreviewGuards.test.ts`, `turnLock.test.ts`, `cinnaNode.test.ts`, `shutdown.test.ts` (quit kills dashboard runs), `componentBridge.test.ts`, `componentReferences.test.tsx`, `ComponentCard.test.tsx`, `Tile.test.tsx`, `DashboardsList.test.tsx`, `AgentDashboardsTab.test.tsx`, `componentReference.test.ts`. E2E: `dashboards.spec.ts`, `dashboard-cards.spec.ts`, `dashboard-panel.spec.ts`, and the billed `live-dashboards.spec.ts` (see [E2E](../../development/e2e/e2e_llm.md)).
