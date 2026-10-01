import type { McpProviderData } from '../../../../preload'

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
