import type { JobSyncManifest } from '../../../shared/sync'
import type { ResolveIndex } from '../../sync/resolvers'
import { agentIdentityKey, normalizeUrl } from '../../sync/identity'

/**
 * Agent dependencies the manifest names that resolve to **nothing** on this
 * device: a folder agent whose workshop directory isn't here, or a remote agent
 * from a server this profile isn't on. Returns their display labels, in
 * manifest order — the labels are the message, see `executeLocal`.
 *
 * This is the same set `getDependencyStatus` reports as
 * `kind: 'agent', state: 'unavailable'`, computed against a prebuilt index so
 * the job *list* can flag every row in one pass instead of one table scan per
 * dependency. `jobService.executeLocal.test.ts` pins the two answers together
 * so an edit to either shows up as a failure rather than as drift.
 *
 * Three things are deliberately **not** here:
 *
 *  - **MCP deps.** A miss auto-creates a disabled shell the user finishes
 *    configuring in the app, so blocking on one would break the ordinary
 *    sync-then-configure path.
 *  - **`source: 'local'` A2A agents.** `resolveLocalAgent` auto-creates a shell
 *    too, so a miss there is the same finish-in-app case as an MCP.
 *  - **A row that is present but disabled.** That is a toggle, not an absence:
 *    the row exists, `getDependencyStatus` calls it `needs-setup`, and its
 *    "Set up" button leads somewhere real.
 *
 * The `serverUrl` guard is not decoration. `ResolveIndex.remoteAgent` is keyed
 * on target type + id alone and carries no server, while `resolveRemoteAgent`
 * — which the detail panel goes through — refuses a descriptor naming a
 * different server. Without the guard here the two would disagree, permissively
 * and in exactly the direction this whole gate exists to close.
 */
export function unresolvableAgentLabels(
  manifest: JobSyncManifest | null,
  idx: ResolveIndex,
  serverUrl: string | null
): string[] {
  if (!manifest) return []
  const out: string[] = []
  for (const desc of manifest.deps) {
    if (desc.kind !== 'agent') continue
    if (desc.source === 'remote') {
      const foreign =
        !!desc.serverUrl &&
        !!serverUrl &&
        normalizeUrl(desc.serverUrl) !== normalizeUrl(serverUrl)
      if (foreign || !idx.remoteAgent.has(agentIdentityKey(desc))) {
        out.push(desc.name ?? 'Remote agent')
      }
    } else if (desc.source === 'folder') {
      if (!idx.folderAgent.has(agentIdentityKey(desc))) {
        out.push(desc.name ?? 'Agent')
      }
    }
  }
  return out
}
