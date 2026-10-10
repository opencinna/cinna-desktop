# Bundles Catalog

## Purpose

Browse and one-click-install agent bundles published on the connected Cinna server, without leaving the desktop app. Three surfaces offer it: Settings → Profile → Catalog, the **Catalog** dialog behind the Agents sidebar's **+ → Install from catalog**, and the chat composer's add-agents picker ([Inline Catalog Install](inline_install.md)). The desktop never re-implements the publisher's credential setup forms — when a freshly installed bundle is missing credentials, the user is deep-linked into the cinna-server credential pages and the desktop polls until the runtime gate clears.

The three surfaces do not read the same list. The sidebar's **Catalog** dialog is the one catalog: cinna-core's `GET /api/v1/catalog/items`, which holds agents that run in Cinna (bundles), agents that run on the user's computer ([shared folder agents](../local_agents/team_sharing.md)) and skills, side by side. Settings → Profile → Catalog and the composer picker still read the older bundle-only `GET /api/v1/catalog/` and show cloud agents only.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Bundle** | Versioned, publisher-owned packaging of an agent on cinna-server, identified by a reverse-DNS `bundle_id`. See [Agent Bundles](https://github.com/) on cinna-server for the full model |
| **Catalog** | Visibility-aware list of what the active Cinna user can see (public, granted, or own). Two readings of it exist: the bundle list `GET /api/v1/catalog/` (Settings → Catalog, the composer picker) and the item listing `GET /api/v1/catalog/items` (the sidebar's Catalog dialog, and team sharing) |
| **Catalog item** | One row of `GET /api/v1/catalog/items`, of one of three kinds: an agent that **Runs in Cinna** (`kind: agent`, `runs_on: cloud` — a bundle), an agent that **Runs on your computer** (`runs_on: desktop` — a shared folder agent) or a **Skill** (`kind: skill`). Each has a `uuid`, a catalog id (`bundle_id` or `package_id`), its latest version (**Version N**, with the publisher's own label beside it when it has one: `Version 3 (1.2.0)`), its maintainers or publisher, and the caller's own installs (`my_installs`) |
| **Install** | A user's running copy of a bundle on cinna-server — an `Agent` row seeded from the latest revision. The desktop never owns this state |
| **Quick Install** | One-click install that mirrors the cinna-server install form's default submission: the desktop first fetches `/install-context` for the server's auto-prefill suggestions, then POSTs `/install` with a constructed body (PBP → `publisher_provides`, PBU/PBT with a suggested credential → `use_existing`, otherwise → `skip`) so existing credentials are linked instead of duplicated |
| **Setup Status** | Per-install runtime-gate verdict from cinna-server: `ready` / `needs_setup` / `publisher_broken`. Drives whether the post-install modal opens |
| **Missing Item** | One credential the install can't run without — either an empty user placeholder (`placeholder_empty`) or a broken publisher-shared row (`publisher_credential_missing` / `_unshared`) |
| **Setup Modal** | Post-install dialog that lists missing credentials as status cards; clicking a card opens the cinna-server credential page in the OS browser. Polls every 3s and on window focus until the gate goes `ready` |
| **Credentials Draft** | A placeholder credential cinna-server pre-creates during install for each user-provided spec — the desktop only needs to open it on the web for the user to fill in |
| **Catalog dialog** | The sidebar's catalog, titled **Catalog**: a fixed-height dialog with a search field and an **All / Agents / Skills** filter over one grid of tiles, every kind together, and a detail view per item. It displays; it owns no action — the install, a cloud agent's Update and a desktop agent's Get and Update all run in the list that opened it |
| **Kind badge** | **Runs in Cinna**, **Runs on your computer** or **Skill**, with an icon per kind: the one thing that tells the kinds apart, the same on a tile, a detail and an Inbox **Update available** card. There is no source switch and no source name — the user sees one catalog |
| **Install store** | The app-wide install state that runs a quick install for the Catalog dialog and the chat picker, so one install runs at a time across both and outlives whichever surface started it. Settings → Catalog keeps its own |
| **Catalog State Refresh** | The shared "catalog changed on the server" reaction: re-fetch `['catalog']` AND fire a remote-agent sync so the local `agents` table catches up immediately. Triggered by Install success, the setup modal flipping to `ready`, and the manual Refresh button |
| **Install Context** | Per-bundle install preview from `GET /catalog/{bundle_id}/install-context` — the server's auto-prefill matcher runs across every required credential and returns a per-spec verdict (matched / not matched) plus the publisher-AI-credential summaries (name + type per role). The desktop never sees the matched credential's UUID at this stage; only the boolean and the publisher's AI name/type strings reach the IPC boundary |
| **AI Credentials** | Two-role pair (Conversation, Building) the install binds separately from the required-credential specs. When the bundle ships AI credentials they're "provided by publisher" (billed to publisher); otherwise the install falls back to the user's account-wide AI defaults configured on the cinna server |

## User Stories / Flows

### Browsing the Catalog

1. Cinna user opens Settings → Profile → Catalog (the menu item lives next to "Agents" inside the active profile group)
2. The desktop fetches `GET /api/v1/catalog/` through its main-process proxy and renders one expandable card per bundle
3. Cards show display name, version label (`v<latest_version>` or `rev <n>` fallback), publisher name/email, the bundle ID as an inline-code pill, and the required-credential summary with each spec's type and provided-by classification rendered as badges
4. Expanding an uninstalled card triggers a lazy `useInstallContext(bundleId)` fetch; while it resolves, a spinner sits next to the "Required credentials" header and each row's icon stays as a placeholder. Once resolved, the icon flips per spec — green check (covered), template (cinna-server will materialise template fields the user fills in after install), or key (no match — the user will provide a brand new credential). An **AI credentials** sibling section appears under the required-credentials list and either names the publisher-provided Conversation / Building credentials (green check, "Shared by publisher" badge) or shows a single "AI credentials — your account defaults" row with a warning key icon
5. If the install-context fetch errors, a single warning chip appears at the top of the expanded body ("Couldn't check matching credentials — icons may be approximate") with a one-click Retry button; the credential icons fall back to the same provided_by-only heuristic the installed-card path uses, and the AI section hides itself because there's no publisher data to display
6. Bundles the user has already installed render a green "Active" pill and an "Installed" indicator instead of the Install button; the install-context query stays disabled for them and the credential icons fall back to a provided_by-only classification (publisher/template → green, user → key) because the match data wouldn't be actionable. The expanded body grows a footer with two actions: **Uninstall** (destructive, left-aligned) opens a confirmation modal that calls `POST /api/v1/agents/{install_id}/uninstall` — same endpoint cinna-server's own web UI uses — and **Open Agent** (right-aligned) opens `{cinnaServerUrl}/agent/{userInstallId}` in the OS browser. The uninstall modal mirrors cinna-server's wording: "This install will be removed and its environment stopped. Your per-bundle App Data is preserved — it will reattach automatically if you reinstall the bundle later." Server-rejected uninstalls (e.g. publisher install) render their server-supplied error inline in the modal so the user sees it in context

### Installing from the Agents sidebar

1. A Cinna user presses **+** in the Agents sidebar and chooses **Install from catalog** (the card is absent for any other profile). See [Agents Tab](../local_agents/agents_tab.md#installing-from-the-catalog)
2. The **Catalog** dialog opens on one grid of every item the account may use — agents that run in Cinna, agents that run on this computer, and skills — and opening it lists the catalog again, so what the user browses is the catalog as it is now. **All / Agents / Skills** narrows the grid; the choice is kept for the rest of the session, so the next open shows the same kind, and a restart starts from All. Search matches name, description, maintainers, publisher and catalog id
3. Each tile shows the kind's icon and the name on its own line, then the kind badge, a **Version N** chip and **by** its maintainers (or its publisher when none are named), a three-line description and a **Needs …** line naming its credential slots. Its footer holds the kind's action (below); a tile with no action has no footer. **Refresh**, beside the close button, runs the Catalog State Refresh and re-reads the team's copies
4. The action, by kind, in the catalog's words:
   - **Runs in Cinna** — **Get**, the same quick install as Settings. Once the install has synced into a local agent, **Open**, with **Update** beside it while the install is behind the latest version (the server's `bundle_version` once the agent has synced, the listing's version numbers before that). In the moment between an install and its sync there is nothing to open, so the tile says **Installed**
   - **Runs on your computer** — **Get**, then **Open**, with **Update** while the team has moved past this computer's copy: team sharing's own verbs ([Team Sharing](../local_agents/team_sharing.md#getting-an-agent-from-the-team)). A desktop agent team sharing does not list (one missing what a Get needs) has no action
   - **Skill** — no action yet. When one of this computer's agents pins it, the tile says **Added to N agents**; otherwise it has no footer
5. Clicking a tile's body opens the item's detail over the grid: the description in full, **Maintainers** (or **Shared by**), for a skill **In your agents**, **Users** (the install count), the **Catalog id**, the credential preview the Settings card shows (`CatalogCardCredentials`, one step down the type scale; its install-context check runs only for a cloud agent not yet installed), and **Versions**, read when the detail opens: each version newest first with its label, who shared it, the date (`13 Sep 2026`) and its release notes, long ones clamped behind **Show more**. A failed versions read stays in that section with **Retry**. Back — or Escape — returns to the grid with its filter, search and scroll position intact; a second Escape closes the dialog
6. **Get** on a cloud agent runs the quick install, then *awaits* a remote-agent sync and reads the agent list back to find the new local agent (`remoteTargetId === installId`)
7. On success the dialog closes and the user lands on that agent's page in chat mode. The setup status is then fetched; anything but `ready` — including a failed check — raises the **Setup Modal** over the page
8. A failed Get or Update lands at the bottom of that item's tile and under the detail header, and closes nothing. A first load that fails takes the grid's place with **Retry** (or **Re-authenticate**); a refresh that fails while tiles are on screen is one line beside **Refresh** — **Couldn't refresh.**, or **Session expired.** with **Re-authenticate** — and the tiles stay
9. A server without the item listing (`404` or `403`) shows **This server has no catalog yet.** rather than an error

### Update Available

> Implementation details: [Bundle Updates — Technical Reference](./bundle_updates_tech.md).

The version state that drives this flow rides the **agent sync**, not the catalog list. cinna-server attaches a `bundle_version` object (`installed_version` / `installed_revision_number`, `latest_version` / `latest_revision_number`, `update_available`, `update_mode`, `last_update_status`) to each consumer-install target on `GET /api/v1/external/agents`. The desktop persists it into `RemoteAgentMetadata.bundle_version` during `syncRemoteAgents`, so it flows to the renderer on every synced agent. The catalog list still carries only the `user_install_pending_update` boolean + `latestVersion` (→ `CatalogEntryDto.pendingUpdate`), used as a fallback when the matching synced agent isn't loaded yet. Surfaced in **four places** — the sidebar Catalog dialog's tile (**Update**, above), the Inbox, the Settings catalog card and the agent page:

**Inbox** — one **Update available for *X*** card per cloud agent whose install is behind and whose `update_mode` is not `automatic`: a server that updates the install on its own needs no one to press a button. The card is the same one a shared desktop agent gets ([The Inbox](../../jobs/tasks/inbox.md)); it carries the kind badge, **Version N** with its label, who published it and when, and **Update**, which applies the update below. It is derived on every Inbox read from the synced agents, so a finished update — here or anywhere else — clears it

**Catalog card** (Settings → Profile → Catalog)

1. `CatalogSettingsSection` joins each catalog entry to its synced agent by install id (`entry.userInstallId === agent.remoteTargetId`, both the cinna-server Agent UUID) and passes the agent's `bundle_version` down as `CatalogCard`'s `bundleVersion` prop
2. When the install is behind (`bundle_version.update_available`, or `pendingUpdate` if the sync hasn't surfaced it yet), the card surfaces the affordance **in the same header slot as the Install button**: the neutral `v<latest>` chip (which would misleadingly read as the *installed* version) is replaced by an amber **"v1.0 → v1.2"** transition chip (falls back to "Update available" when only one end is known), the status dot turns amber, and the right-side action becomes an amber **"Update to v\<latest>"** button (→ `rev <n>` / "Update" when there's no version string)
3. Only one install/update runs at a time — while an Update is in flight the other cards' Install/Update buttons disable

**Agent page** (Agents sidebar → agent → Settings → Connection)

4. The page's Connection view uses `AgentCard(connectionOnly)`, reading `agent.remoteMetadata.bundle_version`. A consumer install whose version is behind gets an amber banner **"Bundle update available · v1.0 → v1.2"** with an **"Update to v\<latest>"** button

**Both** surfaces share `deriveBundleUpdate()` (label/gate derivation) and the `useApplyBundleUpdate()` mutation:

5. Clicking **Update** calls `POST /api/v1/external/agents/{install_id}/apply-update` (the native-client wrapper) via `agents.applyBundleUpdate`. The server stops the environment, swaps in the new revision's bundle folders, restarts, and refreshes prompts — per-bundle App Data and credentials are preserved — and returns the fresh `BundleVersionInfo` snapshot
6. On success the mutation invalidates `['agents']` + `['catalog']` and kicks a remote sync, so the new `bundle_version` lands and the affordance clears on both surfaces; the Catalog shows a "*\<agent name\>* updated" toast, the Agents list clears its banner. Failures surface inline (`reauth_required` routes to the re-auth prompt)

### Quick Install (happy path — all credentials in order)

1. User clicks **Install** on a non-installed card
2. The desktop runs the two-step quick install (mirroring cinna-core's frontend `useQuickInstall` hook): first `GET /api/v1/catalog/{bundle_id}/install-context` so the server's auto-prefill matcher can surface a `suggested_credential_id` for every PBU/PBT spec that matches one of the installer's existing or shared credentials, then `POST /api/v1/catalog/{bundle_id}/install` with the constructed body (PBP → `publisher_provides`, suggested credentials → `use_existing` with the matched UUID, otherwise → `skip`; publisher AI credentials accepted via `use_publisher_ai` when offered). Without the context fetch the server would skip everything and materialise fresh placeholder/template rows even when the installer already owned a matching credential
3. On success the desktop immediately checks `GET /api/v1/agents/{install_id}/setup-status` and kicks off a remote-agent sync so the new install lands in the local `agents` table without waiting for the 5-minute periodic sync
4. Status comes back `ready` → toast "*\<agent name\>* installed", catalog query invalidates, the sync's `agents:remote-sync-complete` broadcast invalidates the agents query, the card flips to "Active", and the new install appears in the agent selector and the `@` mention popup

### Quick Install with Missing Credentials

1. Same first two steps as the happy path
2. The setup-status check returns `needs_setup` or `publisher_broken`
3. The **Setup Modal** opens, listing each missing item as a card
   - User-fillable placeholders are amber and clickable; clicking opens `{cinnaServerUrl}/credential/{credential_id}` in the OS browser
   - Publisher-broken rows are red and not clickable — the modal surfaces an "Open on server" fallback that lands on the install's Credentials tab
4. User fills in the credential on the web, returns to the desktop, the modal's focus listener triggers a re-poll, status flips to `ready`, modal auto-closes with a "*\<agent name\>* is ready" toast
5. While the modal is open it continues polling every 3 seconds — eventual consistency without user input
6. User can also close the modal manually; the install remains in `needs_setup` and surfaces a banner on the cinna-server install page next time they visit

### Refresh & Re-auth

- A manual **Refresh** button at the top of the section runs the [Catalog State Refresh](#core-concepts) — re-fetches the catalog AND syncs remote agents, so a bundle the user uninstalled on the cinna-server web UI is reconciled with one click on the desktop
- When the catalog call fails with `reauth_required` (Cinna 401/403), an inline error banner with a **Re-authenticate** button runs the existing Cinna OAuth flow and refetches on success

## Business Rules

- **Cinna-only feature** — the section short-circuits to a "sign in to Cinna" message for non-Cinna profiles. Catalog API calls go through the active profile's Cinna server URL and JWT, identical to the remote-agents flow
- **Server is the source of truth** — the desktop never persists catalog entries, install metadata, or credential drafts. Every action is a proxy call; UI state is derived from React Query caches
- **Single Catalog State Refresh primitive** — every catalog-changing operation (Install success, setup-modal flipping to `ready`, manual Refresh button) routes through the shared `useRefreshCatalogState()` hook which re-fetches `['catalog']` AND calls `agents.syncRemote()`. The sync's `agents:remote-sync-complete` broadcast then invalidates `['agents']` downstream — so no call site needs to remember to invalidate it manually, and the freshly-installed agent shows up in the `@` picker without waiting for the 5-minute periodic sync
- **Quick install only** — the desktop deliberately does not re-implement the cinna-server install form. Custom installs (per-spec credential picks, AI credential overrides) require the user to open the bundle on the web
- **Auto-prefill via install-context** — quick install always pre-fetches `/install-context` and forwards the server's per-spec `suggested_credential_id` as `use_existing` in the install body. Posting `{}` would tell the server to skip every spec and materialise a fresh placeholder/template row even for credentials the installer already owns; the context-driven payload is the only thing that links existing credentials at install time. The matching itself stays on the server (`CredentialsService.find_match_for_spec`) — the desktop never inspects the user's credential list
- **Install-context UUIDs stop at the main process** — the same `install-context` endpoint feeds both `quickInstall` (which keeps the matched UUIDs to build the install body) and the catalog card's per-spec icon (which only needs a `hasSuggestedMatch` boolean). The `InstallContextDto` projection deliberately drops `suggested_credential_id` / `suggested_credential_name` so the renderer never receives credential UUIDs over IPC
- **One install at a time** — while a Quick Install is in flight the other cards' Install buttons disable. Card-body expansion still works. The Catalog dialog and the chat picker share one app-wide guard in the install store, so an install started in one disables Install in the other; Settings → Catalog has its own `pendingBundleId` and does not share it
- **A sidebar install outlives the sidebar** — switching sidebar tabs unmounts the Agents list that opened the dialog. The install and its landing therefore live in the install store, and the setup dialog is rendered at the app root (`CatalogSetupHost`), so an install finished after the switch still opens the agent and still asks for credentials
- **A result that lands under another profile is dropped** — the store records the active profile when an install starts and discards its success or failure if the profile has changed by the time it finishes; the setup dialog hides under any profile but the one it was raised for. The new agent belongs to the other account, so nothing about it should appear under this one
- **Installed is not the same as added** — the store awaits the sync. If the sync fails, the tile says *"Installed, but it could not be added to your agents yet: …"* (or, for an expired session, *"Installed, but your Cinna session expired before it could be added — re-authenticate and it will appear."*); if the sync succeeds but the agent is not in the list, *"Installed — it will appear in your agents after the next sync."* The server install succeeded in each case, so the message never says it failed
- **Pointer clicks on a just-opened detail are ignored for 300 ms** — the detail's Get / Update / Open appear where the tile was clicked, and a double-click on a tile would otherwise install or update the item. Keyboard activation is never ignored. See [Agents Tab](../local_agents/agents_tab.md#a-control-that-appears-under-the-pointer-ignores-the-click-that-revealed-it)
- **The dialog never resizes** — it has a fixed height; switching between grid and detail, the filter, the search, an action's error and a failed refresh scroll inside it or sit in space the header always has ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 1)
- **One listing, two readers** — the Catalog dialog and [team sharing](../local_agents/team_sharing.md) read the same `GET /api/v1/catalog/items`, fetched and cached in main per profile (`libraryService`): a desktop agent's tile and its Sharing tab can never disagree about its version or access. The dialog keeps every kind as core sent it; team sharing derives its own entries from the desktop agents in it
- **The dialog is told when the listing moved, not on every poll** — main compares each new listing with the last. A move team sharing cares about (a desktop agent's head, version, access, visibility or listing) publishes `sharing:changed`; any other move the dialog shows (a cloud agent's install, a skill's new version, a name) publishes the lighter `catalog:items-changed`, which re-reads only the dialog's items and the Inbox. One event at most per listing, and never for someone else's install: the install count is not part of the comparison. Either way the renderer reads main's fresh cache rather than listing the catalog a second time
- **The dialog owns no action** — Get, Update and the cloud install run in the agents list that opened it, so closing the dialog mid-action loses nothing and the landing on the agent still happens. A cloud update's failure belongs to that visit and is cleared when the dialog closes; an update still running keeps going
- **Versions are read on demand and forgotten on close** — a detail's version list is fetched when it opens, kept while the dialog stays open, and dropped when it closes, so the next visit reads it afresh
- **Setup polling stops at ready** — `useSetupStatus` cancels the 3-second interval as soon as the query data settles on `status === 'ready'`. Window-focus and explicit refetch are the only paths that hit the server after that
- **Per-credential deep link requires a UUID** — only `placeholder_empty` items can resolve to `/credential/{id}` because the install owner doesn't have a credential row for `publisher_credential_*` reasons. Those cards render disabled, and the fallback "Open on server" button surfaces the install's Credentials tab from `setup-status.setup_url`
- **Uninstall is a server round-trip, and Settings → Catalog is the only place it starts** — it undoes an install, so it stayed on the card that performed one rather than being a second destructive verb in the agent page's ⋯ menu, next to a "Delete agent" that means something else. The card's Uninstall button calls `POST /api/v1/agents/{install_id}/uninstall` (same endpoint cinna-server's web UI uses). Server contract: the install row + environment go away, the per-bundle App Data volume is preserved (re-attached on next install of the same bundle), and publisher-installs are 400-rejected with a clear message that we render inline in the confirmation modal. The shared Catalog State Refresh then runs so the card flips back to uninstalled and the agent disappears from the `@` picker without waiting for the periodic remote-agent sync
- **Update is a server round-trip via the native surface** — the "Update to v\<latest\>" button calls `POST /api/v1/external/agents/{install_id}/apply-update` (the native-client wrapper, *not* the web `/agents/{id}/apply-update`). The server applies the bundle's latest revision in place (stop → swap folders → restart → refresh prompts), preserving App Data and credentials, and returns the post-update `BundleVersionInfo`. The desktop never compares revisions itself — it trusts the server's `update_available` (from `bundle_version` on the sync) and falls back to the catalog's `user_install_pending_update` boolean. The `useApplyBundleUpdate` mutation then invalidates `['agents']` + `['catalog']` and re-syncs so both surfaces clear without waiting for the periodic tick
- **Version state lives on the sync, not the catalog** — the catalog list (`/catalog/`) only carries `user_install_pending_update` + `latestVersion`; the installed version (needed for "v1.0 → v1.2") rides `bundle_version` on the agent-sync feed (`/external/agents`). The Catalog card joins the two by install id (`userInstallId === remoteTargetId`); the Agents list reads `bundle_version` straight off each synced agent. A single `deriveBundleUpdate()` helper produces the labels + gate for both
- **Reuses the profile activation gate** — every catalog IPC handler calls `userActivation.requireActivated()` first; deactivated profiles error before any HTTP call is made
- **Open-in-browser uses the shared `system.openExternal` IPC** — http(s)-restricted in the main process; the renderer never holds a `shell` reference
- **A failure's reason reaches the screen that acted** — loading the catalog, Quick Install and Update each report *why* they failed, not just that they did, so an expired Cinna session offers **Re-authenticate** (in the load banner of Settings → Catalog, and in the Catalog dialog's load failure and failed-refresh line) and install or update errors name the expired session. The app-wide re-auth prompt is raised as well. How the reason crosses the process boundary is in [Technical Reference → Security](./bundles_catalog_tech.md)
- **Other catalog calls report only a sentence** — install preview, uninstall, setup status, setup credentials and the server URL show their failure as text; none of them branches on an expired session

## Known gaps

Each entry carries the date it was checked and the method.

- None open. Until 17 Sep 2026 an expired session during catalog load or Quick Install showed a generic error with only **Retry**, because the failure's reason was lost between the main process and the renderer. See [Technical Reference → Security](./bundles_catalog_tech.md) for the fix and the test that pins it.

## Architecture Overview

```
Browse Flow:
  User opens Settings → Profile → Catalog
    → useCatalog() React Query
      → window.api.catalog.list()
        → catalog:list IPC
          → catalogService.list(userId)
            → GET {cinnaServerUrl}/api/v1/catalog/ (Bearer JWT)
            → Project ServerCatalogEntry[] → CatalogEntryDto[]
    → CatalogSettingsSection renders CatalogCard list

  User expands an uninstalled CatalogCard
    → useInstallContext(bundleId, expanded && !isInstalled)
      → catalog:install-context IPC
        → catalogService.getInstallContext(userId, bundleId)
          → GET {cinnaServerUrl}/api/v1/catalog/{bundle_id}/install-context
          → Project per-spec verdict (drop suggested_credential_id UUIDs)
            → InstallContextDto
    → Per-spec icon: green check | template | key (or spinner while loading)

Quick Install Flow:
  User clicks Install
    → useQuickInstallBundle().mutateAsync(bundleId)
      → catalog:quick-install IPC
        → GET  {cinnaServerUrl}/api/v1/catalog/{bundle_id}/install-context
        → buildDefaultCredentialsPayload + buildDefaultAISelections
            (PBP → publisher_provides, suggested → use_existing, else → skip)
        → POST {cinnaServerUrl}/api/v1/catalog/{bundle_id}/install (typed body)
        → Server: install_bundle → Agent row + AppDataVolume + auto MCP route
      → onSuccess → useRefreshCatalogState() runs
        → invalidate ['catalog']
        → window.api.agents.syncRemote() (broadcast invalidates ['agents'])
    → queryClient.fetchQuery(['catalog', 'setup-status', installId])
      → catalog:setup-status IPC → GET /agents/{id}/setup-status
    → Branch:
      • status === 'ready'   → success toast
      • status !== 'ready'   → open CatalogSetupModal (re-runs the same
                                refresh hook when status flips to ready)

Catalog Dialog Flow:
  Agents sidebar + → Add an agent → Install from catalog
    → CatalogBrowserModal (owned by LocalAgentsList; displays only)
      → useCatalogItems({ refresh: true })
        → catalog:items IPC → libraryService.items(userId, refresh)
          → GET {cinnaServerUrl}/api/v1/catalog/items (cached per profile;
             the same listing team sharing reads)
      → joined per tile with useTeamLibrary (desktop agents' local copies),
        useAgents (cloud installs synced to agent rows), useLocalAgents
        (agents that pin a skill)
  User opens a detail
    → useCatalogItemDetail(uuid) → catalog:item → GET …/catalog/items/{uuid}
  Main's listing moved (poll, action, another open)
    → sharing:changed       (desktop agents)  ─┐ renderer re-reads the dialog's
    → catalog:items-changed (any other item)  ─┘ items from main's cache + Inbox

Sidebar Install Flow (Get on a Runs in Cinna tile):
    → useCatalogInstall → catalogInstall.store.install(bundleId)
        (app-wide guard; profile id recorded)
      → catalog:quick-install
      → await agents:sync-remote          (failure → "Installed, but…" on the tile)
      → invalidate ['catalog'], ['agents'] → fetchQuery(['agents'])
      → find remoteTargetId === installId (missing → "it will appear…")
      → profile changed? → drop
      → landCatalogInstall                 (runs even if the list unmounted)
          → ui.store: external-agent page, chat mode
          → fetchQuery(['catalog', 'setup-status', installId])
          → not ready / check failed → store.pendingSetup
              → CatalogSetupHost (App root) → CatalogSetupModal
      → close the dialog                   (only if the list is still mounted)

Setup Modal Flow:
  CatalogSetupModal mounts
    → useSetupStatus({ installId, poll: true }) starts 3s polling
    → useSetupCredentials(installId) loads placeholder UUIDs once
    → For each missing item: render CredentialStatusCard
        amber + link to /credential/{uuid}  (placeholder_empty)
        red + disabled                       (publisher_*)
    → User clicks card → system.openExternal({cinnaServerUrl}/credential/{id})
    → Window regains focus
      → onFocus listener calls refetch()
      → status flips to 'ready' → onReady() → modal closes + toast
```

## Integration Points

- **[Agents Tab](../local_agents/agents_tab.md)** — **+ → Install from catalog** opens the Catalog dialog; a finished install lands on the new agent's page
- **[Team Sharing](../local_agents/team_sharing.md)** — the dialog's **Runs on your computer** agents: folder agents fetched as git repositories with Get and Update, not bundles installed on the server; and the cached item listing both read
- **[The Inbox](../../jobs/tasks/inbox.md)** — the **Update available for *X*** card, for a cloud agent behind its catalog version (manual update mode only) and for a shared desktop agent alike
- **[Agent Skills](../local_agents/skills.md)** — the skills a kit agent pins from the catalog. The dialog's **Added to N agents** and **In your agents** come from core's record of where the user holds a skill (`my_installs` rows with `where: local` and a `host_manifest_id`), matched by manifest id against this computer's agents; the desktop itself does not report skill pins
- **[Composer `[+]` Menu](../../chat/composer_menu/composer_menu.md)** — The same Quick Install is surfaced inline in the new-chat / add-agents Capability Picker via a bottom **Catalog** section (`useCatalogPicker`). It runs through the same install store as the Catalog dialog, then auto-selects the freshly-synced agent (matched by `remoteTargetId === installId`) so the user can start chatting in one click. It deliberately omits the post-install setup-status check / `CatalogSetupModal` — an incomplete install simply auto-replies "setup not complete" on first message, keeping the in-chat path seamless.
- **[Remote Agents](../remote_agents/remote_agents.md)** — Once a bundle is installed on the server, the existing periodic remote-agent sync pulls the new install into the local `agents` table on its next cycle, surfacing it in the agent selector and Settings → Profile → Agents. The cinna-server `/external/agents` response carries `bundle_uuid` and `is_publisher_install` under `metadata`, which the desktop persists into `RemoteAgentMetadata`. Profile → Agents is one server-domain visibility list, including hidden installs. `isBundleAgent` — a consumer install is `bundle_uuid` **and** `is_publisher_install: false`, never `bundle_id`, which cinna-server stamps on every agent at creation — gates the desktop's uninstall paths and, by complement, the Develop action; the agent page itself no longer offers Uninstall or any other destructive action for a server-hosted agent, only a link to its page there. Connection shows available bundle updates
- **[Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md)** — All catalog calls use `getCinnaAccessToken()` so token rotation and 401-driven re-auth work the same as for `cinnaApiService`
- **[Cinna Re-authentication](../../auth/cinna_accounts/reauthentication.md)** — The inline "Re-authenticate" button in the catalog error banner shares the `useCinnaReauth` flow used by the Profile → Agents section
- **[Resource Activation](../../core/resource_activation/resource_activation.md)** — Catalog handlers require an activated profile, matching the rest of the IPC surface
- **[Settings](../../ui/settings/settings.md)** — The Catalog menu item lives inside the Profile group (`PROFILE_SCOPE_TABS`), so deactivating the Cinna profile snaps the sidebar back to a default-scope tab
- **Cinna Server: Agent Bundles** — See `workflow-runner-core/docs/agents/agent_bundles/agent_bundles.md` for publisher-side rules (PBP/PBU/PBT credential modes, runtime gate, setup-status semantics)
