# App Shell

## Purpose

The window-level chrome that frames every view: a permanent top bar next to the macOS traffic lights, a floating left sidebar that slides in/out, and a main working area. Hosts global actions (new chat, sidebar toggle), the profile/account menu, the agent-status indicator, and an interface-preferences popover.

## Core Concepts

- **Top Bar** — A persistent ~36 px strip across the window top. Holds the macOS traffic-light gutter plus the **Collapse/Expand Sidebar** and **New Chat** icon buttons. Its position and contents never change with sidebar state.
- **Floating Sidebar** — A rounded, slightly inset panel on the left. Always slot-reserves its position; expanding/collapsing only animates its visibility (slide + fade), not the surrounding layout.
- **Sidebar Footer** — Bottom row of the sidebar with three slots: profile menu (left), agent-status button (only for Cinna users), and the Interface menu (right).
- **Profile Menu** — Avatar-only trigger that opens an upward dropdown listing local profiles, the Settings entry, "Add Account", and "Sign Out".
- **Interface Menu** — Popover above the gear-toggle button containing three preference toggles: **Console** (app logs overlay), **Verbose**, and **Theme**.
- **Main Area** — Everything to the right of the sidebar; renders either the chat view or the settings page.

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

### Checking Agent Status (Cinna users only)

1. Status icon shows a colored dot when there is a non-OK agent status.
2. User clicks the icon; the agent-status overlay opens. See [Agent Status](../../agents/agent_status/agent_status.md).

## Business Rules

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
    │     └── New Chat button       → useStartNewChat()
    └── flex row
        ├── Sidebar (animated wrapper)
        │     ├── Settings menu OR ChatList (based on activeView)
        │     └── Footer
        │           ├── UserMenu compact (portaled dropdown)
        │           ├── AgentStatusButton (Cinna users only)
        │           └── InterfaceMenu (portaled popover)
        └── MainArea (chat view or SettingsPage)
```

## Integration Points

- **UI Store** — Owns `sidebarOpen`, `activeView`, `settingsTab`, `theme`, `verboseMode`, `logsOpen`, `agentStatusOpen`. See `src/renderer/src/stores/ui.store.ts`.
- [Settings](../settings/settings.md) — The settings page rendered in the main area; entered via the profile dropdown.
- [Verbose Mode](../verbose_mode/verbose_mode.md) — Toggled from the Interface popover.
- [Keyboard Shortcuts](../keyboard_shortcuts/keyboard_shortcuts.md) — ⌘\` opens the logs overlay regardless of the Console toggle.
- [User Accounts](../../auth/user_accounts/user_accounts.md) — Profile dropdown lists local accounts and triggers account switching / sign-out.
- [Agent Status](../../agents/agent_status/agent_status.md) — Sidebar-footer status indicator and overlay.
- [Logger](../../development/logger/logger.md) — Console toggle and overlay.
