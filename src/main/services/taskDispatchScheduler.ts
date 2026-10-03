import type { RunScope } from './runExecutionService'
import { createLogger } from '../logger/logger'

const logger = createLogger('task-dispatch')

/**
 * Start and stop the task dispatcher with the active profile, beside the
 * other schedulers `auth/activation.ts` drives.
 *
 * The import is dynamic for the reason `handoverScheduler`'s is: the
 * dispatcher imports the execution stack, which imports activation. The
 * generation keeps a late-resolving start from reviving a profile that has
 * since been switched away from.
 */
let generation = 0

export const taskDispatchScheduler = {
  start(scope: RunScope): void {
    const mine = ++generation
    void import('./taskDispatchService')
      .then(({ taskDispatchService }) => { if (mine === generation) taskDispatchService.start(scope) })
      .catch((error) => logger.warn('the task dispatcher could not start', { error: String(error) }))
  },

  stop(): void {
    generation += 1
    void import('./taskDispatchService')
      .then(({ taskDispatchService }) => taskDispatchService.stop())
      .catch((error) => logger.warn('the task dispatcher could not stop', { error: String(error) }))
  }
}
