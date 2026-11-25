# Agent Notices

## Purpose

Renders agent-side system messages — startup pings, environment transitions, and other status-style updates the agent itself emits during a turn — as muted system messages inside the chat transcript, distinct from the agent's actual answer bubbles. Notices are excluded from the LLM history rebuild so they never feed back into the model.

## Not these

Transcript notices are the agent's own words. The composer's *account* rows (a Cinna account the agent's credentials come from is signed out, locked, expired or removed, with **Switch to *name***, **Re-authenticate** or **Open accounts**) are the desktop's, belong to the composer notice panel, and never enter the transcript or the `agent_transition` history: see [The composer notice panel](../conversation_ui/conversation_ui.md#the-composer-notice-panel) and [Unavailable accounts](../../agents/service_credentials/README.md#unavailable-accounts). Their warning tone is their own and does not use `cinna.notice_tone`.

## Core Concepts

- **Notice** — A TextPart sent by a Cinna agent with `metadata['cinna.content_kind'] = 'notice'`. Unlike `text` / `thinking` / `tool` / `tool_result` parts, notices do NOT join the assistant message's `parts[]` — they land on their own `agent_transition` row.
- **`agent_transition` row** — A `messages.role` value reserved for agent-emitted system notices. Excluded by role from the LLM history rebuild.
- **Streaming notice block** — The live counterpart of an `agent_transition` row. While a stream is in flight, notice deltas flow into `chat.store.streamingBlocks` as `text`-type blocks with `kind: 'notice'` and render as the expanded muted system-message pill. Once the stream completes and the chat re-fetches, the streaming block is cleared and the persisted `agent_transition` row takes its place — rendered by `NoticeBlock` as a collapsed accent-coloured dot (expand on click).
- **Collapsed dot** — The persisted-notice visual: a single small accent-coloured dot centred in the transcript. Clicking it expands to the original notice text in a muted system-message pill (same look as the live streaming view). The dot exists so the notice survives reload for inspection without permanently consuming vertical space, since after the in-flight ping has served its purpose the user mostly wants their answer to be the visible content.
- **Notice tone** — `info` (the default) or `warning`, from `metadata['cinna.notice_tone'] = 'warning'` on the part. Any notice part carrying `cinna.notice_tone: 'warning'` is drawn as a warning, whatever sent it — an A2A agent may set it too; the key is not stripped for non-ACP sources (it only changes colour and collapse, never routing). The desktop sets it on the ACP driver's provider-error notes ("Gemini answered an error (503): …") and the 90 s "No reply from <engine> …" note, host and vault turns alike. A warning reads in `--color-severity-warning-text` with an `AlertTriangle` in `--color-warning` (as `ComposerWarning`), live and persisted, and **never collapses to the dot** — compact mode included. Its saved text says only what happened; the live row alone appends " Stop ends the turn." (`LIVE_WARNING_HINT`), since there is nothing to stop once the turn is over.
- **Notice persistence ordering** — Each unique `(messageId | artifactId, partIndex)` produces one persisted notice row. Notices are saved before the assistant message they preceded on the wire, so transcript order matches stream order.

## User Stories / Flows

1. User sends a message to a Cinna agent that needs to spin up an execution environment
2. Agent immediately emits a notice TextPart: "Starting up the agent environment, this may take a moment…"
3. Desktop streams the notice live as a muted system message centred between the user bubble and the (yet-to-arrive) answer — the user can see exactly why the answer is taking time
4. Agent finishes startup and streams the actual answer as ordinary `text`-kind parts
5. Stream completes — desktop persists the notice as an `agent_transition` row, then the assistant message as a normal `assistant` row
6. The post-stream cache refetch swaps the live notice for the persisted row. The persisted row renders as a small accent-coloured dot above the answer — the notice has done its job, so it stops eating transcript space
7. On reload the user sees the same dot above the agent's answer. Clicking it expands to the original notice text (same muted system-message pill as the live view) so the context is never lost
8. If the agent is engaged again later, the prior notice is never fed back to the model — `agent_transition` rows are excluded from the orchestrator's history rebuild

## Business Rules

### Wire format

- Notices are recognised by `metadata['cinna.content_kind'] === 'notice'` on an A2A TextPart. No other signal is used — non-Cinna agents that don't set the metadata never trigger notice routing.
- A notice part may stream as deltas like any other part; per-`(messageId|artifactId, partIndex)` keying handles both chunk-style and snapshot-style emissions.
- Notices may appear at any point in the stream; they are persisted in arrival order. The common case is a single notice emitted before the answer begins.

### Persistence

- Each distinct notice part becomes one `agent_transition` row. Two notice parts in the same stream produce two rows, in the order they were first seen.
- Notice rows carry `source_agent_id` (the agent that emitted them) so the transcript can attribute them if needed. An info notice carries no `parts`; a warning keeps its tone in the existing `parts` column as one part, `[{ kind: 'notice', text, tone: 'warning' }]` (no migration). A row without that part — every row written before the tone — reads as info. The same row goes into a vault chat's transcript journal unchanged, so the tone survives a vault lock and unlock.
- Notices are persisted **before** the assistant message of the same turn so `sort_order` matches wire chronology.

### Exclusion from model inputs

- Fresh runtime transcript replay excludes agent_transition rows; notices remain transcript presentation rather than model instructions.

### Rendering

- Both live and persisted notices render through `NoticeBlock`. Left-aligned in the transcript column (not centred), so visually they sit alongside the green collapsible-group dots from `tool` / `tool_result` parts rather than floating in the middle.
- **Live (streaming):** `<NoticeBlock content={…} live />` — forced expanded view, no collapse affordance, since the user is actively waiting on the in-flight ping. Renders as a left-aligned `Info`+text row in `--color-text-muted`.
- **Persisted (compact mode):** `<NoticeBlock content={…} defaultExpanded={false} />` — collapses to a small info-toned dot (`--color-severity-info` at 70% opacity, brightens on hover — blue in both light and dark themes). Hovering the dot exposes a 120-char preview via the native `title` attribute; clicking expands to the same `Info`+text row the live view used; clicking again collapses back.
- **Persisted (verbose mode):** `<NoticeBlock content={…} defaultExpanded={true} />` — stays expanded inline, matching the rest of verbose mode's surfaced meta. Clicking still toggles back to the collapsed dot.
- The swap from live row to persisted view happens when the chat detail query invalidates after stream `done` — `clearStreamingBlocks()` removes the live block on the next frame, and the now-saved `agent_transition` row renders via `NoticeBlock` with `defaultExpanded={verboseMode}`. The shared expanded styling means the verbose-mode swap is seamless; in compact mode the row collapses to a dot.
- **Warning tone** (`tone="warning"`): one non-interactive row, the same live and persisted, in compact and verbose mode alike — `AlertTriangle` + text in `--color-severity-warning-text` (not muted), `data-notice-tone="warning"`, no role (the transcript's one visually hidden `role="status"` region, `NoticeWarningAnnouncer`, present and empty from the start, reads each distinct live warning out once per chat and turn — never again on a re-render or remount). Its left inset is `pl-1`, so the triangle starts where an info dot does. No Show/Hide toggle and no dot, so a provider error or a silent turn stays readable after the turn ends. Two notices never merge live: the accumulator opens each notice part with `newPart: true`, so two in a row are two live blocks (and two rows), and `continuesPart` also splits on tone.
- Notices do not participate in the `CollapsibleGroup` run-merging used for `tool` / `tool_result` parts; each notice owns its own dot so the user can disambiguate individual notices when there are multiple in a turn.

### Verbose mode

- Verbose mode keeps the persisted notice row expanded inline (`defaultExpanded={true}` to `NoticeBlock`). Compact mode collapses an info notice to a dot; a warning notice stays expanded in both. Either way the live (streaming) view stays expanded.
- Notice rows do not carry a `MessageMetaFooter` (no timestamp / kind label) because they are not authored content.

### Legacy compatibility

- Earlier builds reserved `role: 'agent_transition'` but never wrote it. Any legacy rows that survived in user DBs from that period will now render with the same muted-system-message treatment.
- Agents that don't tag with `cinna.content_kind: 'notice'` continue to produce normal `text` parts on the assistant message — there is no heuristic fallback that promotes plain text to a notice.

## Architecture Overview

```
Cinna agent → A2A TextPart with cinna.content_kind=notice
  └─ Main: StreamPartsAccumulator.ingest()
       ├─ notice parts → notices Map (NOT parts[] / answer)
       └─ port.postMessage({type:'delta', kind:'notice', text})
            ↓
Renderer:
  useRunEventHandler → chat.store.appendDelta(text, 'notice')
    └─ streamingBlocks: TextBlock{ kind:'notice' }
         ↓
  MessageStream → NoticeBlock live (forced-expanded Info+text row)

Stream completes:
  Main: a2aStreamingService.streamToAgent
    ├─ for each notice → messageRepo.saveTransition()  (role='agent_transition')
    └─ messageRepo.saveAssistant() for the actual answer
         ↓
  Renderer: 'done' → invalidate ['chat', chatId] → clearStreamingBlocks
    └─ MessageStream renders agent_transition row via NoticeBlock
        defaultExpanded={verboseMode}
        (compact: collapsed info-tone dot; verbose: expanded Info+text row)
```

## Integration Points

- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — Owns the `cinna.content_kind` metadata contract, the per-part delta keying, and the accumulator that separates notices from message parts.
- [Messaging](../messaging/messaging.md) — Defines the `messages` table that backs `agent_transition` rows.
- [Conversation UI](../conversation_ui/conversation_ui.md) — Hosts the surrounding transcript renderer. `role: 'error'` rows render via the local `SystemMessage` (centred danger card); `agent_transition` rows render via `NoticeBlock` (left-aligned, info-tone dot or expanded Info+text row depending on verbose mode).
- [CLI Commands](../cli_commands/cli_commands.md) — Notices commonly precede `/run:*` CLI command output when the agent is bootstrapping its environment before executing the shell command.
