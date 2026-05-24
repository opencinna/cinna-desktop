# Bundles Catalog

## Purpose

Browse and one-click-install agent bundles published on the connected Cinna server, without leaving the desktop app. The desktop never re-implements the publisher's credential setup forms — when a freshly installed bundle is missing credentials, the user is deep-linked into the cinna-server credential pages and the desktop polls until the runtime gate clears.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Bundle** | Versioned, publisher-owned packaging of an agent on cinna-server, identified by a reverse-DNS `bundle_id`. See [Agent Bundles](https://github.com/) on cinna-server for the full model |
| **Catalog** | Visibility-aware list of bundles the active Cinna user can see (public, granted, or own) — fetched from `GET /api/v1/catalog/` |
| **Install** | A user's running copy of a bundle on cinna-server — an `Agent` row seeded from the latest revision. The desktop never owns this state |
| **Quick Install** | One-click install that submits an empty payload; the server applies the same defaults the install form would use unchanged |
| **Setup Status** | Per-install runtime-gate verdict from cinna-server: `ready` / `needs_setup` / `publisher_broken`. Drives whether the post-install modal opens |
| **Missing Item** | One credential the install can't run without — either an empty user placeholder (`placeholder_empty`) or a broken publisher-shared row (`publisher_credential_missing` / `_unshared`) |
| **Setup Modal** | Post-install dialog that lists missing credentials as status cards; clicking a card opens the cinna-server credential page in the OS browser. Polls every 3s and on window focus until the gate goes `ready` |
| **Credentials Draft** | A placeholder credential cinna-server pre-creates during install for each user-provided spec — the desktop only needs to open it on the web for the user to fill in |

## User Stories / Flows

### Browsing the Catalog

1. Cinna user opens Settings → Profile → Catalog (the menu item lives next to "Agents" inside the active profile group)
2. The desktop fetches `GET /api/v1/catalog/` through its main-process proxy and renders one expandable card per bundle
3. Cards show display name, version label (`v<latest_version>` or `rev <n>` fallback), publisher name/email, bundle ID, and the required-credential summary with provided-by labels
4. Bundles the user has already installed render a green "Active" pill and an "Installed" indicator instead of the Install button

### Quick Install (happy path — all credentials in order)

1. User clicks **Install** on a non-installed card
2. The desktop POSTs `/api/v1/catalog/{bundle_id}/install` with `{}` (server applies its quick-install defaults: PBP → `publisher_provides`, suggested credentials → `use_existing`, otherwise → `skip`; publisher AI credentials accepted when offered)
3. On success the desktop immediately checks `GET /api/v1/agents/{install_id}/setup-status`
4. Status comes back `ready` → toast "*\<agent name\>* installed", catalog and agents queries invalidate, the card flips to "Active", and the new install appears in the agent selector

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

- A manual **Refresh** button at the top of the section invalidates the catalog query
- When the catalog call fails with `reauth_required` (Cinna 401/403), an inline error banner with a **Re-authenticate** button runs the existing Cinna OAuth flow and refetches on success

## Business Rules

- **Cinna-only feature** — the section short-circuits to a "sign in to Cinna" message for non-Cinna profiles. Catalog API calls go through the active profile's Cinna server URL and JWT, identical to the remote-agents flow
- **Server is the source of truth** — the desktop never persists catalog entries, install metadata, or credential drafts. Every action is a proxy call; UI state is derived from React Query caches
- **Quick install only** — the desktop deliberately does not re-implement the cinna-server install form. Custom installs (per-spec credential picks, AI credential overrides) require the user to open the bundle on the web
- **One install at a time** — while a Quick Install is in flight the other cards' Install buttons disable. Card-body expansion still works
- **Setup polling stops at ready** — `useSetupStatus` cancels the 3-second interval as soon as the query data settles on `status === 'ready'`. Window-focus and explicit refetch are the only paths that hit the server after that
- **Per-credential deep link requires a UUID** — only `placeholder_empty` items can resolve to `/credential/{id}` because the install owner doesn't have a credential row for `publisher_credential_*` reasons. Those cards render disabled, and the fallback "Open on server" button surfaces the install's Credentials tab from `setup-status.setup_url`
- **No write-side toggling on the catalog** — installed bundles cannot be uninstalled from this UI; users do that on cinna-server (the publisher install protection rule applies there)
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

Quick Install Flow:
  User clicks Install
    → useQuickInstallBundle().mutateAsync(bundleId)
      → catalog:quick-install IPC
        → POST {cinnaServerUrl}/api/v1/catalog/{bundle_id}/install (empty body)
        → Server: install_bundle → Agent row + AppDataVolume + auto MCP route
    → queryClient.fetchQuery(['catalog', 'setup-status', installId])
      → catalog:setup-status IPC → GET /agents/{id}/setup-status
    → Branch:
      • status === 'ready'   → toast + invalidate catalog/agents
      • status !== 'ready'   → open CatalogSetupModal

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
