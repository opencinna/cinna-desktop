import type { JobRow } from '../../db/jobs'
import { jobDefinitionPolicy } from '../../tasks/jobDefinitionPolicy'
import type { JobExecutor } from './contract'
import { desktopJobExecutor } from './desktop'
import { remoteJobExecutor } from './remote'
const executors = { desktop: desktopJobExecutor, remote: remoteJobExecutor }
export function executorFor(job: JobRow): JobExecutor {
  return executors[jobDefinitionPolicy(job.type).executor]
}
