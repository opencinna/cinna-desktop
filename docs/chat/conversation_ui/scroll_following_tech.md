# Transcript Scrolling — Technical Details

## File Locations

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/hooks/useStickToBottom.ts` | The whole model. `useStickToBottom(resetKey?)` returns `{ containerRef, contentRef, pinned, scrollToBottom }`. Owns the pinned state, the `ResizeObserver` that sticks, the `scroll` / `wheel` listeners that decide pinned-ness, and the reset on `resetKey`. Generic over the transcript — it knows nothing about chats, messages or streaming. |
| `src/renderer/src/hooks/useStickToBottom.test.tsx` | Unit tests (Vitest + Testing Library). jsdom has neither layout nor `ResizeObserver`, so the harness supplies both: a stub observer whose callback the test fires by hand (standing in for "a chunk arrived and the transcript got taller"), and `scrollHeight` / `clientHeight` / `scrollTop` defined on the element, because jsdom's own `scrollTop` setter is a no-op that always reads 0. The harness clamps writes to `[0, scrollHeight - clientHeight]` at **both** ends — without the lower bound it cannot represent a transcript shorter than its viewport, where sticking would write a negative position no browser ever produces. |
| `src/renderer/src/components/chat/MessageStream.tsx` | Consumes the hook: `containerRef` on the scrolling `div`, `contentRef` on the centred message column, and the "Jump to latest" pill rendered while `!pinned`. |
| `src/renderer/src/components/layout/MainArea.tsx` | Owns the `relative` chat container the pill is positioned against and measures the composer, passing its height to `MessageStream` as `bottomPadding`. |
| `src/renderer/src/assets/main.css` | `::-webkit-scrollbar` (`height: 6px`) and `.markdown-body table` (`display: block; width: max-content; max-width: 100%; overflow: auto`) — the second, layout half of the shaking bug. |

## Constants

| Constant | Value | What it decides |
|----------|-------|-----------------|
| `BOTTOM_THRESHOLD_PX` | 64 | How close to the bottom counts as at it. Distance is measured as `scrollHeight - scrollTop - clientHeight`. |
| `WHEEL_SUSPEND_MS` | 150 | How long an upward wheel suspends sticking. Milliseconds rather than a frame — see the ordering note below. |
| `MOVED_UP_SLACK_PX` | 4 | How far the position must fall before that counts as the user leaving. Larger than device-pixel rounding, so a trackpad tremor or a scroll-anchoring adjustment landing in the same frame as a chunk cannot unpin. |

## How it is wired

- **State and its mirror.** `pinned` is React state (the pill renders off it) mirrored into `pinnedRef`, because the observer and the listeners are registered once and would otherwise close over a stale value.
- **`stick()`** assigns `scrollTop = scrollHeight` (the browser clamps) and records the result in `lastTopRef`. `lastTopRef` is what lets a later `scroll` event tell "the user moved the view" from "we put it there".
- **`settle()`** is the only writer of the pinned state, and reads live DOM geometry rather than anything remembered. Inside the band → pinned. Outside it → unpinned **only if** the position fell by more than `MOVED_UP_SLACK_PX` since the last reading.
- **`ResizeObserver`** observes both `contentRef` and `containerRef`, both in the default content box. The content element grows with the transcript; the container is what changes when the window resizes or the composer's height (and therefore the scroller's bottom padding) changes — which never resizes the content, so observing that alone left the newest line drifting under the composer. Pinned → `stick()` unless a suspension is open; unpinned → `settle()`, which under the moved-up rule can only ever re-pin.
- **`scroll` and `wheel`** are both registered `passive` on the container. `scroll` calls `settle()`. `wheel` ignores downward deltas; an upward one opens a suspension, recording the container position at the time (`suspendTopRef`). A wheel arriving while a suspension is open re-arms it **only** if `scrollTop` differs from that recorded position — a gesture swallowed by a nested scroller (a tool result's `max-h-96 overflow-y-auto`, a patch block, a command result) never moves this container, so it cannot hold the suspension open indefinitely.
- **When the suspension expires** the timer calls `settle()` first and then `stick()` if still pinned: whatever arrived during the window was not stuck to, so a pinned transcript is behind the bottom by then.
- **`releaseSuspension()`** clears the timer *and* the flag. Called by `scrollToBottom()`, by the `resetKey` layout effect, and by the listener cleanup — dropping the timer alone would leave a suspension nothing is left to lift, and sticking would never resume.
- **`resetKey`** (the chat id) runs in a `useLayoutEffect`: release, pin, stick. It also runs on mount, which is what makes a freshly opened chat start at its latest message.
- The suspension is deliberately **its own ref, never the pinned state**. Writing the state there would flash the pill for any wheel too small to leave the band; writing `pinnedRef` would destroy the value that has to survive a gesture belonging to a nested scroller.

### Event-ordering note

Within one rendering opportunity the browser runs: scroll steps → `requestAnimationFrame` callbacks → **resize-observer steps** → paint. Two consequences the model is built around:

- A suspension released from a `requestAnimationFrame` callback is already gone when the observer step it was meant to hold off runs, and a wheel handled off the main thread may not have reached `scrollTop` by that callback at all. Hence a timer, not a frame.
- The `scroll` event that `stick()`'s assignment queues is not dispatched until the *next* frame's scroll steps, by which time React may have committed another chunk. Hence unpinning on a decrease in `scrollTop`, not on distance.

## Renderer Components

- `src/renderer/src/components/chat/MessageStream.tsx` — returns a fragment, not a wrapper: the pill is absolutely positioned against `MainArea`'s `relative` chat container (the same one the composer overlay anchors to), so it needs no layout box of its own and the scroll element stays the direct flex child it has always been.
- The pill: an `ArrowDown` icon plus the text `Jump to latest`, which is also its accessible name — it deliberately carries no `aria-label` or `title` restating that (a native tooltip repeating the visible label is what UX rule 7 rules out). Centred with `left-1/2 -translate-x-1/2`, `z-10`, and `bottom: max(0, bottomPadding - 8)`, which tracks the composer at whatever height it has grown to and sits low enough to straddle its fade band — clear of the band it covered about twenty characters of fully legible prose.
- Sending re-engages following through an effect on `pendingUserMessage` (from `src/renderer/src/stores/chat.store.ts`) calling `scrollToBottom()`. That effect replaced the previous one keyed on `chatData?.messages` and `streamingBlocks` — `appendDelta` copies the streaming-blocks array on every delta, so the old dependency changed identity many times a second.

## CSS

Both rules live in `@layer base` in `src/renderer/src/assets/main.css`:

- `::-webkit-scrollbar` now declares `height: 6px` alongside `width: 6px`. `height` is the horizontal bar's thickness; styling this pseudo-element at all opts Chrome out of overlay scrollbars, so an *unstyled* horizontal bar claimed Chrome's default 15px of layout. This rule is global — every scroller in the app, not only the transcript.
- `.markdown-body table` replaced `overflow: hidden` with `display: block; width: max-content; max-width: 100%; overflow: auto`. `display: block` gives the table its own box, `max-content` keeps a narrow table narrow (a block would otherwise stretch to full width), `max-width: 100%` stops it widening the transcript, and `overflow: auto` scrolls what still does not fit while clipping to the rounded corners the previous `hidden` was there for. A table whose cells can wrap squashes to the bubble width and wraps; only unbreakable content reaches the inner scrollbar.

## Tests

`npx vitest run src/renderer/src/hooks/useStickToBottom.test.tsx` — 12 cases, one per rule: following while pinned; not being dragged back after scrolling up; not sticking mid-gesture; re-pinning on a scroll back into the band; the on-demand jump; staying pinned when a chunk lands between a stick and the scroll event it queued; a slow trackpad drag escaping instead of being reset by every chunk; a transcript too short to scroll never unpinning; a swallowed gesture not freezing the transcript; the pill dropping when shrinking content puts the view back at the bottom; a suspension not carrying across a chat switch; and following surviving an upward wheel swallowed by a nested scroller.

There is no E2E coverage: the behaviour is frame- and timer-ordering sensitive, and the unit harness can drive the observer and the clock directly, which a real window cannot be asked to do deterministically.

## See Also

- [Transcript Scrolling](scroll_following.md) — the rules and the failures behind them
- [Conversation UI tech](conversation_ui_tech.md) — what `MessageStream` renders inside the scroll container
