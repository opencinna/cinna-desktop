# Conversation UI

## Purpose

Defines message presentation, transcript text actions and unsent composer state. Users can read an answer, reuse it in Notes and visit another chat without losing work in progress.

## Core Concepts

- **Composer draft** — Unsent text, file and note references plus new-chat mode/agent/MCP choices, owned by one profile and composer surface for this renderer session.
- **Message context menu** — Copy text and Save to Notes actions over a captured transcript excerpt or the clicked message body.
- **Chat curtain** — The old layout fades away before the new layout is revealed along a diagonal edge; text stays stationary. Its preference and lifecycle belong to [Appearance](../../ui/appearance/appearance.md).

- **User bubble** — A right-aligned rounded bubble with a tinted background. No avatar icon; the alignment and colour are sufficient to identify the sender.
- **Assistant text** — Full-width plain text rendered directly on the page background, like body copy. No avatar, no bubble wrap. Markdown is rendered inline (live while streaming; syntax highlighting of fenced code is applied once the turn finalizes).
- **Thinking block** — A lightweight collapsible block with a brain icon and the label "Thinking", used for the agent's internal reasoning (A2A `thinking`-kind parts). Collapsed: flat, no background or border — just the header. Expanded: a rounded card with faded border and background fades in, showing italic markdown body at lower opacity. Auto-expanded while streaming, collapsed once persisted.
- **Tool narration block** — A lightweight collapsible block with a wrench icon and the label `Tool: <name>`, used for the agent's narration about a tool it is using (A2A `tool`-kind parts). Same collapsed/expanded visual behaviour as ThinkingBlock. Markdown body, lower opacity. Auto-expanded while streaming, collapsed once persisted.
- **Tool result block** — A lightweight collapsible block with a terminal icon, used for raw stdout/stderr emitted by a tool execution (A2A `tool_result`-kind parts, paired to the originating tool via `cinna.tool_id`). Monospace body, scrollable, max-height capped. Header reads `Output` for stdout; for stderr the icon switches to a warning triangle, the header reads `stderr`, and the card uses danger colouring. Auto-expanded while streaming (the output is the payload the user is waiting on), collapsed once persisted (keeps long outputs from crowding scrollback).
- **Cinna CLI block** — One initially collapsed command/output disclosure for a structured shell command beginning with `cinna`. Matching results are paired by tool ID; compact mode retains a dot per command even when it is the only step. A dot is presentation status, not proof that a remote agent was created.
- **Composer warning** — An actionable full-width warning above the input for a known readiness refusal. Healthy composers reserve no empty warning slot.
- **Command result block** — A bordered card with a terminal icon and `Command output` header, used for the synchronous result of a platform slash-command (A2A `command_result`-kind parts — `/files`, `/agent-status`, `/run:<name>`, …). Markdown-rendered body so structured command output (file lists, status reports) reads naturally; default-expanded inline because it IS the assistant turn (the agent stream did not run), not auxiliary narration. Visually distinct from a normal assistant bubble so the user can tell they're looking at platform output, not an LLM voice.
- **Notice block** — Left-aligned view of an agent-side system notice (`cinna.content_kind: 'notice'` parts, e.g. "Starting up the agent environment…"). While streaming live it shows as a `Info`+text row so the user can read the in-flight ping. Once persisted, compact mode collapses it to a small info-toned blue dot (`--color-severity-info`) the user can click to read; verbose mode keeps it expanded inline. Sits visually alongside the green collapsible-group dots from `thinking` / `tool` / `tool_result` parts, not centred.
- **Disclosure block (shared shell)** — The common collapsible primitive behind the lightweight auxiliary blocks (thinking, tool narration, tool result, command frame, apply-patch). Owns the one-place definition of: transparent-when-collapsed / tinted-when-expanded card chrome, the chevron + icon + truncating-header button, expand state, the streaming pulse dot, and the reveal animation. Variants: `tone` (`default` / `error`) and `frameless` (logical wrapper with no chrome, used by the command frame). `NoticeBlock` is intentionally NOT built on it (it's a dot/inline affordance, not a card).
- **Apply-patch diff block** — A collapsible block with a file-diff icon and `Applying patch · N files` header, used when the `apply_patch` tool is called. Replaces the raw `patch_text` dump with a git-style diff (per-file op badge, path, `+N −M` tally, colorized lines). Collapsed by default. See [Apply-Patch Diff](../apply_patch_diff/apply_patch_diff.md).
- **Tool call block** — A collapsible row showing a tool/provider badge and status icon. The badge line is a borderless header (gradient fade on hover); expanding reveals the detail (method / input / result) in a rounded, bordered card rendered **below** the badge line. Icon convention: a connector (`Plug`) icon + provider badge for MCP tool calls; a wrench for a generic/local tool (e.g. `bash`) with no MCP provider. Used for actual tool calls with input/result data — distinct from agent narration.
- **Agent sub-thread block** — In orchestrated mode an agent-backed tool call renders as an expandable nested sub-thread (the agent's own thinking/tool/result parts) instead of an opaque result string, headed by the agent's name in its hash color. Same badge-line-above / card-below structure. See [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md).
- **System message** — A centered, danger-tinted box used for streaming errors. Contains a short message, an alert icon, and an expandable details section.
- **Loading indicator** — Three bouncing dots shown inline (no avatar, no bubble) while waiting for the first streaming chunk.
- **Following the bottom** — While a reply streams the transcript is held at the bottom, instantly and without animation, but only while the user has not scrolled away from it; scrolling up during a stream holds the position for the rest of the turn. See [Transcript Scrolling](scroll_following.md).
- **"Jump to latest"** — A small pill centred above the composer, shown only while the transcript is not following the bottom. Clicking it resumes following. It is the affordance that makes scrolling away during a stream safe.
- **Entry animation (user)** — A newly sent user message appears first as a small rounded shape on the right and expands left and down into the full bubble while the text fades in.
- **Streaming assistant text** — While streaming, assistant text renders through the **same Markdown path as the persisted message** (the `MessageBubble` assistant render), so bold / lists / tables format **live** as tokens arrive — no raw `**…**` that only formats once the stream ends, and no reflow on the streaming→saved swap. Syntax highlighting of fenced code is deferred until the turn finalizes (highlighting an incomplete code block isn't useful and re-highlighting every token is the main jank source). A pulsing accent cursor trails the last token. There is no per-delta fade animation — Markdown re-parses the whole string each delta, so individual deltas can't be wrapped in animated spans. Streaming `thinking` / `tool` / `tool_result` blocks still use the block-level entry behaviour.
- **Entry animation (assistant, full block)** — When a saved assistant message appears without having streamed (e.g., one-shot non-streaming response or A2A message parts), the entire block softly fades in (opacity + blur) over ~1s using the assistant-reveal mask. When the saved message replaces streaming blocks for the same chat, the block-level animation is suppressed so the swap is silent (the chunks already animated individually).

## Visual Hierarchy

1. **User messages** stand out via colour and right-alignment — they are the "input" the user scans for.
2. **Assistant messages** are the dominant content — presented as readable body text without visual clutter.
3. **Thinking + tool narration blocks** sit in muted, collapsible cards beneath the answer flow — visible at a glance but never competing with the answer text.
4. **Tool calls** recede into the background when collapsed (no border) and surface detail only on interaction.
5. **System messages** use centered placement and danger colour to draw attention without disrupting the conversation flow.

## Design Rules

- No avatar icons anywhere in the conversation — neither for the user nor the assistant
- User messages: right-aligned, rounded bubble, `--color-user-bubble` background, max 80% width
- Assistant messages: full width, no background, no padding beyond the text's own leading — reads like page content
- Tool call blocks: border is `transparent` when collapsed; transitions to `--color-border` on hover or when expanded
- Tool call status icon sits immediately after the tool name (not pushed to the far right)
- Thinking + tool narration + tool result + apply-patch blocks follow the **lightweight collapsible** pattern, now implemented once in the shared `DisclosureBlock`: when collapsed, the block is visually flat — no background, no border — just the header row (icon + label + chevron). On expand, a rounded card with `--color-border` at 60% opacity and secondary background at 40% fades in via `transition-colors duration-200`, and the body appears inside. On collapse, the background and border fade out, leaving only the header. This keeps the chat interface light and uncluttered when blocks are closed. Body text renders at 80–90% opacity. Pulsing accent dot in the header while streaming. The error tone (stderr tool result) swaps the chrome to `--color-danger`; the `frameless` variant (command frame) keeps no chrome in either state
- For A2A messages with structured `parts[]`, render each part in order using its kind-specific block (`text` → MessageBubble, `thinking` → ThinkingBlock, `tool` → ToolNarrationBlock, `tool_result` → ToolResultBlock, `command_result` → CommandResultBlock); LLM messages and legacy A2A messages with no `parts` fall back to a single MessageBubble using `content`
- Streaming cursor: a small pulsing accent-coloured bar appended after the last text delta
- Errors render as a `SystemMessage` — centered box with `--color-danger` border/background at 30%/8% opacity, expandable detail section
- All colours use CSS variables (`var(--color-*)`) — never hardcoded values
- Entry animations run only on first appearance: the user-bubble pop fires when the messages array grows by exactly one (i.e. the user just sent something), so initial loads, chat switches, and bulk re-fetches do not animate. For assistant messages, streaming text renders as live Markdown (no per-delta animation), and the block-level reveal on the DB-saved message is suppressed when that chat just streamed (tracked per-chat via `streamedIncrementallyChatId`) — so the streaming → saved swap is seamless without a second animation
- Animations are theme-agnostic: only opacity / `filter: blur` / `transform` are animated, never colours
- Nothing in the transcript scrolls smoothly. Following the bottom is an instant, pre-paint position assignment; a smooth scroll restarted per chunk is what made a streaming table read as the window shaking
- Markdown tables are their own scroll box (sized to their content, never wider than the bubble). A table is the one markdown block sized by its content rather than its container, and one wide enough made the whole transcript scroll sideways — the horizontal scrollbar then took layout height off the viewport as the streaming table resettled

## User Stories / Flows

### Leaving and returning to a draft

1. Type on the dashboard, an agent start screen or an existing chat; choose any relevant agents, MCP servers, mode, files and notes.
2. Visit another chat, agent page or settings screen. Returning restores that surface's draft, including explicit mode deselection. The dashboard and each agent start page remain independent.
3. The restored textarea resizes, focuses with the caret at the end and scrolls to its last line. Menus and note previews stay closed; reopening a draft used to place the caret at the start, so typing accidentally prepended text.
4. Sending consumes submitted content only after dispatch. Preparation failure leaves it available for retry; newer changes made while preparation runs remain in the source draft.
5. The Local Development start screen restores its own per-profile text draft and places the caret at the end. Build runtime selections remain saved settings; that composer does not gain general chat file, note or capability pickers.

### Reusing message text

1. Right-click a user or assistant message for **Copy text** and **Save to Notes**. To use an excerpt, select text first and right-click within it; selections can include expanded tool output or several messages.
2. With no relevant selection, the actions use the clicked message body's original Markdown, including headings, links, lists and code fences. Partial selections use visible text. A structured reply's individual text block is the body under the pointer, not the entire multi-part turn.
3. Choose Copy text to write the captured payload to the clipboard, or Save to Notes to create and open a profile note with that body. Its title comes from the first nonempty line, with a leading Markdown heading marker removed and a short length cap.
4. Pointer movement and keyboard navigation move one shared highlight between actions. Errors remain beside the actions for retry; pending actions cannot be submitted twice.

### Reading the transcript

1. Read an assistant's answer with its auxiliary steps collapsed in compact mode. Expand the dots to inspect the command headers, then expand a Cinna CLI header to see its associated output.
2. A recognized command appears once rather than repeating in a Bash argument card and narration. Real explanatory narration and stderr stay visible inside the expanded command block. The same rendering applies to saved, streaming and nested-agent replies.
3. Unrecognized shell commands keep ordinary tool/output blocks. Whole-output console/text wrappers are still removed there; a command such as `cd workspace && cinna …` does not need CLI recognition to display its console output cleanly.
4. When the answering agent has a known readiness problem, read the warning above the input and use Check again or Re-authenticate. The message draft stays intact; when recovery clears the warning, input focus returns.

## Business Rules

- **Navigation never consumes a draft.** Each profile has separate dashboard, per-agent and per-chat buffers. They survive component unmounts within the app window, but not renderer refresh, app restart or another window; they are not synced. Existing-chat routing/model settings and build runtime settings retain their own saved ownership.
- **Dispatch is the consumption boundary.** The send result describes handoff to the run path, not successful completion of an agent reply. Cleanup targets the originating draft and removes only submitted fields that are still unchanged. A draft-owned preparation lock survives navigation/remount, preventing duplicate sends before streaming begins while allowing other drafts to prepare independently.
- **Restore files before judging the destination.** Loading or switching destinations must not silently delete selected files. Unsupported or wrong-scope files block sending with an explanation. Late picker/upload results return to their source draft; explicit file clearing invalidates them. See [File Attachments](../file_attachments/file_attachments.md).
- **Capture once before menu focus.** A selected excerpt is captured at right-click so focus changes or new streaming text cannot change what Copy or Save uses. Whole-body source excludes message labels and metadata; partial selection is plain visible text, with no Markdown reconstruction.
- **The menu follows user navigation.** Outside clicks, wheel/touch scrolling, resize, window blur and chat/profile changes close it. Escape, Tab and Page Up/Down dismiss it; arrows and Home/End navigate actions. Programmatic transcript following keeps it open: streaming scroll events previously dismissed the menu before an action could be chosen. Editable inputs retain their normal context menus.
- **One focus means one highlight.** Copy is focused initially; moving onto Save transfers focus and its highlight. Independent hover/focus backgrounds previously left Copy highlighted too. Reduced motion disables the short highlight transition.
- **Saving does not reclaim navigation.** A note that finishes saving after menu dismissal remains saved, but does not reopen the note view. An old-profile result neither opens a note nor invalidates the current profile's cache. Notes creation, editing and reversible Trash deletion follow [Notes](../../notes/notes/notes.md).

- **Pair by identity, never proximity.** Only a recognized structured shell call and later results with its tool ID share a Cinna CLI block. Concurrent stdout/stderr belongs to its originating call; unrelated results stay standalone. Slash-command invocations keep their existing command-specific representation.
- **Keep details opt-in.** Both compact groups and Cinna CLI disclosures start collapsed, including during streaming. Verbose mode shows the collapsed command headers directly. Ordinary generic output retains its existing streaming expansion behavior.
- **Dots do not verify remote outcomes.** Cinna CLI compact steps are pending while the turn streams without a result, red when any associated result is stderr, and otherwise done/green. A persisted command without captured output may therefore be green; expanding it reports No output recorded. Remote creation/readiness must be established by the assistant's actual checks.
- **Only strip a whole-payload terminal wrapper.** Console/text-style outer fences are formatting, so they are removed independently of command recognition. Literal embedded fences, multiple fenced sections and other language-tagged code remain text. An unfinished terminal wrapper is removed only while streaming.
- **Preserve terminal geometry.** Generic output and Cinna CLI output use monospace text, preserved columns, horizontal scrolling and 1.25 line height. Relaxed body-copy spacing left gaps in box-drawing borders; unit line height made rows too condensed. This renderer does not convert terminal tables to HTML tables or interpret their content as Markdown.
- **Warnings carry a reason and remedy, not healthy-state decoration.** Composer readiness problems use the shared warning panel above the message input, matching the build start page. The full reason wraps and the recovery action appears below it. Healthy composers show no warning panel or reserved empty status line. Checking again keeps the draft and returns focus to the input when the warning clears.

## Architecture Overview

Profile + composer surface → session draft store → ChatWorkspace / ChatInput → preparation and run dispatch → consume unchanged source fields.

Transcript right-click → captured text → clipboard, or Notes mutation → existing note IPC/service/storage → note detail while the menu remains current.

MainArea chat selection → stationary-layout curtain; [Appearance](../../ui/appearance/appearance.md) owns the animation, not transcript scrolling.

```
MessageStream
  ├── MessageBubble (role=user)    -> right-aligned bubble, no icon
  ├── MessageBubble (role=assistant) -> full-width plain text
  ├── ThinkingBlock                -> collapsible dimmed card (brain icon, italic body)
  ├── ToolNarrationBlock           -> collapsible dimmed card (wrench icon; header is "Tool: <name>" in compact mode, "<name>(<args>)" in verbose mode when cinna.tool_input is present)
  ├── CinnaCliBlock                -> one recognized command and ID-paired outputs, initially collapsed
  ├── ToolResultBlock              -> collapsible card (terminal/alert icon; monospace body; danger colouring when cinna.tool_stream is "stderr")
  ├── CommandResultBlock           -> bordered "Command output" card (terminal icon; markdown body; default-expanded)
  ├── ApplyPatchBlock              -> git-style diff for the apply_patch tool (FileDiffCard per file; see Apply-Patch Diff)
  ├── NoticeBlock                  -> persisted agent-transition row; collapsed accent dot, expand-on-click
  ├── ToolCallBlock                -> borderless badge line (Plug=MCP / Wrench=local) + bordered detail card below on expand
  ├── AgentToolSubThread           -> orchestrated agent-backed tool call as a nested sub-thread (see Orchestrated Agents)
  ├── SystemMessage                -> centered error box (inline in MessageStream)
  └── Loading dots                 -> three bouncing dots, no wrapper
```

## Integration Points

- [Technical details](conversation_ui_tech.md) — draft ownership, context-action lifecycle, file map and focused validation.
- [Notes](../../notes/notes/notes.md) — Save to Notes creates a normal editable note; [Note Attachments](../note_attachments/note_attachments.md) sends existing notes back into chats.
- [File Attachments](../file_attachments/file_attachments.md), [Chat Modes](../chat_modes/chat_modes.md) and [On-Demand MCP](../../mcp/on_demand/on_demand.md) — draft fields become their normal chat-owned state at dispatch.
- [App Shell](../../ui/app_shell/app_shell.md) — New Chat restores the dashboard buffer; agent pages use separate entry keys.
- [Appearance](../../ui/appearance/appearance.md) — Extra UI animation controls the stationary-text chat curtain independently of draft retention.

- [Sidebar Session Status](../session_status/session_status.md) — Running/interrupt and unread-result indicators live in chat rows, independently of inline loading dots. A result is acknowledged only when the matching saved transcript is available in the foreground chat view.
- [Apply-Patch Diff](../apply_patch_diff/apply_patch_diff.md) — The `apply_patch` tool's git-style diff block; one of the disclosure blocks rendered here
- [Transcript Scrolling](scroll_following.md) — When the conversation follows the bottom, when it stops, and the "Jump to latest" pill
- [Account Build Sessions](../../agents/local_dev/build_sessions.md) — uses the shared warning and CLI-output presentation while building through local tools
- [Agent Drivers & Readiness](../../agents/drivers/drivers.md) — owns refusal state, severity and recovery
- [Messaging](../messaging/messaging.md) — Data flow and streaming protocol that feeds this UI
- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — How `thinking`, `tool`, and `tool_result` parts arrive from A2A agents and end up in the rendering layer
- Theming — All colours reference CSS variables from `src/renderer/src/assets/main.css`
