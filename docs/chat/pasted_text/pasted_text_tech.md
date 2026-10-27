# Pasted Text — Technical Details

## File Locations

- Shared: `src/shared/pastedText.ts` — thresholds, `normalizePaste`, `shouldChipPaste`, `pasteBlock`, `withPastes`, `splitPastes`, `summarizeUserText`, `readableUserText` (exported and tested but called by nothing in app code), `typedText`, `pasteLabel`, `pasteSizeLabel`, `pasteSummary`; tests in `src/shared/pastedText.test.ts`.
- Shared: `src/shared/chatTitle.ts` (`deriveTitleFromMessage`) — typed text, else first paste's label.
- Main: `src/main/services/chatTitleService.ts` (`titleInput`) — what the title model reads.
- Renderer composer: `src/renderer/src/components/chat/ChatInput.tsx` (`takeTextPaste`, `handlePaste`, `handleKeyDown`, `handleInsertPaste`, `handleRemovePaste`), `src/renderer/src/components/chat/PasteBadge.tsx`, `src/renderer/src/components/chat/PastedTextPreviewModal.tsx`, `src/renderer/src/utils/composerPaste.ts` (`PASTE_TOO_LONG`), `src/renderer/src/stores/composerDraft.store.ts` (`pastes`), `src/renderer/src/hooks/useCacheExpiryNotice.ts`.
- Renderer transcript: `src/renderer/src/components/chat/MessageBubble.tsx` (`UserMessageContent`, `PasteCard`), `src/renderer/src/components/chat/useBubbleClamp.ts`.
- Renderer tasks: `src/renderer/src/components/tasks/TaskView.tsx`, `src/renderer/src/components/tasks/TaskFormDialog.tsx` (goal through `summarizeUserText`).
- Tests: `ChatInput.paste.test.tsx`, `ChatInput.pendingQueue.test.tsx` (recall, edit and held-restore chips), `MessageBubble.pastes.test.tsx`, `chatTitleService.test.ts`.
- Live: `e2e/specs/live-pasted-text.spec.ts` (billed, one turn) — a chipped 24-line delivery slip with an escaped closing tag, the agent asked for its ZIP code; passed on OpenCode, Claude, Codex and Antigravity on 2026-10-27, no agent mentioned the tags (Antigravity once its first-prompt credentials section became a pointer).

## Database Schema

None. `messages.content` holds the blocks verbatim; a paste is recognised from the text.

## IPC Channels

None added. The only IPC touched is the existing `window.api.files.clipboardHasFileRefs()`, asked only when a paste would chip and the clipboard also carries files (a Finder copy's names must not chip).

## Wire format

- Block: `<pasted_text lines="N">`, body, `</pasted_text>`; blocks joined by a blank line, then a blank line, then the typed text (which already carries any path-reference lines).
- Order on send: `withPastes(withPathRefs(typed, pathRefs), pastes)`.
- Escaping: in the body `<` + k backslashes + `/pasted_text>` is written with k+1 backslashes and read back with one removed.
- `splitPastes` shape rules: a block may start only at line 0 or after an empty line; opening tag matches an exact pattern with a positive integer; the first closing-tag line after it ends the block; the line after it must be empty or absent; body line count must equal `lines`. A failing candidate is plain text. A message with no closing tag is returned as one text segment without parsing. Text segments lose the separating blank lines and whitespace-only ones are dropped.
- Constants: `PASTE_CHIP_MIN_LINES` 20, `PASTE_CHIP_MIN_CHARS` 2,000, `PASTE_MAX_CHARS` 200,000, `PASTE_LABEL_MAX` 40.

## Composer behaviour

- `takeTextPaste` returns without acting for Cmd/Ctrl+Shift+V (a timestamp set in `handleKeyDown`, valid 1 s), a non-collapsed selection, or `findTriggerToken` at the caret.
- With files on the clipboard but attachments unavailable and `text/plain` present, it chips only if `pasteIntent` says the clipboard is text.
- Undo: `undoablePasteRef` holds the chip id and the textarea value at paste time. `handleKeyDown` clears it on every key except bare modifiers and the paste chord; `handleChange` clears it. Cmd/Ctrl+Z with the ref set and an unchanged textarea value removes the chip and prevents the default.
- The oversize error is `attachError === PASTE_TOO_LONG`; `clearPasteTooLong` clears only that value, on an accepted chip paste and in `handleRemovePaste` / `handleInsertPaste`.
- Run on its own: `autonomousRun.onStart` builds the goal with `withPastes(withPathRefs(input.trim(), pathRefs), pastes)` and records text, path and paste ids in `autonomousSourceRef`; `onStarted` removes exactly those.
- Recall: `pastesFromContent(content)` splits with `splitPastes` into fresh chips (new `newPasteId`) and `typedText`; a content with no block is returned unchanged. `recallHistory` sets `Recall.pasteIds` and writes text and chips in one draft update, replacing the previous entry's chips (by `pasteIds`) and keeping the draft's others. It continues only while the input equals `Recall.text` and `samePasteIds(pastes, pasteIds)`; with no active recall it starts only from an empty input and no chips, so a pastes-only entry (empty input) is told from the history's end by chip ids. Past the newest, the recalled chips are removed with the text. The vanished-edit effect sets `pasteIds: []` so the edit never matches the original and the arrows move the caret.
- Queue edit: `saveQueuedEdit` is allowed with chips alone and sends `withPastes(text, pastes)`; on success it removes the saved chips by id (a chip pasted during the save stays). Esc in edit mode sets the draft to `{ text: '', pastes: [] }`. Send-disabled in edit mode is `!input.trim() && pastes.length === 0`.
- Held restore: each taken item goes through `pastesFromContent`; the edited item is found by raw content, and when the edit stands (typed text or chips in the draft) its own chips are kept and the original's pastes are not re-added, otherwise the original's come back. Other items' chips are appended to the draft's. Blocks that sat between typed text in a merged item all come back as chips (order among chips preserved, ahead of the text on send).
- The send path clears the draft's `pastes` by id; `showStop` and the Send-disabled test count `pastes.length`.
- The draft field is `pastes` on `ComposerDraft`, defaulted to empty in `EMPTY_COMPOSER_DRAFT`; the preview id is cleared on chat/draft change and counts toward `composerBusy`.

## Renderer Components

- `PasteBadge` / `PasteBadgeList`: pill is a button; the X is a `span role=button` to avoid nested buttons.
- `PastedTextPreviewModal`: portal dialog on the glass modal shell (`app-modal-scrim`, `app-modal-panel`, `app-modal-well`), Escape or outside mousedown closes; `onInsert` and `onRemove` render their buttons only when given (the composer passes them, the transcript does not).
- `UserMessageContent` in `MessageBubble.tsx`: segments from `splitPastes`; text segments pass through `repairNestedFences`; a message with no block renders as before. `data-message-markdown` (the whole-message Copy source) sits on the content box and holds the readable text.
- `useBubbleClamp`: `BUBBLE_CLAMP_PX` 300, `BUBBLE_CLAMP_SLACK_PX` 80, `BUBBLE_CLAMP_TRANSITION_MS` 300. Height measured in a layout effect and by `ResizeObserver`. Expanding first calls `leaveBottom(container)` from `useStickToBottom` on the nearest scrolling ancestor and `holdAnchor` on the box, then animates `max-height` to the measured height and then drops the limit on `transitionend` (a timer covers no transition). Collapsing from the dropped limit first pins the measured height so the transition runs, and uses `holdAnchor` / `collapseMinOffset` from `transcriptAnchor`. Expanded state is `useTranscriptDisclosure`.

## Titles and summaries

- `deriveTitleFromMessage`: typed text; path-reference handling next; with no typed text and a paste, `pasteLabel` of the first paste.
- `titleInput`: `summarizeUserText`; if nothing was typed, appended with "The first paste begins:" and the first 1,000 characters of the first paste. The untouched-title comparison in `autoGenerateForFirstMessage` still uses the raw text.
- `summarizeUserText` is also applied to a task goal in both task surfaces.

## Configuration / Security

No settings. The model receives the pasted text as part of the user message, with no instruction wrapper, so a paste can contain anything a typed message can; the tag is a display convention, not a trust boundary. The strict block shape and escaping exist so a message cannot hide text from the reader or end a block early, not to protect the model.

## Known gaps

- The Edit menu role `pasteAndMatchStyle` in `src/main/index.ts` is what delivers Cmd+Shift+V to the inline path; it has been checked in unit tests only, not with real keystrokes in the built app.
