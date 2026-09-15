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
- **Window State** — The main window's normal (un-maximized) size and position plus whether it was maximized, kept by the main process in a small file in the app's data folder and reapplied whenever the main window is created. Belongs to the machine, not to a profile.

## User Stories / Flows

### Collapsing / Expanding the Sidebar

1. User clicks the collapse icon in the top bar (or the expand icon when already collapsed).
2. Sidebar slides left and fades out (or slides in and fades in). Top-bar buttons stay put.
3. Main area smoothly expands or contracts as the sidebar's reserved width changes.
4. The choice is remembered: the next launch opens with the sidebar the way it was left.

### Reopening the App

1. User resizes, moves or maximizes the window, collapses the sidebar, opens a chat or Settings, and quits — or closes the window, which on macOS leaves the app running.
2. On the next launch, or on clicking the Dock icon after closing the window on macOS, the window opens at the same size and position, maximized again if it was, with the sidebar open or collapsed as left.
3. The main area shows the new-chat screen whatever was open before; the chat, page and sidebar tab are not remembered.
4. If the saved position is no longer on any attached display (an unplugged monitor, a changed arrangement), the window opens centred at its saved size, reduced to fit the screen.

### Starting a New Chat

1. User clicks the **+** icon in the top bar (visible in any state, any view).
2. Active chat is cleared and the dashboard composer is shown with its saved session draft and the caret at the end. New Chat is navigation; it does not discard unsent work. Agent start screens keep separate drafts. See [Composer drafts](../../chat/conversation_ui/conversation_ui.md#leaving-and-returning-to-a-draft).

### Opening Settings

1. User clicks the avatar in the sidebar footer.
2. Profile dropdown opens (portaled, so it escapes the sidebar's clip).
3. User clicks "Settings"; main area switches to the settings page and the sidebar's content switches to the settings menu.

### Toggling UI Preferences

1. User clicks the sliders icon in the sidebar footer.
2. Interface popover appears above the button with three small icon toggles: Console, Verbose, Theme.
3. User clicks any toggle to flip the matching preference. Theme chooses the opposite of the currently displayed theme as a fixed Dark/Light preference, including when System was selected. Choose System in Settings → Features → Interface to follow the OS again. Popover stays open until the user clicks outside.

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

- **Chat rows retain background activity.** A running row shows a spinner and offers **Interrupt session** on hover/focus without selecting it. A stopped row can show its latest unread outcome and offers **Delete session**; foreground transcript loading acknowledges the result. See [Sidebar Session Status](../../chat/session_status/session_status.md).
- **Agent rows show stable identity.** Name plus type icon replaces description/credential sublines and readiness dots. Folder agents use a terminal, A2A/Cinna/WebSocket ACP a network icon, and other ACP/Managed agents a bot. Readiness remains in agent details and the separate status surface.
- **Agent grouping is optional.** Settings → Features → Interface → **Show sections in Agents sidebar** is installation-wide and on by default. Turning it off removes headings and section spacing without changing order: default Local folder root, active Cinna server, other folder roots, direct A2A, ACP connections, Managed agents. Hidden Cinna agents remain in Settings → Profile → Agents.
- **Appearance decoration follows one preference.** Default-on Extra UI animation adds a quick stationary-text curtain between main chat layouts, sidebar grid/border bursts, a left-to-right header background wave and occasional secondary-button glows. Composer interaction quiets its own artwork, reduced motion suppresses all extra effects, and collapsing the sidebar disables its decoration. See [Appearance](../appearance/appearance.md) for scope and lifecycle.
- **Top bar is always present.** Buttons do not shift when the sidebar toggles — they share a row with the macOS traffic lights via a fixed left gutter.
- **Sidebar reserves its slot.** Collapse animates the inner panel away (translate + fade) and shrinks the wrapper width, but it does not unmount; the main area reflows in step.
- **Sidebar always renders.** Even when collapsed the wrapper exists in the flex layout (width 0); the inner panel uses `pointer-events: none` when invisible.
- **Traffic-light gutter is hard-coded.** The renderer pads the top bar by 76 px to clear the macOS controls (which are positioned by Electron at x=15, y=10). Changing one without the other breaks alignment — see `src/main/index.ts` `trafficLightPosition`.
- **Settings entry-point.** Settings is reachable from the profile dropdown only — there is no longer a dedicated Settings button in the sidebar footer.
- **Console toggle is always available.** The Interface popover always shows the Console (App Logs) toggle, regardless of whether the logger has been enabled in Development settings. Opening it surfaces logs from that point forward.
- **Profile/Interface popovers are portaled.** They render into `document.body` (via `createPortal`) so the sidebar's `overflow: hidden` (needed for rounded-corner clipping) does not clip them.
- **Base font size is 17 px on `html`.** All rem-based Tailwind sizes (`text-xs`, `text-sm`, …) scale from this baseline. Changing it rescales the entire app uniformly.

### Across launches

- **The window reopens where it was left, never where it cannot be reached.** A saved position is kept only while enough of the window's top strip — the part with the traffic lights that the user drags — lies on an attached display to grab (at least 100 × 20 px of its top 40 px). Otherwise the position is dropped and the window opens centred, because restoring it faithfully after a monitor was unplugged would put it off every screen with nothing to drag it back by.
- **The size fits the display the window lands on.** It is capped to the work area of the display holding most of the top strip, so a large window on a large external monitor keeps its size rather than shrinking to the laptop's. When the position is dropped, or capping the size would pull the strip off that display, the size is capped to the primary display instead. It is never below the 800 × 600 minimum.
- **First launch and a bad file open at 1200 × 800, centred.** No saved state is a first launch and says nothing; an unreadable file, or one with any field missing or of the wrong type, is logged and ignored. Reading and writing window state never throws, so it can cost the user a remembered size but never the window.
- **A maximized window comes back maximized and still un-maximizes to a real size.** What is saved is the window's normal frame plus the maximized flag, and the window is created at that frame and maximized before it is shown. Saving the maximized frame instead would leave a window that can never be made smaller than the screen.
- **Fullscreen is deliberately not restored.** Launching straight into a macOS fullscreen Space is disorienting. A window quit in fullscreen reopens at its normal frame, maximized only if it was maximized before it went fullscreen.
- **Saved as it settles, and again on close.** A drag or resize is written once it has been still for half a second, so a crash keeps the last settled size; closing the window writes immediately, so a resize made just before closing is not lost. The size a maximized window returns to is only taken from a settled window, since the maximize animation passes through near-maximized sizes that must not be mistaken for it. So a resize followed by a maximize within that half second is forgotten, and the window un-maximizes to the size it had before.
- **The sidebar's open state is remembered for the machine, not the profile.** Stored in renderer `localStorage` beside the theme, so every local profile shares it and nothing syncs it. It is read when the UI store is created, so the first paint already has the sidebar in its remembered state instead of rendering open and then collapsing. Only the toggle writes it; no stored value means open.
- **Nothing else about the layout is remembered.** Active view, sidebar tab, settings tab, open chat and agent page all start fresh, so every launch lands on the new-chat screen. A remembered chat, task or agent page can have been deleted, hidden or belong to a different profile by the next launch, and the new-chat screen is valid in every one of those cases.
- **Window state belongs to the main window only.** The menu-bar tray popover is positioned from its icon and is neither saved nor restored.

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

Across launches:

```
Launch / macOS Dock reopen
  -> Main: createWindow -> read window state -> fit to the displays attached now
  -> BrowserWindow at those bounds -> ready-to-show -> maximize (if saved) -> show
  resize / move / maximize / unmaximize -> save once settled;  close -> save now

Renderer boot
  -> UI store reads the sidebar's stored open state -> sidebarOpen
  -> activeView = chat, no active chat -> new-chat screen
```

## Integration Points

- **UI Store** — Owns `sidebarOpen` (the only one of these kept across launches), `activeView`, `settingsTab`, `theme`, `verboseMode`, `logsOpen`, `agentStatusOpen`. See `src/renderer/src/stores/ui.store.ts`.
- [Settings Scope](../../core/settings_scope/settings_scope.md) — Window state and the sidebar's open state are machine-wide, like the theme.
- [Boot Resilience](../../core/boot_resilience/boot_resilience.md) — Window state is read inside `createWindow()`, within the startup boundary where a throw is fatal; it falls back to the defaults instead of throwing, so a bad state file can never become a ghost app.
- [End-to-End Tests](../../development/e2e/e2e.md) — `window-state.spec.ts` covers size and sidebar state across a quit and across a window close.
- [Inbox](../../jobs/tasks/inbox.md) — Global waiting asks, opened from the top bar.
- [Appearance](../appearance/appearance.md) — Theme preference/resolution, shared storage and decorative motion across shell and composers.
- [Settings](../settings/settings.md) — The settings page rendered in the main area; entered via the profile dropdown.
- [Verbose Mode](../verbose_mode/verbose_mode.md) — Toggled from the Interface popover.
- [Keyboard Shortcuts](../keyboard_shortcuts/keyboard_shortcuts.md) — ⌘\` opens the logs overlay regardless of the Console toggle.
- [User Accounts](../../auth/user_accounts/user_accounts.md) — Profile dropdown lists local accounts and triggers account switching / sign-out.
- [Agent Status](../../agents/agent_status/agent_status.md) — Top-bar status indicator and overlay.
- [Menu-Bar Tray](../tray/tray.md) — macOS menu-bar icon + popover; created when the main window opens and destroyed when it closes.
- [Logger](../../development/logger/logger.md) — Console toggle and overlay.
