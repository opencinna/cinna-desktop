import { describe, expect, it } from 'vitest'
import type { TaskDto } from '../../../../shared/tasks'
import type { TaskBoardColumn } from '../../../../shared/folderTasks'
import { boardMoveTargets, folderMoveTargets } from './tasksViewModel'
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
