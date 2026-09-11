/**
 * The path a status push takes to a remote that validates transitions.
 *
 * **A remote is told the steps, not the destination**, and that is §5.12 rule 2
 * of the phase plan rather than a preference. cinna-core validates every status
 * write against the same table `shared/taskStatus.ts` copies, and
 * `VALID_TRANSITIONS['new']` reaches neither `completed` nor `error` — so a
 * desktop job that starts and finishes in two seconds has a local task that
 * went `new → completed` in one step and a remote copy still sitting at `new`.
 * Pushing the destination 400s. Pushing `in_progress` and then `completed`
 * works.
 *
 * Getting it wrong is the single most predicted bug in this phase, and it is
 * predicted to be *misread*: the 400 arrives on every completed task, looks
 * like a network fault, and — before the step-8 review — would have been
 * classified as `not_ours` and unbound the task permanently. `taskStatusPath`
 * and `taskStatusPath.test.ts` exist for this and nothing else.
 *
 * Pure, and deliberately in main rather than in `shared/`: the renderer has no
 * business knowing a remote exists, and this is the only rule in the phase that
 * is about a *remote's* table rather than the desktop's own.
 */

import {
  REMOTE_WRITABLE_STATUSES,
  VALID_TRANSITIONS,
  type TaskStatus
} from '../../shared/taskStatus'

/**
 * The statuses to push, in order, to move a remote from `from` to `to`.
 *
 * - `[]` — the remote is already there. Not a failure; nothing to send.
 * - `[a, b, …]` — push each in turn, stopping at the first refusal. Every entry
 *   is in {@link REMOTE_WRITABLE_STATUSES}, so nothing the route would reject
 *   ever leaves the process.
 * - `null` — **there is no path**, and no number of retries will make one. The
 *   caller drops the intent rather than queueing it for ever.
 *
 * Two shapes of `null` are worth naming, because they look like bugs and are
 * not:
 *
 *  - `to` is outside `REMOTE_WRITABLE_STATUSES` — `archived` (which is
 *    `adapter.archive()`, a different route), `new` (the create state) or
 *    `refining` (cinna's own flow, which the desktop does not drive).
 *  - the remote is in a terminal status the desktop wants to reopen:
 *    `completed → in_progress` is a legal *local* retry (`error → in_progress`
 *    is in the table; `completed` reaches only `archived`), and there is simply
 *    no way to say it to the remote. The local task is right and the remote
 *    copy stays where it is, which is better than an unending 400.
 *
 * `from` is the *remote's* status, which is why it may be one no push could
 * produce: a task cinna created is `new`, and a task its own session handlers
 * moved may be anywhere at all.
 */
export function taskStatusPath(from: TaskStatus, to: TaskStatus): TaskStatus[] | null {
  if (from === to) return []
  if (!REMOTE_WRITABLE_STATUSES.includes(to)) return null

  // Breadth-first, so the answer is the **shortest** path — and the reason is
  // stronger than tidiness. On cinna a step is not a log line, it is a write:
  // `update_task_status` inserts a `TaskStatusHistory` row, posts a
  // `status_change` comment into the task's feed, and stamps `executed_at` /
  // `completed_at` / `archived_at`. A longer route does not record a richer
  // history, it records a **false** one:
  //
  //  - a task cancelled before it ever ran goes `new → cancelled` in one step,
  //    and the remote never claims work started. Routed through `in_progress`,
  //    cinna stamps `executed_at` and the web says a task nobody ran executed
  //    at 10:04;
  //  - a task that was `blocked` and is now `completed` omits the block,
  //    correctly. Pushing it raises a `task_blocked` activity with
  //    `action_required` and lights the user's own inbox for a block that was
  //    resolved minutes ago. Replaying a resolved block is worse than not
  //    recording it.
  //
  // What is lost is the *local* history — blocked episodes, a retry after an
  // error. If that is wanted on the remote the channel is a comment, not a
  // status replay.
  //
  // The transition table's arrays have a fixed order, so the answer is
  // deterministic — a test pins the two-step ones by value.
  const previous = new Map<TaskStatus, TaskStatus>()
  const seen = new Set<TaskStatus>([from])
  const queue: TaskStatus[] = [from]

  while (queue.length > 0) {
    const current = queue.shift() as TaskStatus
    for (const next of VALID_TRANSITIONS[current]) {
      if (seen.has(next)) continue
      // Every step is itself a push, so every step has to be pushable. This is
      // what keeps `archived` out of the middle of a path — it is reachable
      // from everywhere and reaches nothing, so an unfiltered search would
      // happily route through it and file the task away on the way past.
      if (!REMOTE_WRITABLE_STATUSES.includes(next)) continue
      seen.add(next)
      previous.set(next, current)
      if (next === to) return rebuild(previous, from, to)
      queue.push(next)
    }
  }
  return null
}

function rebuild(
  previous: Map<TaskStatus, TaskStatus>,
  from: TaskStatus,
  to: TaskStatus
): TaskStatus[] {
  const path: TaskStatus[] = []
  let step: TaskStatus | undefined = to
  while (step !== undefined && step !== from) {
    path.unshift(step)
    step = previous.get(step)
  }
  return path
}
