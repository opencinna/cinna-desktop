# Minimal View

## Purpose

An open chat with only its transcript on screen. The sidebar, the top bar's buttons and the composer slide away; typing brings back a small frosted "cloud" input in the composer's place. For reading, or for talking to an agent without the app around it.

## Core Concepts

- **Minimal view** — a session-only flag (`minimalView` in the UI store), never persisted. Applies to the main chat view's open chat only, not the new-chat screen, an agent page's chat or a dashboard panel's chat.
- **Cloud input** — the same `ChatInput`, restyled by class, never remounted: borderless frosted glass with feathered edges, no toolbar. Draft, caret, attachments and a running voice session survive entering and leaving because the tree is the same.
- **Wipe gesture** — the pointer swept back and forth across the composer's input, as if wiping it off the screen.
- **Phases** — `full`, `leaving`, `cloud`, `returning`, `entering`. The full composer slides down and fades, and only then does the cloud appear; leaving runs the same in reverse. All surfaces move on the sidebar's 260 ms curve.

## User Stories / Flows

1. Enter: sweep the pointer across the composer's text box (three wipes, no button held), or open the sidebar's Interface menu and press **Minimal view** (offered only with a chat open in the chat view; disabled while the chat needs the user).
2. The sidebar (and its hover peek), the top bar's buttons and the composer animate away. Traffic lights and the top drag strip stay, so the window can still be moved.
3. Type anywhere outside a field: a printable key or Cmd/Ctrl+V focuses the cloud and lands there. Enter sends as usual. The cloud shows only while the draft has something to send (text, files, notes, path references, pasted text) or an attach error to show.
4. Drop files anywhere on the transcript: they go through the composer's one drop path, with a "Drop to attach" overlay.
5. Leave: the **Exit minimal view** button (bottom-right, fades in once the composer is gone), or scroll down twice at the bottom of the transcript. The draft is kept and the caret lands at its end.

## Business Rules

- **It never hides something that needs the user.** Entering is refused (menu button disabled, wipe does nothing) while the chat has a send error, an open top-level permission ask or agent question, an A2A input request, or a pending handoff awaiting review. Entering would hide exactly what needs an answer.
- **It ends on its own when the chat starts needing the user:** a send error, an ask that was not open when minimal view began, a handoff that became pending since. Asks and a handoff already waiting at entry do not end it. A nested agent's ask is shown in its tool call's sub-thread and is not counted. Informational notices (prompt-cache expiry and the like) never restore. A skill-link offer does, though it is not a problem: the cloud has no notice panel, so an offer raised on the open chat (a link pasted into the cloud, clicked in the transcript, or opened from the OS) would be invisible, and the person just acted on it. The rule lives with the offer, not in minimal view's own restore check ([Adding a skill from a link](../../agents/local_agents/skills.md#adding-a-skill-from-a-link)).
- **It ends when the chat view does.** Any other view (Inbox, settings, a deep link) or closing the chat clears the flag; it does not wait for the user to return.
- **The wipe is strict about what counts.** Every counted stroke must pass through the input card; wiping over the transcript alone never fires; a mouse button held (text selection) does not count. It starts over while a composer popup is open or voice is recording, and is off on the new-chat screen and in embedded workspaces. Without this, selecting text in the draft or reaching for the `[+]` menu entered minimal view.
- **Double scroll-down needs the bottom.** The scroll that reaches the bottom, and its trackpad momentum tail, never count; only a second, separate attempt that began at the bottom does. Upward or sideways scrolling resets it. Without this a single flick down the transcript closed minimal view.
- **Keys are forwarded narrowly.** Only printable characters and Cmd/Ctrl+V, only from outside an editable field, and not while a dialog, menu or popover is open. Space is left to scroll the transcript; Cmd+C stays with a transcript selection.
- **An empty cloud is invisible but focusable** (opacity 0, no clicks), so typing still lands in it and the transcript under it keeps its clicks. An attach error (refused drop or paste) shows under the cloud, one line, because the cloud has no toolbar.
- **Nothing in the transcript moves (ux_rules rule 1).** The transcript keeps the bottom padding it had before minimal view, frozen from the moment the composer left its usual shape until it is back, so entering and leaving never shift messages and the last message never sits under the cloud. "Jump to latest" moves to the bottom edge, rising above the cloud only when it is visible.
- **Hidden controls are out of reach.** The sidebar and the top bar's buttons are `inert` (no clicks, no focus); the top bar's strip stays draggable. Extra UI animation off or reduced motion: fade only, no slide.
- **Deliberately not done:** it does not persist across restart or chats, does not change the sidebar's docking or open state (leaving restores it as it was).

## Architecture Overview

```
pointer moves -> useWipeGesture --\
Interface menu toggle ------------+--> requestMinimalView -> ui store minimalView
                                  |                              |
chat store (errors, asks) ---> useMinimalView <-- handoff query  v
                                  |   phases, frozen padding, key forwarding, auto-restore
                                  v
 ChatWorkspace -> ChatInput (cloud) / MinimalRestoreButton / useOverscrollExit -> restore
```

## Integration Points

- [Composer](../conversation_ui/conversation_ui.md) — the cloud is the same `ChatInput`; drafts, attachments and sending are unchanged.
- [Agent Skills](../../agents/local_agents/skills.md#skill-links) — a raised skill-link offer ends minimal view.
- [Ask User Question](../ask_user_question/ask_user_question.md) and permission asks — end minimal view.
- [Appearance](../../ui/appearance/appearance.md) — the Interface menu hosts the toggle; sidebar docking is left untouched.
- [App Shell](../../ui/app_shell/app_shell.md) — top bar and sidebar behaviour under `data-minimal`.
- [UX rules](../../development/ui_guidelines/ux_rules.md) — rule 1.
- [E2E](../../development/e2e/e2e_llm.md) — `e2e/specs/minimal-view.spec.ts`.

See [Technical Details](minimal_view_tech.md).
