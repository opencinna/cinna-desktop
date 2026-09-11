import { describe, expect, it } from 'vitest'
import type { RunState } from './runEvents'
import {
  canTransition,
  DEFAULT_TASK_STATUS,
  isTaskStatus,
  parseTaskStatus,
  REMOTE_WRITABLE_STATUSES,
  TASK_STATUSES,
  taskStatusForRunState,
  VALID_TRANSITIONS,
  type TaskStatus
} from './taskStatus'

/**
 * cinna-core `InputTaskStatus.VALID_TRANSITIONS`, transcribed from
 * `backend/app/models/tasks/input_task.py:41` at `793782a3` — independently of
 * the module under test, which is the only thing that makes this a pin rather
 * than a tautology. If the server's table changes, change *this* literal first
 * and watch the copy fail.
 */
const CINNA_CORE_VALID_TRANSITIONS: Record<string, string[]> = {
  new: ['refining', 'open', 'in_progress', 'cancelled', 'archived'],
  refining: ['new', 'open', 'in_progress', 'archived'],
  open: ['in_progress', 'cancelled', 'archived'],
  in_progress: ['completed', 'blocked', 'cancelled', 'error', 'archived'],
  blocked: ['in_progress', 'cancelled', 'archived'],
  completed: ['archived'],
  error: ['new', 'in_progress', 'archived'],
  cancelled: ['archived'],
  archived: []
}

/** cinna-core `InputTaskStatus.ALL_STATUSES`, same source. */
const CINNA_CORE_ALL_STATUSES = [
  'new',
  'refining',
  'open',
  'in_progress',
  'blocked',
  'completed',
  'error',
  'cancelled',
  'archived'
]

const sorted = (xs: readonly string[]): string[] => [...xs].sort()

describe('the vocabulary is cinna-core’s', () => {
  it('has exactly cinna-core’s statuses', () => {
    expect(sorted(TASK_STATUSES)).toEqual(sorted(CINNA_CORE_ALL_STATUSES))
  })

  it('copies cinna-core’s transition table exactly', () => {
    const copied: Record<string, string[]> = {}
    for (const status of TASK_STATUSES) copied[status] = sorted(VALID_TRANSITIONS[status])

    const source: Record<string, string[]> = {}
    for (const [status, targets] of Object.entries(CINNA_CORE_VALID_TRANSITIONS)) {
      source[status] = sorted(targets)
    }

    expect(copied).toEqual(source)
  })

  it('names only known statuses on both sides of every transition', () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      expect(isTaskStatus(from)).toBe(true)
      for (const to of targets) expect(isTaskStatus(to)).toBe(true)
    }
  })

  it('does not lose the legacy aliases as statuses — they are rewrites, not values', () => {
    expect(isTaskStatus('running')).toBe(false)
    expect(isTaskStatus('pending_input')).toBe(false)
  })

  it('starts tasks in the server’s create state', () => {
    expect(DEFAULT_TASK_STATUS).toBe('new')
  })
})

describe('canTransition', () => {
  it('allows every step the table lists', () => {
    for (const from of TASK_STATUSES) {
      for (const to of VALID_TRANSITIONS[from]) {
        expect(canTransition(from, to)).toBe(true)
      }
    }
  })

  it('refuses every step the table omits', () => {
    for (const from of TASK_STATUSES) {
      const allowed = new Set<string>([from, ...VALID_TRANSITIONS[from]])
      for (const to of TASK_STATUSES) {
        if (allowed.has(to)) continue
        expect(canTransition(from, to)).toBe(false)
      }
    }
  })

  it('treats a no-op as allowed, so callers need no special case', () => {
    for (const status of TASK_STATUSES) expect(canTransition(status, status)).toBe(true)
  })

  it('refuses the ladder jump a finished-in-two-seconds run would attempt', () => {
    // The reason a remote push sends the path and not the destination (§5.12 rule 2).
    expect(canTransition('new', 'completed')).toBe(false)
    expect(canTransition('new', 'error')).toBe(false)
    expect(canTransition('new', 'blocked')).toBe(false)
    expect(canTransition('new', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'completed')).toBe(true)
  })

  it('lets nothing out of archived', () => {
    for (const to of TASK_STATUSES) {
      if (to === 'archived') continue
      expect(canTransition('archived', to)).toBe(false)
    }
  })

  it('lets everything into archived', () => {
    for (const from of TASK_STATUSES) expect(canTransition(from, 'archived')).toBe(true)
  })
})

describe('REMOTE_WRITABLE_STATUSES', () => {
  it('is the server’s allowed_user_statuses set', () => {
    expect(sorted(REMOTE_WRITABLE_STATUSES)).toEqual(
      sorted(['open', 'in_progress', 'blocked', 'completed', 'error', 'cancelled'])
    )
  })

  it('is a strict subset of the vocabulary', () => {
    for (const status of REMOTE_WRITABLE_STATUSES) expect(isTaskStatus(status)).toBe(true)
    expect(REMOTE_WRITABLE_STATUSES.length).toBeLessThan(TASK_STATUSES.length)
  })

  it('excludes the three the route refuses, each for its own reason', () => {
    // `new` is the create state, `refining` belongs to the refine flow,
    // `archived` has POST /{id}/archive because it owns archived_at.
    expect(REMOTE_WRITABLE_STATUSES).not.toContain('new')
    expect(REMOTE_WRITABLE_STATUSES).not.toContain('refining')
    expect(REMOTE_WRITABLE_STATUSES).not.toContain('archived')
  })
})

describe('parseTaskStatus', () => {
  it.each(TASK_STATUSES)('takes %s as itself', (status) => {
    expect(parseTaskStatus(status)).toBe(status)
  })

  it.each([
    ['a status from a newer server', 'awaiting_review'],
    ['a legacy alias the server no longer emits', 'running'],
    ['empty', ''],
    ['null', null],
    ['undefined', undefined]
  ])('maps %s to in_progress rather than throwing', (_label, raw) => {
    expect(parseTaskStatus(raw)).toBe('in_progress')
  })

  it('falls back to the one status every ending is still reachable from', () => {
    // Why `in_progress` and not `new`: guessing `new` would let the desktop
    // attempt transitions the server refuses. From `in_progress` every way a
    // task can end is one legal step away.
    const fallback = parseTaskStatus('something_new')
    for (const ending of ['completed', 'error', 'cancelled', 'blocked', 'archived'] as const) {
      expect(canTransition(fallback, ending)).toBe(true)
    }
  })
})

describe('taskStatusForRunState', () => {
  const EVERY_RUN_STATE: Record<RunState, TaskStatus> = {
    submitted: 'open',
    working: 'in_progress',
    needs_input: 'blocked',
    completed: 'completed',
    failed: 'error',
    canceled: 'cancelled',
    rejected: 'cancelled',
    unknown: 'in_progress'
  }

  it.each(Object.entries(EVERY_RUN_STATE) as [RunState, TaskStatus][])(
    'maps %s to %s',
    (state, expected) => {
      expect(taskStatusForRunState(state)).toBe(expected)
    }
  )

  it('never produces a status the desktop cannot own', () => {
    // `refining` and `archived` are human gestures; no run can put a task there.
    for (const state of Object.keys(EVERY_RUN_STATE) as RunState[]) {
      expect(taskStatusForRunState(state)).not.toBe('refining')
      expect(taskStatusForRunState(state)).not.toBe('archived')
    }
  })

  it('produces only statuses a bound remote would accept', () => {
    for (const state of Object.keys(EVERY_RUN_STATE) as RunState[]) {
      expect(REMOTE_WRITABLE_STATUSES).toContain(taskStatusForRunState(state))
    }
  })
})
