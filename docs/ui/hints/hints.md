# Hints

## Purpose

Teach the composer's keyboard shortcuts *in place*, without an onboarding flow or a help screen. A single compact line stuck to the bottom of the new-chat screen cycles short "you can do X" tips, and preempts that rotation with a targeted tip the moment the user does something adjacent to a shortcut they haven't discovered.

The shortcuts (`@`, `#`, `/`, `?`, `~`, double-ESC, the `?`-then-Enter note expansion) previously had no discovery surface at all — they were documented only in `docs/`, so a user learned them by reading the repo or not at all.

## Core Concepts

- **Hint** — one line of teaching copy, built from **segments** (plain text plus key chips) so `Enter` renders as a keycap rather than as quoted prose.
- **Ambient lane** — hints with no trigger. Shuffled once per session and rotated on a timer.
- **Contextual lane** — hints bound to a **trigger**. Never rotate; they *preempt* whatever is on screen when their event fires, hold longer, then hand the bar back to the rotation.
- **Availability predicate** — the gate answering "can the user act on this right now?". A hint that fails it is never shown.
- **Retirement** — a hint whose gesture the user has demonstrably performed enough times drops out of the pool for good.
- **Hint event** — the single vocabulary the composer emits into (`note-attached`, `mode-picked-via-menu`, …). One event can both retire hints and trigger a contextual one.
- **Hint context** — the snapshot of live state (notes exist, agent declares prompts, files have a destination, …) that every availability predicate is evaluated against.
- **Surface** — the screen a hint may appear on. Only the new-chat screen is wired today; the model is built to take more.
- **Silence** — session-only hide via the bar's hover `×`. Distinct from the durable Settings toggle.

## User Stories / Flows

### Seeing hints

1. The user lands on the new-chat screen. After a short grace period — so nothing flashes during the view transition — the first hint fades in at the bottom.
2. Every few seconds, scaled to the length of the line, the bar crossfades to the next eligible hint.
3. Rotation holds while the pointer rests on the bar, while the composer has a picker or modal open, and while the window is in the background.
4. Only hints the user can act on right now appear — a profile with no notes never sees the `?` tips.

### Getting a contextual hint

1. The user picks a note from the `?` popup.
2. The bar immediately swaps to an accent-colored line telling them that pressing Enter now, on an empty message, pastes the note's text inline instead of attaching it as a file — the exact beat where that gesture is available.
3. The line holds noticeably longer than an ambient hint, then the rotation resumes.
4. If the user takes the advice, both the contextual hint and its ambient twin move toward retirement.

### Outgrowing a hint

1. The user performs the gesture a hint teaches — opening the note picker with `?`, applying a chat mode with `~`, dropping a file on the composer.
2. The composer reports it; the hint's usage counter increments.
3. Once the counter reaches the retirement threshold, the hint leaves the rotation permanently and never returns unless reset.

### Turning hints off

1. **For now:** hover the bar and click the `×`. Hints stay hidden until the app restarts.
2. **For good:** Settings → Features → Interface → **Show hints**.
3. **Bringing retired hints back:** Settings → Features → Interface → **Reset hints** clears every usage counter.

## Business Rules

- **Never teach the unreachable.** Every hint carries an availability predicate evaluated against live state — notes exist, the selected agent declares prompts or commands, chat modes are configured, files have a destination, agents are pending. A hint failing it is not in the pool, and a contextual hint failing it is dropped rather than shown.
- **Hints retire.** After three observations (the default) of a hint's teaching signal, the hint is gone permanently. Without this the bar becomes wallpaper and the contextual lane loses its effect.
- **Contextual hints don't nag.** At most one at a time — a second trigger during a hold is dropped, not queued — once per session per hint, at most twice across the install's lifetime, and never within five seconds of the previous preemption.
- **A contextual hint that is never displayed is never spent.** The trigger fires on the event alone, before availability is known; if the hint turns out to be inactionable it is dropped *and refunded*, so pressing ESC with no agents selected doesn't silently consume one of that hint's two lifetime chances.
- **Contextual hints skip the start delay.** They are a direct response to something the user just did; the grace period applies only to the ambient rotation.
- **Ambient order is per-session and stable.** The eligible pool is shuffled once per launch; hints that become eligible later are appended rather than triggering a whole-pool reshuffle, and hints that become ineligible keep their slot. The hint on screen is tracked by identity, not by position, so selecting an agent mid-session never yanks the line the user is reading.
- **No layout shift.** The bar has a fixed height and is positioned outside the centered composition, so a hint appearing, changing, or being absent never moves the composer. The layout reserves a matching strip — gated on the same setting the bar reads — so a tall composer on a short window can't grow underneath it.
- **Not a live region.** Deliberately announced-on-demand rather than `aria-live` — a polite live region firing every few seconds is hostile to screen-reader users.
- **The `×` is session-scoped only.** A permanent kill hidden behind a hover-only affordance is a trap; the durable switch lives in Settings.
- **Events fire from every chat.** The composer emits hint events in active chats too, even though the bar only renders on the new-chat screen — the gestures are identical, so using `~` inside a live chat correctly retires the `~` tip shown on the dashboard.
- **Setting defaults to on, but renders off until loaded.** The bar waits for the real setting value rather than assuming the default, so a user who turned hints off never sees a flash while the settings query resolves.
- **The catalog is documentation.** A keybinding change must update the hint that teaches it — a stale hint is worse than no hint. See [Keyboard Shortcuts](../keyboard_shortcuts/keyboard_shortcuts.md).

## Hint Catalog

**Ambient** hints teach: `?` (attach a note), the `?`-then-Enter inline expansion, `#` (suggested prompts), `/` (agent commands), `@` (add agents / MCP), `~` (switch chat mode), picker navigation keys, `Shift`+`Enter`, double-ESC, drag-drop attach, the `[+]` menu as the mouse equivalent, attachment and note preview, chat modes, and the app-logs accelerator.

**Contextual** hints fire on: attaching a note (→ the inline-expansion gesture), opening the note picker (→ picker keys), picking a mode via the `[+]` menu (→ `~`), picking a capability via the picker modal (→ `@`), selecting an agent that declares prompts (→ `#`) or commands (→ `/`), attaching files via the menu (→ drag-drop), and a lone ESC with agents selected (→ press it again).

Two hints are deliberately **excluded** from the new-chat surface because they don't apply there: attachment-only send (the new-chat path still requires text for the chat title) and anything about tool-call rendering. Both belong to a future active-chat surface.

## Architecture Overview

```
User gesture in the composer
  -> hint event ("the user just did X")
       -> credit every hint that teaches X   (retirement)
       -> fire the hint triggered by X       (contextual lane, subject to caps)

Live app state (notes, agents, modes, providers)
  -> hint context -> availability predicates -> eligible pool
                                                   |
Scheduler: stable order + dwell timer + pause signals
           contextual preemption wins over ambient
                                                   v
                                          Hint bar (new-chat screen)
```

Renderer-only apart from a single boolean in the installation-global settings store. No IPC channel, database table, or main-process service is added — the setting rides the existing generic settings pair.

## Integration Points

- [Keyboard Shortcuts](../keyboard_shortcuts/keyboard_shortcuts.md) — the registry this feature surfaces. Any change there needs a matching change to the hint catalog.
- [Mention Popups](../../chat/mention_popups/mention_popups.md) — source of the `@` / `#` / `/` / `?` / `~` hints, and of the pause signal raised while a picker is open.
- [Note Attachments](../../chat/note_attachments/note_attachments.md) — owns the double-Enter inline expansion, the flagship contextual hint.
- [Composer `[+]` Menu](../../chat/composer_menu/composer_menu.md) — every mouse-driven pick in this menu is a teachable moment for its keyboard equivalent.
- [File Attachments](../../chat/file_attachments/file_attachments.md) — source of the drag-drop and attachment-preview hints.
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — source of the `~` and chat-mode hints.
- [Settings](../settings/settings.md) — hosts the Features → Interface toggle and the Reset hints button.

See [Hints — Technical Details](hints_tech.md) for file paths, the catalog schema, scheduler timings, and the storage split.
