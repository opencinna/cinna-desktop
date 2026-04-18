# UI Guidelines — LLM Reference

Project-specific UI conventions for the Cinna Desktop renderer. This is an LLM-targeted reference — concise patterns only, skip standard React/Tailwind knowledge.

## Color System

All colors use CSS variables `var(--color-*)` defined in `src/renderer/src/assets/main.css` inside `@layer base`. Never hardcode color values.

| Variable | Usage |
|----------|-------|
| `--color-bg` | Page background |
| `--color-bg-secondary` | Card backgrounds |
| `--color-bg-tertiary` | Badges, table headers, active menu items |
| `--color-bg-hover` | Hover states |
| `--color-border` | Borders, dividers |
| `--color-text` | Primary text |
| `--color-text-secondary` | Secondary text, data values |
| `--color-text-muted` | Labels, placeholders, inactive elements |
| `--color-accent` / `--color-accent-hover` | Primary actions, links, active indicators |
| `--color-danger` | Destructive actions, errors |
| `--color-success` | Connected status, valid states |
| `--color-warning` | Default star, awaiting-auth status |

Custom CSS must go inside `@layer base` in `main.css` (otherwise it overrides Tailwind v4 utilities).

## Typography Scale

| Class | Usage |
|-------|-------|
| `text-base font-semibold` | Page/section titles |
| `text-xs font-medium` | Card titles, button labels |
| `text-[10px]` | Labels, status text, metadata, descriptions |
| `text-[9px]` | Badges (Guest, Active) |

## Expandable Card Pattern

All settings cards (LLM providers, MCP providers, agents, chat modes, user accounts) follow the same structure.

### Card Container
```
rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden
```

### Card Header (clickable)
- Entire header row is clickable to toggle expand/collapse
- `cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors`
- Layout: `flex items-center gap-2 px-4 py-2.5`
- Action buttons inside the header (toggle switch, delete, star) use `e.stopPropagation()` to prevent header click
- Chevron indicator: single `ChevronDown` icon with `transition-transform duration-200` and `rotate-180` when expanded (not two icons swapping)

### Animated Expand/Collapse
- Use `<AnimatedCollapse open={expanded}>` from `src/renderer/src/components/ui/AnimatedCollapse.tsx`
- Wraps the expanded content div
- Provides smooth 200ms height + opacity CSS transition
- Handles mount/unmount of children (only renders when visible)
- Never use conditional rendering `{expanded && (...)}` for card content — always use `AnimatedCollapse`

### Expanded Content
```
border-t border-[var(--color-border)] px-4 py-3 space-y-2.5
```
(or `space-y-3` for forms with more sections)

## Chat Collapsible Block Pattern

Used for expandable blocks inside the chat conversation (ThinkingBlock, ToolNarrationBlock) — distinct from the settings Expandable Card Pattern. Optimised for a lightweight, uncluttered chat interface.

### Key difference from settings cards
Settings cards always show border + background. Chat collapsible blocks are **visually flat when collapsed** — no border, no background — only a small header row. The card appearance fades in on expand and fades out on collapse.

### Outer container
```
rounded-lg border transition-colors duration-200
  collapsed: border-transparent bg-transparent
  expanded:  border-[var(--color-border)]/60 bg-[var(--color-bg-secondary)]/40
```

### Header (always visible)
- Button: `w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]`
- Text: `text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]`
- Chevron: `ChevronRight` size 11, `transition-transform duration-150`, `rotate-90` when expanded
- Streaming indicator: pulsing `w-1 h-1` accent dot

### Body (conditional render)
- Content appears/disappears via `{expanded && (...)}` (not AnimatedCollapse — chat blocks use simple conditional render for minimal overhead)
- Markdown body at `opacity-80` (thinking) or `opacity-90` (tool narration)

### When to use
- Chat conversation blocks that should recede when not actively viewed
- Any expandable element in the message stream where visual noise should be minimised
- Do NOT use for settings cards — those use the Expandable Card Pattern with AnimatedCollapse

## Form Input Pattern

Standard input class used across all settings forms:
```
w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs
border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none
```

Labels: `block text-[10px] text-[var(--color-text-muted)] mb-0.5`

## Button Layout Rules

### Footer Buttons (forms and card actions)
- Always right-aligned: `flex justify-end gap-2`
- **Button order (left to right)**: least important to most important
  - Cancel / dismiss (text-only style)
  - Secondary actions like Test, Disconnect (bordered style)
  - Primary action like Save, Create, Connect (accent-filled style)
- The **most important action is always the rightmost** button

### Button Styles

| Type | Classes |
|------|---------|
| Primary | `bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white` |
| Secondary | `border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]` |
| Cancel/text | `text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]` |
| Destructive | `bg-red-500 hover:bg-red-600 text-white` |
| Link-style | `text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] font-medium` |

All buttons: `px-3 py-1.5 rounded-md text-xs font-medium transition-colors`

Disabled: `disabled:opacity-30 disabled:cursor-not-allowed` (or `disabled:opacity-50` for less critical)

### Inline Action Buttons (icon-only in card headers)
- `p-1 rounded transition-colors`
- Delete: `hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]`

## Toggle Switch Pattern

```
relative w-9 h-5 rounded-full transition-colors shrink-0
  enabled: bg-[var(--color-accent)]
  disabled: bg-[var(--color-border)]

  thumb: absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
    enabled: left-[18px]
    disabled: left-0.5
```

## Status Indicator Pattern

`Circle` icon (size 6) with `fill-current` and dynamic color class:
- Connected/enabled: `text-[var(--color-success)]`
- Disconnected/disabled: `text-[var(--color-text-muted)]`
- Error: `text-[var(--color-danger)]`
- Awaiting auth: `text-[var(--color-warning)]`

## Settings Page Structure

Settings page at `src/renderer/src/components/settings/SettingsPage.tsx`.

### Tabs (sidebar menu items)
`chats` | `agents` | `llm` | `mcp` | `accounts` | `trash`

### Section Pattern
Each section component:
1. Lists existing items as expandable cards
2. Has an "Add" button (dashed border) that toggles an inline form
3. Section components: `LLMSettingsSection`, `MCPSettingsSection`, `AgentsSettingsSection`, `ChatModesSection`, `UserAccountsSection`, `TrashSection`

### Add Button Style
```
flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg
border border-dashed border-[var(--color-border)] text-xs
text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
hover:border-[var(--color-text-muted)] transition-colors
```

## Key Files

- `src/renderer/src/assets/main.css` — CSS variables, theme definitions, custom styles
- `src/renderer/src/components/ui/AnimatedCollapse.tsx` — Animated expand/collapse wrapper
- `src/renderer/src/components/settings/SettingsPage.tsx` — Settings shell, tab routing
- `src/renderer/src/stores/ui.store.ts` — `activeView`, `settingsTab`, `theme`
