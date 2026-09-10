/**
 * Where an A2A agent answers and what it authenticates with — the pre-flight
 * the A2A driver runs before a turn, and that `agentService.testAgent` /
 * `listCliCommands` still share for a card fetch.
 *
 * Moved out of `agentService` in phase 2 of the agent runtime plan: every
 * decision in here is about how a kind of agent is reached, which is a
 * driver's business, not the CRUD service's. It decides by the row's
 * capabilities (`auth`, `cwd`), not by comparing `source` again.
 */
import { agentRepo, type AgentRow } from '../../db/agents'
import { decryptApiKey } from '../../security/keystore'
import { fetchAgentCard, type ProtocolResolution } from '../a2a-client'
import { AgentError } from '../../errors'
import { getCinnaAccessToken } from '../../auth/cinna-tokens'
import { CinnaReauthRequired } from '../../auth/cinna-oauth'
import { createLogger } from '../../logger/logger'
import { capabilitiesFor } from './capabilities'
import { authRejectionStatus } from './a2aErrors'

const logger = createLogger('agents')

/**
 * Remote (Cinna-backed) agents authenticate against the agent card endpoint
 * with a Cinna-issued JWT. A 401/403 means the server has invalidated that
 * JWT (token revoked, replay detected, account suspended) even though the
 * desktop's local copy may still appear valid — surface this as a
 * `CinnaReauthRequired` so the renderer's reauth chip kicks in.
 *
 * Two paths can produce the typed status:
 *  - `A2aHttpError` from `buildLoggingFetch` (intercepts 401/403 before
 *    the SDK / `fetchRawCard` wraps the response)
 *  - `AgentCardFetchError` from `fetchRawCard` (other non-OK statuses on
 *    the card endpoint — kept for symmetry; 401/403 won't reach it because
 *    the fetch layer throws `A2aHttpError` first)
 *
 * Local (manually-added) A2A agents use a user-supplied static token; a
 * 401/403 from them just means the configured token is wrong, with no
 * in-app reauth flow — propagate the original error unchanged.
 */
export function rethrowAsReauthIfCinna401(err: unknown, agent: AgentRow): never {
  if (capabilitiesFor(agent).auth === 'cinna') {
    const status = authRejectionStatus(err)
    if (status !== undefined) {
      throw new CinnaReauthRequired(
        `Cinna server rejected the agent card request (${status}). Re-authentication required.`,
        { cause: err as Error }
      )
    }
  }
  throw err
}

/**
 * If the agent has no resolved endpoint, auto-resolve one for remote agents
 * by fetching the card. Local agents must be tested first — their card URL
 * may require a user-supplied access token we haven't been given yet.
 * Caches the resolution so subsequent messages skip this step.
 *
 * Returns **null** for a folder agent, which has no endpoint at all: it is
 * run by the local engine, not reached over HTTP. Null rather than a throw
 * because "there is no endpoint" is this agent's normal state, not a
 * misconfiguration — and null rather than `''` so the compiler makes every
 * caller decide what to do about it.
 */
export async function resolveEndpointIfNeeded(
  userId: string,
  agent: AgentRow
): Promise<string | null> {
  const capabilities = capabilitiesFor(agent)
  if (capabilities.cwd) return null

  const existing = agent.protocolInterfaceUrl ?? agent.endpointUrl
  if (existing) return existing

  if (capabilities.auth !== 'cinna' || !agent.cardUrl) {
    throw new AgentError(
      'no_endpoint',
      'No compatible protocol endpoint resolved. Test the agent connection first.'
    )
  }

  const accessToken = await resolveAccessToken(userId, agent)
  let protocol: ProtocolResolution
  try {
    ;({ protocol } = await fetchAgentCard(agent.cardUrl, accessToken))
  } catch (err) {
    rethrowAsReauthIfCinna401(err, agent)
  }
  agentRepo.updateResolvedEndpoint(userId, agent.id, {
    endpointUrl: protocol.url,
    protocolInterfaceUrl: protocol.url,
    protocolInterfaceVersion: protocol.version
  })
  logger.info('agent endpoint auto-resolved', {
    agentId: agent.id,
    endpointUrl: protocol.url
  })
  return protocol.url
}

/**
 * Resolve the access token for an agent.
 * Remote agents use the user's Cinna JWT; local agents use the decrypted stored token.
 *
 * A folder agent has neither: nothing authenticates to it over the network,
 * and the token it *does* have (for its own callbacks) lives in the folder's
 * `app-data/desktop.json` and is the local runner's business, not this
 * function's. Short-circuit before touching the keystore.
 *
 * Lets `CinnaReauthRequired` bubble so callers can render an actionable
 * "Re-authenticate" affordance instead of a generic error string.
 */
export async function resolveAccessToken(
  userId: string,
  agent: AgentRow
): Promise<string | undefined> {
  const { auth } = capabilitiesFor(agent)
  if (auth === 'cinna') return getCinnaAccessToken(userId)
  if (auth !== 'token') return undefined
  return agent.accessTokenEncrypted ? decryptApiKey(agent.accessTokenEncrypted) : undefined
}
