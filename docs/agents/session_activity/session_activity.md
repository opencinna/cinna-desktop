# Session Activity — subagents, background processes and tasks beside the composer

## Purpose

A local agent keeps working after its reply: a shell left running in the background, a subagent it handed work to, a task the chat started. Session activity shows that work under the composer while it runs, lets the user stop a background process, and keeps the agent's process alive until the work is done. A turn the agent starts on its own when that work finishes is shown and saved in the chat like any other turn.

Before this existed, all of it was invisible. A background shell finished, Claude read the output, merged the PR and said "Merged.", and none of that reached the app. The traffic sat in the connection's pre-bind pen for ten seconds and was dropped, and a permission ask in that turn was refused after the same ten seconds. Meanwhile the idle reaper could kill the process two minutes after the reply, taking the background work with it.

## Core Concepts

- **Session activity** — what a chat's agent sessions are running beside and between their turns. There are two kinds: **subagents** and **background processes**. It is one engine-neutral model (`src/shared/sessionActivity.ts`): a driver reports changes and never reads the state back
- **Activity item** — one subagent or background process: title, detail, state, start and end times, an output path to show, and whether it can be stopped. Its states are `running`, `completed`, `failed`, `stopped` and `lost`
- **Lost** — the desktop can no longer see the item, because the agent's process exited or was reaped, or the chat stopped answering to that agent. **It is never shown as completed**, because nobody knows whether it finished
- **Activity hub** — the main-process store of every chat's items, **held in memory only**. Activity describes live processes, and an app restart ends them all
- **AIR capabilities** — `asyncTasks` and `nativeSubagentSessions`, from the JetBrains AIR ACP extension. A client advertises them at `initialize`, and an adapter that honours them reports its background tasks and subagents. See [the ACP contract](../local_agents/acp_contract.md#session-activity-over-the-air-extension)
- **Follow-up turn** — a turn the agent starts on its own after its reply, with no user message. It is shown live and saved as an assistant turn. The rules are in [The Agent Turn](../local_agents/agent_turn.md#a-turn-the-agent-starts-on-its-own-is-a-follow-up-turn)
- **Between-turn listening** — after a turn ends, the driver keeps listening to its session until the process goes away, the session is replaced, or the chat stops answering to that agent

## User Stories / Flows

### Watching background work
1. The user asks a Claude agent to run something long in the background. The agent starts it, replies "I'll let you know", and its turn ends
2. A **Background** badge appears under the composer, left of the router badge, showing a gear and the running count. A dot on its corner pulses
3. Hovering or focusing the badge opens a popover headed *Background processes*, with "1 running" beside the heading. Each row shows the title, the state, how long it ran, the description, and the output file path
4. The work finishes. The row turns *Completed*, and the badge leaves with its last running item, once its popover is closed
5. Claude reads the output and answers on its own. The answer streams into the chat as a new assistant message with no user message above it. If the chat is not on screen, the sidebar shows the normal unread result

### Stopping a background process
1. The popover row of a running, stoppable background process has a **Stop** button
2. Pressing it shows "Stopping…" in the same space, and the desktop asks the agent to stop that one task
3. The agent reports the task as stopped, and the row changes to *Stopped*. The popover stays open on that row, even when it was the last one running. The badge then reads 0, and its name is *"No background processes running"*. It leaves when the popover closes
4. A stop that did not happen leaves a sentence under the row, for example *"This process had already ended."* or *"The agent did not answer. Try again in a moment."* Nothing closes. The popover grows downward, so the row stays under the pointer

### Watching subagents
1. A Claude agent hands work to a subagent. A **Subagents** badge appears, and its popover lists the subagent's name and task
2. The subagent's own tool calls and text appear **in the chat**, in a nested sub-thread under the agent's `Agent` tool call, while the agent's own words continue around it ([Conversation UI](../../chat/conversation_ui/conversation_ui.md#subagent-work-in-the-transcript)). Advertising the capability changed nothing here: the desktop writes the `Agent` call back into the stream
3. The badge leaves when the last subagent has ended and its popover is closed

### Seeing the chat's tasks
1. Once a chat owns at least one root task, a **Tasks** badge (a checklist icon and the count) sits next to the router badge
2. Its popover lists the tasks. A row opens its task, and the popover closes with it
3. With more than ten tasks, the popover says "Showing 10 of N" and ends in **Open Inbox**, where all of them can be paged

### When the process goes away
1. The agent's process exits, crashes, is retired, or is reaped. Every item it was running becomes **Lost**, and its row says *"The agent's process ended before this finished."*
2. Quitting the app forgets all activity. On the next launch no badge shows old work

## Business Rules

### A badge exists only while something of its kind runs, or its popover is open
- **The face is an icon and a running count, nothing else.** A badge that appears adds a pill of known width, and the count uses tabular digits at a two-digit minimum, so 9 → 10 does not widen it
- **The cluster is right-aligned, so a badge that appears pushes only what is to its left.** So the badges that come and go (Subagents, Background) are leftmost, and Tasks, which stays once a chat has one, sits next to the router badge. The composer row never wraps: the agent and MCP chips on the left shrink to a floor and then scroll sideways, so a badge arriving on the right never folds the row and moves the textarea while the user types ([UX rule 1](../../development/ui_guidelines/ux_rules.md))
- **Ended items are listed, muted, under the running ones, but do not keep a badge up.** When the last running item ends while the popover is open, the badge and popover stay: the user may be watching the row they just stopped. The count reads 0, the corner dot goes, and the badge is named *"No background processes running"* (*"No subagents or background processes running"* for the collapsed badge). The badge leaves when the popover closes
- **An open popover keeps its top edge.** Content that grows while it is open, such as a refusal line, extends it downward instead of pushing the rows under the pointer up. It may then cover its badge. It is placed above the badge again on the next open or a resize
- **Narrow composer, one badge.** Below a 40rem composer row, Subagents and Background collapse into one **Activity** badge. Its popover groups the items under a heading per kind. The switch is a container query on the row, not a measurement. A measurement would flip back and forth, because swapping the badges changes the width it measured
- The popover is a non-modal dialog that opens on hover and on keyboard focus, never a tooltip, because it holds buttons

### Retention and ordering
- **Running items come first, oldest start first. Ended items follow, most recently ended first**
- **At most five ended items per kind are kept per chat.** When an item of a kind starts while nothing of that kind is running, the ended items of that kind are dropped: they belonged to the previous round, whose badge has already gone
- **A later end replaces an earlier one.** Claude was watched sending `stopped` and then `completed` for the same task, and the hub takes the correction. Nothing moves an ended item back to running, and an end for an unknown item creates nothing
- **A new run of a Codex subagent is a new item** (`<thread>#2`, `#3`…), because an ended item never runs again

### Stop
- **Only a running background process whose agent said it can be stopped offers Stop.** Subagents have no Stop control
- **Every refusal is data with a sentence, never a thrown error:** `already_ended`, `not_stoppable`, `unavailable` (the agent did not answer within five seconds, or its process is gone), `chat_not_found` (not this profile's chat, or it is in the trash). A stop that timed out while the item ended meanwhile reads "already ended", not "no answer"
- **The stop state lives above the popover**, because a popover row unmounts while its stop is still in flight
- **"Stopping…" lasts until the item is seen to stop.** It stays until the pushed state leaves `running` or a refusal comes back. After an accepted stop that no push confirms, it gives up after ten seconds. The engines send the stopped state before they answer, so the fallback rarely matters
- **A retried Stop keeps the old refusal on screen until the new answer replaces or clears it**, so the row does not shrink under the pointer. **A refusal is dropped once its item is no longer running**, because a sentence about stopping a process that has ended says nothing

### Who sees what
- **Only the active profile's chats reach the window.** A trashed chat shows no activity from any profile, and a late report for it is dropped rather than kept
- **Trashing or deleting a chat forgets its activity and stops listening to its sessions**
- **When a chat stops answering to an agent, that agent's activity there becomes `lost`, and its sessions are no longer heard in that chat.** This covers a router change, a changed bound agent, and a removed on-demand agent. The old sessions still hold their context engine-side, but nothing they say lands in a chat that no longer answers to them

### The process is not reaped while its work runs
- The idle reaper normally stops an agent's process two minutes after its last turn. **While the hub shows running items for that agent, the reap is deferred** and checked again after another window
- **The deferral has a 30-minute ceiling.** It counts from whichever came later: the last change to that agent's items, or the end of its last turn. After 30 quiet minutes the process is stopped and its items become `lost`. A background process that never reports again must not hold a process forever
- A follow-up turn that is waiting to open also holds the process, so the reaper cannot kill the turn the traffic is waiting in

### What each engine reports
- **Claude** is sent both capabilities. Its background shells and background or synchronous subagents are all reported
- **Codex** is sent `asyncTasks` only. Advertising `nativeSubagentSessions` would make `codex-acp` drop the spawn call from the parent, and nothing on the wire would link the child to the chat. So Codex subagents are read from the tool calls it sends on the root session instead
- **Command-line (custom) agents** are sent `asyncTasks` only. Only the Claude adapter's shape of native subagent sessions is routed back to the parent, so an agent that implemented them its own way would lose its spawn calls
- **OpenCode** is sent neither and reports nothing

## Known limits
- **Activity is memory-only.** It is lost on restart, and a background process that outlives the app is not rediscovered
- **A Claude background subagent's launch text is not in the transcript.** The CLI writes "launched in the background" itself, and it is not on the wire. The synthesized `Agent` call closes as completed without it
- **The Codex collaboration path is derived from the adapter's code, not watched.** A `spawnAgent` call naming its children, and the `agentsStates` of a collaboration call, are read as `codex-acp` 1.11.0 would send them. The installed CLI sent `subAgentActivity` tool calls instead, and those are what was recorded
- **The output path is shown, not opened**

## Architecture Overview

```
ACP adapter ──session/update──► connection (transport tap, routing, child-session aliases)
   │                                 │
   │                 turn bound? ──► turn handlers ──┐
   │                 otherwise  ──► session observer ─┤
   │                                                  ▼
   │                      activity feed (translateActivity) ──► sessionActivityHub (memory)
   │                                                               │            │
   │                                          session-activity:changed      pool reaper
   │                                                               ▼        (isBusy / lastChangeAt)
   │                                useSessionActivity ──► SessionMetaBadges
   │                                                         ├ Subagents / Background / Activity
   │                                                         └ Tasks (task:list {chatId, rootOnly})
   │
User Stop ──► sessionActivity:stop ──► stopSessionActivity ──► ACP stopper
                                         ──► _session/async_task/stop ──► adapter
```

## Integration Points

- [The Agent Turn](../local_agents/agent_turn.md) — the driver that listens between turns and runs follow-up turns
- [The ACP Engine Contract](../local_agents/acp_contract.md) — the wire facts: between-turn traffic, the AIR messages, stop, the end-of-turn marker
- [The Claude Engine](../local_agents/claude_engine.md) and [The Codex Engine](../local_agents/codex_engine.md) — what each engine is sent and what it reports
- [The Local Engine](../local_agents/engine.md) — the process pool whose reaper reads the hub
- [Command-line Agents](../custom_agents/custom_agents.md) — custom ACP commands, which get background tasks only
- [Tasks](../../jobs/tasks/tasks.md) and [the Inbox](../../jobs/tasks/inbox.md) — the rows the Tasks badge shows, and where "Open Inbox" leads
- [Sidebar Session Status](../../chat/session_status/session_status.md) — the unread result a follow-up turn leaves in an inactive chat
- [Interrupted Turn Recovery](../turn_recovery/turn_recovery.md) — a follow-up turn the app was killed under
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — rule 1, which decides the badge order and the non-wrapping composer row
- Technical details: [Session Activity (tech)](session_activity_tech.md)
