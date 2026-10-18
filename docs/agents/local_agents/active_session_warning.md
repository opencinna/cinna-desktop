# The Active-Session Warning

## Purpose

Several sessions may run on one local agent at the same time — chats, tasks, schedules — and nothing in Cinna stops a second one from starting. Whether two of them get in each other's way is the user's call, so the places that start one more say when the agent is already busy and let the user go on.

## Core Concepts

- **Active session** — a chat whose turn is running now and an agent is answering in it, however the turn started: typed, a task (dispatched or not), a schedule, an autonomous runner. The local default model has none.
- **Warning** — the sentence *<Agent> is already running in “<chat>”. Make sure this request won’t conflict with it.* with **Open**, which goes to the newest running session. With several: *… already running in 2 sessions … with them.* A chat without a title is *a chat*.
- **Snapshot** — a warning that is read once, when the user opens the page or picks an agent, and does not follow the runs that start or end afterwards.

## User Stories / Flows

1. **New chat.** The user picks an agent that is already running. A row joins the [composer notice panel](../../chat/conversation_ui/conversation_ui.md#the-composer-notice-panel), after any readiness rows, one per picked agent. Send stays enabled. An existing chat's composer shows nothing.
2. **Start on a task.** A Ready task's page shows the warning last under **Start** (and under the Continue-with picker), for the agent that Start would run — the assignee, or the one chosen in the picker. It is a snapshot.
3. **The agent's Tasks tab.** Under the **Task queue** status line, the warning reads *<Agent> is also running in “<chat>”. Run next starts beside it.* It is live, and it leaves out the queue's own running tasks, which the status line already names.
4. **Open.** Goes to the chat in the chat view; the user decides.

## Business Rules

- **It warns and never blocks.** Send, Start and Run next all stay available. The dispatcher no longer waits for the folder to be quiet either ([The Task Dispatcher](../../jobs/tasks/task_dispatcher.md#when-a-task-may-start)); this warning is where the cost of that choice is said. Refusing would have made the user stop a chat in order to start a task that does not touch it.
- **A surface with content below it freezes the warning.** On the task page the sections under Start (Goal, Details, subtasks) would move whenever a run began or ended elsewhere, with no gesture of the user's ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 1). It is read when the page opens on the task and when the agent is changed in the picker. Until the first read of that mount lands, opening counts as the gesture, because the cache may be empty or old.
- **It is placed last.** It exists only sometimes, so it sits below the controls, and on the live surfaces it moves nothing above it.
- **Each warning is described by its sentence.** With several agents listed, each **Open** names the sentence it acts on.
- **Only this profile's chats, only agent turns.** A chat the profile does not see, a deleted chat and a turn with no agent are not listed.

## What this deliberately does not do

- **No locking and no queueing.** It is not a mutex on the folder. Two sessions on one agent write the same files if they want to; that is the same as two terminals in one folder.
- **No warning in an existing chat's composer**, which already shows the turn it is in.
- **Nothing for another agent sharing the folder.** The warning is about the agent being started, not its folder.

## Architecture Overview

```
turn opens/closes (runExecutionState) , task runner working flips (taskRunnerState)
   -> activeAgentSessions -> agentSessions:changed (push)
Renderer: useAgentActiveSessions (also refreshed by taskDispatch:changed and chat title updates)
   -> agentSessions:active -> activeAgentSessions(profile)
   -> AgentActiveSessionNotice (task page, Tasks tab) | useActiveSessionNotices -> ComposerNoticePanel (new chat)
```

## Integration Points

- [The Task Dispatcher](../../jobs/tasks/task_dispatcher.md) — starts beside live sessions; this warning is the other half of that rule.
- [Conversation UI](../../chat/conversation_ui/conversation_ui.md) — the composer notice panel hosts the new-chat row.
- [The Tasks View](../../jobs/tasks_view/tasks_view.md) — the task page's Start controls.
- [Technical details](active_session_warning_tech.md).
