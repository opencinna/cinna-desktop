/**
 * Modal shown after a Quick Install when the cinna-server runtime gate
 * reports `needs_setup` / `publisher_broken`. Lists each missing credential
 * as a card with a colored status dot and a link that opens the
 * cinna-server credential page in the user's browser (which the server
 * already pre-created as a draft during install).
 *
 * The desktop never re-implements credential forms — once the user fills
 * the form on the web, the next setup-status poll flips this modal to
 * "ready" and we close it automatically. Polling is every 3s plus every
 * window focus (`useSetupStatus` handles both).
 */
import { useEffect, useMemo } from 'react'
import { X, ExternalLink, AlertTriangle, Circle } from 'lucide-react'
import { useSetupStatus, useSetupCredentials, useCatalogServerUrl } from '../../hooks/useCatalog'
import type { SetupMissingItemDto } from '../../../../shared/catalog'

interface CatalogSetupModalProps {
  installId: string
  agentName: string
  onClose: () => void
  onReady: () => void
}

interface MissingRow {
  key: string
  name: string
  type: string
  isAi: boolean
  isPublisherBroken: boolean
  /** Resolved cinna-server URL for the per-credential page, when known. */
  href: string | null
}

export function CatalogSetupModal({
  installId,
  agentName,
  onClose,
  onReady
}: CatalogSetupModalProps): React.JSX.Element {
  const status = useSetupStatus({ installId, poll: true })
  const credentials = useSetupCredentials(installId)
  const serverUrl = useCatalogServerUrl()

  // Auto-close once the gate is satisfied — the modal is purely about
  // "something is missing"; once nothing is missing there's nothing to
  // show. Caller decides what toast to fire from onReady.
  useEffect(() => {
    if (status.data?.status === 'ready') onReady()
  }, [status.data?.status, onReady])

  const rows: MissingRow[] = useMemo(() => {
    if (!status.data) return []
    const credByName = new Map(credentials.data?.map((c) => [c.name, c]) ?? [])
    return status.data.missing.map((m: SetupMissingItemDto) => {
      const cred = credByName.get(m.specName)
      const isPublisherBroken =
        m.reason === 'publisher_credential_missing' ||
        m.reason === 'publisher_credential_unshared'
      let href: string | null = null
      if (!isPublisherBroken && cred && serverUrl.data) {
        href = `${serverUrl.data.replace(/\/$/, '')}/credential/${cred.id}`
      }
      return {
        key: `${m.specName}::${m.reason}`,
        name: m.specName,
        type: m.specType,
        isAi: m.isAi,
        isPublisherBroken,
        href
      }
    })
  }, [status.data, credentials.data, serverUrl.data])

  const totalSpecs = rows.length

  const installFallbackHref = useMemo(() => {
    if (status.data?.setupUrl) return status.data.setupUrl
    if (serverUrl.data) {
      return `${serverUrl.data.replace(/\/$/, '')}/agent/${installId}#credentials`
    }
    return null
  }, [status.data?.setupUrl, serverUrl.data, installId])

  const openHref = (href: string): void => {
    void window.api.system.openExternal(href)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[460px] max-w-[92vw] rounded-lg border border-[var(--color-border)]
          bg-[var(--color-bg-secondary)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 px-4 py-3 border-b border-[var(--color-border)]">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">Finish setting up {agentName}</div>
            <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
              {totalSpecs > 0 ? (
                <>
                  {totalSpecs} credential{totalSpecs === 1 ? '' : 's'} need
                  {totalSpecs === 1 ? 's' : ''} attention. Click a card to open it on the Cinna
                  server.
                </>
              ) : (
                <>Checking status…</>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-3 space-y-2">
          {status.isLoading && !status.data && (
            <div className="text-[10px] text-[var(--color-text-muted)] py-3 text-center">
              Loading status…
            </div>
          )}

          {status.error && (
            <div
              className="flex items-start gap-2 px-2.5 py-2 rounded-md
                border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10
                text-[10px] text-[var(--color-text-secondary)]"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
              <span>Couldn&apos;t check setup status. Retrying every 3 seconds…</span>
            </div>
          )}

          {rows.map((row) => (
            <CredentialStatusCard
              key={row.key}
              row={row}
              onOpen={() => (row.href ? openHref(row.href) : undefined)}
            />
          ))}

          {status.data && rows.length === 0 && status.data.status !== 'ready' && (
            <div className="text-[10px] text-[var(--color-text-muted)] py-3 text-center">
              Waiting for the server to finalize setup…
            </div>
          )}

          {installFallbackHref && rows.some((r) => r.isPublisherBroken) && (
            <div
              className="flex items-start gap-2 px-2.5 py-2 rounded-md
                border border-[var(--color-border)] bg-[var(--color-bg)]
                text-[10px] text-[var(--color-text-secondary)]"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
              <div>
                Some credentials are provided by the publisher and need their action — contact
                the publisher, or supply your own credentials from{' '}
                <button
                  type="button"
                  onClick={() => openHref(installFallbackHref)}
                  className="text-[var(--color-accent)] hover:underline"
                >
                  the agent&apos;s Credentials tab
                </button>
                .
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[var(--color-border)] flex items-center gap-2">
          <span className="text-[10px] text-[var(--color-text-muted)]">
            Auto-refreshing every 3 seconds
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium
              border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]
              text-[var(--color-text-secondary)] transition-colors"
          >
            Close
          </button>
          {installFallbackHref && (
            <button
              type="button"
              onClick={() => openHref(installFallbackHref)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium
                bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors"
            >
              <ExternalLink size={11} />
              Open on server
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

interface CredentialStatusCardProps {
  row: MissingRow
  onOpen: () => void
}

function CredentialStatusCard({ row, onOpen }: CredentialStatusCardProps): React.JSX.Element {
  const clickable = !!row.href
  // Both reasons map to "publisher broken" — the user can't fix it directly,
  // they need to contact the publisher (red). Otherwise the credential is
  // waiting for the user to fill it on the server (amber).
  const dotColor = row.isPublisherBroken
    ? 'text-[var(--color-danger)]'
    : 'text-[var(--color-warning)]'
  const statusLabel = row.isPublisherBroken ? 'Publisher action needed' : 'Setup needed'

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!clickable}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-left
        border border-[var(--color-border)] bg-[var(--color-bg)] transition-colors
        ${
          clickable
            ? 'hover:bg-[var(--color-bg-hover)] cursor-pointer'
            : 'cursor-not-allowed opacity-80'
        }`}
    >
      <Circle size={8} className={`fill-current shrink-0 ${dotColor}`} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate">
          {row.name}
          {row.isAi && (
            <span className="text-[9px] ml-1.5 px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
              AI
            </span>
          )}
        </div>
        <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
          {row.type} · {statusLabel}
        </div>
      </div>
      {clickable && <ExternalLink size={11} className="text-[var(--color-text-muted)] shrink-0" />}
    </button>
  )
}
