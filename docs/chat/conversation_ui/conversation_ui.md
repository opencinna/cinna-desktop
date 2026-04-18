# Conversation UI

## Purpose

Defines the visual treatment of messages in the chat conversation area. The design favours a clean, document-like reading experience where assistant text blends into the page while user input remains visually distinct.

## Core Concepts

- **User bubble** — A right-aligned rounded bubble with a tinted background. No avatar icon; the alignment and colour are sufficient to identify the sender.
- **Assistant text** — Full-width plain text rendered directly on the page background, like body copy. No avatar, no bubble wrap. Markdown is rendered inline with syntax highlighting.
- **Tool call block** — A collapsible row showing tool name, provider badge, and status icon. Borderless by default; border and background appear on hover or when expanded.
- **System message** — A centered, danger-tinted box used for streaming errors. Contains a short message, an alert icon, and an expandable details section.
- **Loading indicator** — Three bouncing dots shown inline (no avatar, no bubble) while waiting for the first streaming chunk.
- **Entry animation (user)** — A newly sent user message appears first as a small rounded shape on the right and expands left and down into the full bubble while the text fades in.
- **Entry animation (assistant)** — A streaming assistant message softly fades in as a single block (opacity + slight blur) over ~1s. The animation runs on the streaming bubble only; saved messages render statically to avoid a flicker on the streaming → saved transition.

## Visual Hierarchy

1. **User messages** stand out via colour and right-alignment — they are the "input" the user scans for.
2. **Assistant messages** are the dominant content — presented as readable body text without visual clutter.
3. **Tool calls** recede into the background when collapsed (no border) and surface detail only on interaction.
4. **System messages** use centered placement and danger colour to draw attention without disrupting the conversation flow.

## Design Rules

- No avatar icons anywhere in the conversation — neither for the user nor the assistant
- User messages: right-aligned, rounded bubble, `--color-user-bubble` background, max 80% width
- Assistant messages: full width, no background, no padding beyond the text's own leading — reads like page content
- Tool call blocks: border is `transparent` when collapsed; transitions to `--color-border` on hover or when expanded
- Tool call status icon sits immediately after the tool name (not pushed to the far right)
- Streaming cursor: a small pulsing accent-coloured bar appended after the last text delta
- Errors render as a `SystemMessage` — centered box with `--color-danger` border/background at 30%/8% opacity, expandable detail section
- All colours use CSS variables (`var(--color-*)`) — never hardcoded values
- Entry animations run only on first appearance: the user-bubble pop fires when the messages array grows by exactly one (i.e. the user just sent something), so initial loads, chat switches, and bulk re-fetches do not animate. The assistant fade fires only on the streaming bubble — never on saved messages — so the streaming → saved swap is seamless
- Animations are theme-agnostic: only opacity / `filter: blur` / `transform` are animated, never colours

## Architecture Overview

```
MessageStream
  ├── MessageBubble (role=user)    -> right-aligned bubble, no icon
  ├── MessageBubble (role=assistant) -> full-width plain text
  ├── ToolCallBlock                -> collapsible, borderless until hover/expand
  ├── SystemMessage                -> centered error box (inline in MessageStream)
  └── Loading dots                 -> three bouncing dots, no wrapper
```

## Integration Points

- [Messaging](../messaging/messaging.md) — Data flow and streaming protocol that feeds this UI
- Theming — All colours reference CSS variables from `src/renderer/src/assets/main.css`
