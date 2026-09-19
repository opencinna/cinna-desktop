import type { TaskDelegationsDto } from '../../shared/delegations'
import { delegationRepo } from '../db/delegations'
import { taskRepo } from '../db/tasks'

/** Task-page reads have no dispatch side effects and never cross profile boundaries. */
export const delegationQueryService = {
  forTask(userId: string, taskId: string): TaskDelegationsDto {
    const task = taskRepo.getById(userId, taskId)
    if (!task || task.deletedAt) return { from: null, to: [] }
    const from = delegationRepo.byTaskId(userId, taskId)
    return {
      from: from ? delegationRepo.toDto(from) : null,
      to: delegationRepo.listForOriginTask(userId, taskId).map((row) => delegationRepo.toDto(row))
    }
  }
}
