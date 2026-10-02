# Agent Colors

## Purpose

Lets the user give an agent one of a fixed set of colors, so it stands out in the sidebar and its chips and labels in a chat read as that agent at a glance. Set on the agent page's **Interface** tab, per profile, and **None** by default.

## Core Concepts

- **Color preset** — one of fifteen named colors (Rose, Coral, Peach, Honey, Lime, Sage, Mint, Teal, Sky, Blue, Iris, Lavender, Orchid, Sand, Slate), defined once in `src/shared/agentColors.ts`. Mid-tone and slightly desaturated, so each reads on both the dark and the light theme. The preset's **id** is what is stored, never the hex.
- **Ink** — how a chosen color is drawn as text or a line (chip and label text, chip border) or as a glyph (a type icon): the preset as-is on the dark theme, darkened toward black on the light theme, where the mid-tones are too pale against white. On the light theme text is darkened more than a glyph. The swatches, the chat-row dot and a chip's faint background use the preset itself.
- **None** — no preset chosen. The sidebar stays as it was; chips and labels keep the agent's **hash color**.
- **Hash color** — the color every agent had before presets existed: its id hashed into the chat-mode palette, so the same agent is drawn in the same color everywhere. It remains the fallback for any agent left at None.
- **Agent color** (glossary) — the per-profile choice itself: one row per agent and profile in `agent_colors`, no row meaning None.

## User Stories / Flows

### Choose a color

1. The user opens an agent's page, switches to **Settings** and picks the last tab, **Interface**. Below **Keyboard shortcut** sits a **Color** section: a row of round swatches, **None** first (a struck-circle icon), then the fifteen presets, each named in its tooltip and accessible name.
2. The user clicks a swatch. It saves at once — there is no Save button — and the chosen swatch shows a ring around it and a dark check inside it.
3. The sidebar Agents list now draws the agent's type icon in that color, as do the agent page's own header and its row in Settings → Profile → Agents; its group header in the Chats list (when grouping by agent) does the same; its chats elsewhere in the Chats list get a small dot before the title; and its chips in the composer, its message labels and its sub-thread header in the transcript take the color instead of the hash color.
4. Clicking **None** clears it: the sidebar goes back to muted icons and no dots, and the chips go back to the hash color.

### Something goes wrong

1. The save fails (an unknown preset, an agent this profile can no longer see).
2. The message shows under the swatches; the selection goes back to the saved color as soon as the list has re-read. Nothing else on the tab moves.

## Business Rules

- **Per profile, about agents of either scope.** Two profiles that share the same folder agents each keep their own colors; a profile's choice never shows in another. This is the same rule as [agent shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md), and the table follows the shortcut table in every respect but uniqueness.
- **Not one-to-one.** Two agents may share a color, and choosing a taken one takes it from nobody. Fifteen presets cannot give every agent its own, so the shortcut's "choosing a taken digit moves it" rule has no counterpart here.
- **The sidebar is plain unless the user asked.** Every type icon (the Agents list, the agent page header, Settings → Profile → Agents, the Chats group header and the row tooltip) and the row dot use only a *chosen* color; an agent at None keeps the muted icon and no dot. Hash colors there would tint every row, and a tint the user chose would no longer stand out.
- **Chips and labels always have a color.** Every per-agent chip and label in a chat — the composer's bound-agent and attached-agent chips, a message bubble's agent label and the "addressed to" label, the agent sub-thread header, an agent contribution, a job's attached-agent chips — takes the chosen color and falls back to the hash color. They had a color before this feature; a chosen one replaces it, None restores it. The hidden Default runtime keeps the accent chip, since it has no identity to color by.
- **One color reads as one agent everywhere.** Every per-agent chip and label goes through the same lookup, so a chosen color cannot show on the footer chip and not on the sub-thread header of the same agent.
- **The dot is for rows that do not already say who.** A chat row gets a dot only when it is not under a **who** group header in the [Chats list](../../chat/chat_list_grouping/chat_list_grouping.md): in the flat list, under date groups alone, in **Pinned** and in the [Active block](../../chat/chat_list_grouping/active_block.md). Under a who group (including its nested days) the header's tinted icon already carries the color, and a dot on every row beneath it would repeat it. The dot is the chat's **main agent** — the who of its [row summary](../../chat/chat_row_summary/chat_row_summary.md) — so a plain chat on a hidden runtime, or one with only a chat mode, has none. It is drawn in the row's left padding, not in the row's flow: a dot arriving or going never moves the title, and rows with and without one keep their titles aligned. Nothing is reserved for it.
- **One ink rule for both themes.** Every surface that draws a chosen color as text or a glyph goes through the same ink, so a color that reads on the dark theme is not washed out on the light one. A plain fill with nothing drawn on it takes the raw preset in both themes: the swatches, because they are the palette the user is choosing from; the chat-row dot, so it matches its swatch; and a chip's background tint, being only a 10% wash.
- **Choosing does not move the swatches.** The selection is a ring drawn outside the swatch and a check drawn inside it, never a border, so nothing in the row shifts when the choice changes ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 1). While the save is in flight the swatches show the choice being saved, not the one it replaces, so the selection never snaps back before the list re-reads. Clicking the already-chosen swatch saves nothing.
- **Validated in main.** Main stores only an id from the preset list (`invalid_color` otherwise), and choosing a color needs an agent this profile can see (`not_found`). Clearing needs neither, so a color whose agent is gone can still be removed.
- **A retired or unknown id draws as None.** Should a preset ever leave the list, rows holding its id are kept but ignored by the renderer: the sidebar goes plain and chips fall back to the hash color. Preset ids are therefore never renamed.
- **Survives sync; follows the agent; goes with the profile.** No foreign key to `agents.id`, for the reason `agent_overrides` has none: sync may drop and re-create a remote agent under the same id, and the color must survive that. A folder agent re-keyed by **Stamp identity** takes its color with it in every profile. Deleting a hand-added connection drops its color in every profile. A folder agent moved to the Trash keeps its color, as it keeps its shortcut, in case the folder comes back. Deleting a profile deletes its colors.

### What it does not do

- It does not tint the agent pickers or the `@` popup; neither reads the chosen color.
- It does not color chat-mode chips or anything the [chat mode](../../chat/chat_modes/chat_modes.md) color drives — those have their own presets.
- It offers no custom color or free hex. A fixed list is what guarantees every color reads on both themes.
- Development agents have no Interface tab (their Settings opens Local Development), so they cannot be given a color.

## Architecture Overview

```
Interface tab swatch -> useSetAgentColor -> window.api.agents.setColor
  -> IPC agent:set-color -> agentService.setColor (validate id, findAgent)
  -> agentColorRepo.set -> agent_colors (user_id, agent_id) row, or delete for None
  -> invalidate ['agents','colors']

App root: AgentColorsProvider -> useAgentColors -> IPC agent:list-colors
  -> AgentColorsContext (agent id -> #RRGGBB)
     -> useChosenAgentColor('glyph', ink): AgentTypeIcon everywhere (sidebar, page header, Settings, Chats who header/tooltip)
     -> useChosenAgentColor('fill', raw hex): chat-row dot
     -> useAgentColor (chosen, else hash): composer chips, bubble labels, sub-threads, job chips
```

## Integration Points

- [Agents](agents.md) and [Agents Tab & Agent Page](../local_agents/agents_tab.md) — the Interface tab on every agent page that has Settings; the Agents list rows whose icons take the color.
- [Keyboard Shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md) — the other section of the Interface tab; the shortcut table is the model this table copies (per profile, no FK, re-key, delete and profile cascade).
- [Chats List Grouping](../../chat/chat_list_grouping/chat_list_grouping.md) and [Chat Row Summary](../../chat/chat_row_summary/chat_row_summary.md) — the who header icon, the tooltip's who icon and the row dot.
- [Chat Routing](../../chat/chat_routing/chat_routing.md), [Conversation UI](../../chat/conversation_ui/conversation_ui.md) and [Jobs](../../jobs/jobs/jobs.md) — the chips and labels that take the color.
- [Settings Scope](../../core/settings_scope/settings_scope.md) — colors are Profile-bound data about agents of either scope.
- [User Accounts](../../auth/user_accounts/user_accounts.md) — `userRepo.deleteWithCascade` removes the profile's colors.

Sub-doc: [Technical Details](agent_colors_tech.md)
