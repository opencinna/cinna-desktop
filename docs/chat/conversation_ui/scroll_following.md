# Transcript Scrolling

## Purpose

The chat transcript follows the bottom of the conversation while a reply streams in, and stops following the moment the user scrolls away from it. Reading back through an answer while the agent is still writing must be possible, and nothing the stream does may move the view under the user's hands.

## Core Concepts

- **Pinned / unpinned** — the one piece of state. While *pinned*, the view is held at the bottom as the content grows; while *unpinned* it stays exactly where the user left it, whatever arrives. The user's own scrolling is the only thing that changes it (plus sending, and opening another chat — both below). An arriving chunk never re-pins.
- **The bottom band** — 64 px. Both the definition of "at the bottom" and the width of the zone in which the user still counts as following. Wide enough that a sub-pixel `scrollHeight` rounding or the last line of a growing paragraph does not silently unpin; narrow enough that one deliberate wheel notch does.
- **Sticking** — how following is implemented: an immediate assignment of the scroll position, performed after layout and before paint, in response to the content resizing. It is not an animation and not a per-render effect.
- **Wheel suspension** — a short window (150 ms) opened by an upward wheel or trackpad gesture during which sticking does not run, so a chunk landing mid-gesture cannot pull the view back out from under it.
- **Jump to latest** — the pill shown while unpinned, centred just above the composer. Clicking it re-pins and jumps to the bottom. It is the only way back other than scrolling there.

## User Flows

1. **Sending.** The user submits a message; the view re-engages following and jumps to the bottom. The user just acted, and the thing they acted on is at the bottom.
2. **Watching a reply.** Text, thinking blocks, tool results and tables arrive; the view stays at the bottom with no visible movement other than the content itself growing. Blocks that reflow without a re-render (a code block laying out, a collapsible opening, a partial markdown table becoming a real one) are followed too.
3. **Reading back mid-stream.** The user scrolls up. Following stops, the "Jump to latest" pill appears, and the position holds for the rest of the turn.
4. **Coming back.** The user scrolls to within the bottom band, or clicks the pill. Following resumes mid-stream and the pill disappears.
5. **Switching chats.** Opening a different chat starts at that chat's latest message, whatever the previous chat's scroll position was. Scroll position is not remembered per chat.
6. **The viewport changing underneath.** The window is resized, or the composer grows a line and the transcript's bottom padding grows with it. A pinned view stays at the bottom; it does not leave the newest line drifting under the composer.

## Rules

Each rule below exists because of a specific way the transcript misbehaved.

- **Following never animates.** The previous implementation smooth-scrolled to a bottom marker from an effect keyed on the streaming state. Every delta produced a new streaming-blocks array identity, so a fast stream started a fresh several-hundred-millisecond animation many times a second, each interrupting the last. At the chunk rate of a local engine printing a table, that reads as the window shaking. Sticking is instantaneous and happens before paint, so the bottom of the content is simply where it always was — there is no intermediate frame to see.
- **An arriving chunk never re-pins.** The old effect had no notion of where the user was and scrolled unconditionally, so reading back through a long answer meant being dragged to the bottom again on the next chunk. Only the user re-pins: by scrolling into the band, by clicking the pill, or by sending.
- **Unpinning requires the view to have actually moved up** — by more than a 4 px slack. Distance from the bottom is not enough on its own. A stick queues a scroll event that is not dispatched until the next frame, by which time React may have committed another chunk; a handler that judged on distance alone would measure that growth as distance the user never opened up. A chunk tall enough to clear the band in one frame (a table gaining rows, the hand-off from streaming blocks to the persisted message) would then stop the stream following, mid-stream, for no reason the user could see. Scrolling up is the one thing that decreases the scroll position; content growing never does.
- **A wheel gesture suspends sticking on a timer, not on a frame.** Within one rendering opportunity, scroll steps run before animation-frame callbacks, which run before resize-observer steps — so a suspension released from an animation frame is already gone when the observer it was meant to hold off runs. Worse, a wheel handled off the main thread need not have reached the scroll position by that frame, so releasing there can read the pre-gesture position, conclude nothing moved, and stick: the "cannot scroll up" symptom, one frame later. A window measured in milliseconds outlives both, and costs nothing — if the gesture really did scroll the transcript, the scroll event unpins on its own; if it did not, following resumes when the window closes.
- **A gesture only extends its own suspension.** A wheel arriving while a suspension is open refreshes it only if the container has actually moved since the suspension opened. `wheel` bubbles, and the transcript is full of nested scrollers (a tool result's capped body, a patch block, a command result), so unconditional refreshing would let a gesture swallowed by one of those freeze the transcript for as long as the user kept scrolling — and then take the whole catch-up in a single jump. Declining to extend turns that into a series of pauses no one can see.
- **Suspension is not the same state as unpinned.** A wheel too small to leave the bottom band must not flash the pill, and a gesture that turns out to belong to a nested scroller must leave the pinned state exactly as it found it.
- **A deliberate jump cancels any open suspension.** The suspension exists to protect a gesture in flight, and clicking "Jump to latest" or opening another chat supersedes one. A suspension carried across a chat switch would open the new transcript at the top and then jump it to the bottom when the timer fired — the movement the whole model exists to avoid, on the one screen where the user has done nothing yet.
- **A transcript too short to scroll stays pinned.** There is nowhere to scroll to, so there is nothing to offer a way back from, and the pill never appears.
- **Shrinking content re-evaluates the pin.** Content getting shorter — a collapsible closing, a long tool result collapsing at the persisted hand-off — can put the view back inside the band without the scroll position moving at all, so no scroll event fires. Without a re-check the pill would linger a few pixels from the bottom. This can only ever re-pin: a resize never moves the view up.

## Why the window shook: two independent causes

The reported symptom — a local agent streaming a long markdown table, the chat "shaky", scrolling up impossible — had two causes, and fixing either one alone leaves it visible.

1. **The scroll effect**, above: an interrupted smooth animation restarted per delta, and restarted regardless of where the user was.
2. **The table's own box.** A table is the one markdown block sized by its content rather than by its container. The transcript scrolls vertically, and CSS resolves the other axis to `auto` when one axis is not `visible`, so a wide table made the whole message list horizontally scrollable. Because the app styles the scrollbar pseudo-element — which opts Chrome out of overlay scrollbars — that horizontal bar took real layout height, appearing and vanishing as the streaming table's columns resettled, and the vertical viewport changed height with it on every chunk. Markdown tables are now their own scroll box, sized to their content but never wider than the bubble, and the styled scrollbar declares a horizontal thickness to match the vertical one so any bar that does appear costs 6 px instead of Chrome's default 15. A table whose cells can wrap squashes to the bubble width and never reaches a scrollbar at all; only unbreakable content does.

## Deliberately not

- **No smooth scrolling anywhere in the transcript**, at any moment. There is no "gentle" variant held in reserve — the animation *was* the bug.
- **No remembered scroll position.** Chat switches land at the bottom; there is no "continue where you left off", and no per-message read anchor.
- **No auto-scroll to anything but the bottom.** Nothing scrolls a specific message into view.
- **The composer's height belongs to `MainArea`**, which measures it and passes it down as the transcript's bottom padding and the pill's offset. The scroll model only reacts to that padding changing.
- **Nested scrollers own their own scrolling.** The transcript neither delegates to them nor takes wheel events from them; it only declines to treat their gestures as its own.
- **The transcript is not the only scroller in the app**, but it is the only one that follows. The scrollbar thickness rule is global; the following behaviour is not.

## Architecture Overview

```
MainArea (relative container, owns composer height)
  ├── MessageStream  ──uses──>  useStickToBottom(chatId)
  │      scroll container (ref) ── ResizeObserver ──> stick (instant, pre-paint)
  │      content box (ref)      ── scroll / wheel  ──> pinned / unpinned
  └── "Jump to latest" pill (rendered while unpinned, offset by composer height)
```

## Integration Points

- [Conversation UI](conversation_ui.md) — what is being scrolled: bubbles, disclosure blocks, tool calls
- [Transcript Scrolling — Technical Details](scroll_following_tech.md)
- [Messaging](../messaging/messaging.md) — the streaming pipeline whose chunk rate this model is built to survive
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — rule 1, nothing jumps while the user is acting
