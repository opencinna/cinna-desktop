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
| `--color-send-queued` | The composer's Send while a turn runs (joins that turn or its queue); idle Send stays `--color-success` |

Custom CSS must go inside `@layer base` in `main.css` (otherwise it overrides Tailwind v4 utilities).

A hand-written `backdrop-filter` lists `-webkit-backdrop-filter` **first** and the standard property after it. The build's CSS optimizer (lightningcss, run by `@tailwindcss/vite` on build only) keeps just the last of the pair, and Chromium ignores the prefixed one — so with the standard property first, every hand-written blur in `main.css` (`.app-sidebar`, `.app-popover-surface`, `.sidebar-tab`) shipped as no blur at all while looking right in `npm run dev`, and a menu showed the card under it sharp through its 10% alpha. Tailwind's `backdrop-blur-*` utilities are emitted correctly and need nothing.

## Surface Materials

A flat fill on every surface reads as white on white in the light theme and as one grey slab in the dark one. Each surface takes one of four materials, decided by what it is, not by taste. All four live in `main.css`.

| Material | Where | Class |
|----------|-------|-------|
| **Glass scrim** | Behind every modal | `app-modal-scrim` on an `absolute inset-0` sibling *before* the panel |
| **Glass panel** | A modal's own frame: header, body padding, side panels, footer | `app-modal-panel` with `rounded-xl border` (it brings its own tint, border colour, highlight edge and shadow; add no `bg-*` or `shadow-*`) |
| **Solid** | What sits on a glass panel and is acted on or read closely: cards, buttons, inputs, badges, a terminal, an iframe | The `--color-bg*` tokens; `app-modal-well` for a solid content well with its border |
| **Ambient** | An inline block in the transcript that asks the user something: a question (`AskUserQuestionBlock`), a permission request (`PermissionRequestBlock`) | `ambient-block`, `data-tone="ask"` / `"permission"` while it waits (no tone once settled), `style={ambientMeshStyle(seed)}` |

- **A modal is glass by default.** Solid is the exception for what sits on it, the way the Agent Status overlay draws solid agent cards on a frosted frame. Run Script (terminal in an `app-modal-well`), File Preview, Artifact Preview and Answer Questions are built this way. Floating layers inside a modal, like File Preview's Contents panel over the body, take `app-popover-surface`.
- **The scrim is the panel's sibling, never its parent.** A parent with a `backdrop-filter`, `filter`, `opacity` below 1 or a mask becomes the panel's backdrop root, and the panel's blur then sees nothing.
- **Ambient is for blocks that ask, not for every block.** Tool rows, code blocks and message bubbles stay plain. A mesh on everything is noise, and the blocks that need the user stop standing out. `ambient-block` is static gradients (no blur, no animation) so it costs nothing while the chat streams. `ambientMeshStyle` (`components/ui/ambientMesh.ts`) only shifts the cloud positions from a stable seed (the question text, the request id), so two blocks in a row are not stamped copies. Keep the tone border on the block: the mesh sits behind the content and never replaces the border.
- **Older modals still use the solid shell** (`bg-black/25` scrim + `bg-[var(--color-bg-secondary)]` card). Move one to the glass materials when you next touch it; never build a new modal on the old shell.

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

Build a new tab from `src/renderer/src/components/settings/SettingsLayout.tsx`, and move an existing one over when you next touch it (Default → Agents, Features and Development are built on it and Local Development takes `SettingsInfoTip` on its own section titles; AI Credentials matches the scale and the shapes with its own markup):

| Export | What it is |
|--------|-----------|
| `SettingsSection` | `<section>` + uppercase muted title + optional section-wide `action`, wrapping `space-y-3` |
| `SettingsCard` | One setting: `rounded-lg border bg-[var(--color-bg)] p-4` |
| `SettingsRows` / `SettingsRow` | A card holding like rows, `divide-y`; `insetDividers` adds 16 px group insets and removes child horizontal padding. Features and Agents Runtime/Tasks use it; root lists retain full-width dividers |
| `SettingsLabel` / `SettingsInfoTip` | A control's label, with its explanation behind the (?) beside it (`info` prop; tip named `About <label>`, and a non-string label must pass `infoLabel`). `SettingsInfoTip` also works inside a modal `<dialog>`: it portals into the enclosing dialog, since one portaled to `<body>` would render behind the top layer, and its Escape closes the tip without closing the dialog |
| `SettingsToggleRow` / `SettingsSwitch` | `SettingsToggleRow` is one line in a `SettingsRows` list: label, (?) tip and switch; `id` is required so the label names the switch. `SettingsSwitch` is the bare switch (`role="switch"`, the Toggle Switch Pattern below) for a row you lay out yourself, such as the Run Script window's parameter form; give it an `id` and a `<label htmlFor>`. `SettingsInfoTip`'s popover carries `data-info-tip` so a modal built of plain elements can tell a press or Escape on it from its own |
| `SettingsHint` | One line of live value under a label (a path, what a choice resolves to) — never standing prose |
| `SettingsStatusRow` | A prerequisite as a dot + line + the one button that fixes it |
| `SettingsButton` / `SettingsAddButton` / `SettingsIconButton` / `SettingsBadge` | Bordered secondary action, dashed Add, icon-only row action, tag |
| `settingsInputClass` | The shared input/select shell |
| `settingsDropdownRowClass` | Label left, compact select in the rightmost 33%; runtime credential, Open agents with and task concurrency |
| `settingsControlRowClass` | Equal-width label/input columns; OpenCode Path |

Rules the primitives exist to enforce:

- **Name the sections after what the user came to change**, not after the data model: Agent Folders, Runtime and Tasks under Agents; Developer Tools under Local Development. Two or three per tab is normal; a tab needing seven is really two tabs.
- **A fact lives in the section that holds the control which changes it.** Developer Tools shows the resolved OpenCode version beside its path override; Agents Runtime keeps the selected-runtime status and retry beside its choice buttons.
- **The default-runtime choice buttons keep their arrangement.** Compact selects use the right-hand column; they do not replace the runtime buttons. Agent Folders uses a compact secondary Add an agents folder beside Rescan.
- **A section-wide verb (Rescan, Refresh) goes beside the section title**, as a labelled bordered button. It acts on everything in the section, so it belongs to the section, not to the first card; and a bare muted icon there is invisible until hovered (ux_rules rule 11).
- **Explanation behind the (?), status below the control, nothing reserved for nothing.** What a setting is for goes in the `SettingsInfoTip` beside its label, not in a paragraph under it. Under the control there is either a one-line status that is filled in every state (`min-h-[1lh]` on the element that carries the text size and leading, so slot and line cannot drift; copy that fits one line at 800px) or a message rendered only when it exists, last in the card. An empty `min-h` slot in the healthy state is wrong bottom padding, not a reservation (ux_rules rules 1 and 12). Rows that are only a label, a (?) and a switch go in one `SettingsRows` list, one line each.
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
- Ends its transition only on its own wrapper's `transitionend`: a child's transition (a row's hover colour) bubbles up and is ignored, else it would cut the expand/collapse short
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

Labels: `text-[14px] font-medium text-[var(--color-text)]` (`SettingsLabel`), with the explanation behind a `SettingsInfoTip` beside it and, where there is a live value to show, one line at `text-[13px] text-[var(--color-text-muted)]` (`SettingsHint`) under it. Inside a dense expandable card, a compact label — `block text-[12px] text-[var(--color-text-muted)] mb-0.5` — is the variant.

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

### Preview Modal Header Controls
- **Every control in a preview modal's header is 26 px tall with `rounded-lg` corners**, the height of the agent chip under the composer: labelled actions (Run…, Contents), icon buttons (Filter, Download, ⋯, Close) and segmented toggles (Tree / Table, Rendered / Source). The card-header `p-1` size above made them a step smaller than the chips the user just left.
- Build them from `src/renderer/src/components/ui/modalHeader.ts` — `MODAL_HEADER_ACTION`, `MODAL_HEADER_ICON` (14 px icon), `MODAL_HEADER_SEGMENTS` around `MODAL_HEADER_SEGMENT` buttons — and add only the colours. Used by File Preview, Artifact Preview and the file ⋯ menu's trigger.

## Toggle Switch Pattern

One switch visual in the app (ux_rules rule 14), defined once in `ui/SwitchTrack.tsx` in two sizes: `md` (36×20, the settings switch) and `sm` (28×16, the same switch scaled to a menu row or a compact line inside a modal). On is `--color-accent`, off is `--color-border`, the thumb is white. Never hand-draw a track and thumb.

- **`SettingsSwitch`** (`settings/SettingsLayout.tsx`) — the whole control: a `role="switch"` button named by a `<label htmlFor={id}>`. Use it, or `SettingsToggleRow`, whenever a label sits beside the switch.
- **`MenuSwitchItem`** (`ui/MenuSwitchItem.tsx`) — a boolean inside a menu: the whole row is the control (`role="menuitemcheckbox"`) with the `sm` switch at its right edge.
- **`switchTrackClass(checked, size)` / `switchThumbClass(checked, size)`** — the visual alone, for a button you keep yourself because it needs more than `SettingsSwitch` offers: an `aria-label` instead of a label (card headers, the schedule switch), `e.stopPropagation()` in a clickable header, a `title`, or an extra state such as `AgentCard`'s danger ring after a failed toggle. Add disabled styling (`disabled:opacity-50`) after the track class; never override its colour.
- **`<SwitchTrack checked size>`** — the visual as an `aria-hidden` decoration, for a row that is itself the control.

## Status Indicator Pattern

`Circle` icon (size 6) with `fill-current` and dynamic color class:
- Connected/enabled: `text-[var(--color-success)]`
- Disconnected/disabled: `text-[var(--color-text-muted)]`
- Error: `text-[var(--color-danger)]`
- Awaiting auth: `text-[var(--color-warning)]`

## Settings Page Structure

Settings page at `src/renderer/src/components/settings/SettingsPage.tsx`.

### Tabs (sidebar menu items)
Default group: `chats` | `llm` | `local-agents` | `local-dev` | `mcp` | `accounts` | `features` | `development` | `trash`.
Profile group: `profile-chats` | `profile-llm` | `profile-agents` | `profile-catalog` | `profile-sync`.
The `local-agents` tab is labeled Agents and configures local folders/runtime/tools; `profile-agents` is also labeled Agents and controls server visibility/sync. Direct connections use their agent pages. The authoritative list is `sectionTitles` in `SettingsPage.tsx`; each tab renders one `*SettingsSection` component.

### Two shapes of tab
1. **A list of configurable items** — AI Credentials, MCP Providers, Chat Modes, User Accounts. Expandable cards plus a dashed Add button that toggles an inline form.
2. **A set of unrelated settings** — Features, Default → Agents, Local Development. Titled `SettingsSection`s, each holding cards, toggles or a list.

Most tabs are one or the other; a tab that is both (Default → Agents: a folder list, an engine, a tool default) is the second shape with a list inside one of its sections.

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
- `src/renderer/src/components/ui/ContextMenu.tsx` — the shell of every right-click menu (Chats row `ChatRowMenu`, a sidebar folder-agent row's `AgentRowMenu`, agent chips in `AgentChip.tsx` — which a plain click opens too); build a new one on it rather than copying a menu. `ContextMenu` portals, opens at the pointer, keeps 8px inside the window, focuses the first enabled item, wraps ArrowUp/ArrowDown (over `menuitem`, `menuitemradio` and `menuitemcheckbox` rows alike — the voice input menu's microphone picks and its switch row), and closes on Escape, Tab, outside `pointerdown`, a scroll of an ancestor of `anchor` (not the streaming transcript), resize and blur. A menu that had to be pushed up to fit is pinned by its bottom edge and grows upward, with the `error` line *above* the items, so the item just clicked stays under the pointer; one that fits below the pointer shows the error last. Re-decided on every size change through a `ResizeObserver`. `useContextMenuAction(onClose).run(action, fallback)` runs one pick at a time, closes on success and keeps the menu open with the reason on failure (ux_rules §6). `CONTEXT_MENU_ITEM` / `CONTEXT_MENU_SURFACE` are `OpenInMenu`'s `MENU_ITEM` / `MENU_SURFACE` with a focus mark and a narrower `w-44`
- `src/renderer/src/components/settings/SettingsPage.tsx` — Settings shell, tab routing
- `src/renderer/src/components/settings/SettingsLayout.tsx` — the settings section/card/row/status primitives
- `src/renderer/src/components/ui/SwitchTrack.tsx` — the one toggle switch visual (`SwitchTrack`, `switchTrackClass`, `switchThumbClass`; sizes `md` / `sm`); `SettingsSwitch` and `ui/MenuSwitchItem.tsx` are the ready-made controls built on it (Toggle Switch Pattern)
- `src/renderer/src/stores/ui.store.ts` — `activeView`, `settingsTab`, `theme`
