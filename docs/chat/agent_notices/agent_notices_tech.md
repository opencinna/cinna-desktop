# Agent Notices — Technical Details

## File Locations

### Shared

| File | Role |
|------|------|
| `src/shared/messageParts.ts` | `ContentKind` union includes `'notice'`. Type-only; imported from both Electron processes. |

### Main Process

| File | Role |
|------|------|
| `src/main/agents/streamPartsAccumulator.ts` | `StreamPartsAccumulator` recognises `'notice'` in `VALID_KINDS`. Inside `ingest()`, notice parts short-circuit before the `appendToList` call: deltas accumulate into a private `notices: Map<partKey, string>` and post to the port (`{type:'delta', kind:'notice', text}`) but never join `parts[]` or `answer`. `snapshotNotices()` returns `AccumulatedNotice[]` in insertion order. |
| `src/main/services/a2aStreamingService.ts` | After each stream completes (both the streaming and non-streaming branches of `streamToAgent`), iterates `accumulator.snapshotNotices()` and persists each via `messageRepo.saveTransition` **before** the `messageRepo.saveAssistant` call, so `sort_order` matches wire order. Logs `noticeCount` on `Stream complete` / `Non-streaming complete`. |
| `src/main/db/messages.ts` | `messageRepo.saveTransition({ chatId, content, sourceAgentId })` writes a row with `role: 'agent_transition'`. Returns the new row id. `SaveTransitionMessage` interface exposed alongside `SaveAssistantMessage` / `SaveErrorMessage`. |
| `src/main/services/chatStreamingService.ts` | LLM history rebuild already filters `m.role === 'agent_transition'` — notices written by the A2A path are therefore invisible to subsequent LLM-channel sends in the same chat. |
| `src/main/services/multiAgentService.ts` | `turnLineForCatchup` returns `null` for any role that is not `'user'` or `'assistant'`, so `agent_transition` rows are already excluded from catch-up replay. |

### Preload

| File | Role |
|------|------|
| `src/preload/index.ts` | No new bridge surface. The existing `agents.sendMessage` MessagePort stream carries `{type:'delta', kind:'notice', text}` events alongside other deltas. |

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/hooks/useChatStream.ts` | `handleAgent` routes every `delta` event through `chat.store.appendDelta` regardless of `kind`. `AgentEvent.kind` is typed as `ContentKind`, which now includes `'notice'` — no per-kind branching needed in the hook. |
| `src/renderer/src/stores/chat.store.ts` | `appendDelta` accepts `kind: 'notice'` and stores it in `streamingBlocks` as a `TextBlock { kind: 'notice' }`. Consecutive notice deltas with no `toolName` / `toolId` merge into one block via the standard merge rule. Notices clear with `streamingBlocks` on `clearStreamingBlocks()` (fired after the post-stream cache invalidation). |
| `src/renderer/src/components/chat/MessageStream.tsx` | Local `SystemMessage` component gained a `tone?: 'error' \| 'notice'` prop. `tone='error'` (default) keeps the existing red/`AlertTriangle` styling for `role: 'error'` rows. `tone='notice'` uses `--color-border` / `--color-text-muted` / `Info` for the muted treatment. Two render sites use different components: live streaming blocks with `block.kind === 'notice'` render `<SystemMessage tone="notice" />` (expanded pill so the user can read the in-flight ping); persisted `role === 'agent_transition'` rows render `<NoticeBlock content={msg.content} />` (collapsed accent dot, expand-on-click). |
| `src/renderer/src/components/chat/NoticeBlock.tsx` | Persisted-notice component. Default state is a centred `w-2 h-2 rounded-full bg-[var(--color-severity-info)]/70` dot inside a hover-highlighted button (with a 120-char-truncated `title` for hover preview). Expanded state reuses the same muted-pill styling as the live `SystemMessage tone="notice"`. Local `useState` toggle — no global expand/collapse coordination. The info-tone token reads as blue in both light and dark themes (the brand accent flips to orange in light), so the dot stays semantically "info" across themes. |

## Database Schema

No migration required. The `messages` table already supports `role: 'agent_transition'` (reserved in earlier builds, see `src/main/db/migrations/messages.ts`). `agent_transition` rows populate `chat_id`, `role`, `content`, `source_agent_id`, `sort_order`, `created_at` — all other columns are null.

## IPC Channels

No new channels. Existing `agent:send-message` MessagePort stream carries notice deltas with this shape:

| Field | Value |
|-------|-------|
| `type` | `'delta'` |
| `kind` | `'notice'` |
| `text` | The delta string |
| `toolName` / `toolInput` / `toolId` / `toolStream` | `undefined` for notices |

The accumulator deliberately omits the tool* fields for notice deltas so the renderer's merge rule treats consecutive notice deltas as the same streaming block.

## Services & Key Methods

- `src/main/agents/streamPartsAccumulator.ts::StreamPartsAccumulator.ingest()` — Branches on `partKindOf(part)` early: when `kind === 'notice'` the part text is appended to the private `notices` map keyed by `(idPrefix, partIndex)` and a delta event is posted to the port; control returns before the `appendToList` / `answer` mutations.
- `src/main/agents/streamPartsAccumulator.ts::StreamPartsAccumulator.snapshotNotices()` — Returns `AccumulatedNotice[]` (`{ partKey, text }`) in insertion order. Empty array when the agent emitted no notice parts.
- `src/main/services/a2aStreamingService.ts::streamToAgent()` — After loop completion (streaming branch) or `result` ingest (non-streaming branch), iterates `accumulator.snapshotNotices()` calling `messageRepo.saveTransition({ chatId, content, sourceAgentId: agentId })` for each entry, then proceeds to `saveAssistant` if `parts.length > 0`.
- `src/main/db/messages.ts::messageRepo.saveTransition()` — Atomic insert of an `agent_transition` row. Picks the next `sort_order` via `getNextSortOrder(chatId)`.

## Renderer Components

- `src/renderer/src/components/chat/MessageStream.tsx` — `SystemMessage({ message, detail?, tone? })`. The `tone='notice'` variant uses `border-[var(--color-border)]` and `bg-[var(--color-bg-secondary)]/40` with `text-[var(--color-text-muted)]` and the `Info` icon from `lucide-react`. Used for live (streaming) notice blocks; persisted rows go through `NoticeBlock` instead.
- `src/renderer/src/components/chat/NoticeBlock.tsx` — `NoticeBlock({ content })`. Centred button containing either (a) a `w-2 h-2 rounded-full bg-[var(--color-accent)]/60` accent dot (default), or (b) the same muted pill as `SystemMessage tone="notice"` (when expanded). Toggle is local `useState`; clicking the dot opens, clicking the pill closes. No props beyond `content`.

## Configuration

No settings, env vars, or feature flags. The contract is purely the `cinna.content_kind: 'notice'` metadata key on inbound A2A TextParts.

## Security

- Notice content is treated as untrusted text from the agent — same trust boundary as ordinary `text` parts. Rendered through the same React text path; no `dangerouslySetInnerHTML`.
- Notices never feed back into the LLM (role-filtered out of history rebuild) or into other agents (role-filtered out of catch-up replay). A compromised or misbehaving agent cannot use a notice to slip text into another LLM/agent's input.
- `agent_transition` rows are scoped to the chat that received them; no cross-chat exposure.

## Backend Coordination

This is the desktop half of the contract. The Cinna backend (`a2a_event_mapper.py`) must set `metadata['cinna.content_kind'] = 'notice'` on TextParts it intends to surface as system notices. Until the backend ships the tag, agent startup pings continue to arrive as plain `text` parts and render as ordinary assistant bubbles — the desktop changes are dormant until the backend marks the part.

See the [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) `Cinna Metadata Contract` table for the full per-key reference.
