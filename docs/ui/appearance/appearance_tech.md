# Appearance — Technical Details

Implementation companion to [Appearance](appearance.md).

## File Locations

### Main process and preload

- `src/main/ipc/app.ipc.ts` — existing `app:set-theme` validation and icon update.
- `src/main/host/desktop/appIconService.ts` — `apply`, `iconForCurrentTheme`; dock/window icon assets for resolved themes.
- `src/preload/index.ts` — `window.api.app.setTheme`.

### Renderer — state and scheduling

- `src/renderer/src/utils/theme.ts` — `Theme`, `ThemePreference`, `readThemePreference`, `resolveTheme` shared with the tray root.
- `src/renderer/src/stores/ui.store.ts` — persisted preferences, resolved theme, OS/storage listeners and HMR cleanup.
- `src/renderer/src/components/ui/AmbientGrid.tsx` — `makeTrails`, grid/border state, interaction and visibility lifecycle.
- `src/renderer/src/hooks/useAmbientButtons.ts` — one secondary-button scheduler per mounted Shell.
- `src/renderer/src/components/layout/TopBar.tsx` — header-wave scheduler.
- `src/renderer/src/components/layout/ChatTransition.tsx` — chat-switch DOM snapshot and diagonal fading curtain; hosted by `MainArea`.
- `src/renderer/src/components/ui/CinnaLogoDraw.tsx` — new-chat logo: `OUTLINES` (the wordmark of `resources/cinna-desktop-icon-dark.png` / `resources/cinna-desktop-icon-light.png` as closed SVG paths, committed as a constant), local shown state, `DRAW_MS` and the band-sweep scheduler.
- `src/renderer/src/assets/main.css` — theme tokens (including `--color-logo-from` / `--color-logo-to`), grid/edge animations, masked traveling borders, staggered header backgrounds, and the `cinna-logo-*` draw transitions and sweep keyframes.
- `src/renderer/src/trayPanel.tsx` — independent popup theme application and listeners.

### Renderer — hosts and controls

- `src/renderer/src/App.tsx` — `Shell` mounts `useAmbientButtons`.
- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — Theme choice group and Extra UI animation switch.
- `src/renderer/src/components/layout/InterfaceMenu.tsx` — fixed-theme shortcut.
- `src/renderer/src/components/layout/Sidebar.tsx` — grid surface with `active={sidebarOpen}` and explicit border glow.
- `src/renderer/src/components/chat/ChatInput.tsx` — shared textarea grid and current border tint; `src/renderer/src/components/layout/ChatWorkspace.tsx` supplies new/existing and embedded agent composers.
- `src/renderer/src/components/localdev/LocalDevelopmentPage.tsx` — active/ready-gated build composer, focus tint and secondary action opt-in.
- `src/renderer/src/components/settings/SettingsLayout.tsx` — `SettingsButton` opt-in; `src/renderer/src/components/agents/local/LocalAgentPage.tsx` and `src/renderer/src/components/agents/ExternalAgentPage.tsx` opt in only their neutral Settings action.

## Database Schema

No table, migration or `app_settings` key. Preferences use same-origin renderer localStorage, independent of active profile and profile synchronization. Existing icon state in main is process-local.

## IPC Channels

| Channel / preload method | Signature | Effect |
|---|---|---|
| `app:set-theme` / `app.setTheme` | `('dark' or 'light') → { success: boolean }` | Existing handler validates the resolved theme and calls `appIconService.apply`; invalid values return false |

System is resolved before IPC; main never receives `system`. The handler updates dock/window icons, not Electron nativeTheme or the OS appearance. Animation has no IPC or service call.

## Services & Key Methods

### Preference resolution and propagation

- `readThemePreference` accepts saved `dark` or `light`, otherwise returns `system`, so a fresh install (and malformed storage) follows the OS. `resolveTheme` evaluates `prefers-color-scheme: dark` only for System; without matchMedia, System resolves Light.
- `useUIStore.setThemePreference` saves the preference, resolves it, applies `data-theme` to the document, asks main to update icons and publishes both state values. `toggleTheme` selects the opposite resolved theme as a fixed preference.
- The store applies its theme at module load. `followSystemTheme` updates the resolved theme on OS changes only while the preference is System, without overwriting the saved preference. IPC rejection is caught so renderer appearance remains usable.
- `syncAppearance` rereads relevant keys on cross-window storage events; a null key rereads both. HMR disposal removes the store's OS and storage listeners.
- The tray root shares the pure theme helpers, applies on bootstrap, and re-applies on OS changes or storage events for `cinna-theme`. Fixed preferences remain fixed because every event resolves the saved preference. The menu-bar glyph's OS listener remains in `src/renderer/src/hooks/useTrayIcon.ts`.

### Grid and border scheduling

- `AmbientGrid` takes `active` (default true), optional textarea `inputRef`, optional current `borderColor`, and `borderGlow` (defaults to whether an input ref exists). Effective enablement is `active && extraUIAnimation`.
- `makeTrails` uses a 24 px grid with 12 px offset. It favors the host's long axis and open space, builds a directed trunk of up to 12–17 steps and up to two 4–7-step forks, and shares visited nodes so paths cannot reconnect into boxes. Heading, continuation, outward distance and nearby trails weight each next edge. Bounds can shorten a path; forks begin after the pulse reaches their attachment.
- Each burst measures its host before generating artwork. Grid hosts smaller than one cell and border hosts without dimensions retry after their normal quiet interval. Hidden embedded chat composers therefore need no new layout or chat-state mutation.
- `quiet` listens on the textarea for pointerdown, keydown, beforeinput, input and compositionstart. It cancels grid/border timers, sets `data-fading`, retains artwork for the 350 ms opacity fade, then clears it. No focus listener is installed: autofocus remains idle. `resume` runs on blur after actual interaction and schedules normal quiet intervals.
- `restart` clears all timers and artwork on document visibility or reduced-motion changes, then schedules initial delays only when visible, motion is allowed and interaction is inactive. Effect cleanup marks disposal, clears grid/border/fade timers and removes every installed listener. Preference/active gating removes artwork immediately; unmount cleans the effect.

| Effect | Initial/restart delay | Active duration | Quiet interval after completion |
|---|---|---|---|
| Grid pulse | 1.5–4.5 s | 6.5–8.5 s | 12–24 s; also used after interaction ends |
| Input/sidebar border | 18–35 s | 4.2–6 s | 35–70 s; also used after interaction ends |
| Secondary-button border | 4–9 s | 4.2–5.6 s | 8–18 s; no eligible button retries in 8–16 s |
| Header wave | 8–18 s | 2 s scheduling window | 28–55 s |
| New-chat logo sweep | 6–9 s after the logo is shown (5 s draw + 1–4 s); 4–9 s after a visibility/motion change, never before the draw has finished | 4.2–5.6 s | 8–18 s |

Grid/border state is per host; the secondary-button singleton, header scheduler and logo sweep are independent, so their effects can overlap with a surface burst.

### Secondary buttons and header wave

- `useAmbientButtons` queries enabled `button.ambient-button` candidates, plus any `.ambient-button[data-ambient-card]` — the job and task pages' Details panels — at each selection, so a card and a button never glow together. `checkVisibility` checks opacity/CSS visibility; the center must be inside the viewport and `elementFromPoint` must resolve inside the candidate, excluding controls behind dialogs or clipped at that point. Visibility is checked at selection, not continuously throughout a glow.
- One selected button receives `data-ambient-glow`, a random quarter-turn start angle and duration variables. `clear` removes those attributes/styles and the timer before another selection, on visibility/motion changes, when disabled or on unmount. No qualifying candidate means a delayed retry.
- "One at a time" holds among the scheduler's candidates only. The glow CSS matches any `.ambient-button[data-ambient-glow]`, and `src/renderer/src/components/chat/ChatItemTooltip.tsx` puts both on its own `div`, with the same angle and duration variables, on some openings. The scheduler's selector never selects it (it is not a `button` and carries no `data-ambient-card`) and `clear` touches only the element it set, so the two are independent and may glow together. The tooltip reads `extraUIAnimation` itself and relies on the CSS reduced-motion rule; it has no `document.hidden` check, since it exists only under a hovering pointer. See [Chat Row Summary](../../chat/chat_row_summary/chat_row_summary_tech.md#chatitemtooltip).
- `TopBar` sets `data-header-wave` for a two-second window. The four direct children share `ambient-header-button`; CSS gives their background layers a 1.2 s animation with 0/220/440/660 ms left-to-right delays. Hover/focus-visible suppresses the local layer. The effect resets when the preference changes and removes timers/listeners on cleanup.
- All three schedulers check `document.hidden` and `prefers-reduced-motion: reduce`; they do not subscribe to window blur. CSS reduced-motion rules also hide decorative layers and disable grid animations.

### Chat-switch transitions

- `MainArea` wraps its chat workspace in `ChatTransition`, passing the active chat ID and shared animation preference. Only ID changes animate, including transitions to/from null (new chat); first mount and same-chat updates do not. Other `MainArea` feature branches and embedded agent start pages are outside this host.
- `getSnapshotBeforeUpdate` clones the outgoing workspace before React mutates it. The clone is inert, aria-hidden and pointer-transparent, with duplicate IDs/autofocus removed. Descendant scroll offsets are captured and restored after insertion. Clone descendants have CSS animations/transitions disabled and cannot receive pointer input. No second React chat tree or subscriptions mount; navigation, streaming and composer state keep their existing lifecycle.
- Web Animations sweeps oversized diagonal gradient masks across each layout to create a soft curtain edge. The outgoing copy wipes/fades over 110 ms; only then does live content reveal over 150 ms (260 ms total). Text and layout stay stationary: only mask position and opacity animate, with no transforms. Backwards fill hides the incoming layout during the exit. The host clips the curtain to the workspace; masks disappear when the animation ends. The shell classes use the CSS base layer so Tailwind utilities can override their layout defaults, following the repository convention.
- Rapid switches cancel prior animations and remove the old snapshot before capturing another. Completion only cleans its own snapshot. Disabling the preference, OS motion changes, document visibility changes and unmount cancel running effects; hidden documents, reduced motion and unavailable Web Animations skip them.

### New-chat logo

- `ChatWorkspace` renders `CinnaLogoDraw` above the heading only in its non-embedded new-chat branch. The SVG (viewBox 352×216, drawn at 101×62 px) is always mounted there, so its box is reserved. It is `aria-hidden` and `focusable="false"`; `onClick` flips a component-local `shown` that starts false. No store or localStorage key holds it: an active chat renders a different branch and other views replace the workspace in `MainArea`, so each new-chat screen mounts it hidden.
- `data-shown` and `data-animate` (the preference) on the SVG drive the CSS. Each outline has `pathLength=1` with `stroke-dasharray: 1 1`, so one `stroke-dashoffset` change from 1 to 0 draws every path over the same 5 s whatever its real length. These are transitions, not keyframes, so a click mid-draw reverses from the current offset. Draw-in uses `cubic-bezier(0.45, 0, 0.2, 1)` with a 1.5 s opacity fade at its start; draw-out uses the mirrored curve with the fade delayed 3.5 s so it closes the draw. Without `data-animate`, and under reduced motion, the paths have no transition.
- `DRAW_MS` in the component restates the 5000 ms in `main.css`, and the first sweep is timed from it; change both together.
- Strokes use one `linearGradient` (id from `useId`, a user-space diagonal across the viewBox) from `--color-logo-from` to `--color-logo-to`: the dark icon's copper in Dark, the light icon's blue into teal in Light. The paint is set as inline style, `url(#id) var(--color-logo-from)`, because `ChatTransition` strips ids from its outgoing snapshot; without the fallback colour the logo would paint nothing for the length of the exit wipe. The 4.2-unit stroke renders about a pixel wide, because thinner lines break into stair-steps. The `.cinna-logo-draw-lines` group sits at 0.35 opacity (0.45 in Light, where the palette is paler against white) so a sweep has visible room to raise it.
- The sweep effect runs only while `extraUIAnimation` and `shown` are both true and `matchMedia` exists. Each sweep picks an angle (0–360°) and a duration. The render then adds a luminance `mask` holding a 110×600 band, white at opacity 0 → 0.5 → 0 across its width and rotated about the centre, over a second, undashed copy of the outlines. `.cinna-logo-sweep` translates the band from −270 to 270 viewBox units over `--sweep-duration`, starting and ending clear of the logo. The copy shows only under the band, so the lines it crosses read less transparent.
- `restart` clears the timer and any sweep on document visibility or reduced-motion changes, and reschedules only when visible with motion allowed; `play` rechecks both. Effect cleanup (hiding the logo, turning the preference off, unmount) clears the timer, the sweep and both listeners. Under reduced motion, CSS also hides `.cinna-logo-sweep`.

## Renderer Components

- `.ambient-grid-surface` establishes relative positioning and an isolated stacking context. The absolute, negative-z-index `.ambient-grid` clips only decoration, inherits corner radius, ignores pointer events and selection, and is `aria-hidden`; SVG is nonfocusable. Hosts retain their existing input, clipping and popover rules.
- SVG combines faint grid lines under a radial mask with delayed edge strokes and blurred halos. Theme-specific glow tokens and light-theme opacity overrides keep contrast appropriate to the resolved palette.
- Traveling borders use a registered angle property, conic gradient, mask and 270-degree travel. `.ambient-surface-border` sits inside the actual border; its highlight mixes the glow token with `--ambient-input-tint`, falling back to the normal border token.
- `ChatInput` shares `inputBorderColor` between the real border and decoration: drag-over accent takes precedence over chat-mode border and default border. Updating tint does not restart the animation effect. The development host inherits normal/focus-within tint through CSS; the sidebar uses the default tint.
- Features uses labeled System/Dark/Light buttons with `aria-pressed`, plus the existing accessible `SettingsToggleRow`. Both write directly to UI-store setters and remain usable independently of the app-settings query/mutation state.

## Configuration

| Storage / environment | Value and default |
|---|---|
| `cinna-theme` localStorage | `system`, `dark`, `light`; missing/invalid → System |
| `cinna-extra-ui-animation` localStorage | Setters write `1`/`0`; only `0` disables, so missing/other values → enabled |
| `prefers-color-scheme: dark` | Resolves System in main-window and popup renderers |
| `prefers-reduced-motion: reduce` | Suppresses decorative effects without rewriting the preference |

No environment variable or per-agent override controls these effects. Timing and theme tokens live in the renderer files above; this preference does not disable unrelated transitions/spinners.

## Security

Appearance storage contains presentation preferences only. Decoration performs no network, filesystem or agent operation and cannot intercept input; the new-chat logo's click lands only on its own box and changes nothing but its local shown state. The existing icon IPC accepts only fixed themes; it grants no OS appearance control. Builder identity and connection detail safety remain in [Chat Routing](../../chat/chat_routing/chat_routing_tech.md#renderer-components).

## Validation

- `src/renderer/src/components/layout/ChatTransition.test.tsx` — immediate next-chat rendering, inert outgoing snapshots, scroll/focus preservation, rapid switches, preference/motion cancellation and stable child lifecycle.
- `src/renderer/src/stores/ui.appearance.test.ts` — default-on animation persistence, live System resolution, fixed shortcut and cross-window storage propagation.
- `src/renderer/src/components/settings/FeaturesSettingsSection.test.tsx` — accessible controls, immediate persistence and operation while service settings are unavailable.
- `src/renderer/src/components/ui/AmbientGrid.test.tsx` — autofocus versus actual interaction, fade/blur quiet intervals, unmount timer cleanup, live tint and independent sidebar border behavior.
- `src/renderer/src/components/layout/TopBar.agentStatusButton.test.tsx` — four header controls and preference/reduced-motion cancellation. These focused contracts do not verify the visual rendering of randomized artwork or a full Electron workflow.
- No unit or E2E test covers `CinnaLogoDraw`: its shown toggle, draw transitions and sweep scheduler are unverified by the suite.
