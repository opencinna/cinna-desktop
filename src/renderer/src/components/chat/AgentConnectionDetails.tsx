import { useQuery } from '@tanstack/react-query'
import type { AgentData } from '../../../../preload'
import { useLocalAgent } from '../../hooks/useLocalAgents'
import { useProviders } from '../../hooks/useProviders'
import { useAuthStore } from '../../stores/auth.store'
import { RuntimePanel } from '../agents/local/RuntimePanel'

/** Registration ownership (`source: local`) does not imply local execution. */
export function agentLocation(agent: AgentData): 'Local' | 'Remote' {
  return agent.source === 'folder' || (agent.driver === 'acp' && agent.acpTransport !== 'websocket')
    ? 'Local' : 'Remote'
}

function domainOf(...urls: Array<string | null | undefined>): string | null {
  for (const url of urls) {
    if (!url) continue
    try {
      const host = new URL(url).host
      if (host) return host
    } catch { /* Try the next known endpoint. Never display credentials or query strings. */ }
  }
  return null
}

function Details({ rows }: { rows: Array<[string, string | null | undefined]> }): React.JSX.Element {
  return <dl className="space-y-1.5">
    {rows.filter(([, value]) => value).map(([label, value]) => <div key={label} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className="min-w-0 break-words [overflow-wrap:anywhere] text-[var(--color-text)]">{value}</dd>
    </div>)}
  </dl>
}

function FolderDetails({ agent }: { agent: AgentData }): React.JSX.Element {
  const { data, isError } = useLocalAgent(agent.id)
  return <>
    <Details rows={[
      ['Runs on', 'This computer'],
      ['Folder', data?.path]
    ]} />
    {data ? <RuntimePanel agent={data} compact />
      : <p className="mt-2">{isError ? 'Runtime details unavailable' : 'Loading runtime…'}</p>}
  </>
}

function AcpDetails({ agent }: { agent: AgentData }): React.JSX.Element {
  const profileId = useAuthStore((s) => s.currentUser?.id)
  const { data, isError } = useQuery({
    queryKey: ['agents', agent.id, 'connection', profileId],
    queryFn: () => window.api.customAgents.configuration(agent.id)
  })
  const config = data?.config
  const remote = agent.acpTransport === 'websocket'
  return <>
    <Details rows={[
      ['Protocol', remote ? 'ACP · WebSocket' : 'ACP · stdio'],
      ['Domain', config?.transport === 'websocket' ? domainOf(config.url) : null],
      ['Runs on', !remote ? 'Local ACP process' : null],
      [remote ? 'Workspace' : 'Folder', config?.cwd],
      ['Auth', remote ? (agent.hasAccessToken ? 'Access token' : 'No access token') : 'Managed by the ACP agent']
    ]} />
    {!data && <p className="mt-2">{isError ? 'Configuration details unavailable' : 'Loading configuration…'}</p>}
  </>
}

function ManagedDetails({ agent }: { agent: AgentData }): React.JSX.Element {
  const profileId = useAuthStore((s) => s.currentUser?.id)
  const { data: providers } = useProviders()
  const { data, isError } = useQuery({
    queryKey: ['agents', agent.id, 'connection', profileId],
    queryFn: () => window.api.managedAgents.configuration(agent.id)
  })
  const provider = providers?.find((item) => item.id === data?.config.credentialId)
  return <>
    <Details rows={[
      ['Protocol', 'Claude Managed Agents API'],
      ['Domain', provider ? domainOf(provider.baseUrl ?? 'https://api.anthropic.com') : null],
      ['Credential', provider?.name],
      ['Environment', data?.config.environmentId]
    ]} />
    {!data && <p className="mt-2">{isError ? 'Configuration details unavailable' : 'Loading configuration…'}</p>}
  </>
}

/** Mounted only while the tooltip is open; uses the same runtime summary as the agent page. */
export function AgentConnectionDetails({ agent }: { agent: AgentData }): React.JSX.Element {
  const serverUrl = useAuthStore((s) => s.currentUser?.cinnaServerUrl)
  return <>
    <p className="mb-2 break-words font-semibold text-[var(--color-text)]">{agent.name}</p>
    {agent.source === 'folder' ? <FolderDetails agent={agent} />
      : agent.driver === 'acp' ? <AcpDetails agent={agent} />
      : agent.driver === 'managed' ? <ManagedDetails agent={agent} />
      : <Details rows={[
          ['Protocol', [agent.protocol.toUpperCase(), agent.protocolInterfaceVersion].filter(Boolean).join(' · ')],
          ['Domain', domainOf(agent.protocolInterfaceUrl, agent.endpointUrl, agent.cardUrl, agent.source === 'remote' ? serverUrl : null)],
          ['Auth', agent.source === 'remote' ? 'Cinna profile' : agent.hasAccessToken ? 'Access token' : 'No access token']
        ]} />}
  </>
}
