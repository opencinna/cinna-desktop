# Inline Catalog Install (Capability Picker)

Aspect of [Bundles Catalog](bundles_catalog.md). Surfaces the catalog's Quick Install directly inside the chat composer's add-agents picker, so a user can discover, install, and start chatting with a catalog agent without leaving the new-chat flow.

## Purpose

Let the final user install a catalog agent at the exact moment they want to use it: in the new-chat / add-agents modal, a dedicated **Catalog** group lists every visible-but-not-installed bundle with an **Install** button. One click installs it and auto-selects the resulting agent as a chat participant — no detour to Settings → Profile → Catalog.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Catalog Section** | A group rendered at the bottom of the [Capability Picker](../../chat/composer_menu/composer_menu.md) (`AgentPickerModal`), below the user's own agents/MCP, listing not-yet-installed bundles |
| **Catalog Install Card** | A card in the Catalog Section carrying an **Install** action (not a selection toggle). Spins while installing; disappears once installed |
| **Inline Quick Install** | The picker's install flow: `catalog.quickInstall` → awaited `agents.syncRemote` → select the freshly-synced agent. The same server-side install as the settings catalog, minus the post-install setup gate |

## User Stories / Flows

### Seamless install + select (happy path)
1. User opens a new chat → `[+]` → **Add agents / MCP** (or `@`).
2. Below their own agents/MCP they see a **Catalog** group of installable bundles.
3. User clicks **Install** on a card. The card spins (overlay spinner + "Installing…"); every other Install button disables for the duration (one install at a time).
4. The bundle installs on cinna-server, the local `agents` table syncs, the card leaves the Catalog group, the agent reappears as a normal capability card — **already selected**.
5. User starts the conversation with the agent immediately.

### Install with missing credentials
- No special handling here, by design. If the install lands in `needs_setup` / `publisher_broken`, the agent is still selected; messaging it triggers the agent's own "setup not complete" auto-reply (see [Agents](../agents/agents.md)). The in-chat path stays a single click — the [`CatalogSetupModal`](bundles_catalog.md#setup-modal) is intentionally not shown here (it remains the Settings → Catalog path).

### Install failure (hard error)
- Auth/network/server errors are caught and surfaced as an inline error row at the top of the Catalog Section (e.g. *"Cinna session expired — re-authenticate in Settings to install."*). The card stops spinning; nothing is selected. The error clears on the next install attempt.

## Business Rules

- **Cinna-only** — the Catalog Section is driven by `useCatalog()`, which is gated on `currentUser.type === 'cinna_user'`. Non-Cinna profiles get an empty section (no group rendered).
- **Only non-installed bundles** — `catalogItems` filters `useCatalog()` to `!isInstalled`; installed bundles already appear as regular agent cards after the remote-agent sync.
- **Picker opens for catalog-only users** — the composer `[+]` "Add agents / MCP" row shows when `hasCapabilities || catalogItems.length > 0`, so a user with no agents/MCP yet can still reach the picker to install their first agent.
- **One install at a time** — while an install is in flight (`installingBundleId !== null`) all Install buttons disable; the in-flight card shows the spinner.
- **Auto-select via the shared routing** — after install the new agent is selected by calling the picker's own `toggleCapability(agentId)`: a freshly-synced agent is unselected, so toggle *engages* it — buffered into the new-chat pending list, or attached as an on-demand orchestrated tool in an active chat (mirrors the `@`-mention path; see [Composer `[+]` Menu](../../chat/composer_menu/composer_menu.md)).
- **Awaited sync, React-Query cache flow** — unlike the settings catalog's fire-and-forget `useRefreshCatalogState`, this path must *await* `agents.syncRemote()` so the install is in the local table before it reads it back. It then invalidates `['catalog']` + `['agents']` and `fetchQuery(['agents'])` — cache writes stay inside React Query rather than a direct `setQueryData`, avoiding a race with the `agents:remote-sync-complete` broadcast invalidation.
- **Match key** — the new local agent is found by `remoteTargetId === installId` (the cinna-server Agent UUID from `CatalogInstallResultDto`; the synced local row stores it as `remoteTargetId`).
- **No setup-status gate** — deliberately skipped (see flow above). The only post-install branch is success (select) vs. error (inline message).

## Architecture Overview

```
New chat → [+] → Add agents / MCP → AgentPickerModal (Catalog section)
  User clicks Install
    → useCatalogPicker.install(bundleId)
        → window.api.catalog.quickInstall(bundleId)        (CatalogInstallResultDto)
        → await window.api.agents.syncRemote()             (local agents table catches up)
        → invalidate ['catalog'] + ['agents']
        → fetchQuery(['agents'])  → find a.remoteTargetId === installId
        → onInstalled(agentId)  ==  toggleCapability(agentId)
              new chat  → pending buffer (MainArea)
              active    → on-demand attach / orchestrate
    → card flips from Catalog Install card → selected capability card
  On error → setError → inline error row in the Catalog section
```

## Technical Notes

### File Locations
- `src/renderer/src/hooks/useCatalogPicker.ts` — the hook backing the section: `catalogItems`, `installingBundleId`, `install(bundleId)`, `error`. Reuses `useCatalog()`; calls `window.api.catalog.quickInstall` + `window.api.agents.syncRemote` + `window.api.agents.list`. Skips the setup-status gate; scoped logger `catalog-picker` emits `catalog quick install` / `catalog install complete` / failure logs.
- `src/renderer/src/components/agents/AgentPickerModal.tsx` — renders the Catalog section from the optional props `catalogItems` / `installingBundleId` / `onInstallCatalog` / `catalogError`; exports the `CatalogPickerItem` type. Section is appended after the agent/MCP grid; cards are mouse-driven (outside the keyboard-nav `entries` list).
- `src/renderer/src/components/chat/ChatInput.tsx` — wires `useCatalogPicker(toggleCapability)` and forwards the props to `AgentPickerModal`; widens the `[+]` visibility to `hasCapabilities || catalogItems.length > 0`.

### Reused infrastructure
- IPC, DTOs, and the server-side install all come from [Bundles Catalog](bundles_catalog.md) / [tech](bundles_catalog_tech.md) — this aspect adds **no new IPC channels**.
- The local-agent join field (`remoteTargetId`) is populated by `src/main/db/agents.ts` `syncRemote()` (`remoteTargetId = target.targetId`); remote-synced agents default to `enabled: true`, so the installed agent is immediately selectable.

## Integration Points
- **[Bundles Catalog](bundles_catalog.md)** — same Quick Install / server contract; this is the in-chat entry point alongside Settings → Profile → Catalog.
- **[Composer `[+]` Menu](../../chat/composer_menu/composer_menu.md)** — hosts the Capability Picker the Catalog Section lives in; auto-select reuses its `toggleCapability` routing.
- **[Remote Agents](../remote_agents/remote_agents.md)** — `agents.syncRemote()` pulls the new install into the local `agents` table; the agent then behaves like any other remote agent.
- **[Agents](../agents/agents.md)** — handles the "setup not complete" auto-reply that covers incomplete-credential installs, which is why this flow can skip the setup modal.
