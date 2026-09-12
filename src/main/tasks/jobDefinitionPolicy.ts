/** Stored job schema is interpreted once; callers use the selected policy. */
const desktop = { executor: 'desktop', autonomous: true } as const
const remote = { executor: 'remote', autonomous: false } as const
export function jobDefinitionPolicy(type: string): typeof desktop | typeof remote {
  if (type === 'local') return desktop
  if (type === 'cinna_task') return remote
  throw new Error('This job type is not supported.')
}
