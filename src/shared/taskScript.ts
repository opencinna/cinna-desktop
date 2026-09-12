import type { JobDepDescriptor } from './sync'

/** Portable identities, resolved against enabled agents on the executing device. */
export type ScriptAgentRef = Extract<JobDepDescriptor, { kind: 'agent' }>
export type ScriptStep = {
  id: string
  after?: string[]
} & (
  | { agent: string; prompt: string; ask_user?: never }
  | { ask_user: string; agent?: never; prompt?: never }
)

/** Versioned data only: no JavaScript, shell evaluation or nested scripts. */
export interface TaskScript {
  version: 1
  agents: Record<string, ScriptAgentRef>
  steps: ScriptStep[]
}
