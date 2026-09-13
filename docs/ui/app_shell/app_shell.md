# App Shell

## Purpose

The window-level chrome that frames every view: a permanent top bar next to the macOS traffic lights, a floating left sidebar that slides in/out, and a main working area. Hosts global actions (sidebar toggle, Agent Status, Inbox, new chat), the profile/account menu, and an interface-preferences popover.

## Core Concepts

- **Top Bar** — A persistent ~36 px strip across the window top. Holds the macOS traffic-light gutter plus the **Collapse/Expand Sidebar**, **Agent Status**, **Inbox** and **New Chat** icon buttons, in that order. Its position and contents never change with sidebar state.
- **Floating Sidebar** — A rounded, slightly inset panel on the left. Always slot-reserves its position; expanding/collapsing only animates its visibility (slide + fade), not the surrounding layout.
- **Sidebar Footer** — Bottom row of the sidebar with the profile menu on the left and local-development status, update status and Interface controls on the right.
- **Profile Menu** — Avatar-only trigger that opens an upward dropdown listing local profiles, the Settings entry, "Add Account", and "Sign Out".
- **Interface Menu** — Popover above the gear-toggle button containing three preference toggles: **Console** (app logs overlay), **Verbose**, and **Theme**.
- **Main Area** — Everything to the right of the sidebar; routes chats, app settings, Inbox, tasks, jobs, notes and folder/external agent pages.

## User Stories / Flows

### Collapsing / Expanding the Sidebar

1. User clicks the collapse icon in the top bar (or the expand icon when already collapsed).
2. Sidebar slides left and fades out (or slides in and fades in). Top-bar buttons stay put.
3. Main area smoothly expands or contracts as the sidebar's reserved width changes.

### Starting a New Chat

1. User clicks the **+** icon in the top bar (visible in any state, any view).
2. Active chat is cleared and the chat view is shown — same as the old in-sidebar "New Chat" button.

### Opening Settings

1. User clicks the avatar in the sidebar footer.
2. Profile dropdown opens (portaled, so it escapes the sidebar's clip).
3. User clicks "Settings"; main area switches to the settings page and the sidebar's content switches to the settings menu.

### Toggling UI Preferences

1. User clicks the sliders icon in the sidebar footer.
2. Interface popover appears above the button with three small icon toggles: Console, Verbose, Theme.
3. User clicks any toggle to flip the matching preference. Popover stays open until the user clicks outside.

### Checking Agent Status

1. User finds the activity icon between Collapse/Expand Sidebar and Inbox, including with the sidebar collapsed or Settings open. It is available to every profile because folder agents can report without a Cinna account.
2. The icon shows the worst reported severity as a colored dot, including OK; no non-null severity means no dot.
3. User clicks the icon; the agent-status overlay opens and refreshes the status list. See [Agent Status](../../agents/agent_status/agent_status.md).

### Opening an agent

1. User selects an agent in the Agents sidebar. Its page opens a new-chat composer with that agent selected; no empty chat is created.
2. The neutral bordered **Settings** action switches the page body to configuration. The accent **Start chat** action returns to the same composer with its draft intact. Folder agents show a compact runtime summary while chatting and full runtime controls in Settings; non-folder agents expose Overview and Connection tabs in Settings.
3. Sending uses the shared chat flow and opens the resulting conversation under Chats. The row's hover Start chat shortcut opens the dashboard composer directly and does not also select the row's page.

### Opening Inbox

1. User clicks the top-bar Inbox icon, including with the sidebar collapsed or settings open.
2. The main area shows all waiting asks; the selected sidebar tab is retained. The count overlays the fixed-size control so arriving asks do not move the surrounding controls. A failed read shows **!**, not an empty Inbox.

## Business Rules

- **Agent rows show stable identity.** Name plus type icon replaces description/credential sublines and readiness dots. Folder agents use a terminal, A2A/Cinna/WebSocket ACP a network icon, and other ACP/Managed agents a bot. Readiness remains in agent details and the separate status surface.
- **Agent grouping is optional.** Settings → Features → Interface → **Show sections in Agents sidebar** is installation-wide and on by default. Turning it off removes headings and section spacing without changing order: default Local folder root, active Cinna server, other folder roots, direct A2A, ACP connections, Managed agents. Hidden Cinna agents remain in Settings → Profile → Agents.
- **Top bar is always present.** Buttons do not shift when the sidebar toggles — they share a row with the macOS traffic lights via a fixed left gutter.
- **Sidebar reserves its slot.** Collapse animates the inner panel away (translate + fade) and shrinks the wrapper width, but it does not unmount; the main area reflows in step.
- **Sidebar always renders.** Even when collapsed the wrapper exists in the flex layout (width 0); the inner panel uses `pointer-events: none` when invisible.
- **Traffic-light gutter is hard-coded.** The renderer pads the top bar by 76 px to clear the macOS controls (which are positioned by Electron at x=15, y=10). Changing one without the other breaks alignment — see `src/main/index.ts` `trafficLightPosition`.
- **Settings entry-point.** Settings is reachable from the profile dropdown only — there is no longer a dedicated Settings button in the sidebar footer.
- **Console toggle is always available.** The Interface popover always shows the Console (App Logs) toggle, regardless of whether the logger has been enabled in Development settings. Opening it surfaces logs from that point forward.
- **Profile/Interface popovers are portaled.** They render into `document.body` (via `createPortal`) so the sidebar's `overflow: hidden` (needed for rounded-corner clipping) does not clip them.
- **Base font size is 17 px on `html`.** All rem-based Tailwind sizes (`text-xs`, `text-sm`, …) scale from this baseline. Changing it rescales the entire app uniformly.

## Architecture Overview

```
App
└── Shell
    ├── TopBar (always visible, draggable, contains traffic-light gutter + icons)
    │     ├── Collapse/Expand button → ui.store.toggleSidebar()
    │     ├── Agent Status button   → ui.store.setAgentStatusOpen()
    │     ├── Inbox button          → ui.store.setActiveView('inbox')
    │     └── New Chat button       → useStartNewChat()
    └── flex row
        ├── Sidebar (animated wrapper)
        │     ├── Settings menu OR Chats / Jobs / Notes / Agents tab content
        │     └── Footer
        │           ├── UserMenu compact (portaled dropdown)
        │           ├── Local-dev/update controls
        │           └── InterfaceMenu (portaled popover)
        └── MainArea (view router + live-run watch; ChatWorkspace or selected feature page)
```

## Integration Points

- **UI Store** — Owns `sidebarOpen`, `activeView`, `settingsTab`, `theme`, `verboseMode`, `logsOpen`, `agentStatusOpen`. See `src/renderer/src/stores/ui.store.ts`.
- [Inbox](../../jobs/tasks/inbox.md) — Global waiting asks, opened from the top bar.
- [Settings](../settings/settings.md) — The settings page rendered in the main area; entered via the profile dropdown.
- [Verbose Mode](../verbose_mode/verbose_mode.md) — Toggled from the Interface popover.
- [Keyboard Shortcuts](../keyboard_shortcuts/keyboard_shortcuts.md) — ⌘\` opens the logs overlay regardless of the Console toggle.
- [User Accounts](../../auth/user_accounts/user_accounts.md) — Profile dropdown lists local accounts and triggers account switching / sign-out.
- [Agent Status](../../agents/agent_status/agent_status.md) — Top-bar status indicator and overlay.
- [Menu-Bar Tray](../tray/tray.md) — macOS menu-bar icon + popover; created when the main window opens and destroyed when it closes.
- [Logger](../../development/logger/logger.md) — Console toggle and overlay.
