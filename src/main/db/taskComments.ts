import { and, asc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { redactingRepository } from '../security/serviceCredentialRedaction'
import { getDb } from './client'
import { taskComments } from './schema'

export type TaskCommentRow = typeof taskComments.$inferSelect

/**
 * Comments on a task (`task_comment`). Device-local: not a synced collection,
 * and gone with the task row (`ON DELETE CASCADE`; a soft-deleted task keeps
 * them until it is hard-deleted). Bodies are redacted on the way in, as task
 * fields are.
 */
const rawTaskCommentRepo = {
  create(input: {
    userId: string
    taskId: string
    authorKind: 'agent' | 'user'
    authorAgentId: string | null
    body: string
    remoteStatus?: TaskCommentRow['remoteStatus']
  }): TaskCommentRow {
    const row: TaskCommentRow = {
      id: nanoid(),
      taskId: input.taskId,
      userId: input.userId,
      authorKind: input.authorKind,
      authorAgentId: input.authorAgentId,
      body: input.body,
      remoteStatus: input.remoteStatus ?? null,
      createdAt: new Date()
    }
    getDb().insert(taskComments).values(row).run()
    return row
  },

  /** Oldest first: a comment thread reads top to bottom. */
  listForTask(userId: string, taskId: string): TaskCommentRow[] {
    return getDb().select().from(taskComments)
      .where(and(eq(taskComments.userId, userId), eq(taskComments.taskId, taskId)))
      .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
      .all()
  },

  setRemoteStatus(userId: string, id: string, remoteStatus: TaskCommentRow['remoteStatus']): void {
    getDb().update(taskComments).set({ remoteStatus })
      .where(and(eq(taskComments.userId, userId), eq(taskComments.id, id))).run()
  }
}

export const taskCommentRepo = redactingRepository(rawTaskCommentRepo, ['create'])
