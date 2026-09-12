import { scriptRuntimeRepo } from '../db/scriptRuntimes'
import { scriptRuntimeService } from './scriptRuntimeService'
import { taskRunnerService } from './taskRunnerService'

/** Public lifecycle/control dispatch; individual engines retain their own checkpoints. */
export const taskRuntimeService = {
  recover(): void { taskRunnerService.recover(); scriptRuntimeService.recover() },
  interruptAll(reason: string): void { taskRunnerService.interruptAll(reason); scriptRuntimeService.interruptAll(reason) },
  resume(userId: string, taskId: string): void {
    if (scriptRuntimeRepo.owner(userId, taskId)) scriptRuntimeService.resume(userId, taskId)
    else taskRunnerService.resume(userId, taskId)
  },
  cancel(userId: string, taskId: string): void {
    if (scriptRuntimeRepo.owner(userId, taskId)) scriptRuntimeService.cancel(userId, taskId)
    else taskRunnerService.cancel(userId, taskId)
  }
}
