import { getCurrentUserId } from './session'
import { DEFAULT_USER_ID } from '../../shared/userIds'

/**
 * The default (guest) user id. All shared settings — chat modes, LLM
 * providers, MCP providers, and locally-registered agents — live under this
 * scope so they are available regardless of which profile is currently active.
 */
export const DEFAULT_SCOPE_USER_ID = DEFAULT_USER_ID

/**
 * Settings scope: where shared resources (modes, providers, mcp, local agents)
 * are stored and looked up. Always the default user id.
 */
export function getSettingsScopeUserId(): string {
  return DEFAULT_SCOPE_USER_ID
}

/**
 * Profile scope: where account-specific resources (chats, remote agents,
 * cinna tokens) belong. Equals the currently activated user id.
 */
export function getProfileScopeUserId(): string {
  return getCurrentUserId()
}

/**
 * Scope union used when looking up an agent that could either be a shared
 * local agent (default scope) or a profile-bound remote agent (active user).
 */
export function getAgentLookupScope(): string[] {
  const profile = getProfileScopeUserId()
  if (profile === DEFAULT_SCOPE_USER_ID) return [DEFAULT_SCOPE_USER_ID]
  return [DEFAULT_SCOPE_USER_ID, profile]
}
