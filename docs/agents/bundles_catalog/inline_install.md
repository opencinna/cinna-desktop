# Inline Catalog Install (Capability Picker)

Aspect of [Bundles Catalog](bundles_catalog.md). Surfaces the catalog's **Get** directly inside the chat composer's add-agents picker, so a user can discover, get, and start chatting with a catalog agent without leaving the new-chat flow.

## Purpose

Let the user get a catalog agent at the exact moment they want to use it: in the new-chat / add-agents modal, a dedicated **Catalog** group lists the catalog's agents not on this computer yet — ones that run in Cinna and ones that run on this computer — each with a **Get** button. One click gets it and selects the resulting agent as a chat participant — no detour to the catalog.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Catalog Section** | A group rendered at the bottom of the [Capability Picker](../../chat/composer_menu/composer_menu.md) (`AgentPickerModal`), below the user's own agents/MCP, listing catalog agents not on this computer yet |
| **Catalog card** | A card in the Catalog Section in the catalog tile's design and at the catalog dialog's scale: the kind's icon and the name, the kind badge (**Runs in Cinna** / **Runs on your computer**) with a **Version N** chip, **by** its maintainers or publisher, a three-line description, a **Needs …** line naming its credential slots, and a footer with **Get** (not a selection toggle). Spins while getting; disappears once the agent is here |
| **Inline Get** | The picker's get flow. For a cloud agent, the quick install in the app-wide install store it shares with the catalog dialog and Settings (`catalog.quickInstall` → awaited `agents.syncRemote` → find the synced agent). For a desktop agent, team sharing's **Get** from its team entry, whose result names the folder agent it made. Either way the new agent is then selected. Unlike the catalog, no setup gate follows |

## User Stories / Flows

### Seamless get + select (happy path)
1. User opens a new chat → `[+]` → **Add agents / MCP** (or `@`).
2. Below their own agents/MCP they see a **Catalog** group of agents they do not have yet.
3. User clicks **Get** on a card. The card spins (overlay spinner + "Getting…"); every other Get button disables for the duration, titled "Another agent is being added" (one at a time — including a cloud install already running from the catalog dialog or Settings, which spins its card here too if it is listed).
4. A cloud agent installs on cinna-server and the local `agents` table syncs; a desktop agent is fetched from the team into the agents home. The card leaves the Catalog group and the agent reappears as a normal capability card — **already selected**.
5. User starts the conversation with the agent immediately.

### Get with missing credentials
- No special handling here, by design. If a cloud install lands in `needs_setup` / `publisher_broken`, the agent is still selected; messaging it triggers the agent's own "setup not complete" auto-reply (see [Agents](../agents/agents.md)). The in-chat path stays a single click — the [`CatalogSetupModal`](bundles_catalog.md#quick-install-with-missing-credentials) is intentionally not shown here (it remains the catalog's path). The card's **Needs …** line says up front what the agent will ask for. A desktop agent's Get ends as it does anywhere, with the [Finish setup](../service_credentials/README.md#finish-setup) request that opens on the agent's page.

### Get failure (hard error)
- Auth/network/server errors are caught and surfaced as an inline error row at the top of the Catalog Section, showing the message with the IPC wrapper stripped; a desktop agent's refusal is team sharing's sentence for it. The card stops spinning; nothing is selected. The error clears on the next Get. An expired Cinna session on a cloud install shows *"Cinna session expired — re-authenticate in Settings to install."*, and the app-wide re-auth modal opens as well. Both depend on `catalog:quick-install` **returning** its failure code rather than throwing it (see [Bundles Catalog](bundles_catalog.md#business-rules)); until 17 Sep 2026 it threw, the code was lost in transit, and the row showed the server's message instead.
- A cloud install the server accepted but the desktop could not add yet is reported the same way, not as a failure: *"Installed, but it could not be added to your agents yet: …"*, *"Installed, but your Cinna session expired before it could be added — re-authenticate and it will appear."*, or *"Installed — it will appear in your agents after the next sync."* Nothing is selected in any of them.
- **The row shows only the error of a Get this picker started.** The install error lives in the shared store, so a failure left behind by the catalog would otherwise appear here on an agent the user never touched.

## Business Rules

- **Cinna-only** — the Catalog Section reads the catalog's cached item listing (`useCatalogEntries`), which is read only for a Cinna profile. Non-Cinna profiles get no section.
- **The same list as the catalog, read from the cache** — the picker reads the one listing the catalog dialog and Settings read, so all three agree on what is installed. It does not list the catalog again: it opens on every new chat, and the listing is refreshed by the catalog surfaces, main's poll and every install.
- **Only agents not on this computer** — a cloud agent with no install of the user's, and a desktop agent with a team entry and no local copy. Anything already here appears as a regular agent card. A desktop agent team sharing does not list has nothing to Get and is left out.
- **Never skills** — a skill is added to an agent, not to a chat; it is got from the catalog's **Add to agent…**.
- **Picker opens for catalog-only users** — the composer `[+]` "Add agents / MCP" row shows when `hasCapabilities || catalogItems.length > 0`, so a user with no agents/MCP yet can still reach the picker to get their first agent.
- **One Get at a time** — while a cloud install is in flight anywhere (`installingBundleId !== null`, from the shared store) or this picker's desktop Get is running, every Get button disables; the in-flight card shows the spinner.
- **The selection belongs to the picker as it was when clicked** — the completion is captured at click time, and runs only while the picker is still mounted. If the picker has gone, the Get still completes but nothing is selected: there is nowhere to select it. `ChatInput` switches chats without remounting, so a callback read at completion time would have selected the agent in whichever chat was on screen by then. A desktop Get's selection is a `mutate`-level callback, which TanStack drops on unmount, while its hook-level effects (re-reads, Finish setup) still run.
- **Auto-select via the shared routing** — after a Get the new agent is selected by calling the picker's own `toggleCapability(agentId)`: a freshly-arrived agent is unselected, so toggle *engages* it — buffered into the new-chat pending list, or attached as an on-demand orchestrated tool in an active chat (mirrors the `@`-mention path; see [Composer `[+]` Menu](../../chat/composer_menu/composer_menu.md)).
- **Awaited sync, React-Query cache flow** — unlike the fire-and-forget `useRefreshCatalogState`, the cloud path must *await* `agents.syncRemote()` so the install is in the local table before it reads it back; a failed sync (returned as data) stops here with the "Installed, but…" message. It then invalidates `['catalog']` + `['agents']` and `fetchQuery(['agents'])` — cache writes stay inside React Query rather than a direct `setQueryData`, avoiding a race with the `agents:remote-sync-complete` broadcast invalidation.
- **Match key** — a new cloud agent is found by `remoteTargetId === installId` (the cinna-server Agent UUID from `CatalogInstallResultDto`; the synced local row stores it as `remoteTargetId`). A desktop agent's id is the Get's own answer (`result.agentId`).
- **No setup-status gate** — deliberately skipped (see flow above). The only post-Get branch is success (select) vs. error (inline message).

## Architecture Overview

```
New chat → [+] → Add agents / MCP → AgentPickerModal (Catalog section)
  useCatalogPicker
    → useCatalogEntries()                     (cached listing; no re-list)
    → catalogPickerItems(views)               (cloud: no install; desktop: team entry, no local copy)
  User clicks Get
    → useCatalogPicker.install(uuid)          (remembers the item it started)
      cloud_agent:
        → useCatalogInstall                   (captures onInstalled now)
          → catalogInstall.store.install      (app-wide guard, shared with the catalog)
              → window.api.catalog.quickInstall(bundleId)    (CatalogOutcome → unwrapCatalogOutcome)
              → await window.api.agents.syncRemote()         (failure → "Installed, but…")
              → invalidate ['catalog'] + ['agents']
              → fetchQuery(['agents'])  → find a.remoteTargetId === installId
              → profile changed? → drop
          → picker still mounted? → onInstalled(agentId) == toggleCapability(agentId)
      desktop_agent:
        → useGetFromLibrary().mutate(repoId)  (team sharing's Get)
          → done + agentId → toggleCapability(agentId)       (dropped if the picker unmounted)
          → refused / failed → inline error row
    → new chat  → pending buffer (ChatWorkspace)
      active    → on-demand attach / orchestrate
    → card flips from a Catalog card → selected capability card
```

## Technical Notes

### File Locations
- `src/renderer/src/hooks/useCatalogPicker.ts` — `useCatalogPicker(onInstalled)` → `{catalogItems, installingId, busy, install(id), error}`, with `id` the catalog item's uuid; and the pure `catalogPickerItems(views)`. Reads `useCatalogEntries()` (no `refresh`), `useCatalogInstall({ onInstalled })` with no detached callback, so no setup-status gate runs, and `useGetFromLibrary()`. `installingId` is the item whose cloud install is running anywhere (by `bundleId`) or whose desktop Get this picker started (by `repoId`). `error` is a string, or `null` unless it belongs to the item this picker last started.
- `src/renderer/src/hooks/useCatalogPicker.test.tsx` — which items are listed (no skills, nothing already here), the Get per kind and the selection, the error scoping.
- `src/renderer/src/stores/catalogInstall.store.ts`, `src/renderer/src/hooks/useCatalogInstall.ts` — the cloud install itself, shared with the catalog; scoped logger `catalog-install` emits `catalog quick install` / `catalog install complete` / failure and profile-change logs. See [Bundles Catalog — Technical Reference](bundles_catalog_tech.md#the-install-store-every-catalog-surface)
- `src/renderer/src/components/agents/AgentPickerModal.tsx` — renders the Catalog section from the optional props `catalogItems` / `installingCatalogId` / `catalogBusy` / `onInstallCatalog` / `catalogError`; exports the `CatalogPickerItem` type (`id`, `kind`, `name`, `description`, `meta`, `version`, `needs`). The card reuses the catalog's `KindIcon`, `CatalogKindBadge`, `CHIP` and `PRIMARY` and its dialog type scale (`useCatalogType`). Section is appended after the agent/MCP grid; cards are mouse-driven (outside the keyboard-nav `entries` list).
- `src/renderer/src/components/chat/ChatInput.tsx` — wires `useCatalogPicker(toggleCapability)` and forwards the props to `AgentPickerModal`; widens the `[+]` visibility to `hasCapabilities || catalogItems.length > 0`.

### Reused infrastructure
- IPC, DTOs, and the server-side install all come from [Bundles Catalog](bundles_catalog.md) / [tech](bundles_catalog_tech.md), and the desktop Get from [Team Sharing](../local_agents/team_sharing.md) — this aspect adds **no new IPC channels**.
- The local-agent join field (`remoteTargetId`) is populated by `src/main/db/agents.ts` `syncRemote()` (`remoteTargetId = target.targetId`); remote-synced agents default to `enabled: true`, so the installed agent is immediately selectable.

## Integration Points
- **[Bundles Catalog](bundles_catalog.md)** — the same listing, the same quick install and server contract; this is the in-chat entry point beside the catalog dialog and Settings → Profile → Catalog, with which it shares the install store.
- **[Team Sharing](../local_agents/team_sharing.md)** — a desktop agent's Get, and the team entry it is got through.
- **[Composer `[+]` Menu](../../chat/composer_menu/composer_menu.md)** — hosts the Capability Picker the Catalog Section lives in; auto-select reuses its `toggleCapability` routing.
- **[Remote Agents](../remote_agents/remote_agents.md)** — `agents.syncRemote()` pulls the new install into the local `agents` table; the agent then behaves like any other remote agent.
- **[Agents](../agents/agents.md)** — handles the "setup not complete" auto-reply that covers incomplete-credential installs, which is why this flow can skip the setup modal.
