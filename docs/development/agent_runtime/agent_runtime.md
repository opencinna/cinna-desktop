# Agent Runtime Architecture and Completion Record

## Current architecture

Main owns execution, persistence and cancellation. The renderer submits `run:start` and independently attaches with `run:watch`; navigation or renderer reload does not cancel the run. `liveRunHub` retains bounded sequenced replay in process memory for active runs. Transcript persistence and durable Task/Inbox checkpoints are separate; the event cache is not a durable event log. The lower-level `run:send` MessagePort API remains available through the same executor. The retired agent/model-specific preload send methods and IPC forwards are removed.

Seven supported external agent forms use three AgentDriver implementations:

| Agent form | Driver | Runtime selection |
|---|---|---|
| Hand-added A2A | a2a | Tested card/endpoint and optional stored token |
| Cinna-synced | a2a | Cinna endpoint and account credential |
| OpenCode folder | acp | Fresh folder launcher |
| Claude Code folder | acp | Fresh folder launcher |
| Codex folder | acp | Fresh folder launcher through the pinned app-server adapter |
| Custom command, including SSH | acp | Captured owned executable/argv and runtime binding |
| Claude Managed | managed | Bound API credential, agent and environment |

A local LLM coordinator uses the model/tool execution path, separately from AgentDriver. Direct, human, coordinator and script execution share the main run boundary. Source identifies ownership; the explicit stored driver identifies transport. Unsupported or null driver IDs remain visible and refuse execution; migration backfills alone recognize historical missing values.

`agentSessionRepo` is the sole repository export. The physical `a2a_sessions` table and its columns remain unchanged, preserving stored sessions without a cosmetic SQLite migration. `chats.orchestrated` and the former agentTurn service directory are removed. Authored folder runtime choices remain; one ACP driver selects the fresh launcher.

See [Agent Drivers](../../agents/drivers/drivers.md), [technical dispatch and capabilities](../../agents/drivers/drivers_tech.md), [live attachment](../../chat/messaging/live_runs.md), [Tasks and Inbox](../../jobs/tasks/tasks.md), [Managed Agents](../../agents/managed_agents/managed_agents.md) and [Command-line Agents](../../agents/custom_agents/custom_agents.md).

## Measured implementation history

The runtime work progressed through unified events, driver extraction, ACP replacement, routing, Tasks/Inbox, autonomous execution and final cleanup. Phase 5 closed at `b15e569`, phase 6 at `aefc1ae`; phase 7 includes compatibility `0e053f3`, status/tool contracts `4f48f4c`, Job execution `8e7fafa`, MCP/native OAuth `81c78ae`, async answers `1d44041`, Managed `f6772cd` and custom ACP `0bb4663`. This revision completes the validated cleanup.

| Metric | Phase 5 | Phase 6 | Final phase 7 source |
|---|---|---|---|
| Run event vocabularies | 1 | 1 | 1; watch envelopes carry the same events |
| Behavioral ratchet limit | 78 | 79 | 0 |
| Counted source / kind / Job / provider branches | 4 / 42 / 29 / 3 | 4 / 42 / 30 / 3 | 0 / 0 / 0 / 0 |
| Counted engine / routing / remote-adapter branches | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Old agentTurn service files / lines | 5 / 994 | 5 / 994 | 0 / 0 |
| Driver files / lines | 16 / 5,362 | 17 / 5,420 | 31 / 7,201 |
| Engine helper files / lines | 7 / 2,012 | 7 / 2,012 | 7 / 2,012 |
| Driver implementations / external forms | 2 / 4 | 2 / 4 | 3 / 6 |
| Chat execution shapes | 3 | 3 | 3 |
| Full suite passed / skipped / files | 3,326 / 6 / 195 | 3,590 / 6 / 212 | 3,812 / 6 / 225 |

Line counts include non-test TS/TSX files, excluding golden and snapshot directories. Historical branch counts use each revision's own ratchet scanner. The final scanner has seven categories at exact zero, with **98 separately pinned ownership/authoring/presentation comparisons** and **26 allowlisted transport/sync comparisons**. This is zero unpinned comparisons, not zero execution branches: `jobDefinitionPolicy` still selects an executor from `job.type`.

The final full suite passed in **84.69 s**, with typechecks and production build clean. It includes migrations **25**, ratchet **5**, Managed contract **16**, custom ACP contract **25** and custom service **18** passing cases. The six A2A skips are inapplicable local-park clauses for a next-message protocol; they are not known failures. ACP, custom and Managed have no common-contract known violations. Driver tests cover results, cancellation, quietness, continuity and parked replies; the main wrappers own root request IDs and terminal delivery.

The selected built Electron regression passed **16/16 across eight of 44 specs in 66.8 s**: smoke 2, folder-agent 3, agent-permissions 1, human-routing 1, Inbox 1, autonomous-task 2, IPC wire 4 and custom ACP 2. A subsequent post-completion review identified recovery and sync defects; the follow-up fixes and validation are recorded below. The only final test-count reduction from the preceding custom full suite is intentional: two retired forward cases became one absence assertion. Phase 6's full suite preceded its final duplicate-definition/title-wrapping fixes, which had focused validation; the final phase 7 suite covers the accumulated source.

Managed and custom user-facing slices also received their own built UX reviews: Managed **4/4 in 42.3 s**, custom **2/2 in 14.9 s**, both with zero measured control movement. The final cleanup changes architecture names and API wiring rather than introducing another product surface.

## Deliberate boundaries

- MCP uses the official v2 client with modern/legacy negotiation and native loopback DCR. The conditional Tasks lifecycle is unavailable in that dependency; no Tasks poller, elicitation advertisement or invented Tasks golden is claimed. CIMD remains unconfigured without an owned hosted metadata URL. See [MCP connections](../../mcp/connections/connections.md).
- ACP command launchers use stdio. SSH local arguments are passed directly, while SSH remote-command interpretation still follows the remote shell. Test only initializes/disposes; authentication happens in the user's CLI/SSH setup. ACP HTTP and Gemini remain unsupported. [Codex](../../agents/local_agents/codex_engine.md) is implemented through its installed CLI and the pinned ACP adapter; controlled native-peer tests do not establish live model/sandbox behavior.
- Managed validation uses the official SDK against controlled HTTP/SSE peers. No live Claude Managed account was called. Custom tests use real child processes and controlled ACP peers; they do not claim a real SSH host or remote CLI deployment.
- Unsupported complete token accounting remains an explicit refusal. Autonomous execution supports the implemented turn/time budgets; unavailable usage is never fabricated.

This tracked record is the durable documentation entry point. Session planning drafts remain local working history, outside the tracked documentation link graph.

## Post-completion review follow-up (2026-09-12)

See the [finding-by-finding resolution and validation record](post_review_fixes.md) for all eight high and twelve medium fixes, the admission-stall regression, and remaining validation limits.

Recovery checks remote Managed status/history, ignores deleted scheduled tasks for overlap, and keeps schedule reads free of writes. Scheduler observations alone revoke approval for confirmed definition changes; transient folder errors skip a pass. Peer edits preserve run-owned artifacts/budgets. App-sync coalesces independently imported remote replicas by a deterministic ID order. Sync watermarks retain writes made during network work, including writes within the same second.

Tool narration uses stable tool identity across permission blocks in both saved and live output. Replay overflow retains request polling; failed watcher delivery reports degraded live updates and switches to saved-message polling. Ownership is checked at watch admission and profile identity remains checked per message. Unsupported launchers report invalid readiness and remain explicit in the Runtime selector.

MCP supports OAuth for SSE and HTTP, serializes calls per provider during token rotation, encrypts client registrations, reuses registered callback ports, and keeps a mismatched callback from canceling the legitimate flow. A2A Stop discloses unconfirmed remote cancellation. Driver contract park coverage follows advertised input capabilities.

`src/main/services/askDelivery.ts` routes answers to their durable delivery owner. `src/main/services/runExecutionState.ts` owns active run maps independently of renderer attachment. `src/main/tasks/jobDefinitionPolicy.ts` centralizes the retained job-type executor policy.

The original phase 2 assertion that every row has a driver after launch was not delivered: unsupported/null drivers remain visible and refuse execution. The recorded runtime phase delivered no ACP session-relaunch E2E; that phase covered loading through unit/peer tests. The later Codex feature adds a targeted built-Electron restart/resume test with a real adapter and scripted native peer; see [Codex verification](../../agents/local_agents/codex_engine_tech.md#verification-and-limits). Engine helpers remain seven files, not just the three helpers named in the early phase 3 plan. Only coordinator-target manifest handback is structural. These are explicit scope limits, not claims of completed coverage.
