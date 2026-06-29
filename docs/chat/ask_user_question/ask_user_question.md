# Ask User Question

## Purpose

Renders a remote agent's `AskUserQuestion` tool call as an interactive prompt inline in the conversation, and lets the user answer it with a structured modal (single/multi-select options, per-question free-text, a progress counter). The collected answers are formatted into plain text and sent as the next user turn, which auto-threads onto the same agent context so the agent resumes. Without this, the tool call rendered as an opaque, collapsible tool "dot" the user could not act on.

## Core Concepts

- **AskUserQuestion tool** — A pause-and-ask tool an agent emits to collect structured input from the user (Claude Code SDK `AskUserQuestion`, OpenCode `question`). The Cinna backend normalises every variant to the tool name `askuserquestion` and ships it as a `tool`-kind A2A part whose `cinna.tool_input` carries a `{ questions: Question[] }` payload. It arrives over the normal streaming pipeline, indistinguishable on the wire from any other tool call except by name.
- **Question** — One entry in the payload: `question` (text), optional `header` (short tag/badge), `multiSelect` (checkboxes vs radio), and `options[]` (each `label` + optional `description`). A single tool call carries an array of questions — that array is where the modal's progress counter comes from.
- **Custom / "Other" answer** — A synthetic free-text option the modal always appends to every question (sentinel value `__custom__`), regardless of the schema. Picking it reveals a text input; its content is formatted as `Custom answer: <text>`.
- **Recommended option** — An option whose `label` contains `(Recommended)` is highlighted with a star. Purely visual; no behavioural difference.
- **Active vs historical prompt** — A question is *active* (answerable) only while the chat is waiting on it: it is the final turn (no user reply after it) and nothing is streaming. Active prompts render with an accent border + "Answer" button. Once answered (a new user turn lands, or a stream starts), the same block reverts to a muted, read-only record.
- **Answer turn** — The formatted answer text sent through the canonical composer as an ordinary user message. There is no dedicated answer RPC or metadata field — continuity to the agent's open task is implicit in the chat's existing A2A context.

## User Stories / Flows

1. An agent, mid-run, emits an `AskUserQuestion` tool call (e.g. "Which framework? / Which package manager?") and ends its turn.
2. The tool part streams in and persists on the assistant message's `parts[]`. The desktop renders an **Ask User Question** block beneath the agent's turn: a help icon, "The agent is asking N questions", and the list of question texts.
3. Because it is the last turn and nothing is streaming, the block is active — it shows an **Answer** button.
4. The user clicks **Answer**; a modal opens listing every question with its options as radio buttons (single-select) or checkboxes (multi-select), plus an "Other (enter custom answer)" free-text option.
5. With more than one question, a progress counter (`2/3 answered`) shows per-question check/circle icons; clicking one scrolls to that question.
6. The user selects answers; the **Send** button stays disabled until every question has a complete answer (a custom selection requires non-empty text).
7. On send, the answers are formatted into plain text (`question` + `Answer:`/`Answers:` lines) and dispatched as the next user turn. The modal closes.
8. The answer threads onto the agent's existing context; the agent resumes and streams its continuation. The question block reverts to a muted "N questions asked" record.
9. On reload the historical block renders read-only from the persisted `parts[]`.

## Business Rules

### Detection

- A `tool`-kind part (or live tool delta) is treated as an interactive question solely by tool name: lower-cased and stripped of non-letters, it must equal `askuserquestion`. This tolerates `AskUserQuestion`, `ask_user_question`, and the normalised `askuserquestion`. No other tool name triggers the rendering.
- The questions payload is parsed defensively from the untyped `cinna.tool_input`: a missing/!array `questions`, entries without a `question` string, or options without a `label` are dropped. A part that yields zero valid questions renders nothing.
- `multiSelect` is true when the payload sets `multiSelect` (Claude) or `multiple` (OpenCode).

### Active-prompt gating

- A question is answerable only when ALL hold: not currently streaming, no optimistic user message pending, and the question's message is the last message in the chat with `role: 'assistant'`. This is computed once per render as the active question message id.
- Live-streaming question parts always render passively (interactive disabled) — they become answerable only once the turn finishes and the persisted part takes over.
- A historical question (any user turn exists after it) renders muted and read-only forever.

### Answering

- Answers are formatted to plain text matching cinna-core's widget: single-select → `"{question}\nAnswer: {label}"`; multi-select → `"{question}\nAnswers:\n- {a}\n- {b}"`. A custom selection contributes `Custom answer: {text}`. Questions are joined by a blank line.
- The answer is sent through the canonical composer (the same A2A-vs-LLM and orchestrated-chat routing as every other turn) — never a bespoke send path. It carries no special metadata; the agent resumes purely because the turn threads onto the chat's existing context.
- The Send button is gated: every question must have at least one selection, and any `__custom__` selection must have non-empty text.

### No new persistence or transport

- The feature adds no database column, no message role, no IPC channel, and no answer-status flag. The question lives inside the existing `assistant` row's `parts[]`; "answered" is derived from message ordering, not stored. (Contrast cinna-core's own frontend, which persists a `tool_questions_status` flag server-side — the desktop does not need it because it derives the same state locally.)
- The A2A `input-required` task status is **not** used as the trigger. Detection is the reliably-persisted tool part; the status event remains unhandled.

### Rendering placement

- The active prompt is always emitted as a plain (non-collapsible) node so the [Conversation UI](../conversation_ui/conversation_ui.md) dots-grouping never folds an actionable prompt into a collapsed group. Historical questions also render as the same block (muted), in both compact and verbose modes.

## Architecture Overview

```
Remote agent emits AskUserQuestion (turn ends)
  └─ A2A tool part: cinna.tool_name=askuserquestion, cinna.tool_input={questions:[…]}
       ↓
Main: StreamPartsAccumulator → tool-kind MessagePart on assistant parts[]
  └─ port delta {kind:'tool', toolName, toolInput}
       ↓
Renderer: MessageStream
  ├─ isAskUserQuestionTool(toolName)?  → AskUserQuestionBlock (plain node)
  └─ activeQuestionMsgId gate → interactive (Answer button) vs muted record
       ↓
User clicks Answer → AnswerQuestionsModal (collect selections + custom text)
  └─ formatAnswersForSubmission(...) → plain text
       ↓
useChatComposer.submit(text)  ── normal user turn ──▶ agent resumes on same context
```

## Integration Points

- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — Owns the `cinna.content_kind` / `cinna.tool_name` / `cinna.tool_input` metadata contract and the `tool`-kind `MessagePart` this feature consumes.
- [Conversation UI](../conversation_ui/conversation_ui.md) — Hosts the render hierarchy and the collapsible dots-grouping the active prompt deliberately opts out of.
- [Command Results](../command_results/command_results.md) — Sibling special-render of a `parts[]` entry; like this feature it renders a non-`MessageBubble` block as a plain node, but it is read-only platform output whereas this is an interactive prompt.
- [Messaging](../messaging/messaging.md) — Owns the composer send path (`useChatComposer`) the answer turn reuses, and the optimistic-user-message lifecycle the active-prompt gate keys off.
- [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md) — In orchestrated chats an agent's question surfaces through the agent sub-thread path, not the assistant-`parts[]` path this feature renders; `useChatComposer` routing keeps the answer turn correct either way.
