export { canDevelopAgent } from '../../../shared/agentDevelopment'

export function serverLabel(url: string | undefined): string {
  try { return new URL(url ?? '').host } catch { return 'Cinna server' }
}


import { groupAgentsByRoot } from './localAgents'
import type { AgentRootDto, LocalAgentDto } from '../../../shared/localAgents'

type Agent = Awaited<ReturnType<typeof window.api.agents.list>>[number]
type Selection = { id: string; source: string }

/** Mirrors the sidebar's group order, including folder agents that cannot yet run. */
export function sidebarAgentOrder(agents: Agent[], local?: { roots: AgentRootDto[]; agents: LocalAgentDto[] }): Selection[] {
  const visible = agents.filter((agent) => agent.source !== 'remote' || agent.enabled)
  const groups = groupAgentsByRoot(local?.roots ?? [], local?.agents ?? [])
  const folderRows = (isDefault: boolean): Selection[] => groups.filter(({ root }) => root.isDefault === isDefault)
    .flatMap(({ agents }) => agents.map(({ id }) => ({ id, source: 'folder' })))
  return [
    ...folderRows(true),
    ...visible.filter((agent) => agent.source === 'remote'),
    ...folderRows(false),
    ...visible.filter((agent) => agent.source === 'local' && agent.protocol === 'a2a'),
    ...visible.filter((agent) => agent.driver === 'acp' && agent.capabilities.cwd === false),
    ...visible.filter((agent) => agent.driver === 'managed')
  ]
}

export function nextAgentAfterHiding(order: Selection[], hiddenId: string): Selection | null {
  const index = order.findIndex((agent) => agent.id === hiddenId)
  return (index > 0 ? order[index - 1] : order.find((agent) => agent.id !== hiddenId)) ?? null
}
