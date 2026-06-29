# Ask User Question — Technical

Renderer-only feature. No main-process, IPC, database, or preload changes — it consumes the existing `tool`-kind `MessagePart` and answers through the existing composer send path.

## File Locations

### Renderer — utils
- `src/renderer/src/utils/askUserQuestion.ts` — pure helpers (no React): `isAskUserQuestionTool()`, `parseAskQuestions()`, `formatAnswersForSubmission()`, `isQuestionAnswered()`, `isRecommended()`; types `AskQuestion`, `AskQuestionOption`, `CollectedAnswer`; sentinel `CUSTOM_ANSWER_VALUE`.

### Renderer — components
- `src/renderer/src/components/chat/AskUserQuestionBlock.tsx` — the inline transcript block; inner `AnswerAffordance` sub-component owns the answer button + modal + composer hook.
- `src/renderer/src/components/chat/AnswerQuestionsModal.tsx` — the answer-collection modal (portal, options, custom input, progress counter, gated Send).
- `src/renderer/src/components/chat/MessageStream.tsx` — wires the block into the three render paths (verbose persisted, compact persisted, live streaming) and computes the active-prompt gate.

### Reused, not modified
- `src/renderer/src/hooks/useChatComposer.ts` — `submit()` routes the answer turn (A2A vs LLM, orchestrated handling).
- `src/renderer/src/hooks/useChatStream.ts` — `startAgent` / `startLlm` invoked by the composer.
- `src/shared/messageParts.ts` — `MessagePart` (`kind: 'tool'`, `toolName`, `toolInput`) the feature reads.
- `src/main/agents/streamPartsAccumulator.ts` — produces the `tool`-kind part from `cinna.tool_*` metadata (upstream, unchanged).

## Database Schema

None. No new table, column, or `messages.role`. The question persists inside the existing `assistant` row's `parts[]` (a `tool`-kind `MessagePart`). "Answered" state is derived at render time from message ordering, not stored.

## IPC Channels

None added. The answer turn flows through the existing send path: `useChatComposer.submit()` → `useChatStream.startAgent` / `startLlm` → `window.api.agents.sendMessage` / `window.api.llm.sendMessage` (see [Messaging](../messaging/messaging.md)).

## Key Functions & Methods

### `src/renderer/src/utils/askUserQuestion.ts`
- `isAskUserQuestionTool(toolName?)` — detection: lower-case, strip non-letters, equality with `askuserquestion`.
- `parseAskQuestions(toolInput?)` — defensive parse of `toolInput.questions` into `AskQuestion[]`; drops malformed entries; reads `multiSelect` or `multiple`.
- `isQuestionAnswered(_q, answer)` — true when a question has a selection and any custom selection has non-empty text.
- `formatAnswersForSubmission(questions, answers)` — builds the plain-text answer turn (`Answer:` / `Answers:` lines, `Custom answer:` for free-text, blank-line joined).
- `isRecommended(label)` — case-insensitive `(recommended)` test for the star highlight.
- `CUSTOM_ANSWER_VALUE` — `'__custom__'` sentinel for the synthetic free-text option.

### `src/renderer/src/components/chat/AskUserQuestionBlock.tsx`
- `AskUserQuestionBlock({ questions, interactive, chatId })` — renders the block; returns null on empty questions. Muted/read-only unless `interactive`.
- `AnswerAffordance({ questions, chatId })` — inner component rendered only when active, so the `useChatComposer` subscription attaches only to the answerable prompt. Owns modal open state; `handleSubmit` calls `submit(text)` then closes.

### `src/renderer/src/components/chat/AnswerQuestionsModal.tsx`
- `AnswerQuestionsModal({ questions, onSubmit, onClose })` — `createPortal` modal; Escape + outside-click close (mirrors `FilePreviewModal`).
- Local state `answers: Record<number, CollectedAnswer>` (`{ selected: string[]; custom: string }`). `setSelected` toggles (multi) or replaces (single); `setCustom` updates free text.
- `allAnswered` gates the Send button via `isQuestionAnswered` over every question; `handleSend` formats and calls `onSubmit`.
- Progress counter row renders only when `questions.length > 1`; `scrollToQuestion(i)` scrolls via `data-question-index`.

### `src/renderer/src/components/chat/MessageStream.tsx`
- `activeQuestionMsgId` — computed once: non-null only when `!isStreaming && !pendingUserMessage` and the last message is an `assistant` row whose `parts[]` contains an ask-user-question tool. Drives `interactive={msg.id === activeQuestionMsgId}`.
- Three insertion points branch on `isAskUserQuestionTool(...)` before the generic `tool` render: verbose persisted parts (returns the block), compact persisted parts (pushes a `slot: 'plain'` node — never collapsible), live streaming blocks (passive, `interactive={false}`).

## Renderer Components

- **AskUserQuestionBlock** — accent-bordered card when active (help icon, "The agent is asking N questions", question list, Answer button); muted card with check icon when historical. Delegates the interactive surface to `AnswerAffordance`.
- **AnswerQuestionsModal** — per-question card: optional `header` badge, question text, radio (single) / checkbox (multi) option rows, `(Recommended)` star, synthetic "Other" option + revealed text input; header with count, optional progress counter, footer Cancel + gated Send.

## Configuration

None. No settings, env vars, or feature flags. Always active for any agent chat.

## Security

- No credential, token, or key handling.
- `toolInput` originates from the remote agent stream and is untyped (`Record<string, unknown>`); `parseAskQuestions` validates it field-by-field rather than casting, so a malformed/hostile payload degrades to "no questions" instead of throwing or rendering arbitrary structure.
- Answer text is sent through the standard composer path (no shell, no eval); option labels and custom text render as plain React text nodes (no `innerHTML`).
