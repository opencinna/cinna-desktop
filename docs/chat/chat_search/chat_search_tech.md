# Chat Search — Technical Details

## IPC

| Channel | API | Notes |
|---|---|---|
| `chat:search` | `window.api.chat.search(query, filter?)` → `ChatSearchResult` | Requires activation; the profile is resolved in the handler (`getProfileScopeUserId`). Not polled. |

Types and limits live in `src/shared/chatSearch.ts`: `CHAT_SEARCH_PER_CHAT` (3), `CHAT_SEARCH_CHAT_LIMIT` (50), `CHAT_SEARCH_MAX_QUERY` (200), `ChatSearchGroup` (`chatId`, `title`, `total`, `latestAt`, up to 3 `messages` newest first), `ChatSearchResult` (`groups`, `truncated`), `ChatSearchFilter` (`agentIds`, `modeIds`, `none`), `chatSearchFilterOf` (renderer who-keys `agent:<id>` / `mode:<id>` / `none` to a filter; undefined for none pressed).

## Main

- `chatService.search(userId, query, filter)` validates both (a bad filter throws `ChatError('invalid_value')`; an empty filter limits nothing), trims and cuts the query, returns empty for blank. With a filter it builds the chat ids from `buildChatListSummaries` — the same `with` the Chats list groups by, so a conductor-bound chat counts as its mode, not its runtime — and an empty set returns at once. It then asks for `chatLimit + 1` groups: the extra one only sets `truncated`.
- `chatRepo.searchMessages(owners, query, { perChat, chatLimit, chatIds })` (`src/main/db/chats.ts`): one grouped query (count, max `createdAt`, ordered newest match first) over `listedChats(owners)` joined to messages with role in user/assistant and a content test, then one query per returned chat for its newest matches. The test depends on the query's length in code points. From 3 (`SEARCH_INDEX_MIN_CHARS`) it is `messages.rowid IN (SELECT rowid FROM messages_search WHERE messages_search MATCH ?)`, the query quoted as one FTS5 phrase (`"` doubled) so operators and `%`, `_`, `\` are taken literally. `messages_search` is a contentless FTS5 trigram index (`case_sensitive 0`: Unicode case folding, diacritics kept, so `привет` finds `Привет` and `ecole` does not find `École`, as in the renderer), created by `migrateMessagesSearch` (`src/main/db/migrations/messages-search.ts`) with insert, delete and update triggers keyed on `messages.rowid`; the table, the triggers and the one-time backfill of existing messages run in one transaction at boot (about 1.6 s per 33 MB of indexed text, blocking startup once), so a crash mid-backfill leaves no half-built index. The index takes about three times the indexed text on disk. A query holding a NUL returns nothing (FTS5 rejects it in a phrase). Shorter queries have no trigram to look up: the test is the SQL function `cinna_contains_folded(content, lowercasedQuery)` (`src/main/db/searchFunctions.ts`, registered on the connection by `initDatabase`), which reads every user/assistant row of the listed chats synchronously on the main thread.
- The filter is applied in main so a pressed agent's chats beyond the newest 50 are found; filtering the renderer's 50 would have hidden them.

## Renderer

All under `src/renderer/src/components/chat/search/` unless noted.

| File | Role |
|---|---|
| `src/renderer/src/stores/chatSearch.store.ts` | One store per window: `scope`, `query`, `agents` (who-keys), `focusNonce` (re-focus and select on every open), `searchableChatId` (set by the chat view's `MessageStream`; `open('chat')` becomes `'all'` without one), `jump` (a result picked in All chats, with a `nonce` so the same message picked twice is two jumps). Remembers the focused element at open and restores it on a plain close (Esc, close button, scrim), else the composer; a pick closes through `closeForPick`, which restores nothing, and the transcript focuses the opened chat's composer (`focusChatComposer`) once the jump fires. A jump waiting for a different chat is dropped when another transcript mounts, and any unfired jump expires after `CHAT_SEARCH_JUMP_TTL_MS` (5 s), so a chat that takes longer to load opens without the scroll. |
| `useChatSearchShortcut.ts` | Capturing `keydown` on `window`, mounted once in `App.tsx`'s `Shell`: ⌘/Ctrl+F, and Esc when focus is outside the field. `modalOpen` checks `[aria-modal]`, dialog roles and `.app-modal-scrim`, skipping the search's own `[data-chat-search]`. In the renderer rather than the app menu: the app has no Find item and whether a chat is on screen is renderer knowledge. |
| `useSearchPause.ts` | `SEARCH_PAUSE_MS` = 300; returns `applied`, `pending`, `flush`. |
| `ChatSearchBar.tsx` | The pill: icon, input (a combobox over the listbox), count slot of fixed width per scope (72 in chat, 104 in all), scope switch, close. |
| `ChatSearchInChat.tsx` | Chat scope. Matches over `chatData.messages` already loaded (`searchChatMessages`), cards limited to `CHAT_SEARCH_CARD_LIMIT` (30), paints `HIGHLIGHT.all` over every match. Mounted by `MessageStream` in place of `TranscriptPills` while the scope is `chat`; positioned at `pillBottom ?? searchBottom ?? …`. |
| `AllChatsSearch.tsx` | Mounted in `Shell`. Two TanStack queries: `['chat-search', q]` (unfiltered; feeds chips and their counts) and `['chat-search', q, filterKey]` (enabled only with chips pressed; its placeholder is the unfiltered result narrowed to the pressed keys, shown as pending). `keepPreviousData` keeps old results drawn while pending. Who each chat is comes from `chatWho` (`chatGroups.ts`) over the list, summaries, agents and modes. Left edge is measured from the docked sidebar's box. |
| `SearchResultList.tsx` | Listbox plus dot rail; `railLayout` (pitch ≤ 9 px, one extra pitch per chat break, break dropped below pitch 4). Keyed by the results so a new set starts scrolled to the bottom, nearest the bar. |
| `SearchHitCard.tsx` | One result: header and a `MarkdownContent` snippet (exported from `MessageBubble.tsx` for this) with `snippetMarkdown` (pastes and attach tags removed), highlight via `HIGHLIGHT.snippet`. |
| `chatSearchText.ts` | `countMatches`, `searchChatMessages`, `searchTimeLabel`, `textRanges` (skips text inside `button, svg`), the highlight registry wrapper and the three highlight names. |
| `jumpToMessage.ts` | Finds the message's rendered nodes by `data-message-id`, scrolls its first range to 40 % of the viewport (smooth), calls `leaveBottom`, marks `HIGHLIGHT.current` for 1.8 s and replays the `chat-search-flash` animation on the enclosing block. |

Other touched files: `MessageBubble.tsx` puts `data-message-id` on the user bubble (assistant bodies already carried it); `MessageStream.tsx` takes `searchable` and `searchBottom`, reports `searchableChatId`, and fires a pending jump on a double animation frame once the chat's messages are loaded; `ChatWorkspace.tsx` measures how far the composer's drawn content reaches (`ResizeObserver` on the composer and the chat area) so the bar follows the notice panel, and passes `searchable={!embedded && !hosted}`; `ChatList.tsx` has `SearchChatsButton` beside `GroupChatsMenu`; `main.css` holds the `chat-search-*` rules and `::highlight(chat-search-all | -current | -snippet)`.

## Rules that are easy to break

- Never add `mask-image` to `.chat-search-list` or any ancestor of the cards (see the doc: backdrop root). `backdrop-filter` rules follow the project's order (`-webkit-` first).
- Count slots keep fixed pixel widths; do not make the count `auto`.
- Results shown must carry the query they were fetched for (`FetchedSearch.query`): snippets and a pick use it, not the field's current text, or a stale result would highlight and jump to something else.
- Every write to `messages` is a plain INSERT / UPDATE / DELETE. `INSERT OR REPLACE` deletes the old row without firing the delete trigger (no `recursive_triggers`) and leaves a stale index row. A create-copy-drop-rename rebuild of `messages` drops the triggers and renumbers rowids, and `VACUUM` can renumber them too (the rowids are implicit); either makes the index point at the wrong messages without an error. Such a change must drop `messages_search` so the migration rebuilds it. `migrateMessagesSearch` therefore runs last in `runAllMigrations`, after every migration that alters `messages`.
- A new database handle (tests included) must call `registerSearchFunctions`, or a 1-2 character query fails with `no such function`.
- Any new read of `chatData.messages` for search must stay on user/assistant roles; main and renderer must agree on what is searchable.

## Tests

`chatService.search.test.ts` (scope, literal special characters, filter, truncation, Unicode case folding on both paths, the index through insert / draft rewrite / delete / chat cascade, roles never indexed, backfill and rerun), `AllChatsSearch.test.tsx`, `MessageStream.search.test.tsx`, `ChatList.search.test.tsx`, `SearchResultList.test.ts`, `chatSearchText.test.ts`. jsdom lacks the Highlight API, so painting is guarded and not asserted there.
