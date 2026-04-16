import { useState } from 'react'
import {
  X,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Loader2
} from 'lucide-react'
import { useUpsertAgent, useFetchAgentCard } from '../../hooks/useAgents'

interface A2AAgentFormProps {
  onClose: () => void
}

export function A2AAgentForm({ onClose }: A2AAgentFormProps): React.JSX.Element {
  const [cardUrl, setCardUrl] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const upsert = useUpsertAgent()
  const fetchCard = useFetchAgentCard()

  const handleTest = (): void => {
    if (!cardUrl) return
    fetchCard.mutate({
      cardUrl,
      accessToken: accessToken || undefined
    })
  }

  const handleSave = (): void => {
    if (!cardUrl) return
    setSaveError(null)

    // If we have a fetched card, use its data
    const card = fetchCard.data?.card as
      | {
          name?: string
          description?: string
          skills?: Array<{ id: string; name: string; description?: string }>
        }
      | undefined
    const protocol = fetchCard.data?.protocol as
      | { url?: string; version?: string }
      | undefined

    const name = card?.name ?? 'A2A Agent'
    const description = card?.description
    const endpointUrl = protocol?.url
    const skills = card?.skills?.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description
    }))

    upsert.mutate(
      {
        name,
        description,
        protocol: 'a2a',
        cardUrl,
        endpointUrl,
        protocolInterfaceUrl: protocol?.url,
        protocolInterfaceVersion: protocol?.version,
        accessToken: accessToken || undefined,
        cardData: fetchCard.data?.card,
        skills,
        enabled: true
      },
      {
        onSuccess: () => onClose(),
        onError: (err) => setSaveError(String(err))
      }
    )
  }

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  const cardData = fetchCard.data?.card as
    | {
        name?: string
        description?: string
        version?: string
        skills?: Array<{ name: string }>
        protocolVersions?: string[]
        capabilities?: { streaming?: boolean }
        supportedInterfaces?: Array<{ url?: string; protocolVersion?: string; protocolBinding?: string; transport?: string }>
      }
    | undefined
  const protocolData = fetchCard.data?.protocol as
    | { url?: string; version?: string }
    | undefined

  return (
    <div className="rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-bg-secondary)]">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
        <span className="font-medium text-xs">Add A2A Agent</span>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        {/* Card URL */}
        <div>
          <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
            Agent Card URL
          </label>
          <input
            type="text"
            value={cardUrl}
            onChange={(e) => setCardUrl(e.target.value)}
            placeholder="https://agent.example.com or full card URL"
            autoFocus
            className={inputClass}
          />
        </div>

        {/* Access Token (optional) */}
        <div>
          <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
            Access Token <span className="text-[var(--color-text-muted)]">(optional)</span>
          </label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="Bearer token for authentication"
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
        </div>

        {/* Test result */}
        {fetchCard.isPending && (
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            <Loader2 size={10} className="animate-spin" /> Fetching agent card...
          </div>
        )}
        {fetchCard.data && (
          <div>
            {fetchCard.data.success ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <CheckCircle size={10} className="text-[var(--color-success)]" />
                  <span className="text-[var(--color-success)]">Connected</span>
                </div>
                {cardData && (
                  <div className="rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 space-y-1">
                    <div className="text-xs font-medium">{cardData.name}</div>
                    {cardData.description && (
                      <div className="text-[10px] text-[var(--color-text-muted)] line-clamp-2">
                        {cardData.description}
                      </div>
                    )}
                    {cardData.version && (
                      <div className="text-[10px] text-[var(--color-text-muted)]">
                        Agent version: v{cardData.version}
                      </div>
                    )}
                    {protocolData?.version && (() => {
                      const matchedIface = cardData.supportedInterfaces?.find(
                        (i) => i.url === protocolData.url
                      )
                      const transport = matchedIface?.protocolBinding ?? matchedIface?.transport ?? 'JSONRPC'
                      return (
                        <div className="text-[10px] text-[var(--color-text-muted)]">
                          Protocol: A2A v{protocolData.version} · {transport}
                          {cardData.protocolVersions && cardData.protocolVersions.length > 1 && (
                            <span> (supports: {cardData.protocolVersions.join(', ')})</span>
                          )}
                        </div>
                      )
                    })()}
                    {protocolData?.url && (
                      <div className="text-[10px] text-[var(--color-text-muted)]">
                        Endpoint: <span className="text-[var(--color-text-secondary)]">{protocolData.url}</span>
                      </div>
                    )}
                    {cardData.capabilities?.streaming && (
                      <div className="text-[10px] text-[var(--color-success)]">
                        Streaming supported
                      </div>
                    )}
                    {cardData.skills && cardData.skills.length > 0 && (
                      <div className="text-[10px] text-[var(--color-text-muted)]">
                        {cardData.skills.length} skill{cardData.skills.length > 1 ? 's' : ''}:{' '}
                        {cardData.skills.map((s) => s.name).join(', ')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-[10px]">
                <XCircle size={10} className="text-[var(--color-danger)]" />
                <span className="text-[var(--color-danger)] truncate">{fetchCard.data.error}</span>
              </div>
            )}
          </div>
        )}

        {/* Save error */}
        {saveError && (
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-danger)]">
            <XCircle size={10} />
            <span>{saveError}</span>
          </div>
        )}

        {/* Buttons */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-[var(--color-text-muted)]
              hover:text-[var(--color-text-secondary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={!cardUrl || fetchCard.isPending}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)]
              text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]
              disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Test Connection
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!cardUrl || upsert.isPending}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]
              text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {upsert.isPending ? (
              <span className="flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" /> Saving...
              </span>
            ) : (
              'Save Agent'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
