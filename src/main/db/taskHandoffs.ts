import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { taskHandoffs, users } from './schema'
import type { TaskHandoffReceipt } from '../../shared/taskHandoff'

export const taskHandoffRepo = {
  unboundCreatePending(userId: string, adapterId: string): boolean {
    return getDb().select().from(taskHandoffs).where(eq(taskHandoffs.userId, userId)).all()
      .some(({ receipt }) => receipt.adapterId === adapterId &&
        (receipt.state === 'creating' || receipt.state === 'uncertain') && receipt.bindingPending)
  },
  get(userId: string, taskId: string): TaskHandoffReceipt | null {
    return getDb().select().from(taskHandoffs)
      .where(and(eq(taskHandoffs.userId, userId), eq(taskHandoffs.taskId, taskId))).get()?.receipt ?? null
  },
  put(userId: string, receipt: TaskHandoffReceipt): void {
    if (!getDb().select({ id: users.id }).from(users).where(eq(users.id, userId)).get()) {
      throw new Error('The profile owning this handoff was deleted.')
    }
    getDb().insert(taskHandoffs).values({ taskId: receipt.taskId, chatId: receipt.chatId, userId, receipt })
      .onConflictDoUpdate({ target: taskHandoffs.taskId, set: { receipt, chatId: receipt.chatId }, where: eq(taskHandoffs.userId, userId) }).run()
  },
  pendingForChat(userId: string, chatId: string): TaskHandoffReceipt | null {
    return getDb().select().from(taskHandoffs)
      .where(and(eq(taskHandoffs.userId, userId), eq(taskHandoffs.chatId, chatId))).all()
      .find(({ receipt }) => ['creating', 'executing', 'accepted_pending', 'uncertain'].includes(receipt.state))?.receipt ?? null
  },
  unresolvedForChat(userId: string, chatId: string): boolean {
    return this.pendingForChat(userId, chatId) !== null
  },
  unresolved(userId: string, taskId: string): boolean {
    const state = this.get(userId, taskId)?.state
    return state === 'creating' || state === 'executing' || state === 'accepted_pending' || state === 'uncertain'
  }
}
