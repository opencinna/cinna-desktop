# Agent runtime review fixes — 2026-09-12

The review against `a39e786` identified eight high and twelve medium findings. All twenty are addressed in this follow-up, together with the confirmed runtime admission stall, dead code and inaccurate completion/documentation claims. The original review remains local historical evidence in `drafts/agent_runtime/POST_REVIEW.md`.

## Resolution map

| Finding | Result |
|---|---|
| H1 | Managed continuation reconciles remote status and history before deciding whether a checkpoint can resume, including previous interruption, uncertainty and budget checkpoints. |
| H2 | Soft-deleted scheduled tasks no longer block overlap indefinitely; occurrence reconciliation cancels abandoned occurrences while respecting a still-live runner. |
| H3 | Peer edits preserve the claimed run's artifacts and budget. |
| H4 | App-sync and remote polling coalesce duplicate replicas by a deterministic local-ID order, remap references and propagate duplicate tombstones. Two-device tests cover delayed updates and child references. |
| H5 | Saved and live tool parts merge by stable tool identity across permission blocks. |
| H6 | Listing schedules is read-only. Scheduler reconciliation distinguishes confirmed definition changes from transient folder failures. |
| H7 | Legacy SSE uses the OAuth provider and callback flow; transport selection remains visible in settings. |
| H8 | ACP failure handling collects bounded stderr after disposal. Startup timeout tests no longer require child startup to beat a short deadline; a separate real-child test checks termination diagnostics. |
| M1 | MCP calls share the per-provider queue, preventing concurrent refreshes from consuming the same rotating token. |
| M2 | A2A Stop briefly waits for cancellation confirmation and persists a notice when remote cancellation is unconfirmed. |
| M3 | The common contract requires parked-input cases when advertised capabilities support reply resumption. |
| M4 | Managed text and parts both ignore output after stopping. |
| M5 | An active run keeps request polling enabled even when live replay overflows. |
| M6 | Watch delivery failure attempts a small error envelope; the renderer degrades to saved-message polling with an explanation. |
| M7 | Watch admission checks chat ownership once; streamed messages continue to check the active profile without per-delta chat queries. |
| M8 | Unsupported engines report invalid readiness and remain explicit in runtime settings. |
| M9 | MCP client registrations are encrypted with safeStorage, including migration of existing plaintext registrations. |
| M10 | Inbox agent lookup falls back to the local agent scope. |
| M11 | Sync captures its watermark before network work and overlaps the timestamp boundary so mid-cycle and same-second writes are retained. |
| M12 | OAuth reuses registered callback ports, allows ten minutes for consent, and leaves legitimate authorization pending after an invalid callback. An occupied registered port triggers fresh registration. |

Runtime admission now waits for an agent's turn lock before taking a global execution slot, then rechecks the lock after admission. A regression test covers two busy agents without starving a third.

Unused driver response hooks, pending-request removal, unsupported token counters, remote-work/count seams, driver ID exports and unused ACP metadata translations were removed. Custom readiness caching is bounded, the stale routing ratchet exception is gone, and the coordinator tool schema no longer advertises an ignored status update. Technical documentation and the [completion record](agent_runtime.md) now distinguish implementation history, retained policy branches and actual validation scope.

## Validation

- Final full unit suite: **3,824 passed, six skipped, 230 files**. The six skips are the existing inapplicable A2A local-park cases.
- Final `npm run typecheck` and production build: clean.
- A broad offline Electron run covered 43 of 44 specs: **78 passed, seven failed, three skipped**. Its seven failures were corrected: cancellation-notice timing, Managed recovery wording and logger fixtures without an agent root.
- The final built Electron rerun covered ten affected specs: **19/19 passed**, including every previously failing test, task sync, handoff, live attachment, runtime selection and MCP connection settings.
- `git diff --check`: clean.

The broad Electron selection was not rerun in full after those fixes. Live model cases were skipped and the live Cinna integration spec was excluded. Managed and OAuth validation used controlled peers; no live Managed account or SSH host was exercised. ACP session relaunch has unit/peer coverage, not an Electron relaunch test.

## Unreproduced observations

The review's script step left waiting after all requests disappear still has no demonstrated reachable path. The ACP pool's joined acquisition inheriting its first caller's abort signal remains unreachable under the existing per-agent turn lock. Neither speculative path was changed. These observations are separate from the twenty resolved high/medium findings.
