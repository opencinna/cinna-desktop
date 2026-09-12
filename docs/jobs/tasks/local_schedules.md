# Local Schedules

## Purpose

Run a kit agent's reviewed static prompt at matching times while Cinna is open and its profile is active. Each occurrence becomes an ordinary script Job attempt, so questions, Stop, history and interrupted recovery use the same task surfaces as manual work.

## Core Concepts

- **Declaration** — a named static_prompt entry in the kit manifest. Discovery, import, sync and enabling the agent do not authorize scheduled execution.
- **Local binding** — explicit opt-in for one profile, device, manifest identity and schedule name, with a reviewed definition and frozen timezone.
- **Occurrence** — one observed matching civil minute and its durable admission/result record. It retains the definition used even after later review.
- **Generated Job** — a local one-step script addressing the declaring folder by portable manifest identity. Its goal is the literal schedule prompt; default limits are twenty agent turns and sixty minutes.

## User Stories / Flows

1. Open a kit agent's **Schedules** tab. Inspect its cron, timezone and availability. Bare agents do not have this tab.
2. Press **Review and enable**, read the literal prompt and execution limits, then **Enable on this device**. Cancel creates no binding or Job. A rejected enable keeps the review visible.
3. At a later matching minute, main admits a Job attempt even when its conversation is closed. Open its task from the schedule's latest result or the Job history; answer questions in the Inbox.
4. Use the task's Stop or explicit Resume controls for admitted work. **Disable** prevents future occurrences and does not stop the current attempt.
5. If the folder declaration or generated Job changes, review it again before future admission. A new generated Job may replace the previous definition; its older attempts still count for overlap.

## Business Rules

- **Only a ready, effectively enabled kit agent with stable identity can declare local execution.** Names are unique, trimmed and 1–255 characters; prompts are nonblank and at most 64000 characters. Only static_prompt executes. Command/script-trigger declarations remain unsupported.
- **Review is bound to the actual profile and definition.** Main rereads the folder, requires exactly one matching name in the final snapshot, validates the definition and compares its revision/timezone. A stale dialog cannot authorize changed instructions or another profile. Missing, disabled, invalid or changed declarations and deleted/edited generated Jobs suspend future admission rather than choosing a replacement silently.
- **Cron uses five numeric fields.** Wildcards, lists, ranges and positive steps are accepted; Sunday is 0 or 7. Names, macros, seconds and special modifiers are refused. Restricted day-of-month and weekday fields use OR. An omitted timezone is resolved for review and frozen when enabled; later OS timezone changes do not move the schedule.
- **Only the current minute is considered.** Enablement records its minute, so the first possible run is later. Missed minutes are skipped after sleep, downtime or profile inactivity. A monotonic UTC watermark prevents clock rollback from repeating work; the civil-minute key prevents both copies of a fall daylight-saving minute from running. Spring gaps have no occurrence.
- **Unfinished work prevents overlap.** This includes saved questions, interruption, active cancellation, manual runs of the generated Job and unfinished attempts of its historical generated Jobs. A due but blocked occurrence records a skipped result instead of accumulating a queue of missed work.
- **Admission commits before execution.** Occurrence, tasks, chats, run and checkpoint commit together. Preparation failures roll back the attempt and record one failed observation. A committed attempt that cannot launch is interrupted for explicit review; restart never blindly replays its execution.
- **Consent stays on this device.** Bindings and occurrences do not sync and are removed with the profile. Generated Job definitions may sync, but this does not opt another device into execution. Only the activated profile admits new work; already admitted runs retain their captured scope.
- **Deletion performs runtime cleanup.** Deleting a Job run also removes its owned conversation and notifies the runner. A waiting script previously retained unanswerable gates after that deletion; cleanup now cancels its owned work and releases reservations so later occurrences are possible.

## Architecture Overview

Kit Schedules tab → reviewed local-schedule IPC → local binding and generated Job. Activated profile / minute timer / focus / wake → current-minute and overlap checks → occurrence plus script preparation transaction → post-commit launch → script task, Inbox and Job result.

## Integration Points

- [Technical details](local_schedules_tech.md) — storage, scheduler ordering, IPC and review checks.
- [Script execution](script_execution.md), [Jobs](../jobs/jobs.md) and [Inbox](inbox.md) — execution, history and human continuation.
- [Agent page](../../agents/local_agents/agents_tab.md) and [kit contract](../../agents/local_agents/kit_contract.md) — declaration source and controls.
- [Resource activation](../../core/resource_activation/resource_activation.md) — profile lifetime and provider readiness.

There is no operating-system scheduler, arbitrary Job selector, schedule editor, command execution or catch-up queue. Complete token accounting and protocol/new-driver cleanup remain separate work.
