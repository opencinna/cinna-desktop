# App Shell — Technical Details

## File Locations

### Renderer — Composition Root

- `src/renderer/src/App.tsx` — `App` (QueryClientProvider + AuthGate), `Shell` (relative container with `p-2` window padding; sidebar/main flex row + absolutely positioned TopBar overlaying the top so MainArea can claim full window height)

### Renderer — Layout

- `src/renderer/src/components/layout/TopBar.tsx` — Persistent top strip; sidebar toggle + new chat icons; `app-drag-strip` makes the area draggable, traffic-light gutter via `pl-[76px]`. Absolutely positioned (`absolute top-2 left-2 right-2 h-[var(--topbar-h)] z-30`) so it overlays the sidebar/main row rather than stealing height from it
- `src/renderer/src/components/layout/Sidebar.tsx` — Floating sidebar; renders `ChatList` (chat view) or settings menu (settings view); footer composes `UserMenu`, `AgentStatusButton`, `InterfaceMenu`
- `src/renderer/src/components/layout/InterfaceMenu.tsx` — Sliders icon + portaled popover with Console / Verbose / Theme toggles
- `src/renderer/src/components/layout/MainArea.tsx` — Chat or settings content area (untouched by this feature)

### Renderer — Sidebar Footer Sub-components

- `src/renderer/src/components/auth/UserMenu.tsx` — Profile trigger + portaled dropdown; `compact` prop renders the avatar-only sidebar-footer variant
- `src/renderer/src/components/agents/AgentStatusButton.tsx` — Activity icon with severity dot; opens agent-status overlay

### Renderer — Shared UI / Hooks

- `src/renderer/src/components/ui/usePopover.ts` — Generic popover wiring: trigger ref, popover ref, fixed-position computation, outside-click handler with portal-aware exclusion; placements `above-left | above-right | below-right`
- `src/renderer/src/hooks/useStartNewChat.ts` — Stable callback: clears `activeChatId`, sets `activeView` to `chat`

### Renderer — Styles

- `src/renderer/src/assets/main.css` — `@layer base` rules:
  - `html { font-size: 17px }` — base scaling
  - `:root { --topbar-h: 36px }` — TopBar height token; consumed by `TopBar` (`h-[var(--topbar-h)]`), the sidebar card offset, and any view that needs to clear the bar (e.g. `MessageStream`'s `pt-[calc(var(--topbar-h)+12px)]`, `SettingsPage`'s top padding)
  - `.app-sidebar` / `[data-theme="dark"] .app-sidebar` — rounded card surface, border, shadow, dark-theme translucent blur
  - `.app-popover-surface` / `[data-theme="dark"] .app-popover-surface` — shared frosted-glass utility for floating panels (profile dropdown, register/sign-out modals, interface-toggles popover). Translucent fill + `backdrop-filter: blur(14px) saturate(140%)`, theme-aware tint
  - `.app-nav-active` / `[data-theme="dark"] .app-nav-active` — translucent tint for active sidebar nav rows (chat item, settings menu, Trash). Replaces solid `bg-tertiary` so the sidebar's frosted background shows through
  - `.app-sidebar-wrap` — `--sidebar-width: 240px`, width transition (collapse/expand)
  - `.app-sidebar-wrap > .app-sidebar` — absolute position with `top: calc(var(--topbar-h) + 4px)` so the visible card sits below the overlaid TopBar (the wrap itself stays full-height to keep the width-collapse animation pristine); `bottom: 0`; transform/opacity transitions
  - `.app-sidebar-wrap.is-collapsed > .app-sidebar` — `translateX(-100%)` + `opacity: 0` + `pointer-events: none`
  - `.app-drag-strip` — `-webkit-app-region: drag`, with `no-drag` exception for buttons/anchors

### Removed

- `src/renderer/src/components/layout/TitleBar.tsx` — deleted; replaced by `TopBar.tsx` <!-- nocheck -->

## State Management

### UI Store (`src/renderer/src/stores/ui.store.ts`)

| State | Purpose |
|-------|---------|
| `sidebarOpen` | Drives `.is-collapsed` on the sidebar wrapper |
| `activeView` | `'chat' \| 'settings'` — switches sidebar content + main area |
| `settingsTab` | Active settings sub-section (consumed by `Sidebar` + `SettingsPage`) |
| `theme` | `'dark' \| 'light'` — toggled from `InterfaceMenu`; written to `localStorage('cinna-theme')`, applied via `data-theme` on `<html>`, and propagated to main process via `window.api.app.setTheme(theme)` so `appIconService.apply()` swaps the macOS dock + window icon to the matching `cinna-desktop-icon-{dark,light}.png` asset |
| `verboseMode` | Toggled from `InterfaceMenu`; persisted via `localStorage` |
| `logsOpen` | Toggled from `InterfaceMenu` and via ⌘\` |
| `agentStatusOpen` | Toggled from `AgentStatusButton` |

All shell consumers select individual keys (`useUIStore((s) => s.x)`) rather than destructuring the whole store, to avoid render-storm on unrelated updates.

## IPC Channels

| Channel | Type | Params | Returns | Purpose |
|---------|------|--------|---------|---------|
| `app:set-theme` | handle | `'dark' \| 'light'` | `{ success: boolean }` | Updates main-process icon state via `appIconService.apply()`; called on bootstrap and on every theme toggle. Handler in `src/main/ipc/app.ipc.ts` via the shared `ipcHandle` wrap. |

Other shell features (status indicator, profile menu, etc.) consume existing IPC via hooks (`useAgentStatus`, `useUsers`, etc.) — no new channels.

## Renderer Components

### TopBar (`TopBar.tsx`)

- Absolutely positioned overlay (`absolute top-2 left-2 right-2 h-[var(--topbar-h)] z-30`) — sits on top of the sidebar card and MainArea so the chat scroll viewport keeps full window height. Inset by 8 px on top/left/right to match the Shell's `p-2` window border
- Reads `sidebarOpen` to pick icon (`PanelLeftClose` vs `PanelLeft`)
- Calls `useStartNewChat()` for the `+` button
- Buttons share the `TOPBAR_BTN` class string: slight-tint background at rest, solid background + subtle border on hover
- Background is transparent — content scrolling at the very top of MainArea is visible behind the bar's drag region; child views (`MessageStream`, `SettingsPage`, new-chat default) add their own `pt-[…var(--topbar-h)…]` so visible content starts below the buttons

### Sidebar (`Sidebar.tsx`)

- Outer wrapper element has `app-sidebar-wrap` + conditional `is-collapsed`; inner `app-sidebar` is the visible card
- `overflow: hidden` on the inner sidebar is required so its rounded corners clip child content; popovers escape this via `createPortal`
- Two body modes:
  - `activeView === 'settings'` — Back button, "Settings" header, vertical menu items + Trash with a divider
  - otherwise — `pt-2` + `ChatList`
- Footer is a single 3-slot row: `UserMenu compact` / spacer / `AgentStatusButton` (cinna users only) / `InterfaceMenu`

### InterfaceMenu (`InterfaceMenu.tsx`)

- Uses `usePopover<HTMLButtonElement>('above-right')`
- Popover (portaled to `document.body`) holds three icon toggles: Terminal/Eye-EyeOff/Sun-Moon
- Each toggle writes through the UI store; the popover stays open until outside click

### UserMenu (`UserMenu.tsx`)

- `compact` prop swaps the trigger to avatar-only and the dropdown placement to `above-left` (vs `below-right` for the non-compact form, which is unused in the current shell)
- Dropdown is portaled with computed fixed position from `usePopover`
- Hosts three modal flows (Register, Sign-Out, LoginPrompt) — unchanged by the app-shell work; they continue to use their own outside-click refs
- Settings entry calls `setActiveView(activeView === 'settings' ? 'chat' : 'settings')`

### AgentStatusButton (`AgentStatusButton.tsx`)

- Only rendered by `Sidebar` when `currentUser?.type === 'cinna_user'`
- Reads `useAgentStatus()` for severity dot; calls `refetch()` when opening the overlay so the indicator matches what the user is about to see

### usePopover (`usePopover.ts`)

- Single `useEffect` keyed on `[open, placement]`
- Computes `position: fixed` style from the trigger's `getBoundingClientRect`, with a `GAP = 8` (above) or `BELOW_GAP = 4`
- `mousedown` handler closes when target is outside both the trigger ref and the popover ref
- Re-measures on `window resize`; consumer is responsible for re-measuring on scroll if relevant (current shell does not scroll the trigger)

## Configuration

- **macOS traffic-light position** — `src/main/index.ts` `BrowserWindow` config: `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: { x: 15, y: 10 }`. The renderer's `pl-[76px]` gutter in `TopBar.tsx` mirrors this offset (~58 px cluster width + small margin). Keep them in sync.
- **Base font size** — `html { font-size: 17px }` in `main.css`. Scales every rem-based size.
- **Sidebar width** — `--sidebar-width: 240px` on `.app-sidebar-wrap`. Both the wrapper `width` and the inner `width` consume it; the collapse animation translates `-100%` of that value.
- **Shell layering** — `App.tsx` `Shell` is a `relative` flex column with symmetric `p-2` (8 px) window padding. The sidebar/main row is the only in-flow child; `TopBar` is absolutely positioned with the same 8 px inset (`top-2 left-2 right-2`) so the row claims the full Shell height instead of losing it to a flex-sibling header. The horizontal `gap-2` between Sidebar and MainArea stays at 8 px. Visible content in each view clears the bar through `var(--topbar-h)`-derived top padding (sidebar card via CSS `top`, `MessageStream` / `SettingsPage` / new-chat view via `pt-[calc(var(--topbar-h)+12px)]`).
- **App icons** — `resources/cinna-desktop-icon-{dark,light}.png`, loaded via `?asset` in `src/main/services/appIconService.ts`. Build-time installer icons (`build/icon.png`, `build/icon.icns`) are the dark variant (default theme). Windows `build/icon.ico` is built externally — regenerate from `build/icon.png` after icon changes.

## Security

No new surface. Console/Verbose/Theme toggles only mutate UI state (`localStorage` + the UI store). Profile actions reuse the existing user-account IPC channels.

## Related

- [App Shell business doc](./app_shell.md) — user-facing behaviour and business rules
- [Settings](../settings/settings.md) — settings page integration
- [UI Guidelines](../../development/ui_guidelines/ui_guidelines_llm.md) — color system, expandable card pattern
