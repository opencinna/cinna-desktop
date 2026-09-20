import type { RemoteAgentMetadata } from './agentMetadata'

/**
 * A **consumer install from the catalog** — the only remote agent the desktop
 * has any business uninstalling.
 *
 * Only `bundle_uuid` marks descent from a bundle. `bundle_id` deliberately
 * does not, and reading it as bundle membership was a real bug: cinna-server
 * generates a reverse-DNS `bundle_id` for *every* agent at creation time,
 * non-nullable, long before anything is published — "the Agent row IS the
 * Install record". Counting it made an agent the user had just created look
 * like something they had installed from someone else, which put "Uninstall
 * agent…" on an agent nobody had installed and, through
 * {@link canDevelopAgent}, took the Develop button away from its own author.
 *
 * `is_publisher_install` has to say `false` outright rather than merely fail to
 * say `true`. The server sends a real boolean — `Agent.is_publisher_install` is
 * non-nullable and always serialized — so silence would mean a server that does
 * not know the concept, and reading "someone else's bundle" into silence is the
 * same mistake in a smaller place.
 *
 * That is a chosen trade, not a free one: were a server ever to send `null` for
 * a real consumer install, this would call it the caller's own and offer
 * Develop on somebody else's bundle, which the server would then refuse. It
 * cannot cost anyone an agent — nothing in the desktop deletes a server-hosted
 * agent at all, so the worst reading of this predicate is a button that turns
 * out not to work, not one that destroys something.
 */
export function isBundleAgent(agent: { source: string; remoteTargetType: string | null; remoteMetadata: RemoteAgentMetadata | null }): boolean {
  return agent.source === 'remote' && agent.remoteTargetType === 'agent' &&
    !!agent.remoteMetadata?.bundle_uuid &&
    agent.remoteMetadata?.is_publisher_install === false
}
