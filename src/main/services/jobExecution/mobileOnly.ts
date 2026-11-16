import type { JobRow } from '../../db/jobs'
import { JobError } from '../../errors'
import { isAssistantJobMode } from '../../../shared/jobMode'

/**
 * A job mobile runs as the Assistant (manifest `modeName` `@assistant`) never
 * runs on this device: the desktop has no Assistant, and running it on the
 * default chat mode instead would do different work under the same name.
 *
 * The renderer disables every Run control for such a job (`runsOnMobile` on the
 * DTO); this is the backstop every run entry point calls, so a stale list
 * cannot start one. The sentence is the wire contract — a `DomainError.code`
 * does not survive IPC (`ipc/_wrap.ts`).
 */
export const RUNS_ON_MOBILE_MESSAGE =
  "This job runs on mobile as the Assistant, so it can't run on this device. Pick a desktop mode in Edit to run it here."

export function jobRunsOnMobile(job: Pick<JobRow, 'syncDeps'>): boolean {
  return isAssistantJobMode(job.syncDeps?.modeName)
}

export function refuseMobileOnlyJob(job: Pick<JobRow, 'syncDeps'>): void {
  if (jobRunsOnMobile(job)) throw new JobError('runs_on_mobile', RUNS_ON_MOBILE_MESSAGE)
}
