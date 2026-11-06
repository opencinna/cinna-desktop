import { BRAND_THEME_MODES } from './roles'

const SHA256_RE = /^[0-9a-f]{64}$/

/**
 * The sha256 of every asset a served brand theme document references
 * (`theme.logo` / `theme.background`, per mode), deduplicated. Reads any
 * value without trusting it: a malformed document references nothing.
 */
export function servedAssetShas(served: unknown): string[] {
  const theme = (served as { theme?: unknown } | null)?.theme
  if (!theme || typeof theme !== 'object') return []
  const out = new Set<string>()
  for (const block of ['logo', 'background'] as const) {
    const value = (theme as Record<string, unknown>)[block]
    if (!value || typeof value !== 'object') continue
    for (const mode of BRAND_THEME_MODES) {
      const ref = (value as Record<string, unknown>)[mode]
      const sha = ref && typeof ref === 'object' ? (ref as { sha256?: unknown }).sha256 : undefined
      if (typeof sha === 'string' && SHA256_RE.test(sha)) out.add(sha)
    }
  }
  return [...out]
}
