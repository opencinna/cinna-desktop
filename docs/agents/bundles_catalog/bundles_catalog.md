# Bundles Catalog

## Purpose

Browse and one-click-install agent bundles published on the connected Cinna server, without leaving the desktop app. The desktop never re-implements the publisher's credential setup forms — when a freshly installed bundle is missing credentials, the user is deep-linked into the cinna-server credential pages and the desktop polls until the runtime gate clears.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Bundle** | Versioned, publisher-owned packaging of an agent on cinna-server, identified by a reverse-DNS `bundle_id`. See [Agent Bundles](https://github.com/) on cinna-server for the full model |
| **Catalog** | Visibility-aware list of bundles the active Cinna user can see (public, granted, or own) — fetched from `GET /api/v1/catalog/` |
| **Install** | A user's running copy of a bundle on cinna-server — an `Agent` row seeded from the latest revision. The desktop never owns this state |
| **Quick Install** | One-click install that mirrors the cinna-server install form's default submission: the desktop first fetches `/install-context` for the server's auto-prefill suggestions, then POSTs `/install` with a constructed body (PBP → `publisher_provides`, PBU/PBT with a suggested credential → `use_existing`, otherwise → `skip`) so existing credentials are linked instead of duplicated |
| **Setup Status** | Per-install runtime-gate verdict from cinna-server: `ready` / `needs_setup` / `publisher_broken`. Drives whether the post-install modal opens |
| **Missing Item** | One credential the install can't run without — either an empty user placeholder (`placeholder_empty`) or a broken publisher-shared row (`publisher_credential_missing` / `_unshared`) |
| **Setup Modal** | Post-install dialog that lists missing credentials as status cards; clicking a card opens the cinna-server credential page in the OS browser. Polls every 3s and on window focus until the gate goes `ready` |
| **Credentials Draft** | A placeholder credential cinna-server pre-creates during install for each user-provided spec — the desktop only needs to open it on the web for the user to fill in |
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
- **One install at a time** — while a Quick Install is in flight the other cards' Install buttons disable. Card-body expansion still works
- **Setup polling stops at ready** — `useSetupStatus` cancels the 3-second interval as soon as the query data settles on `status === 'ready'`. Window-focus and explicit refetch are the only paths that hit the server after that
- **Per-credential deep link requires a UUID** — only `placeholder_empty` items can resolve to `/credential/{id}` because the install owner doesn't have a credential row for `publisher_credential_*` reasons. Those cards render disabled, and the fallback "Open on server" button surfaces the install's Credentials tab from `setup-status.setup_url`
- **Uninstall is a server round-trip** — the catalog card's Uninstall button calls `POST /api/v1/agents/{install_id}/uninstall` (same endpoint cinna-server's web UI uses). Server contract: the install row + environment go away, the per-bundle App Data volume is preserved (re-attached on next install of the same bundle), and publisher-installs are 400-rejected with a clear message that we render inline in the confirmation modal. The shared Catalog State Refresh then runs so the card flips back to uninstalled and the agent disappears from the `@` picker without waiting for the periodic remote-agent sync
- **Reuses the profile activation gate** — every catalog IPC handler calls `userActivation.requireActivated()` first; deactivated profiles error before any HTTP call is made
- **Open-in-browser uses the shared `system.openExternal` IPC** — http(s)-restricted in the main process; the renderer never holds a `shell` reference
- **Error codes flow end-to-end** — `CinnaApiError` codes (`reauth_required`, `request_failed`, `missing_server_url`, …) are re-emitted by `ipcHandle` so the renderer can switch on `err.code` to render specific affordances

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

- **[Remote Agents](../remote_agents/remote_agents.md)** — Once a bundle is installed on the server, the existing periodic remote-agent sync pulls the new install into the local `agents` table on its next cycle, surfacing it in the agent selector and Settings → Profile → Agents. The cinna-server `/external/agents` response carries `bundle_uuid` and `is_publisher_install` under `metadata`, which the desktop persists into `RemoteAgentMetadata`. Profile → Agents uses those flags to split the "My Agents" section into **Created by me** (own + publisher installs) and **Installed from catalog** (foreign bundle installs), and `AgentCard` renders a green **Bundle** pill on each catalog install
- **[Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md)** — All catalog calls use `getCinnaAccessToken()` so token rotation and 401-driven re-auth work the same as for `cinnaApiService`
- **[Cinna Re-authentication](../../auth/cinna_accounts/reauthentication.md)** — The inline "Re-authenticate" button in the catalog error banner shares the `useCinnaReauth` flow used by the Profile → Agents section
- **[Resource Activation](../../core/resource_activation/resource_activation.md)** — Catalog handlers require an activated profile, matching the rest of the IPC surface
- **[Settings](../../ui/settings/settings.md)** — The Catalog menu item lives inside the Profile group (`PROFILE_SCOPE_TABS`), so deactivating the Cinna profile snaps the sidebar back to a default-scope tab
- **Cinna Server: Agent Bundles** — See `workflow-runner-core/docs/agents/agent_bundles/agent_bundles.md` for publisher-side rules (PBP/PBU/PBT credential modes, runtime gate, setup-status semantics)
