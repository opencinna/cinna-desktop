# Capabilities

## Purpose

Notes and Dashboards are optional sections of the app. A new user starts without them — no tab, no entry point, no hint — and turns each on in Settings → Features → Capabilities when they want it. A user who already has notes or dashboards keeps them on without being asked.

## Core Concepts

- **Capability** — An optional section of the app that adds a sidebar tab and the actions that create content there. There are two: **Notes** and **Dashboards**.
- **State** — Each capability holds one of three values in the installation-wide app settings: `unset` (nobody has decided), `on`, `off`. `on` and `off` are decisions; `unset` is not a choice anyone made.
- **First-run decision** — Main turns `unset` into `on` or `off` once, from whether the installation already holds records of that capability. See below.
- **Gated surface** — Anything that exists only because a capability is on. Listed under Business Rules.

## User Stories / Flows

### A new user

1. Installs Cinna. The sidebar's tab rail shows Chats, Jobs and Agents; no Notes or Dashboards tab.
2. Right-clicking a message offers Copy text but no Save to Notes; typing `?` in the composer is ordinary text; a component card in a chat offers Preview but no Add to dashboard….
3. Opens Settings → Features → **Capabilities**, the first section on that tab, and turns **Notes** or **Dashboards** on. The tab appears at the end of the rail, and every gated surface follows without a reload.

### A user who already has content

1. Upgrades with notes (not in the trash) or dashboards in any profile.
2. At the next launch the matching capability is decided `on`, once. Nothing disappears from under them. A capability with no records is decided `off`.

### Turning one off

1. Turns **Notes** or **Dashboards** off in Capabilities.
2. The tab and every gated surface go. If the user is on that tab or on its screen, the sidebar falls back to Chats and the center to the last chat; a screen that belongs to no tab (Settings itself, the Inbox) stays where it is and only the sidebar tab moves.
3. The data is kept. Turning it back on shows the same notes and dashboards.

## Business Rules

- **Off is the default and the failure mode.** `unset`, settings not loaded yet and a failed read all read as off, because showing a tab that then vanishes costs more than showing it a beat late. Only `on` is on.
- **Decided once, and only from `unset`.** The first-run decision never touches `on` or `off`, so it can never overrule the user. A write of `unset` through the settings channel is refused for the same reason.
- **The decision looks at every profile, not the active one.** The capability is installation-wide, so judging it on whichever profile is active would write Notes off for a user whose notes live in another profile. Notes count only those not in the trash; dashboards count all. These are the only unscoped reads in the database layer and they return a number and nothing else.
- **A failed count decides nothing.** The key stays `unset` (off) and the next reader — `settings:get-all`, or a gated main-process check — tries again, rather than waiting for a restart.
- **Gated surfaces — Notes:** the Notes tab; Save to Notes in the message right-click menu (a group left empty goes with it); the `?` note picker in the composer (the character stays plain text); the hint that teaches the picker (`hasNotes` is false while off).
- **Gated surfaces — Dashboards:** the Dashboards tab; Add to dashboard… on a component card and on the agent's Dashboards tab (the agent's components stay listed and previewable); the "From dashboard" pill and the chat row's origin mark (they would open a view that does not exist); the dashboard names on a component card, which become plain text instead of links.
- **Dashboards off also stops background work.** No launch warm-up, no `while_open_every` timer, no schedule-fed run. What the user or an agent asks for directly (a Preview, a refresh on an open tile) still runs. Turning it on takes effect at the next moment each is asked: a lease renewal arms timers within about 20 seconds; warm-up waits for the next profile start.
- **The two tabs are last on the rail.** Turning one on appends a tab and moves none of the others; the rest of the rail is the same for every user.
- **The data is never touched.** Off hides, nothing deletes. Notes and dashboards keep being stored, synced and retained as before.
- **Writes the window did not make follow.** Main announces to the main window every app setting that changed (`settings:changed`), including a capability it decided itself after the window's first read (a boot-time count that failed and later succeeded), so an E2E fixture's write or a late decision reaches the cache without a reload. A failed settings read counts as loaded and off, so a hidden capability's view is still left.
- **Turning Dashboards off stops a warm-up already running** at its next tile.

## Architecture Overview

```
Settings toggle -> settings:set -> appSettingsService -> app_settings (notesCapability / dashboardsCapability)
                                          |-> settings:changed push -> main window re-reads app settings
core startup / settings:get-all -> capabilityService.resolveUnset -> capabilityCountsRepo (all profiles)
renderer: useCapabilities -> SidebarTabs, MessageContextMenu, ChatInput, hints, dashboard cards
main:     dashboardRefreshService -> capabilityService.isOn('dashboards')
```

## Integration Points

- [Settings](../settings/settings.md) — hosts the Capabilities section and the switch rows.
- [App Shell](../app_shell/app_shell.md) — the tab rail and the fall-back to Chats.
- [Notes](../../notes/notes/notes.md) and [Dashboards](../dashboards/dashboards.md) — the two capabilities.
- [Hints](../hints/hints.md) — the `?` hint waits for Notes.
- [UX rules](../../development/ui_guidelines/ux_rules.md) — rules 14–17 cover optional sections, switches and the Settings sidebar.
