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
import { ChevronDown, Circle, Loader2, Download, CheckCircle2, ArrowUpCircle } from 'lucide-react'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'
import type { CatalogEntryDto } from '../../../../shared/catalog'
import type { BundleVersionInfo } from '../../../../shared/agentMetadata'
import { deriveBundleUpdate } from '../../utils/bundleVersion'
import { CatalogCardCredentials } from './CatalogCardCredentials'
import { CatalogCardFooter } from './CatalogCardFooter'

interface CatalogCardProps {
  entry: CatalogEntryDto
  /**
   * Version state for the user's install, joined in by the parent from the
   * matching synced agent's `remoteMetadata.bundle_version` (by install id).
   * Undefined when the agent sync hasn't surfaced the install yet — in that
   * case the card falls back to the catalog's `pendingUpdate` boolean (and can
   * only name the target version, not the installed one).
   */
  bundleVersion?: BundleVersionInfo | null
  /** True while *this* card's quick-install is in flight. */
  installing?: boolean
  /** True while *this* card's apply-update is in flight. */
  updating?: boolean
  /** Disabled when another card's install/update is still pending. */
  disabled?: boolean
  onInstall: () => void
  onUpdate: () => void
}

export function CatalogCard({
  entry,
  bundleVersion,
  installing,
  updating,
  disabled,
  onInstall,
  onUpdate
}: CatalogCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const targetVersionLabel = entry.latestVersion
    ? `v${entry.latestVersion}`
    : entry.latestRevisionNumber
      ? `rev ${entry.latestRevisionNumber}`
      : null

  // Update state: trust the synced agent's `bundle_version` when present (it
  // carries installed AND latest), else fall back to the catalog's boolean.
  const bundleUpdate = deriveBundleUpdate(bundleVersion)
  const hasUpdate =
    entry.isInstalled &&
    (bundleVersion ? bundleUpdate.updateAvailable : entry.pendingUpdate)

  const latestLabel = bundleUpdate.latestLabel ?? targetVersionLabel
  const installedLabel = bundleUpdate.installedLabel
  // "v1.0 → v1.2" when we know both ends; otherwise nothing (the button still
  // names the target). Shown in place of the neutral version chip, which would
  // misleadingly read `latestVersion` as the installed version.
  const transitionLabel =
    hasUpdate && installedLabel && latestLabel ? `${installedLabel} → ${latestLabel}` : null

  // Neutral version chip: only for non-update states. `latestVersion` equals
  // the installed version when up to date, so it's correct there.
  const versionLabel = hasUpdate ? null : targetVersionLabel

  const statusColor = hasUpdate
    ? 'text-[var(--color-warning)]'
    : entry.isInstalled
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
          {hasUpdate && (
            <span className="text-[11px] ml-1.5 px-1.5 py-0.5 rounded-full bg-[var(--color-warning)]/15 text-[var(--color-warning)] font-medium">
              {transitionLabel ?? 'Update available'}
            </span>
          )}
        </div>

        {!entry.isInstalled ? (
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
        ) : hasUpdate ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onUpdate()
            }}
            disabled={updating || disabled}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-medium
              bg-[var(--color-warning)] hover:opacity-90 text-white
              disabled:opacity-50 disabled:cursor-not-allowed transition-opacity shrink-0"
          >
            {updating ? (
              <>
                <Loader2 size={10} className="animate-spin" />
                Updating…
              </>
            ) : (
              <>
                <ArrowUpCircle size={10} />
                {latestLabel ? `Update to ${latestLabel}` : 'Update'}
              </>
            )}
          </button>
        ) : (
          <span className="flex items-center gap-1 text-[12px] text-[var(--color-text-muted)] shrink-0 px-2">
            <CheckCircle2 size={12} className="text-[var(--color-success)]" />
            Installed
          </span>
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
