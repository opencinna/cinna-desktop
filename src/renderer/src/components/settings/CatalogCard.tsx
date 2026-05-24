/**
 * Single catalog entry card — header (status dot, name, version, install /
 * installed button, expand chevron) plus an expandable body composed of two
 * self-contained children: `CatalogCardCredentials` for the install-context-
 * driven required/AI sections and `CatalogCardFooter` for installed-bundle
 * actions (Uninstall + Open Agent + confirmation modal).
 *
 * The card itself only owns the `expanded` UI state; everything else lives
 * with the subcomponent that consumes it.
 */
import { useState } from 'react'
import { ChevronDown, Circle, Loader2, Download, CheckCircle2 } from 'lucide-react'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'
import type { CatalogEntryDto } from '../../../../shared/catalog'
import { CatalogCardCredentials } from './CatalogCardCredentials'
import { CatalogCardFooter } from './CatalogCardFooter'

interface CatalogCardProps {
  entry: CatalogEntryDto
  /** True while *this* card's quick-install is in flight. */
  installing?: boolean
  /** Disabled when another card's install is still pending. */
  disabled?: boolean
  onInstall: () => void
}

export function CatalogCard({
  entry,
  installing,
  disabled,
  onInstall
}: CatalogCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const versionLabel = entry.latestVersion
    ? `v${entry.latestVersion}`
    : entry.latestRevisionNumber
      ? `rev ${entry.latestRevisionNumber}`
      : null

  const statusColor = entry.isInstalled
    ? 'text-[var(--color-success)]'
    : 'text-[var(--color-text-muted)]'

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Circle size={6} className={`fill-current ${statusColor}`} />

        <div className="flex-1 min-w-0">
          <span className="font-medium text-[14px]">{entry.displayName}</span>
          {versionLabel && (
            <span className="text-[12px] text-[var(--color-text-muted)] ml-1.5">
              {versionLabel}
            </span>
          )}
          {entry.isInstalled && (
            <span className="text-[11px] ml-1.5 px-1.5 py-0.5 rounded-full bg-[var(--color-success)]/15 text-[var(--color-success)] font-medium">
              Active
            </span>
          )}
        </div>

        {entry.isInstalled ? (
          <span className="flex items-center gap-1 text-[12px] text-[var(--color-text-muted)] shrink-0 px-2">
            <CheckCircle2 size={12} className="text-[var(--color-success)]" />
            Installed
          </span>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onInstall()
            }}
            disabled={installing || disabled}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-medium
              bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white
              disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {installing ? (
              <>
                <Loader2 size={10} className="animate-spin" />
                Installing…
              </>
            ) : (
              <>
                <Download size={10} />
                Install
              </>
            )}
          </button>
        )}

        <div
          className={`p-1 text-[var(--color-text-muted)] transition-transform duration-200 ${
            expanded ? 'rotate-180' : ''
          }`}
        >
          <ChevronDown size={12} />
        </div>
      </div>

      <AnimatedCollapse open={expanded}>
        <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-2.5">
          {entry.description && (
            <div className="text-[12px] text-[var(--color-text-muted)]">{entry.description}</div>
          )}

          <div className="text-[12px] text-[var(--color-text-muted)]">
            Publisher:{' '}
            <span className="text-[var(--color-text-secondary)]">
              {entry.publisherName ?? entry.publisherEmail ?? entry.publisherHandle ?? 'unknown'}
            </span>
            {entry.publisherName && entry.publisherEmail && (
              <span className="ml-1">&lt;{entry.publisherEmail}&gt;</span>
            )}
          </div>

          <div>
            <span className="inline-block text-[12px] font-mono px-1.5 py-0.5 rounded bg-[var(--color-bg)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              {entry.bundleId}
            </span>
          </div>

          <CatalogCardCredentials entry={entry} enabled={expanded && !entry.isInstalled} />
        </div>
        {entry.isInstalled && <CatalogCardFooter entry={entry} />}
      </AnimatedCollapse>
    </div>
  )
}
