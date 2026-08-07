# Hints — Technical Details

## File Locations

### Shared
- `src/shared/appSettings.ts` — `showHints: boolean` field on `AppSettingsSchema`

### Main process
- `src/main/db/appSettings.ts` — `DEFAULTS.showHints = true`. No other main-side change; validation and persistence are inherited.

### Renderer — data & logic
- `src/renderer/src/constants/hints.ts` — the catalog and its types (`Hint`, `HintEvent`, `HintContext`, `HintSurface`, `HintSegment`), plus `resolveKey`, `hintText`, `findHint`
- `src/renderer/src/stores/hints.store.ts` — `useHintsStore`, the progress blob, the event bus, `isHintRetired`, `hasHintProgress`
- `src/renderer/src/stores/hints.store.test.ts` — retirement thresholds, per-session fire-once, lifetime cap, preemption gap, refund semantics, reset, corrupt-blob recovery
- `src/renderer/src/hooks/useHintsEnabled.ts` — the `showHints` gate, shared by the bar and the layout so the two can't disagree
- `src/renderer/src/hooks/useHintContext.ts` — assembles `HintContext` from cached queries; emits the state-derived agent events
- `src/renderer/src/hooks/useHintRotation.ts` — eligibility, stable ordering, dwell timers, contextual preemption
- `src/renderer/src/hooks/useAttachDestination.ts` — `useHasAttachDestination`, the shared attach gate

### Renderer — view
- `src/renderer/src/components/ui/HintBar.tsx` — presentation only: crossfade, key chips, hover `×`
- `src/renderer/src/components/layout/MainArea.tsx` — mounts the bar on the new-chat branch and reserves the strip it overlays
- `src/renderer/src/components/chat/ChatInput.tsx` — emits hint events at existing call sites; raises the pause flag while a picker or modal is open
- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — the Interface toggle and the Reset hints button

## Database Schema

No new tables or columns. The feature adds one key to the existing installation-global `app_settings` KV store (see `src/main/db/schema.ts`), which needs no migration — rows are created on first write, and `appSettingsRepo.getAll()` in `src/main/db/appSettings.ts` applies `DEFAULTS` for any key with no row yet.

## IPC Channels

No new channels. The setting rides the existing pair registered in `src/main/ipc/settings.ipc.ts`:

- `settings:get-all` — returns the whole `AppSettingsSchema`, `showHints` included
- `settings:set` — writes one key; `src/main/services/appSettingsService.ts:set()` validates the key against `DEFAULTS` and the value against the default's `typeof`, so a new schema field is picked up with no plumbing

Unlike `enableTrayIcon`, `showHints` triggers no main-process side effect on write.

## Catalog Schema

Each entry in the `HINTS` array in `src/renderer/src/constants/hints.ts` declares:

| Field | Meaning |
|-------|---------|
| `id` | Stable slug; also the persistence key for counters |
| `surfaces` | Screens the hint may appear on (`HintSurface`) |
| `segments` | Ordered text / key-chip parts; built with the `k()` helper |
| `available` | Predicate over `HintContext`; absent ⇒ always eligible |
| `trigger` | Present ⇒ contextual (never rotates); the `HintEvent` that fires it |
| `retiredBy` | Events that count as "the user knows this" |
| `retireAfter` | Observations before retirement; defaults to `DEFAULT_RETIRE_AFTER` (3) |

`MOD_KEY` is a placeholder segment resolved to `⌘` or `Ctrl` by `resolveKey()` at render time. The catalog reads no DOM globals at import, so it loads in the node-environment test suite (`vitest.config.ts`) without a browser shim.

## Services & Key Methods

- `src/renderer/src/stores/hints.store.ts:observe(event)` — the single write path. Credits every hint whose `retiredBy` includes the event, then fires the hint whose `trigger` matches if it passes the retirement check, the per-session guard, the lifetime cap, and the inter-preemption floor. Availability is *not* checked here (the store has no `HintContext`); the rotation hook drops and refunds an ineligible hint.
- `src/renderer/src/stores/hints.store.ts:clearContextual(refund)` — retires the showing contextual hint. `refund: true` also returns the lifetime show it consumed and clears the per-session flag.
- `src/renderer/src/stores/hints.store.ts:setBusy(busy)` — raised by the composer while a picker or modal is open; holds the rotation.
- `src/renderer/src/stores/hints.store.ts:silence()` — session-only hide. Not persisted.
- `src/renderer/src/stores/hints.store.ts:reset()` — clears counters, storage, and the module-level session bookkeeping (`firedThisSession`, `lastPreemptAt`, `preemptSeq`).
- `src/renderer/src/hooks/useHintRotation.ts:useHintRotation(enabled, surface, ctx)` — returns the hint to render, whether it's contextual, and the hover handlers.

## Scheduler Constants

Defined at the top of `src/renderer/src/hooks/useHintRotation.ts`:

| Constant | Value | Role |
|----------|-------|------|
| `AMBIENT_MIN_MS` | 7000 | Floor dwell for an ambient hint |
| `MS_PER_WORD` | 400 | Length scaling: `dwell = max(floor, words × this)` |
| `CONTEXTUAL_MS` | 10000 | Contextual hold before the rotation resumes |
| `START_DELAY_MS` | 1500 | Grace period after mount; ambient lane only |

In `src/renderer/src/stores/hints.store.ts`: `CONTEXTUAL_SHOW_CAP` (2) and `MIN_PREEMPT_GAP_MS` (5000). In `src/renderer/src/components/ui/HintBar.tsx`: `FADE_MS` (180).

Rotation is held when any of: hover, `busy`, `document.hidden`, a contextual hint is showing, the start delay hasn't elapsed, or fewer than two hints are eligible.

## Renderer Components

- `src/renderer/src/components/ui/HintBar.tsx` — fixed-height strip, absolutely positioned at the bottom of the new-chat branch. Renders `segments` as text spans and `<kbd>` chips, crossfades on hint change (with a re-entry guard so a hint that changes away and back inside the fade window can't leave the bar blank), and exposes a hover-revealed `×` wired to `silence()`. `role="note"` with a stable label and no `aria-live`. Honors `prefers-reduced-motion` via Tailwind's `motion-reduce:` variant.
- `src/renderer/src/components/layout/MainArea.tsx` — renders `<HintBar>` in the `!activeChatId` branch and adds bottom padding to the centered container when `useHintsEnabled()` is true, reserving the strip the bar overlays.
- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — adds the **Show hints** `ToggleRow` to the Interface group, plus a **Reset hints** button that calls `reset()` and is disabled when `hasHintProgress()` is false.

## Event Emission Sites

`src/renderer/src/components/chat/ChatInput.tsx` emits at existing call sites — `selectNote`, `selectPrompt`, `selectCommand`, `selectAgent`, `selectMcp`, `handleDrop`, the `[+]` menu's attach and capability-toggle callbacks, the wrapped chat-mode selectors, the double-ESC branch, the `?`-popup open transition, and the note-preview handler. `src/renderer/src/hooks/useHintContext.ts` emits the two events derived from state rather than a gesture (`agent-with-prompts-selected`, `agent-with-commands-selected`).

## Configuration

- **`showHints`** (`app_settings`, default `true`) — installation-global, surfaced at Settings → Features → Interface.
- **`cinna-hints`** (`localStorage`) — `{ used: Record<hintId, count>, shown: Record<hintId, count> }`.

**Storage split, on purpose.** The on/off switch is a boolean in `app_settings` where users expect to find it and where every other feature toggle lives. The per-hint counters are a `localStorage` blob, matching how the renderer already persists `cinna-theme`, verbose mode, and the onboarding flags (`src/renderer/src/constants/onboarding.ts`) — the `app_settings` schema is all-boolean feature switches and a cosmetic counter map has no business widening it. Known trade-off: counters are per-install, not per-profile, and are not covered by [data sync](../../sync/data_sync/data_sync.md).

Both persistence paths degrade rather than throw: a corrupt blob resets to empty progress, and a failed write (quota, private mode) means hints simply don't retire across restarts.

## Security

Nothing sensitive crosses a boundary. Hint state is renderer-local UI preference data with no user-scoped content; the one main-process write goes through `appSettingsService`, which validates key and value before the repo sees them. No IPC channel, no external call, no credential handling, no user-supplied content is rendered — hint copy is a compile-time constant array, so the `<kbd>` and text spans carry no injection surface.

## Extending

- **Adding a hint** — one entry in `src/renderer/src/constants/hints.ts`. If it teaches a gesture the composer doesn't yet report, add the event to `HintEvent` and emit it at the relevant call site.
- **Adding a surface** — widen `HintSurface`, tag the relevant catalog entries, and mount a second `<HintBar>`. The store and scheduler are surface-agnostic; `useHintContext` would need whichever extra gates the new surface implies.
- **Changing a keybinding** — update the hint that teaches it in the same change. See [Keyboard Shortcuts](../keyboard_shortcuts/keyboard_shortcuts.md).
