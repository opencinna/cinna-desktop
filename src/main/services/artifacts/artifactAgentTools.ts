import { validateSession } from '../delegationService'
import { publishedArtifactRepo } from '../../db/publishedArtifacts'
import { artifactApprovals, artifactService } from './artifactService'
import { ArtifactToolProvider, type ArtifactToolSession } from './artifactToolProvider'

/**
 * The agent's `artifacts_publish` for a folder agent's own session, or null
 * while the active profile's instance does not keep artifacts (A14): the
 * agent is never offered a tool it cannot use. Read from the support main
 * last loaded (`hub/core.ts` loads it as each profile becomes ready).
 */
export function artifactToolProviderFor(session: ArtifactToolSession): ArtifactToolProvider | null {
  if (!artifactService.supportedNow(session.scope.profileUserId).supported) return null
  return new ArtifactToolProvider(session, {
    validate: (checked) => {
      const { source } = validateSession(checked)
      return { agentName: source.name, agentDir: source.path }
    },
    service: artifactService,
    repo: publishedArtifactRepo,
    approvals: artifactApprovals
  })
}
