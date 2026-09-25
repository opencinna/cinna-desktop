# Local Schedules

## Purpose

Create recurring schedules for a local Job from its detail page, or prompt/script schedules for a kit agent from its **Schedules** tab. Schedules run while Cinna is open and the relevant profile is active. If scheduled times pass while Cinna is closed, asleep, or using another profile, each overdue schedule runs once when it becomes available again, then resumes its normal cadence.

Local scheduling does not install an operating-system service. Agent schedule definitions travel with the agent; Job schedule rules and all execution permission stay on this device and profile. Syncing a Job never turns its schedule on elsewhere.

## Schedule a local Job

Open a local Job and add a schedule in its **Schedules** section. Name the schedule,
choose the same workday presets, custom weekdays/hours, or advanced cron described
below, and review the timezone and next run. The schedule starts the saved Job's
work: its prompt, routing, attached agents, tools, mode, script, and execution
limits remain the Job's configuration. There is no second prompt or command to
maintain in the timing form.

Review the Job's execution configuration before enabling. Each due occurrence
creates a new task and run under that same Job, visible in its ordinary task
history as well as the schedule's execution history. The main process starts it
even when the Job page and conversation are closed. Normal tasks, explicit
coordinator Jobs, and script Jobs keep their existing execution behavior and
controls; Cinna Task Jobs do not expose this local schedule control.

Changes to the Job's reviewed execution definition or attached agents/tools
suspend its schedules until reviewed again. A stale timing form cannot authorize
a different Job definition. Creating, editing, or re-enabling a schedule starts
strictly in the future. Imported or synced Job definitions carry no local timing
rule or scheduling permission.

All schedules attached to a Job share its overlap protection. Any unfinished
manual or scheduled run—including waiting questions, interruption, and stopping
work—blocks another scheduled attempt. A due period records one skip and moves
to the next future time. Multiple schedules never create a backlog behind the
same Job. Disable or delete a schedule to prevent future admission; existing
attempts keep their normal Stop and recovery controls. Deleting the source Job
also prevents its schedules from starting new work.

Job schedule rules, enablement, saved timezone, editor metadata, due cursor, and
receipts are device/profile-local. They use the same single-catch-up, daylight
saving, clock rollback, and active-profile rules as agent schedules.

## Create and edit an agent schedule

Use **New schedule**, give the schedule a unique name, and choose **Prompt scheduler** or **Script scheduler**. A prompt scheduler starts new agent work using the exact prompt entered. A script scheduler runs a shell command in the agent's folder; it can also use an existing `/run:<name>` command. The execution type stays fixed after creation.

Choose one of these timing options:

| Option | Runs at | Effective cron |
| --- | --- | --- |
| Workday morning | Monday–Friday, 08:00 | `0 8 * * 1-5` |
| Workday hourly | Monday–Friday, every hour from 09:00 through 18:00 inclusive | `0 9-18 * * 1-5` |
| Custom | Every selected whole hour on every selected weekday | Compiled from the selections |
| CRON advanced | The entered five-field numeric rule | The entered rule |

Workdays do not include a public-holiday calendar. Custom presents Monday–Sunday and all 24 hours in two rows of 12. Select at least one day and one hour. There is no per-day timetable or minute picker in Custom. Advanced retains minutes, month/day constraints, and steps when a schedule is reopened.

Check the timing summary, timezone, next scheduled time, and exact prompt or command before saving. The timezone defaults to the current system timezone and is saved explicitly; changing the computer's timezone later does not move existing schedules. Presets copy their timing into the schedule, so future changes to a template do not change saved schedules.

Saving with execution enabled reviews the definition in that form. Imported or externally changed definitions require **Review and enable**. A save conflict keeps the form's edits. If the manifest was saved but local enablement could not finish, the saved definition needs review before execution.

A schedule that shows a problem — an invalid cron, a missing command, a duplicate name — can still be opened, saved, and deleted from the editor, because the editor is how the problem gets fixed. It cannot be enabled until the problem is gone.

Enabling is a device choice, not part of the definition. The editor never writes an `enabled` field into `cinna-agent.json`. If the agent's author set `enabled: false` on an entry, the editor keeps that value and the entry stays editable. Saving it with the enable toggle off updates it without a warning. Saving it with the toggle on saves the definition and warns that it cannot be enabled, because the author's `false` takes precedence over this device's opt-in. Only the author can lift it, by changing the manifest.

Each enablement is tied to the exact definition it reviewed. A prompt schedule runs through a generated Job, and that Job is reused only while the definition is unchanged. If you save an edit with the schedule disabled and enable it later, Cinna generates a fresh Job for the new definition. It never re-enables the Job built for the old definition. Earlier generated Jobs remain in the schedule's history and overlap checks.

## Execution and history

A prompt occurrence becomes an ordinary one-step script Job attempt, with twenty agent turns and sixty minutes as defaults. Each occurrence starts new work. Open its task from schedule history, answer questions in the Inbox, and use the usual Stop or explicit recovery controls.

A script runs with the agent's command environment and folder lock, with a five-minute timeout and bounded output collection. If the agent is busy when the occurrence is due (a chat turn, an editor save, or another command), the script waits for the agent to become free instead of failing. The five-minute limit starts only when the command itself starts. While a script is waiting, its occurrence counts as unfinished, so later due times are skipped in the usual way. History retains its exit code, stdout, stderr, intended due time, and actual execution times.

| Script result | What happens |
| --- | --- |
| Exit 0 and trimmed stdout is exactly `OK` | Quiet success; no agent task, conversation, or model call |
| Exit 0, stdout `OK`, and stderr contains a warning | Quiet success; stderr remains in history |
| Blank stdout, lowercase `ok`, other output, or a nonzero exit | One agent task receives the command's execution context |
| Spawn failure or timeout | Execution error; this occurrence is not automatically retried |
| Stopped while still waiting for the agent (Stop, sleep, profile switch, or quit) | Cancelled with "Stopped before the command started"; nothing ran, so later occurrences are not held back |
| Stopped after the command started | Stop records a cancellation. Sleep, a profile switch, or quit records an interruption, which needs review. The command is not automatically repeated |
| Uncertain process outcome (no exit code) | Interruption, which needs review before later runs; the command is not automatically repeated |

Truncated stdout cannot qualify as exact `OK`. Command output passed to the follow-up task is identified as execution output. A script's follow-up uses the same agent and normal task controls. A running command has Stop in its history even when no task exists.

**Disable** prevents future occurrences without stopping admitted work. Deleting a definition also prevents new admission; existing work retains its history and ordinary Stop/recovery lifecycle. Renaming a schedule in the editor preserves its history. Renaming it outside Cinna creates a new, unreviewed declaration.

## Catch-up and overlap

Enabling or re-enabling a schedule, or reviewing a changed execution definition, starts its timing strictly after the current time. Disabled periods and time before first enablement do not create overdue work. Upgrading from the former scheduler also starts a future baseline, without turning old downtime into owed executions.

After a later interruption, the oldest due instant represents all eligible times through recovery:

- Five missed weekday mornings produce one catch-up, followed by the next future weekday at 08:00.
- Waking at 13:40 after missing hourly runs from 09:00 through 13:00 produces one catch-up, followed by 14:00.
- Opening on Saturday after missing Friday morning still runs one catch-up; Monday 08:00 remains next.
- Recovering exactly at a scheduled minute includes that minute in the same catch-up.

Each overdue schedule is considered separately. Running work, saved questions, stopping, interrupted work, or an unfinished manual/historical run of its source or generated Job prevents overlap. A blocked due period records one skip and advances to a future time; completion does not release a backlog. An admitted error consumes its occurrence, so repeated startup, focus, and resume events do not retry it.

Unavailable folders leave one overdue schedule pending. Changed, removed, or invalid definitions suspend future execution for review. A crash after admission can require explicit task recovery, but never silently repeats an uncertain command. Durable records prevent duplicate admission; they cannot guarantee exactly-once effects in external systems.

## Definition and consent rules

- Agent schedules require kit agents with stable manifest identity. Bare folders have no agent schedule store in this version; a local Job can still be scheduled independently. The agent must be effectively enabled and runnable; missing credential values can warn, while invalid or unsupported contracts prevent execution.
- `cinna-agent.json` owns the named `schedules[]` definitions. Names are unique, trimmed, and 1–255 characters. Prompt schedules require a nonblank literal prompt of at most 64,000 characters, without a hidden entrypoint fallback.
- Cron has five numeric fields: minute, hour, day of month, month, weekday. Numbers, wildcards, lists, ranges, positive steps, and Sunday 0/7 are supported. Restricted day-of-month and weekday fields use OR. Seconds, weekday names, macros, and Quartz modifiers are unsupported; impossible rules are rejected.
- Spring-forward times that do not exist are skipped. A repeated fall-back civil minute runs once. Clock rollback cannot repeat admitted work; a forward jump can create one catch-up.
- Consent binds the actual profile, reviewed definition, saved timezone, and resolved catalog command. Editing a catalog entry requires review; ordinary script file contents remain the agent's code. Generated Jobs cannot be silently replaced after deletion or editing.
- Bindings, due cursors, editor metadata, and execution receipts do not sync. Importing a definition, syncing a generated Job, or enabling an agent never authorizes scheduling on another device.

## Integration points

- [Technical details](local_schedules_tech.md) — durable admission, storage, and review checks.
- [Script execution](script_execution.md), [Jobs](../jobs/jobs.md), and [Inbox](inbox.md) — agent work and human continuation.
- [Agent page](../../agents/local_agents/agents_tab.md) and [kit contract](../../agents/local_agents/kit_contract.md) — definition ownership.
- [Resource activation](../../core/resource_activation/resource_activation.md) — profile lifetime and readiness.

Personal template management, bare-agent scheduling, manual Run now, and automatic retry policies are outside this version.
