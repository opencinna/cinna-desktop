import { jobDefinitionPolicy } from './jobDefinitionPolicy'
import type { JobRuntimeDefinition } from '../../shared/jobs'
import { runtimeBudget } from './runtimeBudget'
import { validateTaskScript } from './scriptRouter'

/** Validate locally authored runtime fields; sync stores future definitions verbatim. */
export function jobRuntimeDefinition(input: JobRuntimeDefinition & { type: string }): JobRuntimeDefinition {
  const router = input.router ?? null
  if (router !== null && router !== 'script' && router !== 'coordinator') throw new Error('This job router is not supported.')
  if (router !== null && !jobDefinitionPolicy(input.type).autonomous) throw new Error('Autonomous job routing requires a local job.')
  if (router !== 'script' && input.script != null) throw new Error('A script definition requires the script router.')
  if (router === null && input.budget != null) throw new Error('A task budget requires an autonomous job router.')
  return { router, script: router === 'script' ? validateTaskScript(input.script) : null,
    budget: input.budget == null ? null : runtimeBudget(input.budget) }
}
