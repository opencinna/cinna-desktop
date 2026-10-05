import { describe, expect, it } from 'vitest'
import type { TaskDto } from '../../../../shared/tasks'
import type { TaskBoardColumn } from '../../../../shared/folderTasks'
import { agentCards, boardMoveTargets, folderMoveTargets, withinTaskPeriod } from './tasksViewModel'
import { statusLockReason } from './TaskFormDialog'

/**
 * The move targets the board, its Move to menu and Edit task offer for a task
 * the dispatcher flagged (`blocked` with a `dispatchNote`), against the shared
 * rule main applies in `task:set-status`.
 */
const HERE = { executor: 'desktop', runsHere: true, runtime: undefined, remote: null } as const
const COLUMNS: TaskBoardColumn[] = [
  { label: 'Todo', category: 'backlog', status: 'new', droppable: true },
  { label: 'Up Next', category: 'ready', status: 'open', droppable: true },
  { label: 'Doing', category: 'active', status: 'in_progress', droppable: false },
  { label: 'Stuck', category: 'waiting', status: 'blocked', droppable: false },
  { label: 'Shipped', category: 'done', status: 'completed', droppable: true }
]
const FILE = {
  remote: { adapter: 'folder', id: 'folder:m1:t-1', key: 't-1', url: null } as unknown as TaskDto['remote'],
  file: { path: '/agents/ledger/.cinna/tasks/t-1.md', readOnlyFields: [], blockedBy: [] } as unknown as TaskDto['file']
}

describe('a task the dispatcher flagged', () => {
  it('offers Backlog, Ready and Done on the category board', () => {
    expect(boardMoveTargets({ ...HERE, dispatchNote: 'Ended without reporting' }, 'blocked')).toEqual(['backlog', 'ready', 'closed'])
  })

  it('offers the folder’s droppable columns on its folder board', () => {
    const targets = folderMoveTargets({ ...HERE, ...FILE, statusLabel: 'Stuck', dispatchNote: 'Ended without reporting' }, 'blocked', COLUMNS)
    expect(targets.map((column) => column.label)).toEqual(['Todo', 'Up Next', 'Shipped'])
  })

  it('keeps a blocked task without the note held: no targets', () => {
    expect(boardMoveTargets({ ...HERE, dispatchNote: null }, 'blocked')).toEqual([])
    expect(folderMoveTargets({ ...HERE, ...FILE, statusLabel: 'Stuck', dispatchNote: null }, 'blocked', COLUMNS)).toEqual([])
  })

  it('leaves the Edit task status unlocked, while an unflagged blocked task stays locked', () => {
    const task = { ...HERE, ...FILE, status: 'blocked', statusLabel: 'Stuck', dispatchNote: 'Ended without reporting' } as unknown as TaskDto
    expect(statusLockReason(task, ['open'])).toBeNull()
    expect(statusLockReason({ ...task, dispatchNote: null }, [])).toBe('Set in the task file by its agent.')
  })
})

describe('withinTaskPeriod', () => {
  const NOW = Date.UTC(2026, 9, 5, 12)
  const DAY = 24 * 60 * 60 * 1000
  const at = (status: TaskDto['status'], daysAgo: number): Pick<TaskDto, 'status' | 'updatedAt'> =>
    ({ status, updatedAt: new Date(NOW - daysAgo * DAY) })

  it('always lets Waiting, In progress and Ready through, however long they sat still', () => {
    // Mutation: apply the cutoff to every category and this fails.
    for (const status of ['blocked', 'in_progress', 'open'] as const) {
      for (const period of ['week', 'month', 'all'] as const) expect(withinTaskPeriod(at(status, 400), period, NOW)).toBe(true)
    }
  })

  it('lets Backlog and Done through only inside the period, by last change', () => {
    for (const status of ['new', 'refining', 'completed', 'error'] as const) {
      expect(withinTaskPeriod(at(status, 6.9), 'week', NOW)).toBe(true)
      expect(withinTaskPeriod(at(status, 7), 'week', NOW)).toBe(true)
      expect(withinTaskPeriod(at(status, 7.1), 'week', NOW)).toBe(false)
      expect(withinTaskPeriod(at(status, 29), 'month', NOW)).toBe(true)
      expect(withinTaskPeriod(at(status, 31), 'month', NOW)).toBe(false)
      expect(withinTaskPeriod(at(status, 4000), 'all', NOW)).toBe(true)
    }
  })
})

describe('agentCards', () => {
  const t = (id: string, overrides: Partial<TaskDto>): TaskDto => ({
    id, title: id, status: 'new', updatedAt: new Date(Date.UTC(2026, 9, 1)),
    assignee: { kind: 'model', agentId: null, name: null }, ...overrides
  }) as unknown as TaskDto
  const of = (agentId: string, name: string): Partial<TaskDto> => ({ assignee: { kind: 'agent', agentId, name } as TaskDto['assignee'] })
  const NAMES: Record<string, string> = { w: 'writer', r: 'Reviewer', e: 'Editor', gone: 'Archivist' }
  const name = (id: string): string | undefined => NAMES[id]

  it('draws a card only for an agent with a task, A→Z, then No agent only when an unassigned task exists', () => {
    // Mutation: add a card for every known agent and this fails — Editor has no task.
    const tasks = [t('a', of('w', 'writer')), t('b', of('r', 'Reviewer'))]
    expect(agentCards(tasks, name).map((card) => [card.name, card.tasks.length])).toEqual([['Reviewer', 1], ['writer', 1]])
    const withUnassigned = agentCards([...tasks, t('u', {})], name)
    expect(withUnassigned.map((card) => card.key)).toEqual(['agent:r', 'agent:w', 'none'])
    expect(withUnassigned.at(-1)).toMatchObject({ agentId: null, name: 'No agent', tasks: [expect.objectContaining({ id: 'u' })] })
    expect(agentCards([], name)).toEqual([])
  })

  it('names a card by the agents list, else the task, else Unnamed agent', () => {
    const cards = agentCards([
      t('g', of('gone', 'Old name')),
      t('x', of('x', 'Remote helper')),
      t('y', { assignee: { kind: 'agent', agentId: 'y', name: null } as TaskDto['assignee'] })
    ], name)
    expect(cards.map((card) => card.name)).toEqual(['Archivist', 'Remote helper', 'Unnamed agent'])
  })

  it('orders a card’s tasks by the list’s sections, the last changed first within one', () => {
    const day = (d: number): Date => new Date(Date.UTC(2026, 9, d))
    const [card] = agentCards([
      t('done', { ...of('w', 'writer'), status: 'completed', updatedAt: day(4) }),
      t('back-old', { ...of('w', 'writer'), status: 'new', updatedAt: day(1) }),
      t('back-new', { ...of('w', 'writer'), status: 'new', updatedAt: day(3) }),
      t('ready', { ...of('w', 'writer'), status: 'open', updatedAt: day(1) }),
      t('wait', { ...of('w', 'writer'), status: 'blocked', updatedAt: day(1) })
    ], name)
    expect(card.tasks.map((task) => task.id)).toEqual(['wait', 'ready', 'back-new', 'back-old', 'done'])
  })
})
