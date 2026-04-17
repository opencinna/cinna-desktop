import { useState } from 'react'
import {
  Trash2,
  ChevronDown,
  Circle,
  CheckCircle,
  XCircle,
  Loader2,
  Eye,
  EyeOff
} from 'lucide-react'
import { useUpsertAgent, useDeleteAgent, useTestAgent } from '../../hooks/useAgents'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

const PROTOCOL_LABELS: Record<string, string> = {
  a2a: 'A2A'
}

interface AgentCardProps {
  agent: AgentData
}

export function AgentCard({ agent }: AgentCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [accessToken, setAccessToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const upsert = useUpsertAgent()
  const deleteAgent = useDeleteAgent()
  const testAgent = useTestAgent()

  const handleToggle = (): void => {
    upsert.mutate({
      id: agent.id,
      name: agent.name,
      protocol: agent.protocol,
      enabled: !agent.enabled
    })
  }

  const handleSaveToken = (): void => {
    if (!accessToken) return
    setSaveError(null)
    upsert.mutate(
      {
        id: agent.id,
        name: agent.name,
        protocol: agent.protocol,
        accessToken
      },
      {
        onSuccess: () => {
          setAccessToken('')
        },
        onError: (err) => setSaveError(String(err))
      }
    )
  }

  const handleTest = (): void => {
    testAgent.mutate(agent.id)
  }

  const statusColor =
    agent.enabled
      ? 'text-[var(--color-success)]'
      : 'text-[var(--color-text-muted)]'

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  const cardData = agent.cardData as
    | {
        name?: string
        description?: string
        version?: string
        capabilities?: { streaming?: boolean }
        protocolVersion?: string
        protocolVersions?: string[]
        supportedInterfaces?: Array<{ url?: string; protocolVersion?: string; protocolBinding?: string; transport?: string }>
      }
    | undefined

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Circle size={6} className={`fill-current ${statusColor}`} />
        <div className="flex-1 min-w-0">
          <span className="font-medium text-xs">{agent.name}</span>
          <span className="text-[10px] text-[var(--color-text-muted)] ml-1.5">
            {PROTOCOL_LABELS[agent.protocol] ?? agent.protocol}
            {agent.protocolInterfaceVersion && ` v${agent.protocolInterfaceVersion}`}
          </span>
        </div>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleToggle() }}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
            agent.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
          }`}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              agent.enabled ? 'left-[18px]' : 'left-0.5'
            }`}
          />
        </button>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); deleteAgent.mutate(agent.id) }}
          className="p-1 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
        >
          <Trash2 size={12} />
        </button>

        <div className={`p-1 text-[var(--color-text-muted)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
          <ChevronDown size={12} />
        </div>
      </div>

      <AnimatedCollapse open={expanded}>
        <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-2.5">
          {/* Agent details */}
          {agent.description && (
            <div className="text-[10px] text-[var(--color-text-muted)]">
              {agent.description}
            </div>
          )}

          {agent.cardUrl && (
            <div className="text-[10px] text-[var(--color-text-muted)]">
              Card URL: <span className="text-[var(--color-text-secondary)]">{agent.cardUrl}</span>
            </div>
          )}

          {/* Protocol & connection details */}
          <div className="space-y-0.5">
            {agent.protocolInterfaceVersion && (() => {
              const matchedIface = cardData?.supportedInterfaces?.find(
                (i) => i.url === agent.protocolInterfaceUrl
              )
              const transport = matchedIface?.protocolBinding ?? matchedIface?.transport ?? 'JSONRPC'
              return (
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  Protocol:{' '}
                  <span className="text-[var(--color-text-secondary)]">
                    A2A v{agent.protocolInterfaceVersion}
                  </span>
                  {' · '}
                  <span className="text-[var(--color-text-secondary)]">{transport}</span>
                  {cardData?.protocolVersions && cardData.protocolVersions.length > 1 && (
                    <span>
                      {' '}(agent supports: {cardData.protocolVersions.join(', ')})
                    </span>
                  )}
                </div>
              )
            })()}
            {agent.protocolInterfaceUrl && (
              <div className="text-[10px] text-[var(--color-text-muted)]">
                Endpoint: <span className="text-[var(--color-text-secondary)]">{agent.protocolInterfaceUrl}</span>
              </div>
            )}
            {cardData?.version && (
              <div className="text-[10px] text-[var(--color-text-muted)]">
                Agent version: <span className="text-[var(--color-text-secondary)]">v{cardData.version}</span>
              </div>
            )}
          </div>

          {/* Capabilities */}
          {cardData?.capabilities?.streaming && (
            <div className="text-[10px] text-[var(--color-success)]">
              Streaming supported
            </div>
          )}

          {/* Skills */}
          {agent.skills && agent.skills.length > 0 && (
            <div>
              <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
                Skills ({agent.skills.length})
              </label>
              <div className="space-y-0.5">
                {agent.skills.map((s) => (
                  <div key={s.id} className="text-[10px] text-[var(--color-text-secondary)]">
                    {s.name}
                    {s.description && (
                      <span className="text-[var(--color-text-muted)]"> — {s.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Access token update */}
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
              Access Token{' '}
              {agent.hasAccessToken && (
                <span className="text-[var(--color-success)]">(saved)</span>
              )}
            </label>
            <div className="flex gap-1.5">
              <div className="flex-1 relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder={agent.hasAccessToken ? 'Enter new token to replace' : 'Enter access token'}
                  className={`${inputClass} pr-8`}
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                >
                  {showToken ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
              {accessToken && (
                <button
                  type="button"
                  onClick={handleSaveToken}
                  disabled={upsert.isPending}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]
                    text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Save
                </button>
              )}
            </div>
          </div>

          {saveError && (
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-danger)]">
              <XCircle size={10} />
              <span>{saveError}</span>
            </div>
          )}

          {/* Test connection */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleTest}
              disabled={testAgent.isPending}
              className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] font-medium transition-colors"
            >
              {testAgent.isPending ? (
                <span className="flex items-center gap-1">
                  <Loader2 size={10} className="animate-spin" /> Testing...
                </span>
              ) : (
                'Test Connection'
              )}
            </button>

            {testAgent.data && (
              <span className="flex items-center gap-1 text-[10px]">
                {testAgent.data.success ? (
                  <>
                    <CheckCircle size={10} className="text-[var(--color-success)]" />
                    <span className="text-[var(--color-success)]">Connected</span>
                  </>
                ) : (
                  <>
                    <XCircle size={10} className="text-[var(--color-danger)]" />
                    <span className="text-[var(--color-danger)] truncate max-w-[200px]">
                      {testAgent.data.error}
                    </span>
                  </>
                )}
              </span>
            )}
          </div>
        </div>
      </AnimatedCollapse>
    </div>
  )
}
