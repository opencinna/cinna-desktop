# Minimal View — Technical Details

## File Locations

Renderer only; no main, preload, IPC or database involvement.

- `src/renderer/src/stores/ui.store.ts` — `minimalView`, `setMinimalView`; `setActiveView` clears it for any view but chat; `selectSidebarVisible` is false while it is on.
- `src/renderer/src/hooks/useMinimalView.ts` — phases, frozen padding, auto-restore, key forwarding, `requestMinimalView`, `canEnterMinimalView`, `MINIMAL_TRANSITION_MS` (260).
- `src/renderer/src/hooks/useWipeGesture.ts` — wipe detector (pure step logic plus the pointer listener).
- `src/renderer/src/hooks/useOverscrollExit.ts` — double overscroll detector (`overscrollStep`, `scrolledToBottom`).
- `src/renderer/src/utils/minimalView.ts` — pure decisions: `cloudHasContent`, `minimalRefused`, `shouldRestoreMinimal`, `openTopLevelAskIds`, `isEditableTarget`, `shouldForwardKey`.
- `src/renderer/src/components/layout/MinimalRestoreButton.tsx` — the exit button.
- `src/renderer/src/components/layout/ChatWorkspace.tsx` — wires the hooks, the transcript-wide drop target and overlay, `data-minimal-phase` on the composer dock.
- `src/renderer/src/components/chat/ChatInput.tsx` — `minimal` prop (cloud classes on the same elements), `onCloudShownChange`, `focusAtEnd()`, `acceptsFileDrop()` and the drop entry on its imperative handle.
- `src/renderer/src/components/layout/InterfaceMenu.tsx`, `Sidebar.tsx` (`inert`, no peek), `TopBar.tsx` (controls `inert`), `App.tsx` (`data-minimal` on the shell root), `components/tasks/PendingHandoffControl.tsx` (`useChatHandoffPending`, read from the chat's own polled query), `components/chat/MessageStream.tsx` (`bottomPadding`, `pillBottom`, scroll box geometry), `components/chat/voice/VoiceInputButton.tsx` (marks `data-voice-recording`, read by the wipe).
- `src/renderer/src/assets/main.css` — `[data-minimal]`, `.composer-dock[data-minimal-phase]`, `.composer-cloud*`, `.minimal-restore`, reduced-motion and `data-motion-fade` fallbacks. The cloud's glass layer is a `::before` so text is not feathered with it, and `-webkit-backdrop-filter` stays first (see the lightningcss note in the CSS conventions).
- Tests beside each hook/util plus `ChatInput.minimal.test.tsx`, `ChatWorkspace.minimal.test.tsx`; `e2e/specs/minimal-view.spec.ts`.

## Tuning Constants

Exported from the hook that uses them. They were tuned on recorded real trackpad and mouse traces, committed as fixtures beside the hooks and replayed by the tests: `useWipeGesture.traces.json`, `useOverscrollExit.trace_a.json`, `_b.json`, `_c.json`. Change a constant only with a trace that shows the failure, and re-run the replay tests.

- Wipe (`useWipeGesture.ts`): `WIPE_MIN_STROKE_PX` 55 (recorded short strokes are only 80–90 px wide), `WIPE_REVERSAL_HYSTERESIS_PX` 12, `WIPE_MAX_VERTICAL_RATIO` 2, `WIPE_FLAT_TOLERANCE_RATIO` 0.1, `WIPE_STROKES_TO_FIRE` 6, `WIPE_WINDOW_MS` 1500, `WIPE_MAX_PAUSE_MS` 500. Real wipes are ~45° diagonals that overshoot above the composer and past the window edge; a gap between moves is not a break.
- Overscroll (`useOverscrollExit.ts`): `OVERSCROLL_ATTEMPT_GAP_MS` 28, `OVERSCROLL_ATTEMPT_MIN_DELTA` 20, `OVERSCROLL_WINDOW_MS` 1500, `OVERSCROLL_BOTTOM_SLACK_PX` 2. Momentum events are at most 12 ms apart; a second flick often starts 34–41 ms after the first one's last event.

## Behaviour Notes

- Phases advance on a `MINIMAL_TRANSITION_MS` timer; `useOverscrollExit` is enabled only in `cloud`, the wipe only in `full`.
- Baseline (`MinimalBaseline`) is captured at entry: open ask ids and handoff state. `shouldRestoreMinimal` compares against it on every chat-store change.
- A skill-link offer ends minimal view from outside this hook: `watchSkillLinkScreen` (`hooks/useSkillLinkIntents.ts`) subscribes to the offer store and calls `setMinimalView(false)` when an offer is raised or moved onto the composer on screen (`composerKeyOnScreen`). `shouldRestoreMinimal` and `MinimalBaseline` know nothing of it.
- Focus: entering focuses the cloud unless focus is already inside the chat area; an auto-restore with focus nowhere lands it in the composer.
- Key forwarding is a capture-phase `keydown` listener; it skips `defaultPrevented` events, editable targets and any open `OPEN_FLOATING_LAYER_SELECTOR` / `.app-modal-panel`.
- The drop target is the whole chat area while minimal view is on and the composer accepts files; drag depth is counted so child enter/leave pairs do not flicker the overlay.

## Testing

- `e2e/specs/minimal-view.spec.ts` — wipe entry, typing/sending/drop through the cloud, restore keeps the draft, Interface menu toggle. Selectors and the file-drop recipe are in `docs/development/e2e/e2e_llm.md`.
