# App Shell — Technical Details

## File Locations

### Main Process — Window

- `src/main/index.ts:createWindow()` — builds the main `BrowserWindow` from `loadWindowState()`, attaches `trackWindowState()` immediately, and maximizes in `ready-to-show` before `show()` / `showInactive()`. The `activate` handler calls it again when no window exists, which is how a macOS Dock reopen gets the saved state too (the tray popover is destroyed with the main window, so it does not count as one)
- `src/main/window/windowState.ts` — load, resolve and save of window state; `DEFAULT_WINDOW_WIDTH`/`HEIGHT` (1200 × 800) and `MIN_WINDOW_WIDTH`/`HEIGHT` (800 × 600), which `createWindow` passes as `minWidth`/`minHeight`. See [Window State](#window-state)

### Renderer — Composition Root

- `src/renderer/src/App.tsx` — `App` (QueryClientProvider + AuthGate), `Shell` (relative container with `p-2` window padding; sidebar/main flex row + absolutely positioned TopBar overlaying the top so MainArea can claim full window height)
- `src/renderer/src/App.tsx` — `AuthGate` branches on `useStartup()`: blank backdrop while pending, `StartupError` (message + Retry) if the startup call failed, `LoginScreen` when a password is required, otherwise the app. `StartupError` is the only guard against a silent blank window on a failed boot — see [Resource Activation](../../core/resource_activation/resource_activation.md)

### Renderer — Layout

- `src/renderer/src/components/layout/TopBar.tsx` — Persistent top strip; sidebar toggle + Agent Status + Inbox + new chat icons; `app-drag-strip` makes the area draggable, traffic-light gutter via `pl-[76px]`. Absolutely positioned (`absolute top-2 left-2 right-2 h-[var(--topbar-h)] z-30`) so it overlays the sidebar/main row rather than stealing height from it
- `src/renderer/src/components/layout/Sidebar.tsx` — Floating sidebar; renders Chats/Jobs/Notes/Agents tab content or the settings menu; footer composes `UserMenu`, local-development/update status and `InterfaceMenu`
- `src/renderer/src/components/layout/InterfaceMenu.tsx` — Sliders icon + portaled popover with Console / Verbose / Theme toggles
- `src/renderer/src/components/layout/MainArea.tsx` — View router for chat, settings, Inbox, task/job/note and local/external agent pages; mounts `useLiveRunWatch` and `useReadChatResult` once above the individual workspaces. Only activeView=chat supplies a visible chat ID for foreground result acknowledgement; [status details](../../chat/session_status/session_status_tech.md#renderer-components).

### Renderer — Header and Footer Sub-components

- `src/renderer/src/components/auth/UserMenu.tsx` — Profile trigger + portaled dropdown; `compact` prop renders the avatar-only sidebar-footer variant
- `src/renderer/src/components/agents/AgentStatusButton.tsx` — Top-bar activity icon with severity dot; opens agent-status overlay

### Renderer — Shared UI / Hooks

- `src/renderer/src/components/ui/usePopover.ts` — Generic popover wiring: trigger ref, popover ref, fixed-position computation, outside-click handler with portal-aware exclusion, and a clamp back inside the window (horizontal for every placement, vertical for `right`); placements `above-left | above-right | below-right | right`
- `src/renderer/src/hooks/useStartNewChat.ts` — Stable callback: clears `activeChatId`, sets `activeView` to `chat`

### Renderer — Styles

- `src/renderer/src/assets/main.css` — `@layer base` rules:
  - `html { font-size: 17px }` — base scaling
  - `:root { --topbar-h: 36px }` — TopBar height token; consumed by `TopBar` (`h-[var(--topbar-h)]`), the sidebar card offset, and any view that needs to clear the bar (e.g. `MessageStream`'s `pt-[calc(var(--topbar-h)+12px)]`, `SettingsPage`'s top padding)
  - `.app-sidebar` / `[data-theme="dark"] .app-sidebar` — rounded card surface, border, shadow, dark-theme translucent blur
  - `.app-popover-surface` / `[data-theme="dark"] .app-popover-surface` — shared frosted-glass utility for floating panels (profile dropdown, register/sign-out modals, interface-toggles popover). Translucent fill + `backdrop-filter: blur(14px) saturate(140%)`, theme-aware tint
  - `.app-nav-active` / `[data-theme="dark"] .app-nav-active` — translucent tint for active sidebar nav rows (chat item, settings menu, Trash). Replaces solid `bg-tertiary` so the sidebar's frosted background shows through
  - `.app-sidebar-wrap` — `--sidebar-page-width: 240px` + `--sidebar-tab-rail: 28px` (`--sidebar-width` is their sum), and the width / transform / opacity transitions (collapse/expand)
  - `.app-sidebar-wrap > .app-sidebar` — absolute position with `top: calc(var(--topbar-h) + 4px)` so the visible card sits below the overlaid TopBar (the wrap itself stays full-height to keep the width-collapse animation pristine); `left: var(--sidebar-tab-rail)` leaves room for the tab rail; `bottom: 0`
  - `.app-sidebar-wrap.is-collapsed` — `width: 0` + `transform: translateX(calc(-1 * var(--sidebar-width)))` + `opacity: 0` + `pointer-events: none`. The slide and fade live on the **wrap**, not on the rail and the card separately: a per-element `translateX(-100%)` resolves against each element's own width (28 px vs 240 px), which tore the tabs off the page mid-animation
  - `.app-drag-strip` — `-webkit-app-region: drag`, with `no-drag` exception for buttons/anchors

### Removed

- `src/renderer/src/components/layout/TitleBar.tsx` — deleted; replaced by `TopBar.tsx` <!-- nocheck -->

## State Management

### UI Store (`src/renderer/src/stores/ui.store.ts`)

| State | Purpose |
|-------|---------|
| `sidebarOpen` | Drives `.is-collapsed` on the sidebar wrapper. Persisted as `cinna-sidebar-open`: read synchronously in the store initializer (only `0` collapses; missing or anything else is open) and written by `toggleSidebar` as `1`/`0`. Direct `setState` calls — tests only — do not write it |
| `activeView` | `ActiveView` — chat, settings, inbox, task, job-detail, job-edit, cinna-task-run, note-detail, local-agent or external-agent |
| `sidebarTab` | Chats / Jobs / Notes / Agents, retained when opening a cross-tab view such as Inbox |
| `activeLocalAgentId`, `activeExternalAgentId` | Mutually exclusive agent selections; each setter clears the other |
| `agentPageMode` | `chat` or `settings`, initially `chat`; row selection sets chat mode explicitly |
| `pendingAgentId` | One-shot dashboard preselection consumed only by the non-embedded workspace |
| `settingsTab` | Active settings sub-section (consumed by `Sidebar` + `SettingsPage`) |
| `theme` | Resolved `'dark' \| 'light'`, applied via document `data-theme` and `window.api.app.setTheme(theme)` for dock/window icons |
| `themePreference` | `'system' \| 'dark' \| 'light'`, persisted as `cinna-theme`; Features chooses any value, InterfaceMenu selects a fixed opposite resolved theme |
| `extraUIAnimation` | Default-on renderer preference, persisted as `cinna-extra-ui-animation`; gates grid, surface/button borders, header wave and the new-chat logo's draw and sweep |
| `verboseMode` | Toggled from `InterfaceMenu`; persisted via `localStorage` |
| `logsOpen` | Toggled from `InterfaceMenu` and via ⌘\` |
| `agentStatusOpen` | Toggled from `AgentStatusButton` |

Most shell components select individual store keys to limit unrelated renders; `ChatWorkspace` also reads the whole UI store for its view and pending selection.

**What survives a relaunch.** `sidebarOpen`, `themePreference`, `extraUIAnimation` and `verboseMode` read `localStorage` at store creation. Everything navigational — `activeView` (`chat`), `sidebarTab` (`chats`), `settingsTab`, the agent/job/task/note selections, and `activeChatId` in `src/renderer/src/stores/chat.store.ts` (`null`) — starts from its literal default, which is what puts every launch on the new-chat screen. Persisting any of them would change that; the comment on `SIDEBAR_KEY` says so at the point someone would add one.

## IPC Channels

| Channel | Type | Params | Returns | Purpose |
|---------|------|--------|---------|---------|
| `app:set-theme` | handle | `'dark' \| 'light'` | `{ success: boolean }` | Updates main-process icon state via `appIconService.apply()`; called on bootstrap and when explicit selection, System appearance or another window changes the resolved theme. Handler in `src/main/ipc/app.ipc.ts` via the shared `ipcHandle` wrap. |

Other shell features (status indicator, profile menu, etc.) consume existing IPC via hooks (`useAgentStatus`, `useUsers`, etc.) — no new channels.

## Renderer Components

### TopBar (`TopBar.tsx`)

- Absolutely positioned overlay (`absolute top-2 left-2 right-2 h-[var(--topbar-h)] z-30`) — sits on top of the sidebar card and MainArea so the chat scroll viewport keeps full window height. Inset by 8 px on top/left/right to match the Shell's `p-2` window border
- Reads `sidebarOpen` to pick icon (`PanelLeftClose` vs `PanelLeft`)
- Renders `AgentStatusButton` between sidebar toggle and Inbox, independently of sidebar state, active view, profile type and available statuses. This keeps the overlay reachable with the sidebar collapsed.
- Renders `InboxButton` between Agent Status and `+`. Its 29×29 px control overlays an aria-hidden count (blank at zero, `99+` above 99, `!` on read error). On a partial read (`unreadable` non-empty) the count keeps its value in the warning tint, falling back to `!` at zero, and the accessible name appends `describeUnreadable`'s sentence (`Inbox — 2 waiting, one service could not be read`). The button exposes the full count/state in its title and accessible name, and sets `aria-pressed` for the Inbox view.
- Calls `useStartNewChat()` for the `+` button
- Buttons share the `TOPBAR_BTN` class string: slight-tint background at rest, solid background + subtle border on hover
- Background is transparent — content scrolling at the very top of MainArea is visible behind the bar's drag region; child views (`MessageStream`, `SettingsPage`, new-chat default) add their own `pt-[…var(--topbar-h)…]` so visible content starts below the buttons

### Sidebar (`Sidebar.tsx`)

- Outer wrapper element has `app-sidebar-wrap` + conditional `is-collapsed`; inner `app-sidebar` is the visible card
- `overflow: hidden` on the inner sidebar is required so its rounded corners clip child content; popovers escape this via `createPortal`
- Two body modes:
  - `activeView === 'settings'` — Back button, "Settings" header, vertical menu items + Trash with a divider
  - otherwise — the tab rail and the list selected by `sidebarTab`: `ChatList`, `JobsList`, `NotesList` or `LocalAgentsList`
- Footer is `UserMenu compact` / spacer / `LocalDevStatusButton` / `UpdateStatusButton` / `InterfaceMenu`.
- Returning to the already selected Agents tab from Inbox restores `external-agent` when `activeExternalAgentId` exists; otherwise it uses the tab's folder-agent view.
- `LocalAgentsList` reads `showAgentSidebarSections` from `useAppSettings`, defaulting on unless explicitly false. The same group ordering renders with or without headers; flattening adds no empty-group placeholder.

### InterfaceMenu (`InterfaceMenu.tsx`)

- Uses `usePopover<HTMLButtonElement>('above-right')`
- Popover (portaled to `document.body`) holds three icon toggles: Terminal/Eye-EyeOff/Sun-Moon
- Each toggle writes through the UI store; the popover stays open until outside click. Theme calls `toggleTheme`, which chooses a fixed Dark/Light value from the opposite resolved theme; System is selected in Features.

### UserMenu (`UserMenu.tsx`)

- `compact` prop swaps the trigger to avatar-only and the dropdown placement to `above-left` (vs `below-right` for the non-compact form, which is unused in the current shell)
- Dropdown is portaled with computed fixed position from `usePopover`
- Hosts three modal flows (Register, Sign-Out, LoginPrompt) — unchanged by the app-shell work; they continue to use their own outside-click refs
- Settings entry calls `setActiveView(activeView === 'settings' ? 'chat' : 'settings')`

### AgentStatusButton (`AgentStatusButton.tsx`)

- Always rendered by `TopBar` between sidebar toggle and Inbox, including empty/default/local profiles. With no reporting agents its glyph has no severity dot.
- Uses a fixed 29×29 px button with a 15 px Activity glyph, an overlaid severity dot and the `TOPBAR_BTN` classes passed through `className`, matching Inbox without moving adjacent controls when statuses change.
- `aria-label` mirrors the count/severity title; `aria-pressed` tracks `agentStatusOpen` and gives the open overlay an accent treatment. Glyph and dot are aria-hidden.
- Reads `useAgentStatus()` for severity dot; toggles the overlay and calls `refetch()` only when opening it so the indicator matches what the user is about to see

### usePopover (`usePopover.ts`)

- Single `useLayoutEffect` keyed on `[open, placement]`. A layout effect, not a passive one: the position is measured in the frame the popover opens, so one that follows the pointer from row to row never paints a frame of nothing in between
- Computes `position: fixed` style from the trigger's `getBoundingClientRect`, with a `GAP = 8` (above), `BELOW_GAP = 4` or `RIGHT_GAP = 4`
- `right` sits beside the trigger with top edges level — for a row's hoverable popover, which must cover neither the row nor the rows the pointer moves on to. 4 px is close enough for the pointer to cross onto it; it may overlap the sidebar card's edge. Used by the [chat row summary](../../chat/chat_row_summary/chat_row_summary_tech.md)
- `mousedown` handler closes when target is outside both the trigger ref and the popover ref
- Re-measures on `window resize`; consumer is responsible for scroll. The shell's own triggers do not scroll; the chat row summary's does, and closes on it rather than re-measuring

**Edge clamping.** Every placement anchors one *horizontal side* to the trigger, which is right for a trigger in a corner — where this hook started, in the sidebar footer — and wrong for one in the middle of a dialog, where a wide popover anchored two thirds of the way across a narrow window hangs off the far side. A `max-w` caps the width; it does not move anything. So a `useLayoutEffect` measures the popover once it is laid out and applies a horizontal `translateX` (`EDGE = 8` px minimum gap), leaving the anchor logic alone. Three details, each a trap worth not re-introducing:

- It measures **with the current shift already applied** and compares against it, so the corrected position is a fixed point rather than an oscillation.
- The left-edge correction runs **only when the popover fits** (`width <= vw - EDGE * 2`). One wider than the window cannot satisfy both edges, and trying moves it back and forth forever.
- A **zero-width rect returns early**. That covers an element not yet laid out *and* jsdom, where every rect is zero and "it starts before the left edge" would otherwise be true forever — a real infinite-render failure in the unit suite, not a hypothetical.

**Vertical clamping, `right` only.** `right` is the one placement that hangs down beside its trigger, so a trigger near the bottom of the window would push its popover past the edge. A second layout effect applies the same correction vertically, built the same way (current shift included, whole pixels, zero-height rect returns early), and the style's transform becomes `translate(x, y)`. When both edges cannot be kept the **top wins**, because a popover's first line is the one that says what it is about. The other placements grow away from the edge they were designed against and are left exactly as they were.

Layout is unmeasurable in jsdom, so the horizontal behaviour is covered by an E2E assertion instead: `e2e/specs/connect-intent.spec.ts` resizes to 620 px, opens the local-dev explainer and asserts the popover's box stays within the viewport. The `right` position and its vertical clamp are covered in `src/renderer/src/components/ui/usePopover.test.tsx` against stubbed rects and a stubbed window height.

### Shared chat workspace

- `src/renderer/src/components/layout/ChatWorkspace.tsx` owns the former chat branch of `MainArea`: pending agent/MCP lists, reactive chat-mode selection, example prompts, tilde popup state, send errors, new-chat submission and active-chat layout/composer measurement.
- `agentId` seeds the pending agent list. `embedded` forces the new-chat branch regardless of the stored active chat, omits the dashboard welcome heading (with its logo) and HintBar, and leaves the global `pendingAgentId` handoff to the dashboard instance. Agent selection remains editable through the shared composer.
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx` embeds a workspace keyed by agent id; `src/renderer/src/components/agents/ExternalAgentPage.tsx` keys it by profile and agent id. Both hide its wrapper in settings mode instead of unmounting it. In chat mode the page column and that wrapper are `flex flex-1 flex-col`, filling the height below the header. The embedded branch centres itself with `flex-1 justify-center`, which only works when its parent has height to give it: inside a plain block wrapper it shrinks to its `min-h-64`, and the composer sits directly under the header. Draft content lives in the profile/surface-keyed `composerDraft.store`, so it also survives navigation away and remount. Dashboard and individual agent keys remain independent; hidden settings mode still preserves the mounted composer.
- On an embedded dispatch confirmed by `startNewChat`'s boolean result, `handleNewChat` switches `activeView` to chat and `sidebarTab` to chats, then consumes only unchanged submitted selections. A false preparation result keeps the draft for retry; it is not inferred from unrelated global stream errors. The ordinary workspace reads the active chat id and renders its transcript.
- `RuntimePanel compact` is the folder landing/connection-tooltip summary; the full runtime form mounts only in folder Settings. Shared resolution supplies engine, credential/model and setup state. Claude subscription wording requires logged-in authentication with `authMethod === 'claude.ai'` or a subscription type; unknown auth is not a confirmed subscription.
- `ExternalAgentPage` uses Overview for description/readiness/skills and Connection for `AgentCard connectionOnly` (A2A/Cinna) or Configure buttons opening ACP/Managed dialogs. The Cinna header host opens through `window.api.system.openExternal`; failures stay on the page.

### Appearance integration

- `MainArea` wraps only its main `ChatWorkspace` branch in `ChatTransition`, keyed by active chat ID and the shared preference. An ID change (including null for dashboard) takes an inert outgoing DOM snapshot while the real workspace updates immediately. Agent/settings/Notes route changes do not gain a global page transition. Timing and cancellation belong to [Appearance](../appearance/appearance_tech.md#chat-switch-transitions).
- The non-embedded new-chat heading renders `src/renderer/src/components/ui/CinnaLogoDraw.tsx`. Its shown state is component-local and resets whenever the new-chat branch unmounts; drawing, sweep timing and theme colors belong to [Appearance](../appearance/appearance_tech.md#new-chat-logo).

- `Shell` mounts `src/renderer/src/hooks/useAmbientButtons.ts` once. `TopBar` owns its independent header-wave timer and passes the shared decorative class to all four controls.
- `Sidebar` marks its card as `ambient-grid-surface` and mounts `src/renderer/src/components/ui/AmbientGrid.tsx` with explicit border glow and `active={sidebarOpen}`; collapse cancels decoration without unmounting the sidebar.
- Every `ChatWorkspace` path reaches the shared decorated `ChatInput`; Local Development has its own active/ready-gated host. The neutral Settings button on folder/external agent pages opts into secondary glows; its accent Start chat state does not.
- Preference storage, System/cross-window propagation, scheduler timing and reduced-motion/interaction cleanup belong to [Appearance technical details](../appearance/appearance_tech.md). Draft lifetime belongs to [Conversation UI](../../chat/conversation_ui/conversation_ui_tech.md#draft-ownership); decoration and the curtain do not consume or persist drafts.

### Desktop visibility notification

- `src/renderer/src/hooks/useAgentDesktopVisibility.ts` handles Cinna hide/restore, snapshots sidebar order before the optimistic update, invalidates status data, and navigates after successful hide only if profile and selected external page still match. It picks the nearest preceding remaining agent, then another available agent, then the empty dashboard. Non-remote agents can be re-enabled from legacy disabled state but cannot be disabled here.
- `src/renderer/src/utils/agentNavigation.ts` owns `sidebarAgentOrder`, `nextAgentAfterHiding` and server host labeling, keeping hide navigation consistent with the grouped/flat sidebar.
- `src/renderer/src/components/ui/DesktopToast.tsx` mounts in `Shell` above every view. The single toast in `src/renderer/src/stores/toast.store.ts` replaces any previous toast, uses `role="status"`, dismisses after ten seconds or manually, and offers Settings → Profile → Agents for restoring hidden Cinna agents.
- `e2e/specs/agent-landing.spec.ts` checks local/A2A landing, settings transitions and draft preservation; `e2e/specs/agent-sidebar-sections.spec.ts` checks the setting through real UI, label activation and restart persistence.

## Window State

Behavioural rules are in [App Shell → Across launches](./app_shell.md#across-launches); this is how they are held.

### Storage

- **A JSON file in `userData`, `window-state.json`**, holding `{x, y, width, height, isMaximized}` — every field required. Not an `appSettings` key: that schema is shared with the renderer through the settings IPC, and window bounds are read and written only by main, so putting them there would hand the renderer a value it has no use for and a write path it must never take. No IPC channel, preload method or migration exists for it.
- Because the file lives under `userData`, the E2E suite's `CINNA_USER_DATA` sandbox covers it with no extra seam: a test never reads or overwrites the developer's own window position.
- Written to `window-state.json.<pid>.tmp` and renamed into place, so a crash mid-write leaves the previous file rather than half of one. A failed write removes the temp file and logs `window state not saved`.

### Services & Key Methods

- `src/main/window/windowState.ts:resolveWindowBounds()` — pure and Electron-free; takes the parsed value, the displays and the primary work area, so every display arrangement is unit-testable. Anything failing the type guard returns the defaults with no `x`/`y`. Otherwise it picks the **home display** as the one with the largest overlap with the window's 40 px top strip (counting only overlaps of at least 100 × 20 px), caps the size to that work area, and keeps the position only if the capped window still has a grabbable strip there. With no home, or a strip lost to the cap, it omits `x`/`y` — Electron centres a window created without them — and caps to the primary work area. `isMaximized` passes through either way.
- `src/main/window/windowState.ts:loadWindowState()` — reads and resolves against `screen`, so it can only run after `app` is ready. `ENOENT` is silent (first launch); any other read or parse failure, and anything the resolver throws, logs a warning and returns the defaults.
- `src/main/window/windowState.ts:trackWindowState()` — attach before the window is maximized, so the first bounds it records are the normal ones. `resize`, `move`, `maximize` and `unmaximize` schedule a save 500 ms after the last of them (`SAVE_DEBOUNCE_MS`); `close` saves synchronously, because by `closed` the window has no bounds left to read; `closed` cancels any pending save.

### Why the normal bounds are tracked, not read

The tracker keeps its own copy of the normal frame instead of calling `getNormalBounds()` at save time. On macOS, once a maximized window has been minimized, `getNormalBounds()` returns the maximized frame until the next `unmaximize()`; saving that restores a window that can never be made smaller than the screen. The maximized flag is only read while the window is neither minimized nor fullscreen, because neither state says whether the window the user returns to is maximized, and entering fullscreen may report it as maximized.

**The frame is taken only once the window has settled**, in the debounced save and on `close`, when the window is neither maximized, minimized nor fullscreen, and not from each `resize`/`move` event. The macOS zoom animation fires dozens of `resize` events with frames growing towards the maximized one while `isMaximized()` is still false (about 35 on Electron 41). Recording on each event saved a near-maximized frame as the normal size, which is the same can-never-shrink window by a different route. The accepted cost: a resize followed by a maximize within the 500 ms debounce is never seen settled, so the saved normal size is the one from before that resize.

### Tests

- `src/main/window/windowState.test.ts` — the resolver over malformed input, off-screen, partly-visible and multi-monitor layouts; load and save over a real temp `userData` with a fake window whose `getNormalBounds()` reproduces the macOS behaviour above, so a tracker that trusted it fails, and a replay of the maximize animation's growing frames, so a tracker that recorded per event fails too.
- `src/renderer/src/stores/ui.appearance.test.ts` — `sidebar open state`: default open, written on every toggle, a fresh store reads it back and still starts on `chat` / `chats`.
- `e2e/specs/window-state.spec.ts` — see [End-to-End Tests](../../development/e2e/e2e.md). A plain relaunch cannot prove the save on `close` (Playwright's teardown outlasts the debounce), so the spec also resizes and closes in one tick; the reasoning is in [Writing E2E Tests](../../development/e2e/e2e_llm.md).

## Configuration

- **Window size** — default 1200 × 800 and minimum 800 × 600, exported from `src/main/window/windowState.ts`; the saved state lives in `<userData>/window-state.json`. No setting or environment variable changes either.
- **Sidebar open state** — `localStorage` key `cinna-sidebar-open`, `1`/`0`.
- **macOS traffic-light position** — `src/main/index.ts` `BrowserWindow` config: `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: { x: 15, y: 10 }`. The renderer's `pl-[76px]` gutter in `TopBar.tsx` mirrors this offset (~58 px cluster width + small margin). Keep them in sync.
- **Agent sidebar sections** — `showAgentSidebarSections: boolean`, default `true`, in `src/shared/appSettings.ts` and `src/main/db/appSettings.ts`; persisted via installation-wide `app_settings`. Features settings surfaces read/save failures, including the restart guidance for an unknown key.
- **Base font size** — `html { font-size: 17px }` in `main.css`. Scales every rem-based size.
- **Sidebar width** — `--sidebar-page-width: 240px` and `--sidebar-tab-rail: 28px` on `.app-sidebar-wrap`; `--sidebar-width` is their sum. The wrapper `width` uses the sum, the inner card uses the page width (inset by the rail), and the collapse animation translates the wrapper by the sum so rail + card leave together.
- **Shell layering** — `App.tsx` `Shell` is a `relative` flex column with symmetric `p-2` (8 px) window padding. The sidebar/main row is the only in-flow child; `TopBar` is absolutely positioned with the same 8 px inset (`top-2 left-2 right-2`) so the row claims the full Shell height instead of losing it to a flex-sibling header. The horizontal `gap-2` between Sidebar and MainArea stays at 8 px. Visible content in each view clears the bar through `var(--topbar-h)`-derived top padding (sidebar card via CSS `top`, `MessageStream` / `SettingsPage` / new-chat view via `pt-[calc(var(--topbar-h)+12px)]`).
- **App icons** — `resources/cinna-desktop-icon-{dark,light}.png`, loaded via `?asset` in `src/main/host/desktop/appIconService.ts`. Build-time installer icons (`build/icon.png`, `build/icon.icns`) are the dark variant (default theme). Windows `build/icon.ico` is built externally — regenerate from `build/icon.png` after icon changes.

## Security

No new surface. Console/Verbose/Theme toggles and the sidebar toggle only mutate UI state (`localStorage` + the UI store). Profile actions reuse the existing user-account IPC channels. `window-state.json` holds only screen coordinates and is never exposed to the renderer; a hand-edited or corrupt file can at worst open the window at the defaults, because every value is type-checked and fitted to the attached displays before use.

## Related

- [App Shell business doc](./app_shell.md) — user-facing behaviour and business rules
- [Settings](../settings/settings.md) — settings page integration
- [Appearance](../appearance/appearance.md) — theme and extra-animation contracts
- [UI Guidelines](../../development/ui_guidelines/ui_guidelines_llm.md) — color system, expandable card pattern
