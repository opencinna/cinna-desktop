import { agentRepo } from '../db/agents'
import { getProfileScopeUserId } from '../auth/scope'
import { libraryService } from './libraryService'
import { createLogger } from '../logger/logger'
import type { UpdateAvailableInboxItem } from '../../shared/inbox'

const logger = createLogger('inbox')

/**
 * "Update available" for cloud agents: the active profile's synced agents
 * installed from the catalog whose install is behind its latest version
 * (the server's own `bundle_version`, written by the remote sync) and which
 * the server does not update by itself (`update_mode` other than
 * `automatic`). Who published that version, and when, comes from the cached
 * listing when it has the item. Local reads only; a failure is an empty list.
 */
export function cloudUpdateItems(profileUserId?: string): UpdateAvailableInboxItem[] {
  try {
    const profile = profileUserId ?? getProfileScopeUserId()
    const items = libraryService.cached(profile)?.items ?? []
    return agentRepo.listRemote(profile).flatMap((row): UpdateAvailableInboxItem[] => {
      const version = row.remoteMetadata?.bundle_version
      const installId = row.remoteTargetId
      if (!version?.update_available || version.update_mode === 'automatic' || !installId) return []
      // Only a cloud agent's own install: a skill's `my_installs` can carry the
      // install id of the agent it is linked to.
      const item = items.find(
        (entry) =>
          entry.kind === 'agent' &&
          entry.runs_on !== 'desktop' &&
          Array.isArray(entry.my_installs) &&
          entry.my_installs.some((install) => install?.install_id === installId)
      )
      const publishedAt = item?.latest?.published_at ? new Date(item.latest.published_at) : null
      return [
        {
          kind: 'update_available',
          target: 'cloud_agent',
          agentId: row.id,
          agentName: row.name,
          installId,
          version: version.latest_revision_number ?? item?.latest?.revision_number ?? null,
          // The publisher's label from the same answer the number came from.
          versionLabel:
            version.latest_revision_number != null ? (version.latest_version ?? null) : (item?.latest?.version ?? null),
          changedBy: item?.latest?.published_by?.display_name ?? null,
          changedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null
        }
      ]
    })
  } catch (err) {
    logger.warn('cloud update notices could not be read', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}
