import { describe, expect, it } from 'vitest'
import { taskStatusPath } from './taskStatusPath'
import {
  REMOTE_WRITABLE_STATUSES,
  TASK_STATUSES,
  VALID_TRANSITIONS,
  type TaskStatus
} from '../../shared/taskStatus'

/**
 * The test §5.12 rule 2 exists for.
 *
 * A desktop job that finishes in two seconds leaves a local task at `completed`
 * and a remote copy at `new`, and cinna-core refuses `new → completed`. If the
 * push sends the destination, **every** completed task 400s — on a status code
 * that also means "not your task", which is how a bug in one line becomes a
 * permanently unbound task rather than a retry.
 *
 * Written before the adapter that needs it, deliberately.
 */
describe('the path a status push takes', () => {
  it('sends two requests for a task that went new → completed locally', () => {
    // The single most predicted failure in the phase, by name.
    expect(taskStatusPath('new', 'completed')).toEqual(['in_progress', 'completed'])
  })

  it('sends two for one that failed before it started', () => {
    expect(taskStatusPath('new', 'error')).toEqual(['in_progress', 'error'])
  })

  /**
   * Not tidiness — truthfulness. Every step cinna takes stamps a timestamp and
   * posts a comment, so a detour records something that did not happen.
   */
  it('does not route a task nobody ran through “in progress”', () => {
    // `in_progress` would make cinna stamp `executed_at`, and the web would say
    // a task that was called off before anyone touched it executed at 10:04.
    expect(taskStatusPath('new', 'cancelled')).toEqual(['cancelled'])
    expect(taskStatusPath('open', 'cancelled')).toEqual(['cancelled'])
  })

  it('does not replay a block that is already over', () => {
    // Pushing `blocked` raises a `task_blocked` activity with `action_required`
    // and lights the user's own inbox for something resolved minutes ago.
    expect(taskStatusPath('in_progress', 'completed')).not.toContain('blocked')
    expect(taskStatusPath('new', 'completed')).not.toContain('blocked')
  })

  it('sends one where the remote can take the step', () => {
    expect(taskStatusPath('new', 'in_progress')).toEqual(['in_progress'])
    expect(taskStatusPath('in_progress', 'completed')).toEqual(['completed'])
    expect(taskStatusPath('in_progress', 'blocked')).toEqual(['blocked'])
    expect(taskStatusPath('blocked', 'in_progress')).toEqual(['in_progress'])
    // `cancelled` is reachable from `new` directly — a task called off before
    // anyone touched it never pretends to have been in progress.
    expect(taskStatusPath('new', 'cancelled')).toEqual(['cancelled'])
  })

  it('sends nothing when the remote is already there', () => {
    for (const status of TASK_STATUSES) {
      expect(taskStatusPath(status, status)).toEqual([])
    }
  })

  it('routes out of a status the desktop can only reach by pulling', () => {
    // `refining` is cinna's own flow. The desktop never writes it, but a
    // replica can arrive in it, and work continuing here has to be sayable.
    expect(taskStatusPath('refining', 'in_progress')).toEqual(['in_progress'])
    expect(taskStatusPath('refining', 'completed')).toEqual(['in_progress', 'completed'])
  })

  it('refuses a destination the route would not accept', () => {
    // Not a path problem — a vocabulary one. `archived` has its own route
    // (`adapter.archive()`), `new` is the create state, `refining` is cinna's.
    expect(taskStatusPath('in_progress', 'archived')).toBeNull()
    expect(taskStatusPath('error', 'new')).toBeNull()
    expect(taskStatusPath('new', 'refining')).toBeNull()
  })

  it('refuses to reopen a remote that has finished, rather than retrying for ever', () => {
    // `completed → in_progress` is a legal *local* retry; the remote's table
    // has no way to say it (`completed` reaches only `archived`). The answer is
    // null so the caller drops the intent instead of queueing a 400 per poll.
    expect(taskStatusPath('completed', 'in_progress')).toBeNull()
    expect(taskStatusPath('cancelled', 'in_progress')).toBeNull()
    // `error` is the one terminal-looking status that *is* reopenable.
    expect(taskStatusPath('error', 'in_progress')).toEqual(['in_progress'])
  })

  /**
   * The property, not the examples: whatever the path, every step is a legal
   * transition from the one before it *and* a status the route accepts. This is
   * what would catch a search that routed through `archived` — reachable from
   * everywhere, filing the task away on the way past.
   */
  it('only ever emits steps the remote can both take and accept', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const path = taskStatusPath(from, to)
        if (path === null) continue
        let current: TaskStatus = from
        for (const step of path) {
          expect(REMOTE_WRITABLE_STATUSES, `${from} → ${to} pushes ${step}`).toContain(step)
          expect(VALID_TRANSITIONS[current], `${from} → ${to} steps ${current} → ${step}`).toContain(
            step
          )
          current = step
        }
        expect(current).toBe(path.length === 0 ? from : to)
      }
    }
  })

  it('never takes a longer way round than it has to', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const path = taskStatusPath(from, to)
        if (path === null) continue
        // Nine statuses; no shortest path can be longer than the writable set.
        expect(path.length).toBeLessThanOrEqual(REMOTE_WRITABLE_STATUSES.length)
        // And no status appears twice — a cycle in a shortest path is a bug in
        // the search, not a longer route.
        expect(new Set(path).size).toBe(path.length)
      }
    }
  })
})
