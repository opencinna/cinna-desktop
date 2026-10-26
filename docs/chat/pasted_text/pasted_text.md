# Pasted Text

## Purpose

A long text paste into the composer becomes a compact chip instead of a wall of text in the input, and a long user message in the transcript is clamped behind Show more instead of pushing the conversation off screen. The agent still receives the full text, inline in the message.

## Core Concepts

- **Paste chip**: a pill in the composer's attachment row showing the paste's first readable line, its size (lines, or characters for a single long line) and an X. The whole pill opens the preview.
- **Pasted text is text, not a file.** It travels as a block inside the message text, so it reaches every engine, including drivers that accept no attachments, and needs no upload or destination. This is the difference from [File Attachments](../file_attachments/file_attachments.md).
- **Paste block**: the `<pasted_text lines="N">` … `</pasted_text>` block a chip becomes in the sent message. The message text is the only record; there is no column, so a transcript recognises a paste from the text alone (the way reference lines are recognised, see [Path Mentions](../path_mentions/path_mentions.md)).
- **Paste card**: a block rendered in a sent user bubble as one compact row (clipboard icon, label, size). Click opens the preview.
- **Clamp**: a long user bubble shown at a fixed height with a fade and Show more / Show less.

## User Stories / Flows

1. **Paste**: Cmd/Ctrl+V of plain text that is 20 or more lines, or 2,000 or more characters, adds a chip and leaves the textarea as it was. Shorter text pastes natively.
2. **Stays inline** (always the native paste): Cmd/Ctrl+Shift+V and the Edit menu's Paste and Match Style (paste as plain text); a paste while editing a recalled queued message (the edit saves its text alone, a chip would be lost); a paste while text is selected (it means "replace this"); a paste while an `@`, `#`, `/` or `?` trigger is being typed (the paste is its filter); a paste of a Finder copy whose clipboard carries file names.
3. **Too long**: over 200,000 characters nothing is pasted or chipped, and the composer says "This paste is too long to send as text — attach it as a file instead." The message goes away with the next paste that is accepted and when a chip is removed or inserted as text; it does not outlive the situation it describes, and a file error is left alone.
4. **Preview**: click the chip. A dialog shows the raw text, monospace and wrapped, never rendered as markdown, with Copy, **Insert as text** (puts it at the start of the textarea, before anything typed, with a blank line between, and drops the chip) and Remove.
5. **Undo**: Cmd/Ctrl+Z right after a chip paste takes that chip back. Any other keystroke or edit in between hands undo back to the textarea.
6. **Send**: chips go first, one block each in paste order, then the typed text, separated by blank lines — material first, instruction after. A chip alone is sendable. **Run on its own** (the autonomous task) takes the same material as its goal — typed text, path references and pastes — and clears them from the composer when the task starts.
7. **Read back**: in the transcript a sent paste is a card between or before the typed text; clicking it opens the same preview with Copy only. A card never expands inline.
8. **Long messages**: a user bubble taller than about 300 px is clamped with a fade and an accent-coloured Show more; Show less folds it back. This applies to every long user message, pasted or typed, including old ones.

## Business Rules

- **Plain text only.** Only `text/plain` is read. A Mail or Gmail copy also carries HTML; the chip holds the plain text and the formatting is dropped.
- **Normalised once.** Line endings become LF and leading and trailing blank lines are dropped; the inside is kept verbatim.
- **Same text twice is two chips**; unlike path chips there is no de-duplication.
- **Sent chips are consumed by id.** A paste chipped while a send is in flight survives it.
- **Drafts keep chips** with the rest of the composer draft, and an empty draft means no chips too (the cache-expiry strip treats a chip as content).
- **The block is the exact shape the app writes.** Opening tag alone on its line with a line count that matches the body, closing tag alone on its line, a blank line or the end of the message after it, and the block at the message start or after a blank line (the queue merges several messages into one text, so a block can sit mid-message). Anything else — a typed `<pasted_text>` tag, a wrong count, text glued to the closing tag — stays ordinary text. This is what stops a forged or half-typed block from turning part of a message into a card, or hiding text behind one.
- **A closing tag inside a paste is escaped** by adding one backslash on write and removing one on read, so pasted text that itself contains the tag (or an already-escaped one, such as a message copied out of Cinna) round-trips and cannot end its own block early.
- **The line count is part of the shape.** The model-facing count is for the model; the reader also uses it to refuse a block whose body does not match.
- **Where a block is summarised, and where it is left raw.** Summarised as `[Pasted text · N lines]`: the title derived from the first message, the text the auto-title model reads, and a task's goal on the Tasks view and in the edit dialog. Left raw: search over messages, text sent to other agents (A2A), and the model's own context, because those must see what was actually sent (none of them calls the summariser). Whole-message Copy gives the pastes' raw text and the typed text without tags.
- **Titles.** The title is the typed text; with none, the first paste's label (its first readable line). The auto-title model is told `[Pasted text · N lines]` in place of each paste; when nothing was typed it also gets the first 1,000 characters of the first paste, since a message of pastes asked nothing in words. Whether a title is still untouched is judged on the raw-text-derived title, so a user's rename still wins.
- **The clamp is render-only** and measured in pixels, not lines, because cards and markdown blocks make a line count lie. A clamp that would hide under 80 px is not applied, so a bubble is never folded to save a few lines.
- **The clamp never moves the reader.** Show more is a click on lines the reader is looking at, and a transcript pinned to the bottom would follow the growth and push those lines off the top. So the click counts as leaving the bottom: the view unpins, the bubble's top is held through the animation, and it grows downward. The Jump to latest pill may appear afterwards, which is correct — the reader did leave the bottom. Following resumes when the reader scrolls back or sends. Collapsing holds the bubble in place through the animation or, if its top was above the view, brings the top back so the toggle stays on screen. The open state is a transcript disclosure: "Collapse expanded" closes it too.
- **Known gap**: recalling a sent or queued message (ArrowUp, or restoring a held queue) puts its raw `<pasted_text>` blocks into the textarea, not chips. Editing inside a block changes its line count, and the block then fails the shape rule and renders as raw text.
- **Not done here**: no chips for HTML, images or files (those keep their own paths, see [File Attachments](../file_attachments/file_attachments.md)); no editing of a paste inside the chip (Insert as text is the way to edit); no clamp on agent replies.

## Architecture Overview

```
Cmd+V -> ChatInput.takeTextPaste -> draft.pastes -> PasteBadge -> preview modal
send: withPathRefs(typed) -> withPastes -> message text (blocks first) -> every engine
transcript: MessageBubble -> splitPastes -> paste cards + markdown, inside useBubbleClamp
titles / tasks: summarizeUserText -> "[Pasted text · N lines]"
```

## Integration Points

- [Path Mentions](../path_mentions/path_mentions.md): the sibling chip; reference lines follow the typed text, paste blocks precede it.
- [Conversation UI](../conversation_ui/conversation_ui.md): the composer row and draft hold the chips; the user bubble and transcript expansion host cards and the clamp.
- [Auto Chat Titles](../auto_titles/auto_titles.md): what the title and the title model read.
- [Pending Messages](../pending_messages/pending_messages.md): the queue merges texts, which is why blocks are recognised mid-message.
- [Prompt Cache Notice](../../agents/session_telemetry/session_telemetry.md): a chip counts as a non-empty draft.
