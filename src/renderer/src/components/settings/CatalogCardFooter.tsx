/**
 * Footer band rendered below the expanded body of an *installed* catalog
 * card. Houses two actions: Uninstall (destructive, opens
 * `CatalogUninstallModal`) and Open Agent (deep-links to the cinna-server
 * agent detail page in the OS browser).
 *
 * Self-contained: owns its own mutation, modal state, and the server-URL
 * query so the parent only has to render it when `entry.isInstalled`. Returns
 * `null` when there's nothing to render (e.g. `entry.userInstallId` is
 * missing, which would be a server-side inconsistency we'd rather skip than
 * surface a broken button).
 */
import { useState } from 'react'
import { ExternalLink, PackageX } from 'lucide-react'
import type { CatalogEntryDto } from '../../../../shared/catalog'
import { useCatalogServerUrl, useUninstallBundle } from '../../hooks/useCatalog'
import { CatalogUninstallModal } from './CatalogUninstallModal'

interface CatalogCardFooterProps {
  entry: CatalogEntryDto
}

export function CatalogCardFooter({ entry }: CatalogCardFooterProps): React.JSX.Element | null {
  const serverUrl = useCatalogServerUrl()
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [uninstallError, setUninstallError] = useState<string | null>(null)
  const uninstallMutation = useUninstallBundle()

  if (!entry.userInstallId) return null

  const openAgentHref = serverUrl.data
    ? `${serverUrl.data.replace(/\/$/, '')}/agent/${entry.userInstallId}`
    : null

  const handleConfirmUninstall = (): void => {
    if (!entry.userInstallId) return
    setUninstallError(null)
    uninstallMutation.mutate(entry.userInstallId, {
      onSuccess: () => {
        setUninstallOpen(false)
      },
      onError: (err) => {
        // CinnaApiError messages already carry the server's `.detail` text
        // (see `extractErrorDetail` in catalogService.ts) so we can render
        // them verbatim. Network/parse errors get the same surface.
        setUninstallError(err instanceof Error ? err.message : String(err))
      }
    })
  }

  const closeUninstallModal = (): void => {
    if (uninstallMutation.isPending) return
    setUninstallOpen(false)
    setUninstallError(null)
  }

  return (
    <>
      <div className="border-t border-[var(--color-border)] px-4 py-2.5 flex items-center justify-between gap-2 bg-[var(--color-bg)]">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setUninstallError(null)
            setUninstallOpen(true)
          }}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium
            text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 transition-colors"
        >
          <PackageX size={11} />
          Uninstall
        </button>
        {openAgentHref && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void window.api.system.openExternal(openAgentHref)
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium
              border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]
              text-[var(--color-text-secondary)] transition-colors"
          >
            <ExternalLink size={11} />
            Open Agent
          </button>
        )}
      </div>

      {uninstallOpen && (
        <CatalogUninstallModal
          agentName={entry.displayName}
          pending={uninstallMutation.isPending}
          errorMessage={uninstallError}
          onConfirm={handleConfirmUninstall}
          onClose={closeUninstallModal}
        />
      )}
    </>
  )
}
