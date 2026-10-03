# The Task Dispatcher

## Purpose

Cinna works a folder agent's queue of Ready tasks for it, one task at a time: it picks the next task by priority and age, starts it in the agent's folder, and reads what the agent says about it afterwards. A task the agent never reports on is flagged, and the queue stops until the user looks. A task whose file was written outside Cinna does not run until the user approves exactly that content.

## Core Concepts

- **Queue** — the Ready (`open`) tasks assigned to one enabled local folder agent, bare or kit, that this device runs. A remote cinna agent, the default model and an unassigned task have no queue.
- **Run mode** — how a queue runs, per agent, per profile, on this device only:
  - **Manual** (the default) — nothing starts on its own. **Run next** still works.
  - **One at a time** — Cinna starts the next Ready task whenever the agent and its folder are free.
- **Run next** — start one task now, in either mode and while the queue is paused. It does not clear the pause.
- **Dispatched turn** — a turn the dispatcher started (from One at a time, Run next or an approval). It is settled by the report rule, not by how the turn ended.
- **Dispatch-owned task** — a task whose dispatched turn stopped on a question. The queue still owns how it settles, so the turn the answer resumes is settled by the report rule too.
- **Report** — the agent saying how the task went. A task the agent left in a **Done, Failed, Waiting or Cancelled** category at the end of its turn has been reported on.
- **Pause** — the queue stopped starting tasks on its own because a dispatched task needs the user: it ended without reporting, it failed, the user stopped it, or Cinna quit while it ran. The task gets a **dispatch note** saying why it is blocked.
- **Outside-content gate** — the Inbox approval a task needs before it runs when its file content was written outside Cinna. One card per version of the content.

## User Stories / Flows

1. **Turn a queue on.** On a folder agent's page, the **Tasks** tab shows the **Task queue** section: **Run mode** (Manual / One at a time), **Run next** beside the title, and one status line. Choosing One at a time starts the next Ready task as soon as the agent and its folder are free.
2. **Run one task by hand.** **Run next** starts the top of the queue. The Tasks view filtered to that agent has the same control: **Run next**, with the run mode behind its chevron. On a Ready task's own page, **Start** runs that task through its agent's queue, so the same folder and approval rules apply.
3. **The agent reports.** During the turn the agent moves its task — `task_update` with a status, a new status word in its task file, or `handover_report`. When the turn ends, Cinna reads the task again, sees it was reported on, and goes on to the next task.
4. **The agent does not report.** The turn ends with the task still In progress, or moved back to Ready or Backlog. Cinna moves it to Waiting with the note **Ended without reporting** and pauses the queue.
5. **See the pause.** The **Tasks** tab gets a warning dot. The tab shows **Paused — <task> ended without reporting** with **Resume**. In the filtered Tasks view, the Run next half of the control becomes **Resume** in the warning tone. The Inbox shows **<agent>'s queue is paused**. The flagged task's page shows its note and **Paused <agent>'s queue · Resume**.
6. **Resume.** Any of those Resume buttons clears the pause. The flagged task stays where it is until the user moves it.
7. **The agent asks a question.** The task waits on the question and the queue moves on to its next task. When the user answers, the task's chat continues. When that turn ends, it is settled by the same report rule.
8. **A file changed outside Cinna.** In One at a time, the queue opens an Inbox card for that task and skips to the next one. The card shows the title, the file and the prompt exactly as the agent will receive it. **Approve and run** trusts that content and starts the task, in either run mode. **Skip** leaves it untrusted. **Run next** on that task opens the card instead of running it.

## Business Rules

### Which task

- **Eligible**: assigned to the agent, Ready, run by this desktop, not a script, no open question, no runtime or script runner owning it, no unresolved remote handoff, and no delegation or file handover that is still starting it through its own approval.
- **Order**: highest priority first, then oldest, then by id, so two passes always agree.
- **`blocked_by` is strict.** A task file's `blocked_by` ids are resolved against the tasks kept in files in the same folder. The task starts only when every one of them is **Done** (`completed`). Failed and Cancelled blockers still block. **An id that names no task blocks too.** A typo would otherwise let work start before what it depends on. The task page says which blocker is missing (`<id> — not found`).
- **A task that already has a conversation continues in it.** A task that ran before and went back to Ready gets its next turn in the same chat, with the same prompt a first start sends, so the agent keeps what it already knew. A chat that has since been deleted is replaced by a new one.
- **Rechecked after the wait.** The wait for a runner slot can be long. Before starting, the task is chosen again: it may have been started by hand, finished, reassigned, deleted or changed outside Cinna in the meantime. A task that no longer qualifies ends the wait quietly. The queue does not pause for it, and it moves on.

### When a task may start

- **One dispatched run per agent.**
- **One dispatched run per folder.** Agents that share a folder share this limit. Two agents writing the same files at once is the failure this exists to prevent.
- **Never while any turn is running in the folder**, including a chat the user is typing in and an autonomous runner's turn. The dispatcher waits for that turn to let go of its chat.
- **Never while a resumed, dispatch-owned turn is still being settled** for an agent or folder. Between that turn closing its chat and the dispatcher's decision, the folder looks free. A queue that started its next task in that gap would have been working while it was being paused.
- **One global runner slot per dispatched turn**, shared with autonomous and script runs (`taskRunnerConcurrency`, 2 by default). One at a time waits for a slot and shows **Waiting for a runner slot**. Run next does not wait. It refuses with *"Every task runner slot is busy."* so that the user is not left with a click that might start something minutes later.
- **Only while Cinna is open, and only for the active profile.** Switching profile stops the queue from starting anything new. Runs already under way finish and are settled.

### The report rule

- **A dispatched turn is settled by what the agent said, not by how the turn ended.** A turn that ends normally is not the same as a task that is done. Without this rule, every quiet ending would have been marked complete.
- **The task's status is read again, freshly, before deciding.** A status word the agent wrote into its file just before the turn ended must be seen. A read that started before the turn ended might miss it, so the dispatcher waits for a read that starts after.
- **The outcomes:**
  - **Reported** (Done, Failed, Waiting or Cancelled) — the queue continues.
  - **Ended on an open question** — the task waits on the question and stays dispatch-owned. The queue continues.
  - **Normal end, no report** (In progress, or back in Ready or Backlog) — the task is moved to Waiting with **Ended without reporting** and the queue pauses. Ready or Backlog is no report because the queue would only pick the task up again. A Ready or Backlog task goes through In progress on the way, because neither may move straight to Waiting.
  - **The turn failed or hit its budget** — the task is Failed with the turn's error, and the queue pauses.
  - **The user pressed Stop** — the task is Cancelled and the queue pauses.
- **Only the dispatched run is the dispatcher's.** Marks are kept by chat and run id, never by task, so a user's own Start or chat message on the same task ends the way any turn does.
- **Job-run tasks: the agent's report wins.** A dispatched task can belong to a job run. When the agent reported Done or Failed during the turn, the run's attempt is mapped from that instead of being overwritten by how the turn ended. When it reported Waiting, the attempt stays running and the task stays Waiting.

### Dispatch-owned tasks

- **Ownership is written to the task** (`dispatch_agent_id`) when the dispatched run is accepted, so it survives a restart.
- **It lasts while the task waits on a question.** The turn an Inbox answer or a typed message resumes in that task's chat ends by the report rule, and pauses the queue the same way.
- **Anything else ends it.** The dispatcher settling the task, or any status other than In progress or Waiting (a report, a person's move, a pull), releases the task. So do take over and hand off, and a device-sync copy from another device that changes the task's status or which device runs it. Once the run has moved, a turn on this device cannot pause the queue on its behalf. A synced title or description edit leaves the run alone, so it leaves ownership alone too.
- **Limit.** A resumed turn is started by the chat, not by the dispatcher. It takes no runner slot. The queue never starts in a folder while that turn runs, but the turn itself can start while another dispatched run works in the same folder, as any typed message can.

### Pause and Resume

- **What pauses**: no report, an error ending or a failed start, a Stop, and Cinna quitting mid-run. A start that fails pauses only a queue that started it itself. A failed Run next shows its error beside the button instead.
- **What a pause stops**: One at a time starting anything on its own. Run next and Approve and run still work.
- **Resume clears the pause and nothing else.** The flagged task stays blocked with its note until the user moves it, so the same task is not run straight back into the same failure.
- **The note clears itself.** Any status other than Waiting removes the dispatch note.

### Boot recovery

- **A dispatched run Cinna quit under is found at the next start.** The run in flight is recorded on the agent's queue. At boot, before any profile activates, its task is moved to Waiting with **Interrupted when Cinna quit** if it was still In progress, it is released, and its queue pauses.
- **A dispatch-owned task left In progress with no open question** (an answered question's turn that was running at quit) is flagged, released and its queue paused the same way. That turn had no in-flight record, because the dispatcher did not start it. Without this check, the task would have stayed In progress and owned indefinitely.
- **A resumed turn that ends during shutdown is left alone** for the same reason: the task stays running and owned, and the next boot flags it. Settling it through the ordinary path on the way out would have marked it complete.
- **Nothing is settled during shutdown.** A turn ending because Cinna is closing is not a Stop. Settling it then would have recorded the user cancelling work they did not cancel.

### The outside-content gate

- **What counts as outside**: a task file whose current bytes are not content Cinna vouches for — written by an editor, a script, a `git pull`, or the agent itself editing its own file. A Cinna write on top of outside content does not make it trusted. See [Folder Tasks](folder_tasks.md#trust-whose-content-is-this).
- **One card per content hash.** The card shows the prompt exactly as it would be sent. Once the file changes, older cards are superseded: what they showed is no longer what would run.
- **The queue moves on.** A gated task is passed over and the next task runs, so one untrusted file cannot hold up the whole queue.
- **Approve and run** trusts that exact content (for the task and for its file binding, so the next read keeps it trusted) and starts the task the way Run next does: in either mode and while paused. When the folder is busy, the card says when the task will start: on its own in One at a time, or by Run next in Manual.
- **Skip** leaves the content untrusted. No new card is asked for the same content, and the queue keeps passing over the task until its file changes. Run next on that task asks again.
- **A stale answer is refused.** If the file changed after the card was opened, Approve is refused with *"The task file changed since this was asked."* and a new card shows the new content.
- **Status when only gated tasks are left**: **Waiting for approval in the Inbox** while a card for one of them is open; otherwise **Next: <task> — needs approval**, and Run next opens its card.

### Inbox cards and badge

- **Two dispatcher cards**: the approval of outside content, and **<agent>'s queue is paused** (the task it paused on, the note when it says more than the line, and **Resume**). They sit among the asks, newest first, and a card the user answered stays on screen until they leave the Inbox.
- **The top-bar badge counts them.** Each one has a button only the user can press.
- **Cards for an agent that cannot work a queue** (disabled, or its folder gone) are not listed. Their rows are kept, so the agent comes back with them.

## What this deliberately does not do

- **No parallel runs in one folder**, and no "up to N" mode. Two agents editing one working tree at once is not safe without a worktree per task.
- **No dispatching for remote agents, the default model or unassigned tasks.** Those have their own execution path.
- **Nothing runs while Cinna is closed**, and run modes do not travel to the user's other devices.
- **No automatic retry** of a failed or unreported task. The user decides.
- **No gate on native tasks.** Only a task with a file can be written outside Cinna.

## Architecture Overview

```
Agent page Tasks tab / Tasks view control / task page Start / Inbox card
   -> taskDispatch:* , inbox:dispatch-gate -> taskDispatchService
taskDispatchService pass (mode change, Resume, task write, run closed, profile ready, 30 s tick)
   -> candidates -> gate? (task_dispatch_gates -> Inbox) | launch
   -> withRuntimeAgent slot -> taskExecutionService.start(continueInChat, onRunAccepted)
   -> markDispatchedRun + tasks.dispatch_agent_id
Turn end -> inboxService.endTurn: dispatched run -> leave it | dispatch-owned task -> settleOwnedTurn
   -> settleTask: pullFresh -> report rule -> continue | flag + pause (agent_task_dispatch)
Boot -> recoverInterrupted ; quit -> shutdown (settle nothing)
main -> taskDispatch:changed -> renderer invalidates queues, tasks, Inbox
```

## Integration Points

- [Folder Tasks](folder_tasks.md) — the files a bare agent's queue lives in, status words, `blocked_by`, and the two digests behind the gate.
- [Agent Task Tools](agent_task_tools.md) — `task_update`, the way an agent reports.
- [A Chat's First Ask Creates Its Task](chat_tasks.md) — the ordinary turn-end settlement that dispatched turns skip.
- [Autonomous Tasks](autonomous_tasks.md) — the runner slots the dispatcher shares.
- [The Inbox](inbox.md) — the approval and pause cards.
- [The Tasks View](../tasks_view/tasks_view.md) — the filtered view's Run next / Resume control.
- [Handover Bus](handover_bus.md) and [File Handovers](file_handovers.md) — delegated work starts through its own approval, never through the queue. `handover_report` is a report.
- [Jobs](../jobs/jobs.md) — a job-run task's attempt is mapped from the agent's report.
- [Technical details](task_dispatcher_tech.md).
