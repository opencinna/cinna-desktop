/**
 * Derives the display state for a bundle install's "update available"
 * affordance from cinna-server's `BundleVersionInfo` (carried on a synced
 * agent's `remoteMetadata.bundle_version`). Shared by the Catalog card and the
 * Agents list so the two surfaces render the same "v1.0 → v1.2" labels and the
 * same update gate.
 *
 * Version labels prefer the publisher-supplied `*_version` string and fall
 * back to `rev <n>` when a revision has no version label.
 */
import type { BundleVersionInfo } from '../../../shared/agentMetadata'

export interface BundleUpdateState {
  /** True only when the server says the install is behind the latest revision. */
  updateAvailable: boolean
  /** e.g. "v1.0" / "rev 3" / null when neither is known. */
  installedLabel: string | null
  /** e.g. "v1.2" / "rev 5" / null when neither is known. */
  latestLabel: string | null
}

function versionLabel(version: string | null, revisionNumber: number | null): string | null {
  if (version) return `v${version}`
  if (revisionNumber != null) return `rev ${revisionNumber}`
  return null
}

export function deriveBundleUpdate(
  bv: BundleVersionInfo | null | undefined
): BundleUpdateState {
  if (!bv) {
    return { updateAvailable: false, installedLabel: null, latestLabel: null }
  }
  return {
    updateAvailable: Boolean(bv.update_available),
    installedLabel: versionLabel(bv.installed_version, bv.installed_revision_number),
    latestLabel: versionLabel(bv.latest_version, bv.latest_revision_number)
  }
}
