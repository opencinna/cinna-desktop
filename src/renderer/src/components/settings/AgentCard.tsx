import { useState, type ReactNode } from 'react'
import {
  Trash2,
  ChevronDown,
  Circle,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Eye,
  EyeOff,
  ArrowUpCircle
} from 'lucide-react'
import {
  useUpsertAgent,
  useDeleteAgent,
  useTestAgent,
  useSetAgentEnabled,
  useApplyBundleUpdate,
  useCheckAgentReadiness
} from '../../hooks/useAgents'
import {
  readinessSeverity,
  readinessText,
  readinessTitle,
  readinessTone
} from '../chat/ComposerReadiness'
import { deriveBundleUpdate } from '../../utils/bundleVersion'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

const PROTOCOL_LABELS: Record<string, string> = {
  a2a: 'A2A'
}

interface AgentCardProps {
  agent: AgentData
  initiallyExpanded?: boolean
  connectionOnly?: boolean
}

function ConnectionRow({ label, children, technical = false }: { label: string; children: ReactNode; technical?: boolean }): React.JSX.Element {
  return <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-4 py-2.5 text-xs">
    <dt className="text-[var(--color-text-muted)]">{label}</dt>
    <dd className={`min-w-0 break-words text-[var(--color-text)] ${technical ? 'font-mono text-[11px] [overflow-wrap:anywhere]' : ''}`}>{children}</dd>
  </div>
}

function ConnectionBody({ standalone, open, children }: { standalone: boolean; open: boolean; children: ReactNode }): React.JSX.Element {
  return standalone ? <>{children}</> : <AnimatedCollapse open={open}>{children}</AnimatedCollapse>
}

export function AgentCard({ agent, initiallyExpanded = false, connectionOnly = false }: AgentCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [accessToken, setAccessToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const upsert = useUpsertAgent()
  const deleteAgent = useDeleteAgent()
  const testAgent = useTestAgent()
  const setEnabled = useSetAgentEnabled()
  const applyUpdate = useApplyBundleUpdate()
  const [updateError, setUpdateError] = useState<string | null>(null)

  const handleToggle = (): void => {
    setEnabled.mutate({ agentId: agent.id, enabled: !agent.enabled })
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
        onSuccess: (result) => {
          if (!result.success) setSaveError(result.error ?? 'Could not save access token.')
          else setAccessToken('')
        },
        onError: (err) => setSaveError(String(err))
      }
    )
  }

  const checkReadiness = useCheckAgentReadiness()

  const handleTest = (): void => {
    testAgent.mutate(agent.id)
    // The same press re-asks readiness, so the dot and the composer's refusal
    // follow a test the user just ran rather than waiting for the next check.
    checkReadiness.mutate(agent.id)
  }

  // A switched-off agent is not checked, and its dot already says it is off.
  const readinessIssue =
    agent.enabled && agent.readiness && agent.readiness.state !== 'ok' ? agent.readiness : null

  const isRemote = agent.source === 'remote'
  // For remote agents originating from a catalog bundle install. Publisher
  // working copies (`is_publisher_install=true`) and unpublished agents
  // (`bundle_uuid=null`) render without the pill — they are the user's own.
  const bundleUuid = agent.remoteMetadata?.bundle_uuid
  const isPublisherInstall = agent.remoteMetadata?.is_publisher_install === true
  const isBundleInstall =
    isRemote &&
    typeof bundleUuid === 'string' &&
    bundleUuid.length > 0 &&
    !isPublisherInstall

  // In-app bundle update: only consumer installs carry `bundle_version`, and
  // `remoteTargetId` is the cinna-server install id the apply-update route
  // takes. "v1.0 → v1.2" when both ends are known, else just the target.
  const bundleUpdate = deriveBundleUpdate(agent.remoteMetadata?.bundle_version)
  const showUpdate = isBundleInstall && bundleUpdate.updateAvailable
  const transitionLabel =
    bundleUpdate.installedLabel && bundleUpdate.latestLabel
      ? `${bundleUpdate.installedLabel} → ${bundleUpdate.latestLabel}`
      : bundleUpdate.latestLabel

  const handleUpdate = (): void => {
    if (!agent.remoteTargetId) return
    setUpdateError(null)
    applyUpdate.mutate(agent.remoteTargetId, {
      onError: (err: Error & { code?: string }) => {
        setUpdateError(
          err.code === 'reauth_required'
            ? 'Cinna session expired — re-authenticate to update.'
            : err.message || 'Update failed'
        )
      }
    })
  }

  const statusColor = !agent.enabled
    ? 'text-[var(--color-text-muted)]'
    : readinessIssue
      ? readinessTone(readinessIssue)
      : 'text-[var(--color-success)]'
  // A warning glyph for something the user fixes (a token, a login), a cross
  // for an agent that cannot be reached at all.
  const ReadinessIcon =
    readinessIssue && readinessSeverity(readinessIssue) === 'warning' ? AlertTriangle : XCircle

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

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
    <div className={connectionOnly ? 'space-y-4' : 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden'}>
      {!connectionOnly && <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Circle size={6} className={`fill-current ${statusColor}`} />
        <div className="flex-1 min-w-0">
          <span className="font-medium text-[14px]">{agent.name}</span>
          <span className="text-[12px] text-[var(--color-text-muted)] ml-1.5">
            {PROTOCOL_LABELS[agent.protocol] ?? agent.protocol}
            {agent.protocolInterfaceVersion && ` v${agent.protocolInterfaceVersion}`}
          </span>
          {isRemote && (
            <span className="text-[11px] ml-1.5 px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium">
              Remote
            </span>
          )}
          {isBundleInstall && (
            <span
              className="text-[11px] ml-1.5 px-1.5 py-0.5 rounded-full bg-[var(--color-success)]/15 text-[var(--color-success)] font-medium"
              title="Installed from the catalog"
            >
              Bundle
            </span>
          )}
          {showUpdate && (
            <span
              className="text-[11px] ml-1.5 px-1.5 py-0.5 rounded-full bg-[var(--color-warning)]/15 text-[var(--color-warning)] font-medium"
              title={transitionLabel ? `Update available: ${transitionLabel}` : 'Update available'}
            >
              Update
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleToggle() }}
          title={setEnabled.error ? String(setEnabled.error) : undefined}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
            setEnabled.error
              ? 'bg-[var(--color-danger)]/40 ring-1 ring-[var(--color-danger)]'
              : agent.enabled
                ? 'bg-[var(--color-accent)]'
                : 'bg-[var(--color-border)]'
          }`}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              agent.enabled ? 'left-[18px]' : 'left-0.5'
            }`}
          />
        </button>

        {!isRemote && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); deleteAgent.mutate(agent.id) }}
            className="p-1 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
          >
            <Trash2 size={12} />
          </button>
        )}

        <div className={`p-1 text-[var(--color-text-muted)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
          <ChevronDown size={12} />
        </div>
      </div>}

      <ConnectionBody standalone={connectionOnly} open={expanded}>
        <div className={connectionOnly ? 'space-y-4' : 'border-t border-[var(--color-border)] px-4 py-3 space-y-3'}>
          {/* Bundle update banner — applies the publisher's latest revision in
              place (App Data + credentials preserved). */}
          {showUpdate && (
            <div
              className="flex items-center gap-2 px-2.5 py-2 rounded-md
                border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10"
            >
              <ArrowUpCircle size={14} className="shrink-0 text-[var(--color-warning)]" />
              <div className="flex-1 min-w-0 text-[12px] text-[var(--color-text-secondary)]">
                Bundle update available
                {transitionLabel && (
                  <span className="text-[var(--color-text-muted)]"> · {transitionLabel}</span>
                )}
              </div>
              <button
                type="button"
                onClick={handleUpdate}
                disabled={applyUpdate.isPending}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-medium
                  bg-[var(--color-warning)] hover:opacity-90 text-white
                  disabled:opacity-50 disabled:cursor-not-allowed transition-opacity shrink-0"
              >
                {applyUpdate.isPending ? (
                  <>
                    <Loader2 size={10} className="animate-spin" />
                    Updating…
                  </>
                ) : (
                  bundleUpdate.latestLabel ? `Update to ${bundleUpdate.latestLabel}` : 'Update'
                )}
              </button>
            </div>
          )}
          {updateError && (
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-danger)]">
              <XCircle size={10} />
              <span>{updateError}</span>
            </div>
          )}

          <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3">
            <h2 className="mb-1 text-sm font-medium">Connection details</h2>
            <dl className="divide-y divide-[var(--color-border)]">
              <ConnectionRow label="Protocol">{PROTOCOL_LABELS[agent.protocol] ?? agent.protocol}{agent.protocolInterfaceVersion && ` v${agent.protocolInterfaceVersion}`}</ConnectionRow>
              {agent.protocolInterfaceVersion && <ConnectionRow label="Transport">{(() => {
                const iface = cardData?.supportedInterfaces?.find((item) => item.url === agent.protocolInterfaceUrl)
                return iface?.protocolBinding ?? iface?.transport ?? 'JSONRPC'
              })()}</ConnectionRow>}
              {(agent.protocolInterfaceUrl || agent.endpointUrl) && <ConnectionRow label="Endpoint" technical>{agent.protocolInterfaceUrl || agent.endpointUrl}</ConnectionRow>}
              {agent.cardUrl && <ConnectionRow label="Agent card URL" technical>{agent.cardUrl}</ConnectionRow>}
              {cardData?.version && <ConnectionRow label="Agent version">{cardData.version}</ConnectionRow>}
              {!!cardData?.protocolVersions?.length && <ConnectionRow label="Supported versions">{cardData.protocolVersions.join(', ')}</ConnectionRow>}
              {typeof cardData?.capabilities?.streaming === 'boolean' && <ConnectionRow label="Streaming">{cardData.capabilities.streaming ? 'Supported' : 'Not supported'}</ConnectionRow>}
            </dl>
          </section>

          {/* Skills */}
          {!connectionOnly && agent.skills && agent.skills.length > 0 && (
            <div>
              <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">
                Skills ({agent.skills.length})
              </label>
              <div className="space-y-0.5">
                {agent.skills.map((s) => (
                  <div key={s.id} className="text-[12px] text-[var(--color-text-secondary)]">
                    {s.name}
                    {s.description && (
                      <span className="text-[var(--color-text-muted)]"> — {s.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Access token update — hidden for remote agents (they use Cinna JWT) */}
          <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
            <h2 className="text-sm font-medium">Authentication</h2>
            {isRemote ? <p className="text-xs text-[var(--color-text-secondary)]">Uses your active Cinna profile. Desktop manages the connection with your Cinna session.</p> : <>
              <div>
                <label htmlFor={`agent-token-${agent.id}`} className="block text-[12px] text-[var(--color-text-muted)] mb-1.5">
                  Access Token{' '}
                  {agent.hasAccessToken && (
                    <span className="text-[var(--color-success)]">(saved)</span>
                  )}
                </label>
                <div className="flex gap-1.5">
                  <div className="flex-1 relative">
                    <input
                      id={`agent-token-${agent.id}`}
                      type={showToken ? 'text' : 'password'}
                      value={accessToken}
                      onChange={(e) => setAccessToken(e.target.value)}
                      placeholder={agent.hasAccessToken ? 'Enter new token to replace' : 'Enter access token'}
                      className={`${inputClass} pr-8`}
                    />
                    <button
                      type="button"
                      aria-label={showToken ? 'Hide access token' : 'Show access token'}
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
                      className="px-3 py-1.5 rounded-md text-[14px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]
                        text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      Save
                    </button>
                  )}
                </div>
              </div>

              {saveError && (
                <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-danger)]">
                  <XCircle size={10} />
                  <span>{saveError}</span>
                </div>
              )}
            </>}
          </section>

          <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
          <h2 className="text-sm font-medium">Connection test</h2>
          <p className="text-xs text-[var(--color-text-muted)]">Check that Desktop can reach this agent with the current connection settings.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleTest}
              disabled={testAgent.isPending}
              // Wide enough for "Test Connection", so "Testing..." does not
              // narrow the button and slide the reason beside it.
              className="min-w-[6.5rem] text-left text-[12px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] font-medium transition-colors"
            >
              {testAgent.isPending ? (
                <span className="flex items-center gap-1">
                  <Loader2 size={10} className="animate-spin" /> Testing...
                </span>
              ) : (
                'Test Connection'
              )}
            </button>

            {/* A failed test and a refusal describe the same failure, and the
                refusal says it in the user's words: the test's raw error
                ("fetch failed") replaced "Can't reach this agent." with nothing
                to explain it. Only a passing test outranks the reason — the
                re-check the same press started clears it moments later. */}
            {readinessIssue && !testAgent.data?.success ? (
              <span className="flex items-center gap-1 text-[12px] min-w-0">
                <ReadinessIcon
                  size={10}
                  aria-hidden="true"
                  data-readiness-icon={readinessSeverity(readinessIssue)}
                  className={`shrink-0 ${readinessTone(readinessIssue)}`}
                />
                <span
                  className={`truncate max-w-[260px] ${readinessTone(readinessIssue)}`}
                  title={readinessTitle(readinessIssue)}
                >
                  {readinessText(readinessIssue)}
                </span>
              </span>
            ) : testAgent.data ? (
              <span className="flex items-center gap-1 text-[12px]">
                {testAgent.data.success ? (
                  <>
                    <CheckCircle size={10} className="text-[var(--color-success)]" />
                    <span className="text-[var(--color-success)]">Connected</span>
                  </>
                ) : (
                  <>
                    <XCircle size={10} className="text-[var(--color-danger)]" />
                    <span
                      className="text-[var(--color-danger)] truncate max-w-[200px]"
                      title={testAgent.data.error}
                    >
                      {testAgent.data.error}
                    </span>
                  </>
                )}
              </span>
            ) : null}
          </div>
          </section>
        </div>
      </ConnectionBody>
    </div>
  )
}
