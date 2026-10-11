# Bundles Catalog

## Purpose

Browse and get what the connected Cinna server publishes — agents that run in Cinna (bundles), agents that run on the user's computer, and skills — without leaving the desktop app. Three surfaces offer it: the **Catalog** dialog behind the Agents sidebar's **+ → Install from catalog**, Settings → Profile → Catalog, and the chat composer's add-agents picker ([Inline Catalog Install](inline_install.md)). The desktop never re-implements the publisher's credential setup forms — when a freshly installed bundle is missing credentials, the user is deep-linked into the cinna-server credential pages and the desktop polls until the runtime gate clears.

All three surfaces read one list: cinna-core's `GET /api/v1/catalog/items`, cached in main per profile and shared with [team sharing](../local_agents/team_sharing.md). The dialog and Settings show every kind side by side, with the same tiles, the same detail and the same actions; the picker shows only the agents the user does not have yet. Settings used to read an older, bundle-only list (`GET /api/v1/catalog/`) and draw its own cards, so the two catalogs could disagree about what was installed and offered different actions on the same agent; that list and its cards are gone.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Bundle** | Versioned, publisher-owned packaging of an agent on cinna-server, identified by a reverse-DNS `bundle_id`. See [Agent Bundles](https://github.com/) on cinna-server for the full model |
| **Catalog** | Visibility-aware list of what the active Cinna user can see (public, granted, or own): the item listing `GET /api/v1/catalog/items`, fetched and cached in main per profile (`libraryService`). Every catalog surface and team sharing read that one cache |
| **Catalog item** | One row of the listing, of one of three kinds: an agent that **Runs in Cinna** (`kind: agent`, `runs_on: cloud` — a bundle), an agent that **Runs on your computer** (`runs_on: desktop` — a shared folder agent) or a **Skill** (`kind: skill`). Each has a `uuid`, a catalog id (`bundle_id` or `package_id`), its latest version (**Version N**, with the publisher's own label beside it when it has one: `Version 3 (1.2.0)`), its maintainers or publisher, and the caller's own installs (`my_installs`) |
| **Install** | A user's running copy of a bundle on cinna-server — an `Agent` row seeded from the latest revision. The desktop never owns this state |
| **Quick Install** | One-click install that mirrors the cinna-server install form's default submission: the desktop first fetches `/install-context` for the server's auto-prefill suggestions, then POSTs `/install` with a constructed body (PBP → `publisher_provides`, PBU/PBT with a suggested credential → `use_existing`, otherwise → `skip`) so existing credentials are linked instead of duplicated. The catalog's word for it is **Get** |
| **Setup Status** | Per-install runtime-gate verdict from cinna-server: `ready` / `needs_setup` / `publisher_broken`. Drives whether the post-install modal opens |
| **Missing Item** | One credential the install can't run without — either an empty user placeholder (`placeholder_empty`) or a broken publisher-shared row (`publisher_credential_missing` / `_unshared`) |
| **Setup Modal** | Post-install dialog that lists missing credentials as status cards; clicking a card opens the cinna-server credential page in the OS browser. Polls every 3s and on window focus until the gate goes `ready` |
| **Credentials Draft** | A placeholder credential cinna-server pre-creates during install for each user-provided spec — the desktop only needs to open it on the web for the user to fill in |
| **Catalog dialog** | The sidebar's catalog, titled **Catalog**: a fixed-height dialog with a search field and an **All / Agents / Skills** filter over one grid of tiles, every kind together, and a detail view per item. It displays; its actions run in the list that opened it. The one action it starts itself is a skill's **Add to agent…**, whose state lives in the query client's mutation cache, so it too outlives the dialog |
| **Settings → Catalog** | The same catalog on a settings page, in one section titled **Agents and skills**: the same filter, search, tiles, detail and actions, at the Settings type scale. The detail takes the grid's place rather than covering it |
| **Kind badge** | **Runs in Cinna**, **Runs on your computer** or **Skill**, with an icon per kind: the one thing that tells the kinds apart, the same on a tile, a detail, the picker's catalog card and an Inbox **Update available** card. There is no source switch and no source name — the user sees one catalog |
| **Install store** | The app-wide install state that runs every quick install — from the dialog, Settings and the chat picker — so one install runs at a time across all three and outlives whichever surface started it |
| **Catalog State Refresh** | The shared "catalog changed on the server" reaction: re-fetch `['catalog']` AND fire a remote-agent sync so the local `agents` table catches up immediately. Triggered by Install success, the setup modal flipping to `ready`, an uninstall, and the Refresh button |
| **Install Context** | Per-bundle install preview from `GET /catalog/{bundle_id}/install-context` — the server's auto-prefill matcher runs across every required credential and returns a per-spec verdict (matched / not matched) plus the publisher-AI-credential summaries (name + type per role). The desktop never sees the matched credential's UUID at this stage; only the boolean and the publisher's AI name/type strings reach the IPC boundary |
| **AI Credentials** | Two-role pair (Conversation, Building) the install binds separately from the required-credential specs. When the bundle ships AI credentials they're "provided by publisher" (billed to publisher); otherwise the install falls back to the user's account-wide AI defaults configured on the cinna server |

## User Stories / Flows

### Browsing the catalog

1. A Cinna user opens the catalog: **+** in the Agents sidebar → **Install from catalog** (the card is absent for any other profile; see [Agents Tab](../local_agents/agents_tab.md#installing-from-the-catalog)), or Settings → Profile → Catalog (the menu item lives next to "Agents" inside the active profile group). Settings under any other profile says only "The catalog is available when signed in to a Cinna account."
2. Either surface opens on one grid of every item the account may use — agents that run in Cinna, agents that run on this computer, and skills — and opening it lists the catalog again, so what the user browses is the catalog as it is now. **All / Agents / Skills** narrows the grid. In the dialog the choice is kept for the rest of the session, so the next open shows the same kind, and a restart starts from All; Settings starts from All on each visit. Search matches name, description, maintainers, publisher and catalog id
3. Each tile shows the kind's icon and the name on its own line, then the kind badge, a **Version N** chip and **by** its maintainers (or its publisher when none are named), a three-line description and a **Needs …** line naming its credential slots. Its footer holds the kind's action (below); a tile with no action has no footer. **Refresh** — beside the dialog's close button, or in the Settings section's header — runs the Catalog State Refresh and re-reads the team's copies
4. The action, by kind, in the catalog's words:
   - **Runs in Cinna** — **Get**, the quick install. Once the install has synced into a local agent, **Open**, with **Update** beside it while the install is behind the latest version (the server's `bundle_version` once the agent has synced, the listing's version numbers before that). In the moment between an install and its sync there is nothing to open, so the tile says **Installed**
   - **Runs on your computer** — **Get**, then **Open**, with **Update** while the team has moved past this computer's copy: team sharing's own verbs ([Team Sharing](../local_agents/team_sharing.md#getting-an-agent-from-the-team)). A desktop agent team sharing does not list (one missing what a Get needs) has no action
   - **Skill** — **Add to agent…**, a menu of this computer's kit agents (a bare folder has no manifest to pin into). Each row is an agent; one that already pins the package reads **Added**, one shared with the user to use only (or whose access is not known) reads **Can use only**, titled "Its skills come with the team's version", and until sharing status is read every row reads **Checking access…**; those rows are disabled. A pick reads **Adding…** and the others wait; main downloads the latest version, checks it and pins it ([Agent Skills](../local_agents/skills.md#adding-a-skill-from-the-catalog)). The menu closes on success; a refusal stays under that agent's row, and a refusal that lands after the menu was closed reopens it, so no failure goes unsaid. Escape closes the menu before the dialog. Beside the button, **In N agents** when any agent on this computer pins it
5. Clicking a tile's body opens the item's detail: in the dialog over the grid, in Settings in the grid's place. It holds the description in full, **Maintainers** (or **Shared by**), for a skill **In your agents** (their names), **Users** (the install count), the **Catalog id**, the credential preview (`CatalogCardCredentials`; its install-context check runs only for a cloud agent not yet installed — see [Credential preview](#credential-preview)), and **Versions**, read when the detail opens: each version newest first with its label, who shared it, the date (`13 Sep 2026`) and its release notes, long ones clamped behind **Show more**. A failed versions read stays in that section with **Retry**
6. An installed cloud agent's detail also has two icons beside its action: **Open in Cinna** (its page on the server, `{cinnaServerUrl}/agent/{install_id}`, in the OS browser) and **Uninstall** (below)
7. Back — or, in the dialog, Escape — returns to the grid with its filter, search and scroll position intact, focus on the tile that was opened in Settings and on the search field in the dialog; a second Escape closes the dialog
8. A failed Get or Update lands at the bottom of that item's tile and under the detail header, and closes nothing. A first load that fails takes the grid's place with **Retry** (or **Re-authenticate**); a refresh that fails while tiles are on screen is one line beside **Refresh** — **Couldn't refresh.**, or **Session expired.** with **Re-authenticate** — and the tiles stay
9. A server without the item listing (`404` or `403`) shows **This server has no catalog yet.** rather than an error

### Getting a cloud agent

1. **Get** on a Runs in Cinna tile or detail, from the dialog or Settings, runs the quick install in the install store: first `GET /api/v1/catalog/{bundle_id}/install-context`, so the server's auto-prefill matcher can surface a `suggested_credential_id` for every PBU/PBT spec that matches one of the installer's existing or shared credentials, then `POST /api/v1/catalog/{bundle_id}/install` with the constructed body (PBP → `publisher_provides`, suggested credentials → `use_existing` with the matched UUID, otherwise → `skip`; publisher AI credentials accepted via `use_publisher_ai` when offered). Without the context fetch the server would skip everything and materialise fresh placeholder/template rows even when the installer already owned a matching credential
2. Main lists the catalog again before answering, so the listing every surface reads already names the install and no surface offers **Get** on that bundle a second time
3. The store then *awaits* a remote-agent sync and reads the agent list back to find the new local agent (`remoteTargetId === installId`)
4. On success the dialog closes (Settings has nothing to close) and the user lands on that agent's page in chat mode. The setup status is then fetched; anything but `ready` — including a failed check — raises the **Setup Modal** over the page

### Quick Install with Missing Credentials

1. The setup-status check after a Get returns `needs_setup` or `publisher_broken`
2. The **Setup Modal** opens, listing each missing item as a card
   - User-fillable placeholders are amber and clickable; clicking opens `{cinnaServerUrl}/credential/{credential_id}` in the OS browser
   - Publisher-broken rows are red and not clickable — the modal surfaces an "Open on server" fallback that lands on the install's Credentials tab
3. User fills in the credential on the web, returns to the desktop, the modal's focus listener triggers a re-poll, status flips to `ready`, and the modal closes and runs the Catalog State Refresh
4. While the modal is open it continues polling every 3 seconds — eventual consistency without user input
5. User can also close the modal manually; the install remains in `needs_setup` and surfaces a banner on the cinna-server install page next time they visit

### Uninstalling a cloud agent

1. **Uninstall** (a package-with-a-cross icon) on an installed cloud agent's detail, in the dialog or Settings, opens a confirmation in cinna-server's wording: "This install will be removed and its environment stopped. Your per-bundle App Data is preserved — it will reattach automatically if you reinstall the bundle later."
2. Confirming calls `POST /api/v1/agents/{install_id}/uninstall`, the endpoint cinna-server's own web UI uses. While it runs the confirm cannot be dismissed; a server refusal (a publisher install, say) is shown inside it, and it stays open
3. Main lists the catalog again before answering, then the Catalog State Refresh runs: the confirm closes, the item reads as not installed with **Get**, and the agent leaves the `@` picker without waiting for the periodic sync

### Credential preview

The detail's credential section (`CatalogCardCredentials`) previews what a quick install would do with each required credential:

1. For a cloud agent not yet installed, opening the detail triggers a lazy install-context fetch; while it resolves, a spinner sits next to the **Required credentials** heading and each row's icon stays a placeholder. Once resolved, the icon flips per spec — green check (covered), template (cinna-server will materialise template fields the user fills in after install), or key (no match — the user will provide a brand new credential). An **AI credentials** section appears under the list and either names the publisher-provided Conversation / Building credentials (green check, "Shared by publisher" badge) or shows a single "AI credentials — your account defaults" row with a warning key icon
2. If the install-context fetch errors, a single warning chip appears ("Couldn't check matching credentials — icons may be approximate") with a one-click Retry; the icons fall back to a provided_by-only heuristic, and the AI section hides itself because there's no publisher data to display
3. For an installed agent the install-context query stays disabled and the icons use the provided_by-only classification (publisher/template → green, user → key), because the match data wouldn't be actionable

### Update Available

> Implementation details: [Bundle Updates — Technical Reference](./bundle_updates_tech.md).

The version state that drives this flow rides the **agent sync**. cinna-server attaches a `bundle_version` object (`installed_version` / `installed_revision_number`, `latest_version` / `latest_revision_number`, `update_available`, `update_mode`, `last_update_status`) to each consumer-install target on `GET /api/v1/external/agents`. The desktop persists it into `RemoteAgentMetadata.bundle_version` during `syncRemoteAgents`, so it flows to the renderer on every synced agent. Before an install has synced, the listing's own numbers stand in: the install's `revision_number` below the item's latest. Surfaced in **three places**:

**Catalog tile and detail** (the dialog and Settings) — **Update** beside **Open**, above. It applies the update below; only one update runs at a time, and a failure belongs to that item

**Inbox** — one **Update available for *X*** card per cloud agent whose install is behind and whose `update_mode` is not `automatic`: a server that updates the install on its own needs no one to press a button. The card is the same one a shared desktop agent gets ([The Inbox](../../jobs/tasks/inbox.md)); it carries the kind badge, **Version N** with its label, who published it and when, and **Update**. It is derived on every Inbox read from the synced agents, so a finished update — here or anywhere else — clears it. It does not wait for the five-minute agent sync: when a catalog listing lands that names a newer version of an install than its synced agent knows of, the desktop runs that sync once, and the card follows within seconds of the listing (a catalog opening, a sharing action, or the listing's own five-minute poll)

**Agent page** (Agents sidebar → agent → Settings → Connection) — the page's Connection view uses `AgentCard(connectionOnly)`, reading `agent.remoteMetadata.bundle_version`. A consumer install whose version is behind gets an amber banner **"Bundle update available · v1.0 → v1.2"** with an **"Update to v\<latest>"** button

Every surface applies it the same way, through `useApplyBundleUpdate()`:

1. **Update** calls `POST /api/v1/external/agents/{install_id}/apply-update` (the native-client wrapper) via `agents.applyBundleUpdate`. The server stops the environment, swaps in the new revision's bundle folders, restarts, and refreshes prompts — per-bundle App Data and credentials are preserved — and returns the fresh `BundleVersionInfo` snapshot
2. On success the mutation invalidates `['agents']` + `['catalog']` and kicks a remote sync, so the new `bundle_version` lands and the affordance clears everywhere. Failures surface inline (`reauth_required` reads as an expired session and raises the re-auth prompt)

### Refresh & Re-auth

- **Refresh** runs the [Catalog State Refresh](#core-concepts) — lists the catalog again AND syncs remote agents, so a bundle the user uninstalled on the cinna-server web UI is reconciled with one click on the desktop
- When the catalog read fails with `reauth_required` (Cinna 401/403), **Re-authenticate** — in the failed-load panel, or beside **Refresh** when tiles are on screen — runs the Cinna OAuth flow and reads the catalog again on success

## Business Rules

- **Cinna-only feature** — the catalog is read only for a Cinna profile; Settings → Catalog short-circuits to a "signed in to a Cinna account" sentence for any other. Catalog API calls go through the active profile's Cinna server URL and JWT, identical to the remote-agents flow
- **One list, every reader** — the dialog, Settings → Catalog, the composer picker and [team sharing](../local_agents/team_sharing.md) read the same `GET /api/v1/catalog/items`, fetched and cached in main per profile (`libraryService`): a desktop agent's tile and its Sharing tab can never disagree about its version or access, and two catalog surfaces can never disagree about what is installed. The catalog keeps every kind as core sent it; team sharing derives its own entries from the desktop agents in it
- **One set of tiles and actions** — the dialog and Settings are built from the same hooks (`useCatalogEntries`, `useCatalogActions`) and the same tile, detail and list parts; each takes the type scale of the surface it renders into ([UX Rules](../../development/ui_guidelines/ux_rules.md), rules 12 and 13). A second implementation is how the old Settings cards came to offer **Install** and **Open Agent** where the dialog offered **Get** and **Open**
- **Opening a surface lists again; the picker reads what is cached** — the dialog and Settings ask main to list the catalog again when they open, because the user came to see it as it is now. The picker, open on every new chat, reads main's cache. The three share one query, so whether a read lists again is asked of the surfaces observing it at that moment, not of whichever rendered last
- **Server is the source of truth** — the desktop never persists catalog entries, install metadata, or credential drafts. Every action is a proxy call; UI state is derived from React Query caches and main's in-memory listing
- **Single Catalog State Refresh primitive** — every catalog-changing operation (Install success, setup-modal flipping to `ready`, uninstall, Refresh) routes through the shared `useRefreshCatalogState()` hook which re-fetches `['catalog']` AND calls `agents.syncRemote()`. The sync's `agents:remote-sync-complete` broadcast then invalidates `['agents']` downstream — so no call site needs to remember to invalidate it manually, and the freshly-installed agent shows up in the `@` picker without waiting for the 5-minute periodic sync
- **An install or uninstall moves the listing before it answers** — main lists the catalog again (quietly: a failure is logged, never the verb's) before a quick install or an uninstall returns, waiting at most five seconds — past that the answer goes without it and the listing lands later with `catalog:items-changed` — so the re-read that follows already sees the change. Without it the cached listing still named the old state, and a surface offered **Get** on a bundle just installed
- **Quick install only** — the desktop deliberately does not re-implement the cinna-server install form. Custom installs (per-spec credential picks, AI credential overrides) require the user to open the bundle on the web
- **Auto-prefill via install-context** — quick install always pre-fetches `/install-context` and forwards the server's per-spec `suggested_credential_id` as `use_existing` in the install body. Posting `{}` would tell the server to skip every spec and materialise a fresh placeholder/template row even for credentials the installer already owns; the context-driven payload is the only thing that links existing credentials at install time. The matching itself stays on the server (`CredentialsService.find_match_for_spec`) — the desktop never inspects the user's credential list
- **Install-context UUIDs stop at the main process** — the same `install-context` endpoint feeds both `quickInstall` (which keeps the matched UUIDs to build the install body) and the detail's per-spec icon (which only needs a `hasSuggestedMatch` boolean). The `InstallContextDto` projection deliberately drops `suggested_credential_id` / `suggested_credential_name` so the renderer never receives credential UUIDs over IPC
- **One install at a time, app-wide** — while a quick install is in flight every other **Get** of a cloud agent disables, titled "Another agent is being added", on every surface: the dialog, Settings and the chat picker share one guard in the install store
- **An install outlives the surface that started it** — switching sidebar tabs unmounts the Agents list that opened the dialog, and leaving Settings unmounts its catalog. The install and its landing therefore live in the install store, and the setup dialog is rendered at the app root (`CatalogSetupHost`), so an install finished after the switch still opens the agent and still asks for credentials
- **A result that lands under another profile is dropped** — the store records the active profile when an install starts and discards its success or failure if the profile has changed by the time it finishes; the setup dialog hides under any profile but the one it was raised for. The new agent belongs to the other account, so nothing about it should appear under this one
- **Installed is not the same as added** — the store awaits the sync. If the sync fails, the tile says *"Installed, but it could not be added to your agents yet: …"* (or, for an expired session, *"Installed, but your Cinna session expired before it could be added — re-authenticate and it will appear."*); if the sync succeeds but the agent is not in the list, *"Installed — it will appear in your agents after the next sync."* The server install succeeded in each case, so the message never says it failed
- **Pointer clicks on a just-opened detail are ignored for 300 ms** — the detail's Get / Update / Open and a version's **Show more** appear where the tile was clicked, and a double-click on a tile would otherwise install or update the item. Keyboard activation is never ignored. See [Agents Tab](../local_agents/agents_tab.md#a-control-that-appears-under-the-pointer-ignores-the-click-that-revealed-it)
- **Nothing jumps** — the dialog has a fixed height; switching between grid and detail, the filter, the search, an action's error and a failed refresh scroll inside it or sit in space the header always has. Settings returns from a detail to the grid at the scroll position it left, and its page keeps a stable scrollbar gutter, so a filter that empties the list does not shift the page sideways ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 1)
- **The surfaces are told when the listing moved, not on every poll** — main compares each new listing with the last. A move team sharing cares about (a desktop agent's head, version, access, visibility or listing) publishes `sharing:changed`; any other move the catalog shows (a cloud agent's install, a skill's new version, a name) publishes the lighter `catalog:items-changed`, which re-reads only the catalog's items, the Inbox and the folder agents (their Skills rows show **Update** from the listing); `sharing:changed` re-reads the folder agents too. One event at most per listing, and never for someone else's install: the install count is not part of the comparison. Either way the renderer reads main's fresh cache rather than listing the catalog a second time
- **The surface that hosts the catalog owns its actions** — Get, Update and Uninstall run in a hook held by the Agents list that opened the dialog, or by the Settings section, never by the tiles that show the buttons, so closing the dialog mid-action loses nothing and the landing on the agent still happens. A failure belongs to the visit: it is cleared when the dialog opens or closes and when Settings → Catalog opens; an update still running keeps going
- **Versions are read on demand and forgotten on close** — a detail's version list is fetched when it opens, kept while the dialog or Settings → Catalog stays open, and dropped when it closes, so the next visit reads it afresh
- **Setup polling stops at ready** — `useSetupStatus` cancels the 3-second interval as soon as the query data settles on `status === 'ready'`. Window-focus and explicit refetch are the only paths that hit the server after that
- **Per-credential deep link requires a UUID** — only `placeholder_empty` items can resolve to `/credential/{id}` because the install owner doesn't have a credential row for `publisher_credential_*` reasons. Those cards render disabled, and the fallback "Open on server" button surfaces the install's Credentials tab from `setup-status.setup_url`
- **Uninstall lives with the catalog, not the agent** — it undoes an install, so it is offered on the catalog item the install came from (the dialog's or Settings' detail), never in the agent page's ⋯ menu, next to a "Delete agent" that means something else. Server contract: the install row + environment go away, the per-bundle App Data volume is preserved (re-attached on next install of the same bundle), and publisher-installs are 400-rejected with a clear message rendered inline in the confirmation. The confirm closes when the removal succeeds, not when the listing stops naming the install: that follows a re-read, and may name another install
- **Update is a server round-trip via the native surface** — **Update** calls `POST /api/v1/external/agents/{install_id}/apply-update` (the native-client wrapper, *not* the web `/agents/{id}/apply-update`). The server applies the bundle's latest revision in place (stop → swap folders → restart → refresh prompts), preserving App Data and credentials, and returns the post-update `BundleVersionInfo`. The desktop trusts the server's `update_available` (from `bundle_version` on the sync) and compares revision numbers itself only before the agent has synced. The `useApplyBundleUpdate` mutation then invalidates `['agents']` + `['catalog']` and re-syncs so every surface clears without waiting for the periodic tick
- **Reuses the profile activation gate** — every catalog IPC handler calls `userActivation.requireActivated()` first; deactivated profiles error before any HTTP call is made
- **Open-in-browser uses the shared `system.openExternal` IPC** — http(s)-restricted in the main process; the renderer never holds a `shell` reference
- **A failure's reason reaches the screen that acted** — reading the catalog, Quick Install and Update each report *why* they failed, not just that they did, so an expired Cinna session offers **Re-authenticate** (in the failed-load panel and the failed-refresh line of both catalog surfaces) and install or update errors name the expired session. The app-wide re-auth prompt is raised as well. How the reason crosses the process boundary is in [Technical Reference → Security](./bundles_catalog_tech.md)
- **Other catalog calls report only a sentence** — install preview, uninstall, setup status, setup credentials and the server URL show their failure as text; none of them branches on an expired session

## Known gaps

Each entry carries the date it was checked and the method.

- None open. Until 17 Sep 2026 an expired session during catalog load or Quick Install showed a generic error with only **Retry**, because the failure's reason was lost between the main process and the renderer. See [Technical Reference → Security](./bundles_catalog_tech.md) for the fix and the test that pins it.

## Architecture Overview

```
Browse Flow (Catalog dialog, Settings → Catalog):
  CatalogBrowserModal (owned by LocalAgentsList) | CatalogSettingsSection
    → useCatalogEntries({ refresh: true })
      → useCatalogItems → catalog:items IPC → libraryService.items(userId, refresh)
          → GET {cinnaServerUrl}/api/v1/catalog/items (cached per profile;
             the same listing team sharing reads)
      → joined per item with useTeamLibrary (desktop agents' local copies),
        useAgents (cloud installs synced to agent rows), useLocalAgents
        (kit agents and their pins), useShareStatuses (Can use only)
    → CatalogSearchRow · CatalogListBody · CatalogTileGrid · CatalogItemDetailView
    → actions from useCatalogActions (held by LocalAgentsList / the Settings section)
  User picks Add to agent… → an agent
    → catalog-skills:add → catalogSkillService.addToAgent (download, check, pin)
  User opens a detail
    → useCatalogItemDetail(uuid) → catalog:item → GET …/catalog/items/{uuid}
    → uninstalled cloud agent: useInstallContext(bundleId)
        → catalog:install-context → GET …/catalog/{bundle_id}/install-context
        → per-spec verdict, credential UUIDs dropped → InstallContextDto
  Main's listing moved (poll, action, another open)
    → sharing:changed       (desktop agents)  ─┐ renderer re-reads the catalog's
    → catalog:items-changed (any other item)  ─┘ items from main's cache + Inbox
                                                  + local agents (Skills rows' Update)

Get Flow (a Runs in Cinna item, any surface):
    → useCatalogInstall → catalogInstall.store.install(bundleId)
        (app-wide guard; profile id recorded)
      → catalog:quick-install
          → GET  …/catalog/{bundle_id}/install-context
          → POST …/catalog/{bundle_id}/install (publisher_provides | use_existing | skip)
          → libraryService.refreshQuietly   (the listing names the install)
      → await agents:sync-remote          (failure → "Installed, but…" on the tile)
      → invalidate ['catalog'], ['agents'] → fetchQuery(['agents'])
      → find remoteTargetId === installId (missing → "it will appear…")
      → profile changed? → drop
      → landCatalogInstall                 (runs even if the surface unmounted)
          → ui.store: external-agent page, chat mode
          → fetchQuery(['catalog', 'setup-status', installId])
          → not ready / check failed → store.pendingSetup
              → CatalogSetupHost (App root) → CatalogSetupModal
      → close the dialog                   (only if its list is still mounted)

Uninstall Flow (installed cloud agent's detail):
    → CatalogUninstallModal → useUninstallBundle
      → catalog:uninstall → POST …/agents/{install_id}/uninstall
          → libraryService.refreshQuietly
      → useRefreshCatalogState → confirm closes

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
      → status flips to 'ready' → onReady() → modal closes + Catalog State Refresh
```

## Integration Points

- **[Agents Tab](../local_agents/agents_tab.md)** — **+ → Install from catalog** opens the Catalog dialog; a finished install lands on the new agent's page
- **[Team Sharing](../local_agents/team_sharing.md)** — the catalog's **Runs on your computer** agents: folder agents fetched as git repositories with Get and Update, not bundles installed on the server; and the cached item listing both read
- **[The Inbox](../../jobs/tasks/inbox.md)** — the **Update available for *X*** card, for a cloud agent behind its catalog version (manual update mode only) and for a shared desktop agent alike, and **Update available for *skill* in *agent*** for a catalog skill a kit agent pins at an older version
- **[Agent Skills](../local_agents/skills.md)** — the skills a kit agent pins from the catalog, and what **Add to agent…** does. **In N agents** and **In your agents** count an agent on this computer by its own pins alone, which move the moment an add or a Remove lands; core's record of where the user holds a skill (`my_installs` rows with `where: local` and a `host_manifest_id`, which the desktop reports after each add, update, fetch and remove) counts only for a manifest id no kit agent here has, so a skill just removed here never reads as added while core's record catches up
- **[Composer `[+]` Menu](../../chat/composer_menu/composer_menu.md)** — the add-agents Capability Picker's bottom **Catalog** section (`useCatalogPicker`, [Inline Catalog Install](inline_install.md)) lists the catalog's agents not on this computer yet, cloud and desktop, from the same cached listing, and selects the agent a **Get** lands as. It deliberately omits the post-install setup-status check / `CatalogSetupModal` — an incomplete install simply auto-replies "setup not complete" on first message, keeping the in-chat path seamless
- **[Remote Agents](../remote_agents/remote_agents.md)** — Once a bundle is installed on the server, the existing periodic remote-agent sync pulls the new install into the local `agents` table on its next cycle, surfacing it in the agent selector and Settings → Profile → Agents. The cinna-server `/external/agents` response carries `bundle_uuid` and `is_publisher_install` under `metadata`, which the desktop persists into `RemoteAgentMetadata`. Profile → Agents is one server-domain visibility list, including hidden installs. `isBundleAgent` — a consumer install is `bundle_uuid` **and** `is_publisher_install: false`, never `bundle_id`, which cinna-server stamps on every agent at creation — gates, by complement, the Develop action; the agent page itself offers no Uninstall or any other destructive action for a server-hosted agent, only a link to its page there. Connection shows available bundle updates
- **[Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md)** — All catalog calls use `getCinnaAccessToken()` so token rotation and 401-driven re-auth work the same as for `cinnaApiService`
- **[Cinna Re-authentication](../../auth/cinna_accounts/reauthentication.md)** — the catalog's **Re-authenticate** shares the `useCinnaReauth` flow used by the Profile → Agents section
- **[Resource Activation](../../core/resource_activation/resource_activation.md)** — Catalog handlers require an activated profile, matching the rest of the IPC surface
- **[Settings](../../ui/settings/settings.md)** — The Catalog menu item lives inside the Profile group (`PROFILE_SCOPE_TABS`), so deactivating the Cinna profile snaps the sidebar back to a default-scope tab
- **Cinna Server: Agent Bundles** — See `workflow-runner-core/docs/agents/agent_bundles/agent_bundles.md` for publisher-side rules (PBP/PBU/PBT credential modes, runtime gate, setup-status semantics)
