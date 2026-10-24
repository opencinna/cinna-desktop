import type { McpProviderData } from '../../../../preload'
import type { CredentialHealth } from './credentialPresentation'

/**
 * The sentence behind a connector's warning glyph, or null when it is fine.
 * One wording for every list that draws a connector (ux_rules rule 13): the
 * Settings card, an agent's Addons card and the attach picker.
 */
export function mcpProblem(provider: Pick<McpProviderData, 'enabled' | 'status' | 'error'>): string | null {
  if (!provider.enabled) return 'Turned off — nothing gets its tools'
  if (provider.status === 'connected') return null
  if (provider.status === 'awaiting-auth') return 'Waiting for authorization in your browser'
  if (provider.status === 'error') return provider.error ?? 'Could not connect'
  return 'Not connected'
}

/**
 * A connector's state as the shared status glyph draws it, wherever a
 * connector is listed (Settings → MCP, an agent's Addons tab): connected is a
 * check, a failed connect a red cross, anything else that keeps its tools out
 * of sessions (turned off, not connected, waiting for a sign-in) a triangle.
 * One mapping, so the same connector never wears two colours (ux_rules rule 13).
 */
export function mcpHealth(provider: Pick<McpProviderData, 'enabled' | 'status' | 'error'>): CredentialHealth {
  const problem = mcpProblem(provider)
  if (problem === null) return { tone: 'ok', label: 'Connected' }
  return { tone: provider.enabled && provider.status === 'error' ? 'error' : 'warning', label: problem }
}
