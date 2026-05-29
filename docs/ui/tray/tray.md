# Menu-Bar Tray

## Purpose

A macOS menu-bar (status-bar) icon with a small popover window that surfaces agent health at a glance — even when the main window is unfocused. The icon carries a severity-colored dot; clicking it opens a compact list of agent statuses, and acting on an item redirects the main window.

## Core Concepts

- **Tray Icon** — The menu-bar icon (Electron `Tray`). A monochrome glyph plus a severity dot reflecting the **worst** status across the user's agents. Mirrors the sidebar-footer `AgentStatusButton`.
- **Tray Popup** — A frameless, always-on-top popover window anchored under the icon. On macOS it uses native vibrancy (frosted-glass material) with rounded corners and a native shadow; it fades in and out.
- **Severity Dot** — Colored badge on the icon: error→red, warning→amber, info→sky, ok→emerald, unknown→muted. Absent when no agent has published a status.
- **Renderer-push icon** — The main window computes the worst severity and pushes a rendered icon image to the main process. There is **no** main-process polling.
- **Second renderer entry** — The popup is its own window and React root (`trayPanel.html`), separate from the main app window, with its own store and query caches.

## User Stories / Flows

### Glancing at health from the menu bar
1. While the main window is open, a Cinna icon appears in the macOS menu bar.
2. If any agent has published a status, the icon shows a colored dot of the worst severity; the tooltip summarizes count + worst severity.
3. The dot updates as the main window's background poll refreshes statuses.

### Opening the popup
1. The user clicks (or right-clicks) the menu-bar icon; the popup fades in centered under the icon.
2. It shows a compact "Agents [count]" list sorted by urgency (most severe first, then freshest).
3. A refresh-all control re-fetches; clicking outside the popup (losing focus) fades it out.

### Viewing a status detail (redirect to main window)
1. The user clicks a card body.
2. The popup closes, the main window is raised, and the in-app Agent Status overlay opens directly at that agent's detail view.

### Starting a chat from a card
1. The user clicks a card's chat button.
2. The popup closes, the main window is raised, any open overlay (status or console) is closed so the chat page isn't hidden underneath, and the chat view opens with that agent preselected.

### Refresh feedback
1. The user clicks the refresh-all button.
2. The icon spins for at least a minimum period (so an instant cached refetch still reads as a deliberate action), then briefly flashes green on success or red on error before fading back to the default color.

## Business Rules

- **Tray lifetime = main-window lifetime.** The tray is created when the main window opens and destroyed when it closes. On macOS the app stays alive with no window, in which case there is no tray icon; reactivating the app rebuilds both.
- **No main-process polling.** Severity is pushed from the main window's existing agent-status poll. With no main window there is no tray, so this is sufficient.
- **Cinna-gated content.** Agent statuses exist only for `cinna_user` accounts. Non-cinna users (or users with no reporting agents) see the base icon with no dot and an empty popup.
- **Own store/query instances.** The popup is a separate renderer; it re-hydrates the active user on window focus and relies on focus-refetch to refresh statuses each time it is shown.
- **Card click opens detail in the main window**, not in the popup — the popup is a launcher, not a detail surface.
- **Platform fallback.** macOS gets vibrancy + native rounded corners/shadow; other platforms fall back to a translucent CSS-rounded panel without blur, positioned near the cursor.
- **Theme.** The popup surface follows the app theme via the shared `cinna-theme` localStorage key (live via the `storage` event). The menu-bar **glyph** color follows the OS appearance (light/dark menu bar), not the app theme.

## Architecture Overview

```
Main window renderer (useTrayIcon)
   worst severity → canvas image → [tray:set-image] → Main (Tray.setImage)

Menu-bar Tray click → trayService.toggle() → Tray Popup window (trayPanel.html)
   Tray Popup (useAgentStatus) → [agent-status:list]  (existing IPC, reused)
   card body   → [tray:open-status] → Main raises window + [tray:focus-status] → overlay opens at agent
   chat button → [tray:start-chat]  → Main raises window + [tray:focus-chat]   → chat opens (overlays closed)
```

## Integration Points

- [Agent Status](../../agents/agent_status/agent_status.md) — Data source and the in-app overlay the popup redirects into; the card/detail views are shared components.
- [App Shell](../app_shell/app_shell.md) — The sidebar-footer status button is the in-app sibling surface; the main-window lifecycle owns tray creation/destruction.
- [Logger](../../development/logger/logger.md) — The `tray` scoped logger traces tray create/destroy and icon-set failures.
