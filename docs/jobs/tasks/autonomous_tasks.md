# Autonomous Tasks

## Purpose

Let a configured coordinator work toward a goal while the user leaves the conversation. The desktop keeps the task, asks for human decisions in the Inbox and stops at explicit completion, cancellation or an execution limit.

## Core Concepts

- **Autonomous task** — an explicit execution mode for a task linked to a coordinator chat, admitted from that conversation or an explicitly configured local Job. Turning on ordinary coordination alone does not start an autonomous loop.
- **Owner turn** — one coordinator or handed-off specialist turn. A delegated agent is a tool call within its coordinator turn; it does not become the owner.
- **Checkpoint** — device-local state recording the current owner, continuation, limits and durable question. It is separate from the task definition that syncs to other devices.
- **Runner gate** — a persisted coordinator question with its own delivery owner and no invented agent identity. It survives the turn and application restart.

## User Stories / Flows

1. In an existing chat with **Model routes**, open the composer’s **+** menu and choose **Run on its own…**. Review the goal, initially copied from the composer. **More options** exposes a turn limit and time limit, defaulting to twenty turns and sixty minutes.
2. Press **Start task**. Main validates the configured coordinator and records the task/checkpoint before queuing work. The dialog closes after admission; the current conversation stays open. A refusal preserves the goal and limit fields. A changed composer draft is not cleared by the earlier submission.
3. The coordinator may delegate to attached agents, update task progress or hand the next turn to a specialist. Delegation returns into the current model loop. A completed handed-off turn returns to the coordinator; a question pauses work instead.
4. Answer a coordinator or specialist question through the Inbox. Acceptance advances the saved checkpoint and queues its continuation without leaving the Inbox. The same task/chat and any linked job provenance remain; a new job attempt is not created.
5. Open the task from Jobs → Tasks for **Stop task**, **Open the Inbox**, execution limits or, after interruption, **Resume task**. Resume reviews saved work through a new instruction; it does not mechanically resend the interrupted tool batch.
6. Settings → Default → Agents → Tasks → **Autonomous task concurrency** changes the device-wide admission limit from one to eight, default two.

## Business Rules

- **Job autonomy is also explicit.** An explicit coordinator Job resolves its model and dependencies in main, creates a new hidden conversation and attempt transactionally, and starts the same runner after commit. Ordinary jobs with a null router retain their existing one-turn behavior. There is no autonomous-definition editor in the Job form.
- **Autonomy is explicit.** Existing-chat admission requires an owned, configured coordinator chat, no active turn/runner and no pending local questions. It uses that chat’s model rather than silently selecting another default. A new task gets the entered goal; reusing a task requires the entered goal to match its immutable original goal after trimming. A different goal requires a new conversation.
- **Only the coordinator controls the loop.** Its fixed commands are delegate, handoff, ask_user, update_task and finish. A specialist cannot return a control instruction through its ordinary result. The first successful end-of-turn control wins; later calls in that model response receive persisted non-execution results.
- **Kit handback adds context to normal return.** A kit agent explicitly declaring the coordinator role may end an eligible successful answer with a bounded `/handback <note>` line. The note reaches the existing coordinator after questions settle; an unmarked completed specialist still returns normally. Ordinary chats, delegates and script steps cannot activate this control. See [manifest handback](manifest_handback.md).
- **Only explicit finish completes autonomous work.** Ordinary text without a control can start another bounded coordinator turn. Failed or cancelled specialist work does not masquerade as successful handback. Unknown request cleanup or input-needed without an answerable saved ask interrupts progression.
- **Limits bound admission and active work.** Each owner turn counts once, separately from the model loop’s ten-request ceiling. Turn limits accept integers 1–1000; time limits are positive and at most 1440 minutes. Time includes queue waits and execution but excludes settled human waits. Live approvals inside a running agent turn still count, and the task page offers the Inbox while that turn is blocked. Timeout aborts active work and waits for turn cleanup before finalization. An unclean running checkpoint conservatively charges the unfinished interval through recovery, including downtime.
- **Token limits are unavailable.** An explicit maxTokens is refused before participant dispatch because the adapters and agents do not all report complete usage. Missing usage is never counted as zero. The dialog exposes only supported turn/time limits.
- **Reservations outlive individual turns.** A task owns its conversation while queued, running, waiting or interrupted. Ordinary sends and model/router changes refuse while it owns the chat; renaming remains possible. Working reservations keep chat Stop available between individual turns, and Stop cancels the whole runner.
- **Queues remain cancelable.** Tasks and runner agent calls use separate bounded queues, with one call per agent. Busy local agents wait for their lock instead of turning contention into a failed task. These limits govern autonomous admission, not every ordinary chat on the device.
- **Waiting is durable; interruption is not replay.** Coordinator questions and A2A next-message questions retain their identities across restart. A running or queued checkpoint becomes interrupted on recovery; it never dispatches automatically. Sleep and app quit checkpoint interruption before aborting. Resume repairs missing tool-result pairs as historical non-execution and preserves any real gate. A new review instruction cannot guarantee that a model will never independently choose a similar action; the saved transcript is the evidence to inspect.
- **Stop ends this execution.** Cancellation settles the task and expires its durable continuations. It is not a resumable pause. Terminal tasks have no Resume action; exhausted limits are not editable through the runtime control.
- **Ownership stays authoritative.** The runner retains captured profile/settings scopes, rechecks device claim/status and revalidates attached agent availability after waiting. A reserved runner blocks remote handoff, and an unresolved remote handoff blocks runner start. Lost ownership, removal, terminal state or account deletion stops local admission/work. Deleting its conversation durably cancels the task/runtime and expires gates. A late completion cannot write through lost ownership.
- **The app must remain open.** Leaving the conversation does not stop work. Closing the app or sleeping the device interrupts active execution; there is no background system scheduler here.

## Architecture Overview

Composer → autonomous-task IPC → task/checkpoint transaction → task runner → shared turn executor → coordinator model or agent driver → saved outcome → next owner, Inbox wait or terminal task.

Inbox answer → scoped gate/checkpoint transaction → queued continuation. Task recovery → historical tool-pair repair → saved gate or fresh review instruction.

## Integration Points

- [Technical details](autonomous_tasks_tech.md) — commands, storage, IPC and lifecycle hooks.
- [Tasks](tasks.md), [Inbox](inbox.md) and [chat-owned tasks](chat_tasks.md) — durable work and the separate ordinary one-turn path.
- [Orchestrated agents](../../chat/orchestrated_agents/orchestrated_agents.md) — ordinary per-agent tools remain available outside autonomous execution.
- [Live attachment](../../chat/messaging/live_runs.md) and [turn outcomes](../../chat/messaging/turn_completion.md) — selected-chat visibility and per-turn results.
- [Remote handoff](remote_handoff.md) — moving the executor to another service is distinct from changing the desktop runner’s next specialist owner.

[Script execution](script_execution.md) shares admission queues and runtime controls, using a fixed dependency graph instead of coordinator decisions. [Local schedules](local_schedules.md) admit reviewed kit work through the script engine. Complete token accounting, protocol/new-driver work and final cleanup remain separate implementation work.
