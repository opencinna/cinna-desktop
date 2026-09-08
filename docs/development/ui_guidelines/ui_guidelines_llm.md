# UI Guidelines — LLM Reference

Project-specific UI conventions for the Cinna Desktop renderer. This is an LLM-targeted reference — concise patterns only, skip standard React/Tailwind knowledge.

This file is about what things look like. How a screen *behaves* — what may move while the user types, what goes above the fold, when a banner is allowed, how a destructive action confirms — is in [UX Rules](ux_rules.md), which the `cinna-desktop-ux-reviewer` agent enforces.

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

## Typography — two scales, chosen by surface

Cinna has **two** type scales, and picking the wrong one is the most visible way a screen goes wrong: it renders a step or two smaller than the screen beside it and reads as a different application. The scale is decided by *where the surface lives*, never by how much content it has.

### Settings scale — every tab under Settings

Settings is a reading surface: the user arrives to decide something, reads a sentence, and acts once. It is set at a comfortable reading size.

| Class | Usage |
|-------|-------|
| `text-base font-semibold` | The page title (`SettingsPage`'s `h1`) |
| `text-[14px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]` | Section title (`SettingsSection`) |
| `text-[14px] font-medium` | Card title, setting label, the name of a listed item |
| `text-[13px]` | Descriptions, hints, sub-lines, status detail, button labels |
| `text-[12px]` | Monospace paths and values, chips, secondary metadata |
| `text-[11px]` | Badges (Home, Added folder, Guest, Active) |

**`text-xs`, `text-[10px]` and `text-[9px]` do not belong on a Settings surface.** They are the app-chrome scale below; a settings section written in them is the defect this table exists to prevent.

### App-chrome scale — sidebar, agent pages, chat, jobs, tray

These are density-first: many rows on screen at once, scanned rather than read.

| Class | Usage |
|-------|-------|
| `text-xs` / `text-[11px]` | Row titles, button labels |
| `text-[10px]` | Labels, status text, metadata, descriptions |
| `text-[9px]` | Badges |

### Which one am I writing?

If the file is under `src/renderer/src/components/settings/`, or renders inside `SettingsPage`, it is the Settings scale. A component shared by both — `AgentsRootGit` is one, rendered inside a settings row — takes the scale of the surface it renders *into*, and any reserved height it computes (`h-[2rem]` for two clamped lines) is written as a multiple of that scale's leading rather than as a measured pixel count, so the two cannot drift apart.

## Settings Section Pattern

**A settings tab is a stack of titled sections, not a stack of cards.** The section title is what a user scans for ("where do I set the engine path?"); a card is one setting, or one list, inside the answer. A tab of five unlabelled cards has no scannable structure and forces the user to read all of it to find one thing — that is the defect that produced this pattern.

Build a new tab from `src/renderer/src/components/settings/SettingsLayout.tsx`, and move an existing one over when you next touch it (Local Agents is the first caller; Features, Local Development and AI Credentials match the scale and the shapes with their own markup):

| Export | What it is |
|--------|-----------|
| `SettingsSection` | `<section>` + uppercase muted title + optional section-wide `action`, wrapping `space-y-3` |
| `SettingsCard` | One setting: `rounded-lg border bg-[var(--color-bg)] p-4` |
| `SettingsRows` / `SettingsRow` | A card holding a list of like things, `divide-y` rather than gapped |
| `SettingsLabel` / `SettingsHint` | A control's label, and the sentence above it saying what it does |
| `SettingsStatusRow` | A prerequisite as a dot + line + the one button that fixes it |
| `SettingsButton` / `SettingsAddButton` / `SettingsIconButton` / `SettingsBadge` | Bordered secondary action, dashed Add, icon-only row action, tag |
| `settingsInputClass` | The shared input/select shell |

Rules the primitives exist to enforce:

- **Name the sections after what the user came to change**, not after the data model: Agent Folders, Engine Settings, Developer Tools. Two or three per tab is normal; a tab needing seven is really two tabs.
- **A fact lives in the section that holds the control which changes it.** The engine's status sits above the engine path, not in a separate Readiness card three rows up — the user reading "not running" is one keystroke from the field that decides *which* binary starts.
- **A section-wide verb (Rescan, Refresh) goes beside the section title**, as a labelled bordered button. It acts on everything in the section, so it belongs to the section, not to the first card; and a bare muted icon there is invisible until hovered (ux_rules rule 11).
- **The hint goes above the control, messages below it.** A save error or an "applies on next start" note rendered under a field must sit in a slot that is always there (`min-h-[1.125rem]`), or it moves everything below as the user types (ux_rules rule 1).
- **`SettingsSection` and the Expandable Card Pattern compose.** A section whose content is a list of configurable items (AI Credentials, MCP Providers) puts expandable cards inside the section; the two are not alternatives.

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

Standard input/select class across settings forms — `settingsInputClass` in `SettingsLayout.tsx`:
```
w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5
text-[13px] text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none
```

The input's background is one step *up* from its card: on a `--color-bg` card use `bg-[var(--color-bg-secondary)]`; inside a `--color-bg-secondary` card (the expandable cards) use `bg-[var(--color-bg)]`. An input that matches its card has only its border to say it is an input.

Labels: `text-[14px] font-medium text-[var(--color-text)]` (`SettingsLabel`), with the explanatory sentence under it at `text-[13px] text-[var(--color-text-muted)]` (`SettingsHint`). Inside a dense expandable card, a compact label — `block text-[12px] text-[var(--color-text-muted)] mb-0.5` — is the variant.

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

All buttons: `px-3 py-1.5 rounded-md font-medium transition-colors`, at `text-[13px]` on a Settings surface and `text-xs` on the app-chrome scale.

Primary and destructive buttons use `text-white`, never `text-[var(--color-on-accent)]`: that token is **dark** in the light theme (`#1a1a1a`), so an accent-filled button styled with it comes out blue with dark text while every settings button is blue with white text. `--color-on-accent` is for the accent-tinted chips and popup highlights that use it today, not for filled buttons.

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
Default group: `chats` | `llm` | `agents` | `local-agents` | `local-dev` | `mcp` | `accounts` | `features` | `development` | `trash`.
Profile group: `profile-chats` | `profile-llm` | `profile-agents` | `profile-catalog` | `profile-sync`.
The authoritative list is `sectionTitles` in `SettingsPage.tsx`; each tab renders one `*SettingsSection` component.

### Two shapes of tab
1. **A list of configurable items** — AI Credentials, MCP Providers, Chat Modes, User Accounts. Expandable cards plus a dashed Add button that toggles an inline form.
2. **A set of unrelated settings** — Features, Local Agents, Local Development. Titled `SettingsSection`s, each holding cards, toggles or a list.

Most tabs are one or the other; a tab that is both (Local Agents: a folder list, an engine, a tool default) is the second shape with a list inside one of its sections.

### Add Button Style
`SettingsAddButton` in `SettingsLayout.tsx`:
```
flex w-full items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg
border border-dashed border-[var(--color-border)] text-[13px] font-medium
text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
hover:border-[var(--color-text-muted)] transition-colors
```

## Key Files

- `src/renderer/src/assets/main.css` — CSS variables, theme definitions, custom styles
- `src/renderer/src/components/ui/AnimatedCollapse.tsx` — Animated expand/collapse wrapper
- `src/renderer/src/components/settings/SettingsPage.tsx` — Settings shell, tab routing
- `src/renderer/src/components/settings/SettingsLayout.tsx` — the settings section/card/row/status primitives
- `src/renderer/src/stores/ui.store.ts` — `activeView`, `settingsTab`, `theme`
