# Verbose Mode — Technical Details

## File Locations

### State

| File | Role |
|------|------|
| `src/renderer/src/stores/ui.store.ts` | Holds `verboseMode: boolean` plus `toggleVerboseMode()` action. Initial value read from `localStorage` under `cinna-verbose-mode`. Toggle writes `'1'` / `'0'` and flips the in-memory flag in one `set`. |

### Renderer — Components

| File | Role |
|------|------|
| `src/renderer/src/components/layout/Sidebar.tsx` | Renders the Eye / EyeOff toggle button in the sidebar bottom bar, immediately before the theme toggle. Uses the same active-state visual (`bg-[var(--color-bg-tertiary)]`) as the Settings and Logs buttons. |
| `src/renderer/src/components/chat/MessageStream.tsx` | Subscribes to `verboseMode` with a selector. Wraps each persisted message in a `<div>` so the footer can render beneath it; applies `defaultExpanded={verboseMode ? undefined : false}` to streaming `ThinkingBlock` / `ToolNarrationBlock` blocks. |
| `src/renderer/src/components/chat/MessageMetaFooter.tsx` | Single-message footer: relative timestamp span + info button. Uses `useRelativeNow()` for the tick and `MetaPopup` for the info panel. Owns `buildMeta()` which selects and labels the fields surfaced in the popup. |
| `src/renderer/src/components/chat/MetaPopup.tsx` | Shared popup used by both `MessageMetaFooter` and `MessageBubble`. Accepts `meta`, `align`, `onClose`. Positions itself with `absolute bottom-full mb-1` above the nearest `relative` parent. Closes on `mousedown` outside the popup. |
| `src/renderer/src/components/chat/MessageBubble.tsx` | Consumes the shared `MetaPopup` for its own hover-info use case (assistant messages with a `meta` prop). Verbose mode does not touch the hover popup path — it only adds the persistent footer. |
| `src/renderer/src/components/chat/ThinkingBlock.tsx` / `ToolNarrationBlock.tsx` | Unchanged APIs. The `defaultExpanded` prop (already present) is what `MessageStream` uses to gate verbose vs compact expansion during streaming. Behaviour: `useState(defaultExpanded ?? !!isStreaming)` — when `defaultExpanded` is `false`, the block mounts collapsed even while `isStreaming` is true; when `undefined`, it falls back to `!!isStreaming`. |

### Renderer — Hooks

| File | Role |
|------|------|
| `src/renderer/src/hooks/useRelativeNow.ts` | Shared 30 s tick. Module-level `Set<() => void>` of subscribers + a single `window.setInterval` that is created lazily on first subscribe and cleared when the last subscriber unsubscribes. Exposed via `useSyncExternalStore` so all consumers re-render together on each tick. |

## Key Flows

### Toggle flow

1. User clicks the sidebar button → `Sidebar.tsx` invokes `toggleVerboseMode()`
2. `ui.store.ts` flips the `verboseMode` flag and writes `localStorage['cinna-verbose-mode']`
3. `MessageStream.tsx` (subscribed via `useUIStore((s) => s.verboseMode)`) re-renders
4. Every `MessageMetaFooter` either mounts (verbose → compact becomes verbose) or unmounts (compact)
5. Any streaming `ThinkingBlock` / `ToolNarrationBlock` keeps its current `useState` value — only **new** mounts pick up the new `defaultExpanded` — which is the intended behaviour (mode switch does not forcibly collapse or expand in-flight blocks)

### Relative-time tick

1. First `MessageMetaFooter` mounts → `useRelativeNow()` calls `useSyncExternalStore(subscribe, getSnapshot)`
2. `subscribe()` registers the component's re-render callback and, if the module-level `intervalId` is `null`, starts a single 30 s `window.setInterval`
3. Interval callback mutates the module-level `currentNow` to a new `Date` and fires every listener
4. On each tick, all subscribed footers re-render — each one derives `relative` via `formatRelative(createdAt, now)`
5. When the last footer unmounts, `subscribe`'s cleanup removes the listener; the interval is cleared because `listeners.size === 0`

### Meta popup open/close

1. User clicks the info button in `MessageMetaFooter` → local `showMeta` flips to `true`
2. `MetaPopup` mounts, attaches a `mousedown` document listener
3. Any `mousedown` outside the popup element calls `onClose`, flipping `showMeta` back to `false` and unmounting the popup
4. The listener is removed on unmount via the `useEffect` cleanup

### Streaming block expansion gating

1. `MessageStream.tsx` maps `streamingBlocks`. For `text`-kind entries with `kind === 'thinking'` or `'tool'`, it passes `defaultExpanded={verboseMode ? undefined : false}` to the corresponding block component.
2. Block components read `useState(defaultExpanded ?? !!isStreaming)`:
   - Compact (`defaultExpanded === false`) → mounts collapsed regardless of `isStreaming`
   - Verbose (`defaultExpanded === undefined`) → falls back to `!!isStreaming`, matching legacy behaviour
3. When streaming completes, `streamingBlocks` clears and the persisted message renders via `parts[]`. Fresh block instances mount there with no `defaultExpanded` and `isStreaming` undefined — they default to collapsed in both modes (unchanged).

## Type Derivation

- `MessageMetaFooter` derives `MessageData` locally via `NonNullable<Awaited<ReturnType<typeof window.api.chat.get>>>['messages'][number]` because `src/preload/index.ts` is not included in `tsconfig.web.json`, so a direct `import type { MessageData }` from preload fails with TS6307. The derivation keeps the footer strictly typed without pulling the preload implementation file into the renderer type project.

## Persistence

- `localStorage` key `cinna-verbose-mode` — value `'1'` means verbose on, anything else (including absence) means compact. Mirrors the existing `cinna-logger-enabled` pattern in the same store.

## Styling

- Footer: `text-[10px] text-[var(--color-text-muted)]` so it is subtly visible but never competes with message content. `mt-1` sits it close under the message without adding a full line of whitespace.
- Footer alignment: `justify-end` for user messages, `justify-start` for everything else.
- Popup: `absolute bottom-full mb-1`, `w-72 max-h-56 overflow-y-auto`, `bg-[var(--color-bg-secondary)]` with `border-[var(--color-border)]`, `font-mono text-[11px]`. Keys rendered in `--color-text-muted`, values in `--color-text`.
- Toggle button: mirrors the Logs / Settings button styling — inactive uses the standard muted hover treatment, active uses `text-[var(--color-text)] bg-[var(--color-bg-tertiary)]`.

## Security

- No user-controlled content is rendered unescaped: the popup uses React text rendering for every key/value pair and falls back to `JSON.stringify` for non-string values.
- No main-process surface added — the feature lives entirely in the renderer and consumes already-exposed message data from `window.api.chat.get`.
