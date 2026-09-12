# Script Execution

## Purpose

Run a saved dependency graph in main, with a separate conversation for each step and durable Inbox questions. The graph decides what becomes eligible; an agent cannot rewrite the graph through its response. The root assignee reads **Defined script steps**; human steps read **You (via the Inbox)**, so neither is presented as a local model turn.

## Core Concepts

- **Script attempt** — one Job run, root task and local checkpoint containing the validated definition, resolved participants, limits and step progress.
- **Step task** — a child task and isolated conversation for one declared agent prompt or human question. Dependency output is passed explicitly; siblings do not share conversation history.
- **Ready step** — a pending step whose dependencies have completed. Independent ready steps may run concurrently within the device's admission limits.
- **Saved gate** — an Inbox question whose answer and continuation are recorded together. It can survive application restart without a live agent process.

## User Stories / Flows

1. A programmatic caller creates a local Job with an explicit script router and a [version-1 definition](script_definitions.md). The Job form has no script editor or graph authoring controls.
2. Press **Run** on that Job. Main validates the definition, budget and available agent identities before creating the attempt. It records the root, children and checkpoint together, then queues execution. Opening or leaving the conversation does not dispatch another prompt.
3. Open the root task to browse its children. Each child's conversation contains its full interaction; the root records compact step results and a final summary. Dependency prompts receive only the outputs the graph permits.
4. Answer a script question or an agent's saved continuation in the Inbox. The answer advances its own step; unrelated running steps and sibling questions retain their state.
5. Use **Stop task** or, after interruption, **Resume task** on the root or a nonterminal child. Both actions control the whole script, as the task page explains. Stop ends the attempt; Resume preserves completed steps and saved questions and asks interrupted agent work to review its existing conversation.

## Business Rules

- **Admission is atomic.** Invalid definitions, unsupported limits and unavailable or ambiguous agent references refuse before creating a partial attempt. Script aliases resolve against resources already available in the captured profile/settings scope; they do not install agents or fetch missing cards.
- **Dependencies are authoritative.** A step is durably claimed before dispatch. Human steps finish only after answer acceptance; an agent step with an outstanding saved question cannot release its dependants. Compact outputs include a shortening notice, while oversized expanded instructions refuse rather than silently truncate.
- **Limits cover the whole attempt.** Each agent dispatch consumes one turn from the shared script budget. Human gates consume no agent turn. Time includes task/agent queue waits, execution and live approvals. It pauses when all remaining work is held behind settled saved questions. Token budgets are refused because complete participant usage is unavailable.
- **Conversations remain reserved.** The root and all step conversations, including completed steps, remain reserved until the attempt ends. Ordinary sends, routing changes and remote handoff cannot compete with the saved graph. Stop retains reservations while active handles finish cancellation cleanup.
- **Recovery requires an explicit choice.** Startup changes queued/running attempts to interrupted without dispatch. Resume retains completed output and real gates; it never mechanically replays a saved tool batch. A review instruction cannot guarantee an agent will never independently choose a similar action, so the saved conversation remains the evidence to inspect.
- **Bindings are rechecked.** Recovery, Resume, answers and dispatch validate the root definition/root conversation and each child's parent, conversation and local ownership. A synced reparent or changed definition cannot silently deliver an old gate into different work. Interruption marks still-owned unfinished children blocked; completed or moved children retain their status. Valid conversation reservations remain until the attempt is resolved, while moved children lose the old reservation. A Stop already in progress refuses new answers without consuming them.
- **Cleanup follows the attempt's ownership.** Terminal/deleted roots close their still-owned children and recorded questions, even if root deletion already removed the checkpoint row. A moved child keeps its new status; cleanup expires only this attempt's recorded or run-scoped addresses, never unrelated requests with no run ID. Late completion cannot rewrite another job attempt.
- **The application must remain open.** Sleep/quit interrupts execution. There is no system scheduler or automatic dispatch after restart.

## Architecture Overview

Job Run → main validation and participant resolution → root/children/checkpoint transaction → shared task queue → ready graph steps → shared agent queues and turn executor → saved outcomes → dependent steps, Inbox wait or terminal summary.

Inbox answer → binding and checkpoint checks → answer/step transaction → queued continuation. Restart → checkpoint validation → saved wait or explicit interruption.

## Integration Points

- [Technical details](script_execution_tech.md) — checkpoints, queues, admission and cleanup predicates.
- [Script definitions](script_definitions.md) — portable identities, parser and template bounds.
- [Autonomous coordination](autonomous_tasks.md) — the other main-owned engine, sharing admission and task controls.
- [Jobs](../jobs/jobs.md), [Tasks](tasks.md), [Inbox](inbox.md) and [live attachment](../../chat/messaging/live_runs.md) — existing entry, navigation and conversation surfaces.

Schedules, manifest-driven handback, complete token accounting and the phase 7 protocol/driver cleanup remain outside this execution slice.
