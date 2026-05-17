# Mention Popups — Technical Details

## File Locations

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/components/chat/MentionPopup.tsx` | Generic listbox primitive. Exports `MentionPopup<T>` and the `MentionPopupProps<T>` interface. Owns the floating container, header, scrollable list, item layout, accent-tinted theming, outside-click handler, and selection-following scroll. Holds no domain knowledge — every variable bit is a prop. |
| `src/renderer/src/components/chat/AgentMentionPopup.tsx` | Thin wrapper for the `@` trigger. Binds `AgentData` and renders `Bot` icon, `Agents` header, `w-72` width, `agent.protocol` as the meta tag, `agent.description` as the truncated secondary line. |
| `src/renderer/src/components/chat/CliCommandPopup.tsx` | Thin wrapper for the `/` trigger. Binds `CliCommand`, renders `Terminal` icon, `Agent Commands` header, `w-80` width, `cmd.description` as a 2-line clamped secondary. |
| `src/renderer/src/components/chat/ExamplePromptPopup.tsx` | Thin wrapper for the `#` trigger. Binds `ExamplePrompt`, renders `Hash` icon, `Example Prompts` header, `w-80` width, `prompt.full` as a 2-line clamped secondary. |
| `src/renderer/src/components/chat/ChatInput.tsx` | Owns the trigger-token state machine (`triggerChar`, `triggerFilter`, `triggerStart`, `triggerIndex`), the three filter `useMemo`s, the popup-open gates, and the shared keyboard handler. The shared textarea carries `role="combobox"` and `aria-controls` / `aria-activedescendant` referring to `${listboxId}-opt-${triggerIndex}`. |
| `src/renderer/src/assets/main.css` | Theme tokens for `--color-accent` (used by the popup tint, border, and selected-item gradient) and the page-level `data-theme` attribute switch that the popup's light-theme overrides target. |

## Component API — `MentionPopup<T>`

| Prop | Type | Purpose |
|------|------|---------|
| `items` | `T[]` | Already-filtered list. The parent owns the filter predicate; the popup renders what it receives. |
| `selectedIndex` | `number` | Index of the keyboard-highlighted row. The parent advances it in response to Arrow keys. |
| `onSelect(item)` | callback | Click or keyboard-commit on a row. |
| `onClose()` | callback | Outside-click detected. Parent decides whether to clear trigger state. |
| `listboxId` | `string` | Stable `useId()` from the parent so the textarea can wire `aria-controls`. |
| `anchorRef?` | `RefObject<HTMLElement>` | Element treated as "inside" for outside-click detection — typically the chat textarea. |
| `header` | `string` | Uppercase section label rendered above the list. |
| `ariaLabel` | `string` | `aria-label` on the `<ul role="listbox">`. |
| `icon` | `LucideIcon` | Icon component rendered at the start of each row. |
| `width?` | `string` | Tailwind width class for the container. Defaults to `w-72`. |
| `getKey(item, i)` | `string` | React key extractor — wrappers compose stable keys (e.g. `${cmd.slug}-${i}`). |
| `getPrimary(item)` | `string` | Bold primary label on each row. |
| `getSecondary?(item)` | `string \| null \| undefined` | Optional second line below the primary. Falsy values omit the line entirely. |
| `getMeta?(item)` | `string \| null \| undefined` | Optional right-aligned tag on the primary line. |
| `secondaryClamp?` | `'truncate' \| 'line-clamp-2'` | Whether the secondary line ellipsises after one row or wraps to two. Defaults to `truncate`. |

## Theming

- **Container** — accent-tinted with `backdrop-blur-xl` for a frosted-glass effect. Dark theme: `bg-accent/10`, `border-accent/25`. Light theme override: `bg-accent/4`, `border-accent/12` (the icon-derived accent reads too saturated against a bright background otherwise).
- **Selected item** — horizontal accent gradient, denser on the left. Dark: `from-accent/65 to-accent/40`. Light: `from-accent/40 to-accent/22`.
- **Selected-item text** — driven by the theme-aware `--color-on-accent` token defined in `main.css` (white in dark theme, `#1a1a1a` in light). Same opacity ladder applies to the meta tag (70%) and secondary line (80%) so they fade consistently against the gradient surface.
- **Theme switching** — performed at the page level via `data-theme="light"` on a root ancestor. The container and accent-gradient overrides use Tailwind's `[[data-theme=light]_&]:` arbitrary variant; the foreground swap happens automatically via the CSS variable. All style constants live at the top of `MentionPopup.tsx` (`CONTAINER_CLS`, `ACTIVE_BG`, `ACTIVE_TEXT`, `ACTIVE_TEXT_70`, `ACTIVE_TEXT_80`) — one place to tune the entire popup family.

## ARIA & Keyboard

- The popup container is purely presentational — combobox semantics live on the textarea in `ChatInput`.
- Each row is a `<button role="option">` with `aria-selected={isActive}` and a stable `id` of the form `${listboxId}-opt-${index}`.
- `<ul role="listbox" aria-label={ariaLabel}>` wraps the rows.
- Active row is scrolled into view (`block: 'nearest'`) on every `selectedIndex` change.
- Keyboard handlers (Arrow / Enter / Tab / Esc) live in `ChatInput`. See [Keyboard Shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md).

## Filter Semantics

Each trigger has its own filter predicate in `ChatInput.tsx`:

- **`@`** (`filteredAgents`) — matches `agent.name` and `agent.protocol`.
- **`#`** (`filteredPrompts`) — matches `prompt.label` and `prompt.full`.
- **`/`** (`filteredCommands`) — matches **only** `c.slug` and `c.command` (the signature parts). `name` and `description` are intentionally excluded so a filter like `/status` does not pull in commands whose human-readable text happens to contain "status".

## IPC Channels

None. The popups are pure renderer-side UI; data sources are owned by their respective features.

## Configuration

No settings, env vars, or feature flags. All behavior is prop-driven.

## Security

- React escapes all interpolated text — no `dangerouslySetInnerHTML` is used.
- Selected items travel back to `ChatInput`, which inserts plain text into the textarea. No HTML, shell, or markdown evaluation occurs at the popup boundary.
- No credentials or tokens cross the popup; data sources upstream (agent card fetch, prompt extraction) handle their own auth.
